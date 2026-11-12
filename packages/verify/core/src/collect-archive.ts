/**
 * Contract 1.3 (#80 item 6, #232): `verify collect archive` — a read-only, deterministic collector that turns a
 * tar / tar.gz into a SQLite snapshot of raw observations. Judgement stays in the frozen predicate AST: there are no
 * ok / changed / invalid columns. A failed or partial read is recorded as rows in `archive_errors`, never dropped.
 *
 * Determinism: rows are built in memory in stream order and written with `VACUUM INTO`, so the same input on the
 * same engine gives a byte-identical snapshot. Bounds (entries, decompressed bytes, path length) are recorded in
 * `archive_meta`; reaching one is an error row, and collection stops there.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { constants as zc, gunzipSync } from "node:zlib";

import { openDatabaseSync } from "./sqlite-bindings";

export const ARCHIVE_COLLECTOR = "archive@1";

export interface ArchiveLimits {
  maxEntries: number;
  maxBytes: number;
  maxPath: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = { maxEntries: 100_000, maxBytes: 1 << 30, maxPath: 4096 };

export interface ArchiveEntryRow {
  seq: number;
  header_offset: number;
  path: string;
  path_hex: string;
  header_name: string;
  typeflag: string;
  size: number;
  mode: number | null;
  linkname: string;
  payload_sha256: string | null;
  header_checksum_ok: number;
  pax_keys: string;
  path_occurrence: number;
}

export type ArchiveErrorKind =
  | "unreadable"
  | "empty_input"
  | "malformed_input"
  | "not_tar"
  | "truncated"
  | "malformed_header"
  | "orphan_pax"
  | "missing_end"
  | "bound_entries"
  | "bound_bytes"
  | "bound_path";

export interface ArchiveErrorRow {
  seq: number;
  header_offset: number | null;
  kind: ArchiveErrorKind;
  detail: string;
  raw_hex: string;
}

export interface ArchiveObservation {
  meta: Array<[string, string]>;
  entries: ArchiveEntryRow[];
  errors: ArchiveErrorRow[];
}

const BLOCK = 512;
/** Types whose size field does not announce a payload in the stream (links, devices, directories, FIFOs). */
const NO_PAYLOAD = new Set(["1", "2", "3", "4", "5", "6"]);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const hex = (b: Uint8Array, max = BLOCK) => Buffer.from(b.subarray(0, max)).toString("hex");

function cstr(b: Uint8Array): Uint8Array {
  const end = b.indexOf(0);
  return end < 0 ? b : b.subarray(0, end);
}

/** Octal numeric field (spaces / NULs as terminators), or GNU base-256 when the high bit is set. null = malformed. */
function numeric(field: Uint8Array): number | null {
  if (field.length && field[0] & 0x80) {
    let n = field[0] & 0x7f;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i];
    return Number.isSafeInteger(n) ? n : null;
  }
  const s = Buffer.from(field).toString("latin1").replace(/[\0 ]+$/, "").replace(/^ +/, "");
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) return null;
  const n = parseInt(s, 8);
  return Number.isSafeInteger(n) ? n : null;
}

function checksumOk(h: Uint8Array): boolean {
  const stored = numeric(h.subarray(148, 156));
  if (stored === null) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : h[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return stored === unsigned || stored === signed;
}

/** PAX records `"<len> <key>=<value>\n"`; null when a record is malformed. */
function paxRecords(payload: Uint8Array): Map<string, Uint8Array> | null {
  const out = new Map<string, Uint8Array>();
  let i = 0;
  while (i < payload.length) {
    if (payload[i] === 0) break;
    const sp = payload.indexOf(0x20, i);
    if (sp < 0) return null;
    const lenText = Buffer.from(payload.subarray(i, sp)).toString("latin1");
    if (!/^[0-9]+$/.test(lenText)) return null;
    const len = Number(lenText);
    if (len <= sp - i + 1 || i + len > payload.length || payload[i + len - 1] !== 0x0a) return null;
    const rec = payload.subarray(sp + 1, i + len - 1);
    const eq = rec.indexOf(0x3d);
    if (eq <= 0) return null;
    out.set(Buffer.from(rec.subarray(0, eq)).toString("utf8"), rec.subarray(eq + 1));
    i += len;
  }
  return out;
}

const decode = (b: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(b);

/** Parse a tar byte stream into observations (pure; `collectArchive` adds input handling and the SQLite write). */
export function observeTar(tar: Uint8Array, limits: ArchiveLimits, errors: ArchiveErrorRow[] = []): ArchiveEntryRow[] {
  const entries: ArchiveEntryRow[] = [];
  const seen = new Map<string, number>();
  const err = (kind: ArchiveErrorKind, at: number | null, detail: string, raw: Uint8Array = new Uint8Array()) =>
    errors.push({ seq: errors.length + 1, header_offset: at, kind, detail, raw_hex: hex(raw) });
  let pending: { pax?: Map<string, Uint8Array>; paxAt?: number; longName?: Uint8Array; longLink?: Uint8Array } = {};
  let total = 0;
  let off = 0;
  let ended = false;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) {
      ended = true;
      break;
    }
    const ok = checksumOk(h);
    const magic = Buffer.from(h.subarray(257, 262)).toString("latin1");
    if (!ok && entries.length === 0 && magic !== "ustar") {
      err("not_tar", off, "the first block is neither a tar header (checksum) nor an end marker", h);
      return entries;
    }
    const size = numeric(h.subarray(124, 136));
    const mode = numeric(h.subarray(100, 108));
    const typeflag = h[156] === 0 ? "" : String.fromCharCode(h[156]);
    const nameRaw = cstr(h.subarray(0, 100));
    const prefixRaw = magic === "ustar" ? cstr(h.subarray(345, 500)) : new Uint8Array();
    const headerName = prefixRaw.length ? Buffer.concat([prefixRaw, Buffer.from("/"), nameRaw]) : Buffer.from(nameRaw);
    if (size === null) {
      err("malformed_header", off, "size field is not an octal or base-256 number", h);
      return entries;
    }
    const hasPayload = !NO_PAYLOAD.has(typeflag);
    const payloadLen = hasPayload ? size : 0;
    const dataAt = off + BLOCK;
    if (entries.length + 1 > limits.maxEntries) {
      err("bound_entries", off, `more than ${limits.maxEntries} headers`);
      return entries;
    }
    if (total + payloadLen > limits.maxBytes) {
      err("bound_bytes", off, `payload bytes exceed ${limits.maxBytes}`);
      return entries;
    }
    if (dataAt + payloadLen > tar.length) {
      err("truncated", off, `header announces ${payloadLen} payload bytes, ${Math.max(0, tar.length - dataAt)} remain`, h);
      return entries;
    }
    const payload = tar.subarray(dataAt, dataAt + payloadLen);
    total += payloadLen;
    // effective path: PAX path > GNU long name > ustar prefix/name
    const isMeta = typeflag === "x" || typeflag === "g" || typeflag === "L" || typeflag === "K";
    const paxPath = !isMeta ? pending.pax?.get("path") : undefined;
    const pathRaw = isMeta ? headerName : paxPath ?? (pending.longName ? cstr(pending.longName) : headerName);
    const linkRaw = isMeta ? cstr(h.subarray(157, 257)) : pending.pax?.get("linkpath") ?? (pending.longLink ? cstr(pending.longLink) : cstr(h.subarray(157, 257)));
    let paxKeys = "";
    if (typeflag === "x" || typeflag === "g") {
      const recs = paxRecords(payload);
      if (!recs) {
        err("malformed_header", off, "PAX extended header has a malformed record", payload);
        return entries;
      }
      paxKeys = [...recs.keys()].sort().join(",");
      if (typeflag === "x") {
        if (pending.pax) err("orphan_pax", pending.paxAt ?? null, "PAX header followed by another PAX header, not an entry");
        pending.pax = recs;
        pending.paxAt = off;
      }
    } else if (typeflag === "L") pending.longName = payload;
    else if (typeflag === "K") pending.longLink = payload;
    else {
      paxKeys = pending.pax ? [...pending.pax.keys()].sort().join(",") : "";
      pending = {};
    }
    if (pathRaw.length > limits.maxPath) {
      err("bound_path", off, `path is ${pathRaw.length} bytes, the limit is ${limits.maxPath}`);
      return entries;
    }
    const path = decode(pathRaw);
    const occurrence = (seen.get(path) ?? 0) + 1;
    seen.set(path, occurrence);
    entries.push({
      seq: entries.length + 1,
      header_offset: off,
      path,
      path_hex: Buffer.from(pathRaw).toString("hex"),
      header_name: decode(headerName),
      typeflag,
      size,
      mode,
      linkname: decode(linkRaw),
      payload_sha256: hasPayload ? sha256(payload) : null,
      header_checksum_ok: ok ? 1 : 0,
      pax_keys: paxKeys,
      path_occurrence: occurrence,
    });
    if (!ok) {
      err("malformed_header", off, "header checksum mismatch", h);
      return entries;
    }
    if (mode === null) err("malformed_header", off, "mode field is not an octal number", h.subarray(100, 108));
    off = dataAt + Math.ceil(payloadLen / BLOCK) * BLOCK;
  }
  if (pending.pax || pending.longName || pending.longLink) err("orphan_pax", pending.paxAt ?? null, "extended header at the end of the archive, no entry follows");
  if (!ended) {
    if (off === 0 && entries.length === 0) err("not_tar", 0, `${tar.length} byte(s), less than one tar header block`, tar);
    else if (off < tar.length) err("truncated", off, `${tar.length - off} trailing byte(s), less than one header block`, tar.subarray(off));
    else err("missing_end", off, "no end-of-archive block");
  }
  return entries;
}

/** Read the input, decompress within bounds, observe. Never throws for input problems — they become error rows. */
export function observeArchive(inputPath: string, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): ArchiveObservation {
  const errors: ArchiveErrorRow[] = [];
  const err = (kind: ArchiveErrorKind, detail: string, raw: Uint8Array = new Uint8Array()) =>
    errors.push({ seq: errors.length + 1, header_offset: null, kind, detail, raw_hex: hex(raw) });
  const meta: Array<[string, string]> = [
    ["collector", ARCHIVE_COLLECTOR],
    ["input_name", basename(inputPath)],
    ["max_entries", String(limits.maxEntries)],
    ["max_bytes", String(limits.maxBytes)],
    ["max_path", String(limits.maxPath)],
  ];
  let raw: Buffer | null = null;
  try {
    raw = readFileSync(inputPath);
  } catch (e) {
    err("unreadable", (e as Error).message.split(inputPath).join(basename(inputPath)));
  }
  let entries: ArchiveEntryRow[] = [];
  if (raw) {
    meta.push(["input_sha256", sha256(raw)], ["input_bytes", String(raw.length)]);
    const gz = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
    meta.push(["compression", gz ? "gzip" : "none"]);
    let tar: Uint8Array | null = raw;
    if (raw.length === 0) {
      err("empty_input", "the input file is empty");
      tar = null;
    } else if (gz) {
      const cap = limits.maxBytes + (limits.maxEntries + 2) * BLOCK * 2;
      try {
        tar = gunzipSync(raw, { maxOutputLength: cap });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ERR_BUFFER_TOO_LARGE") {
          err("bound_bytes", `decompressed size exceeds ${cap} bytes`);
          tar = null;
        } else if (code === "Z_BUF_ERROR") {
          err("truncated", `gzip stream ends early: ${(e as Error).message}`, raw.subarray(Math.max(0, raw.length - 64)));
          try {
            tar = gunzipSync(raw, { maxOutputLength: cap, finishFlush: zc.Z_SYNC_FLUSH });
          } catch {
            tar = null;
          }
        } else {
          err("malformed_input", `gzip: ${(e as Error).message}`, raw.subarray(0, 64));
          tar = null;
        }
      }
    }
    if (tar) entries = observeTar(tar, limits, errors);
  }
  meta.push(["entries", String(entries.length)], ["errors", String(errors.length)]);
  return { meta, entries, errors };
}

/** `verify collect archive`: observe and write the snapshot with VACUUM INTO (deterministic). `out` must not exist. */
export function collectArchive(inputPath: string, outPath: string, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): { out: string; sha256: string; entries: number; errors: number } {
  if (existsSync(outPath)) throw new Error(`--out ${outPath} already exists — a collected snapshot is never overwritten`);
  const obs = observeArchive(inputPath, limits);
  const db = openDatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE archive_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE archive_entries(seq INTEGER PRIMARY KEY, header_offset INTEGER NOT NULL, path TEXT NOT NULL, path_hex TEXT NOT NULL,
        header_name TEXT NOT NULL, typeflag TEXT NOT NULL, size INTEGER NOT NULL, mode INTEGER, linkname TEXT NOT NULL,
        payload_sha256 TEXT, header_checksum_ok INTEGER NOT NULL, pax_keys TEXT NOT NULL, path_occurrence INTEGER NOT NULL);
      CREATE TABLE archive_errors(seq INTEGER PRIMARY KEY, header_offset INTEGER, kind TEXT NOT NULL, detail TEXT NOT NULL, raw_hex TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    const m = db.prepare("INSERT INTO archive_meta(key, value) VALUES (?, ?)");
    for (const [k, v] of obs.meta) m.run(k, v);
    const e = db.prepare("INSERT INTO archive_entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const r of obs.entries) {
      e.run(r.seq, r.header_offset, r.path, r.path_hex, r.header_name, r.typeflag, r.size, r.mode, r.linkname, r.payload_sha256, r.header_checksum_ok, r.pax_keys, r.path_occurrence);
    }
    const x = db.prepare("INSERT INTO archive_errors VALUES (?,?,?,?,?)");
    for (const r of obs.errors) x.run(r.seq, r.header_offset, r.kind, r.detail, r.raw_hex);
    db.prepare("VACUUM INTO ?").run(outPath);
  } finally {
    db.close();
  }
  return { out: outPath, sha256: sha256(readFileSync(outPath)), entries: obs.entries.length, errors: obs.errors.length };
}
