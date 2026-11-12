/**
 * Contract 1.3 part 3 (#80 items 6–7, #232): the archive collector records raw observations — PAX / GNU long names,
 * orphans, malformed headers, truncation and bounds become rows, never dropped members — and the engine never lets a
 * 1.3 spec PASS on a snapshot whose collector recorded errors. Rust parity for the engine rule: tests/collect_errors.rs.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

import { collectArchive, DEFAULT_ARCHIVE_LIMITS, observeArchive, observeTar, type ArchiveErrorRow } from "../src/collect-archive";
import type { VerifySpec } from "../src/contract";
import { runVerify } from "../src/engine";
import { SqliteRunner } from "../src/sqlite-runner";

function header(name: string | Buffer, size: number, type: string, opts: { sizeField?: Buffer; mode?: string } = {}): Buffer {
  const h = Buffer.alloc(512);
  (typeof name === "string" ? Buffer.from(name, "utf8") : name).copy(h, 0, 0, 100);
  h.write(opts.mode ?? "0000644\0", 100, "latin1");
  (opts.sizeField ?? Buffer.from(size.toString(8).padStart(11, "0") + "\0", "latin1")).copy(h, 124);
  h.write("        ", 148, "latin1");
  h.write(type, 156, "latin1");
  h.write("ustar\0" + "00", 257, "latin1");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return h;
}
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
const member = (name: string | Buffer, data: string | Buffer, type = "0", opts = {}) => {
  const d = typeof data === "string" ? Buffer.from(data) : data;
  return Buffer.concat([header(name, d.length, type, opts), pad(d)]);
};
const pax = (records: Record<string, string>) => {
  const body = Object.entries(records).map(([k, v]) => {
    const rest = ` ${k}=${v}\n`;
    let len = rest.length + 1;
    while (`${len}${rest}`.length !== len) len++;
    return `${len}${rest}`;
  }).join("");
  return member("PaxHeader/x", body, "x");
};
const END = Buffer.alloc(1024);
const L = DEFAULT_ARCHIVE_LIMITS;
const observe = (tar: Buffer, limits = L) => {
  const errors: ArchiveErrorRow[] = [];
  const entries = observeTar(tar, limits, errors);
  return { entries, errors, kinds: errors.map((e) => e.kind) };
};

describe("observeTar: raw observations, no verdicts", () => {
  it("PAX path and linkpath override the header; the entry lists the PAX keys that applied", () => {
    const { entries, kinds } = observe(Buffer.concat([pax({ path: "package/very/long/name.js", mtime: "1" }), member("short", "abc"), END]));
    expect(kinds).toEqual([]);
    expect(entries.map((e) => [e.typeflag, e.path, e.pax_keys])).toEqual([["x", "PaxHeader/x", "mtime,path"], ["0", "package/very/long/name.js", "mtime,path"]]);
    expect(entries[1]).toMatchObject({ header_name: "short", size: 3, payload_sha256: createHash("sha256").update("abc").digest("hex"), header_checksum_ok: 1, mode: 0o644 });
  });

  it("GNU long names apply to the next entry; directories and links carry no payload hash", () => {
    const { entries } = observe(Buffer.concat([member("././@LongLink", "package/long.txt\0", "L"), member("trunc", "x"), member("package/", "", "5"), header("package/ln", 0, "2"), END]));
    expect(entries.map((e) => [e.typeflag, e.path, e.payload_sha256 === null])).toEqual([["L", "././@LongLink", false], ["0", "package/long.txt", false], ["5", "package/", true], ["2", "package/ln", true]]);
  });

  it("path_occurrence counts repeats; invalid UTF-8 keeps its raw bytes in path_hex", () => {
    const bad = Buffer.from([0x70, 0xff, 0x71]);
    const { entries } = observe(Buffer.concat([member("a", "1"), member("a", "2"), member(bad, "3"), END]));
    expect(entries.map((e) => e.path_occurrence)).toEqual([1, 2, 1]);
    expect(entries[2]).toMatchObject({ path: "p�q", path_hex: "70ff71" });
  });

  it("orphan PAX headers, a missing end marker and trailing bytes are error rows", () => {
    expect(observe(Buffer.concat([member("a", "1"), pax({ path: "x" }), END])).kinds).toEqual(["orphan_pax"]);
    expect(observe(Buffer.concat([pax({ path: "x" }), pax({ path: "y" }), member("a", "1"), END])).kinds).toEqual(["orphan_pax"]);
    expect(observe(member("a", "1")).kinds).toEqual(["missing_end"]);
    expect(observe(Buffer.concat([member("a", "1"), Buffer.alloc(100, 1)])).kinds).toEqual(["truncated"]);
  });

  it("malformed headers: a bad checksum stops after recording the row, a bad mode does not stop", () => {
    const h = member("b", "2");
    h[148] = 0x37;
    const ck = observe(Buffer.concat([member("a", "1"), h, member("c", "3"), END]));
    expect(ck.kinds).toEqual(["malformed_header"]);
    expect(ck.entries.map((e) => [e.path, e.header_checksum_ok])).toEqual([["a", 1], ["b", 0]]);
    const md = observe(Buffer.concat([member("a", "1", "0", { mode: "zz\0\0\0\0\0\0" }), member("c", "3"), END]));
    expect(md.kinds).toEqual(["malformed_header"]);
    expect(md.entries.map((e) => [e.path, e.mode])).toEqual([["a", null], ["c", 0o644]]);
    expect(observe(Buffer.concat([member("a", "1", "0", { sizeField: Buffer.from("9z\0\0\0\0\0\0\0\0\0\0") }), END])).kinds).toEqual(["malformed_header"]);
    expect(observe(Buffer.concat([Buffer.alloc(512, 0x41), END])).kinds).toEqual(["not_tar"]);
  });

  it("base-256 sizes parse; a payload past the end is truncated", () => {
    const b256 = Buffer.alloc(12);
    b256[0] = 0x80;
    b256[11] = 3;
    expect(observe(Buffer.concat([member("a", "xyz", "0", { sizeField: b256 }), END])).entries[0].size).toBe(3);
    const cut = Buffer.concat([header("big", 4096, "0"), Buffer.alloc(100)]);
    expect(observe(cut).kinds).toEqual(["truncated"]);
  });

  it("bounds stop collection and are error rows", () => {
    const three = Buffer.concat([member("a", "1"), member("b", "2"), member("c", "3"), END]);
    expect(observe(three, { ...L, maxEntries: 2 })).toMatchObject({ kinds: ["bound_entries"] });
    expect(observe(three, { ...L, maxEntries: 2 }).entries.length).toBe(2);
    expect(observe(three, { ...L, maxBytes: 2 }).kinds).toEqual(["bound_bytes"]);
    expect(observe(Buffer.concat([member("a".repeat(50), "1"), END]), { ...L, maxPath: 10 }).kinds).toEqual(["bound_path"]);
  });
});

describe("observeArchive / collectArchive: input handling and deterministic snapshots", () => {
  const home = mkdtempSync(join(tmpdir(), "ygl-collect-core-"));
  afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const file = (name: string, bytes: Buffer) => {
    const p = join(home, name);
    writeFileSync(p, bytes);
    return p;
  };
  const tar = Buffer.concat([member("package/a.txt", "hello"), member("package/b.bin", "z".repeat(3000)), END]);

  it("gzip and plain tar give the same entries; meta records input, compression and limits", () => {
    const gz = observeArchive(file("a.tgz", gzipSync(tar)));
    const plain = observeArchive(file("a.tar", tar));
    expect(gz.entries).toEqual(plain.entries);
    expect(Object.fromEntries(gz.meta)).toMatchObject({ collector: "archive@1", input_name: "a.tgz", compression: "gzip", entries: "2", errors: "0", max_entries: String(L.maxEntries) });
    expect(Object.fromEntries(plain.meta).compression).toBe("none");
  });

  it("unreadable, empty, corrupt and truncated gzip input, and a decompression bomb, are error rows", () => {
    expect(observeArchive(join(home, "nope.tgz")).errors.map((e) => e.kind)).toEqual(["unreadable"]);
    expect(observeArchive(join(home, "nope.tgz")).errors[0].detail).not.toContain(home);
    expect(observeArchive(file("e.tgz", Buffer.alloc(0))).errors.map((e) => e.kind)).toEqual(["empty_input"]);
    const gz = gzipSync(tar);
    const corrupt = Buffer.from(gz);
    corrupt[20] ^= 0xff;
    expect(observeArchive(file("c.tgz", corrupt)).errors.map((e) => e.kind)[0]).toMatch(/malformed_input|truncated/);
    const t = observeArchive(file("t.tgz", gz.subarray(0, gz.length - 12)));
    expect(t.errors.map((e) => e.kind)).toContain("truncated");
    const bomb = observeArchive(file("bomb.tgz", gzipSync(Buffer.alloc(4 << 20))), { maxEntries: 1, maxBytes: 1024, maxPath: 100 });
    expect(bomb.errors.map((e) => e.kind)).toEqual(["bound_bytes"]);
  });

  it("the same input gives a byte-identical snapshot; an existing --out is never overwritten", () => {
    const input = file("d.tgz", gzipSync(tar));
    const a = collectArchive(input, join(home, "d1.sqlite"));
    const b = collectArchive(input, join(home, "d2.sqlite"));
    expect(a.sha256).toBe(b.sha256);
    expect(createHash("sha256").update(readFileSync(join(home, "d2.sqlite"))).digest("hex")).toBe(b.sha256);
    expect(() => collectArchive(input, join(home, "d1.sqlite"))).toThrow("already exists");
    const db = new DatabaseSync(join(home, "d1.sqlite"), { readOnly: true });
    const cols = (db.prepare("SELECT name FROM pragma_table_info('archive_entries')").all() as Array<{ name: string }>).map((c) => c.name);
    db.close();
    expect(cols.filter((c) => /ok$|changed|invalid|valid/.test(c))).toEqual(["header_checksum_ok"]);
  });
});

describe("no silent empty pass: collector error rows turn a 1.3 PASS into ERROR", () => {
  const home = mkdtempSync(join(tmpdir(), "ygl-collect-rule-"));
  afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const snap = (name: string, errors: number) => {
    const p = join(home, name);
    const db = new DatabaseSync(p);
    db.exec("CREATE TABLE archive_entries(seq INTEGER PRIMARY KEY, path TEXT); INSERT INTO archive_entries(path) VALUES ('package/a'), ('package/b');");
    db.exec("CREATE TABLE archive_errors(seq INTEGER PRIMARY KEY, kind TEXT)");
    for (let i = 0; i < errors; i++) db.exec("INSERT INTO archive_errors(kind) VALUES ('truncated')");
    db.close();
    return p;
  };
  const spec = (contract: string): VerifySpec => ({
    contract_version: contract, spec_id: "spec_collect13", spec_version: 1, title: "collect", domain: "test",
    created: "2026-11-11T00:00:00.000Z", runtime_min: "1", verifier: { engine_version: "test", corpus_version: "1.2" },
    as_of: { kind: "snapshot", value: "2026-11-11T00:00:00.000Z" }, attachments: [], sealed: { review: false },
    vu: [
      { id: "V1", role: "assert", severity: "S1", source_clause: "paths stay in package/", checker: { type: "sql", expect: "empty", fail_when: "rows>0", predicate: { from: "archive_entries", select: ["path"], where: { op: "and", conditions: [{ col: "path", op: "not-glob", value: "package/*" }] } } } },
      { id: "V2", role: "assert", severity: "S1", source_clause: "no b", checker: { type: "sql", expect: "empty", fail_when: "rows>0", predicate: { from: "archive_entries", select: ["path"], where: { op: "and", conditions: [{ col: "path", op: "=", value: "package/b" }] } } } },
    ],
  } as never);
  const run = async (s: VerifySpec, db: string) => {
    const runner = new SqliteRunner(db);
    try { return await runVerify(s, { runner, mode: "open", nowIso: () => "2026-11-11T00:00:00.000Z", runId: "run_collect13" }); }
    finally { runner.close(); }
  };

  it("clean snapshot: PASS stays PASS, FAIL stays FAIL", async () => {
    const r = await run(spec("1.3"), snap("clean.sqlite", 0));
    expect(r.vu.map((v) => v.verdict)).toEqual(["PASS", "FAIL"]);
  });

  it("with error rows: PASS becomes ERROR naming the table, FAIL stays FAIL, overall is never PASS", async () => {
    const r = await run(spec("1.3"), snap("errors.sqlite", 2));
    expect(r.vu.map((v) => v.verdict)).toEqual(["ERROR", "FAIL"]);
    expect(r.vu[0].evidence).toMatchObject({ input_errors: [{ table: "archive_errors", rows: 2 }] });
    expect(String((r.vu[0].evidence as { reason: string }).reason)).toContain("input_errors: 2 row(s) in archive_errors");
    expect(r.overall).toBe("FAIL");
  });

  // #270: summary / overall are folded after every downgrade, so the report agrees with its own units
  const folded = (vu: Array<{ verdict: string; role?: string }>) => {
    const out = { pass: 0, fail: 0, needs_material: 0, error: 0 };
    for (const v of vu) {
      if (v.role === "source") continue;
      if (v.verdict === "PASS") out.pass++;
      else if (v.verdict === "FAIL") out.fail++;
      else if (v.verdict === "NEEDS-MATERIAL") out.needs_material++;
      else out.error++;
    }
    return out;
  };

  it("#270: with error rows the summary counts the downgraded units as ERROR, not PASS", async () => {
    const r = await run(spec("1.3"), snap("errors270.sqlite", 1));
    expect(r.summary).toEqual(folded(r.vu as never));
    expect(r.summary).toMatchObject({ pass: 0, fail: 1, error: 1 });
  });

  it("#270: schema drift downgrades before summary and overall are folded", async () => {
    const s = spec("1.3");
    s.vu = [s.vu[0]];
    s.schema_fingerprint = "sha256:not-the-snapshot";
    const r = await run(s, snap("drift270.sqlite", 0));
    expect(r.vu[0].verdict).toBe("ERROR");
    expect(r.summary).toEqual(folded(r.vu as never));
    expect(r.summary).toMatchObject({ pass: 0, error: 1 });
    expect(r.overall).toBe("ERROR");
  });

  it("1.2 specs are untouched by the rule", async () => {
    const twelve = spec("1.3");
    twelve.contract_version = "1.2";
    (twelve.vu[0].checker as { predicate: { where: unknown } }).predicate.where = { op: "and", conditions: [{ col: "path", op: "=", value: "elsewhere/x" }] };
    expect((await run(twelve, snap("errors12.sqlite", 1))).vu[0].verdict).toBe("PASS");
  });
});
