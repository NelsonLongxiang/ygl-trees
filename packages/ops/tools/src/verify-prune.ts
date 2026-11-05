/**
 * #222: `verify prune` — retention for `$YGL_HOME/verify/` (reports, archive sidecars and zips, retained snapshots).
 *
 * Every `verify run` leaves a report, an archive and a retained snapshot that used to stay forever; verifier homes
 * reached tens of GiB, mostly self-check injection runs. Prune keeps the runs that carry evidence and drops the rest:
 *
 *   recent      the newest N reports of each spec (--keep-last, default 10)
 *   flip        both sides of the last F changes of `overall` per spec (--keep-flips, default 10; 0 = none)
 *   first       the first report of each spec_version
 *   pinned      a run id named in a --keep-runs-in file or folder, a graduation record, a tree report,
 *               or the registry's verifier_runs
 *   young       finished less than M minutes ago (--min-age-minutes, default 60) — protects runs in flight
 *   unreadable  a report that cannot be parsed is never deleted
 *
 * The default is a dry run that changes no file. `--apply` deletes, per pruned run, the archive zips its sidecar lists
 * inside `archives/`, then the sidecar, then the report (an interrupted apply leaves a plain unarchived report that the
 * next prune still sees), and last the retained snapshots no kept run references. Orphan snapshots are counted, never
 * deleted. Every usage check runs before any verify-root I/O (#175 ordering).
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export const PRUNE_FLAGS = ["keep-last", "keep-flips", "keep-runs-in", "min-age-minutes", "apply"];
export const USAGE_PRUNE = "usage: verify prune [--keep-last N] [--keep-flips N] [--keep-runs-in <file|dir>]... [--min-age-minutes M] [--apply]";
export const PRUNE_DEFAULTS = { keepLast: 10, keepFlips: 10, minAgeMinutes: 60 };
export const KEEP_REASONS = ["recent", "flip", "first", "pinned", "young", "unreadable"] as const;
export type KeepReason = (typeof KEEP_REASONS)[number];

export interface PruneOptions {
  keepLast: number;
  keepFlips: number;
  minAgeMinutes: number;
  pins: string[];
  apply: boolean;
}

const RUN_TOKEN = /run_[0-9a-f]{12,64}/g;
const SHA_TOKEN = /[0-9a-f]{64}/g;
/** Text files a pinned folder is scanned for; a file named directly is read whatever its extension. */
const PIN_EXT = /\.(json|jsonl|ndjson|md|txt|log|csv|tsv|ya?ml)$/i;

const list = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Flag checks only; the one filesystem touch is that each --keep-runs-in path exists — a mistyped pin would
 *  otherwise drop its runs silently, so it is a usage error (rc=2), refused before the verify root is read. */
export function prunePreflight(flags: Record<string, unknown>): string | null {
  for (const [flag, min] of [["keep-last", 1], ["keep-flips", 0], ["min-age-minutes", 0]] as const) {
    const v = flags[flag];
    if (v === undefined) continue;
    if (typeof v !== "string" || !/^\d{1,6}$/.test(v) || Number(v) < min) return `--${flag} needs an integer ≥ ${min} (got ${JSON.stringify(v)}) — ${USAGE_PRUNE}`;
  }
  if (flags.apply !== undefined && flags.apply !== true) return `--apply takes no value — ${USAGE_PRUNE}`;
  for (const pin of list(flags["keep-runs-in"])) {
    if (typeof pin !== "string" || !pin.trim()) return `--keep-runs-in needs a file or folder path — ${USAGE_PRUNE}`;
    if (!existsSync(pin)) return `--keep-runs-in path not found: ${pin} (a missing pin would drop the runs it names)`;
  }
  return null;
}

export function parsePruneOptions(flags: Record<string, unknown>): PruneOptions {
  const int = (k: string, d: number) => (flags[k] === undefined ? d : Number(flags[k]));
  return {
    keepLast: int("keep-last", PRUNE_DEFAULTS.keepLast),
    keepFlips: int("keep-flips", PRUNE_DEFAULTS.keepFlips),
    minAgeMinutes: int("min-age-minutes", PRUNE_DEFAULTS.minAgeMinutes),
    pins: list(flags["keep-runs-in"]).map((p) => resolve(String(p))),
    apply: flags.apply === true,
  };
}

interface RunRecord {
  run_id: string;
  spec_id: string;
  spec_version: number;
  overall: string;
  finished: string;
  at: number;
  snapshot: string;
}

export interface PrunePlan {
  root: string;
  options: PruneOptions;
  reports: { total: number; keep: number; delete: number; unreadable: number };
  kept_by: Record<KeepReason, number>;
  pinned_runs: number;
  archives: { sidecars: string[]; zips: string[] };
  snapshots: { total: number; keep: number; delete: string[]; orphan: number; orphan_bytes: number };
  bytes: { reports: number; archives: number; snapshots: number; total: number };
  specs: Array<{ spec_id: string; total: number; keep: number; delete: number; oldest_deleted: string; newest_deleted: string }>;
  /** Run ids to delete, oldest first. */
  delete: string[];
  /** Snapshot shas a kept, young or unreadable run may still need (re-checked before an apply deletes). */
  keptShas: Set<string>;
}

function size(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function hex(sha: unknown): string {
  const s = String(sha ?? "").replace(/^sha256:/, "");
  return /^[0-9a-f]{64}$/.test(s) ? s : "";
}

/** Every `run_…` token in a pin file, or in the text files of a pin folder (recursively). */
export function pinnedRunIds(paths: string[], into = new Set<string>()): Set<string> {
  const scan = (file: string) => {
    for (const m of readFileSync(file, "utf8").matchAll(RUN_TOKEN)) into.add(m[0]);
  };
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && PIN_EXT.test(e.name)) scan(p);
    }
  };
  for (const p of paths) (statSync(p).isDirectory() ? walk : scan)(p);
  return into;
}

function readReport(file: string): RunRecord | null {
  try {
    const r = JSON.parse(readFileSync(file, "utf8"));
    const runId = basename(file, ".json");
    if (r?.run_id !== runId || typeof r.spec_id !== "string") return null;
    const finished = String(r.finished ?? r.started ?? "");
    const at = Date.parse(finished);
    return {
      run_id: runId,
      spec_id: r.spec_id,
      spec_version: Number(r.verifier?.spec_version ?? r.spec_version ?? 0),
      overall: String(r.overall ?? ""),
      finished,
      at: Number.isFinite(at) ? at : statSync(file).mtimeMs,
      snapshot: hex(r.data_source?.sha256),
    };
  } catch {
    return null;
  }
}

/** The zips a run's sidecar lists, resolved inside `archives/` only (a sidecar written on another machine falls back
 *  to its file name there; a zip written with `archive --out` elsewhere is never touched). */
function sidecarZips(archives: string, runId: string): string[] {
  const file = join(archives, `${runId}.json`);
  if (!existsSync(file)) return [];
  let entries: any[] = [];
  try {
    entries = JSON.parse(readFileSync(file, "utf8"))?.archives ?? [];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const a of Array.isArray(entries) ? entries : []) {
    for (const cand of [String(a?.path ?? ""), join(archives, basename(String(a?.filename ?? "")))]) {
      if (!cand) continue;
      const abs = resolve(cand);
      const rel = relative(archives, abs);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel) && existsSync(abs)) {
        out.push(abs);
        break;
      }
    }
  }
  return out;
}

/** Decide what prune keeps and deletes. Reads only; `extraPins` carries run ids from outside the verify root
 *  (the registry's verifier_runs). */
export function planPrune(root: string, options: PruneOptions, extraPins: Iterable<string> = [], now = Date.now()): PrunePlan {
  const reportsDir = join(root, "reports");
  const archives = join(root, "archives");
  const snapsDir = join(root, "snapshots");

  const pins = pinnedRunIds(options.pins, new Set(extraPins));
  const keptShas = new Set<string>();
  for (const dir of ["graduations", "tree-reports"]) {
    for (const n of names(join(root, dir)).filter((f) => f.endsWith(".json"))) {
      const text = readFileSync(join(root, dir, n), "utf8");
      for (const m of text.matchAll(RUN_TOKEN)) pins.add(m[0]);
      if (dir === "tree-reports") for (const m of text.matchAll(SHA_TOKEN)) keptShas.add(m[0]);
    }
  }

  const reasons = new Map<string, Set<KeepReason>>();
  const keep = (id: string, why: KeepReason) => {
    let s = reasons.get(id);
    if (!s) reasons.set(id, (s = new Set()));
    s.add(why);
  };
  const bySpec = new Map<string, RunRecord[]>();
  const all: RunRecord[] = [];
  let unreadable = 0;
  const youngBefore = now - options.minAgeMinutes * 60_000;
  for (const n of names(reportsDir).filter((f) => f.endsWith(".json"))) {
    const rec = readReport(join(reportsDir, n));
    if (!rec) {
      unreadable++;
      keep(basename(n, ".json"), "unreadable");
      // whatever sha an unreadable report names stays retained
      try {
        for (const m of readFileSync(join(reportsDir, n), "utf8").matchAll(SHA_TOKEN)) keptShas.add(m[0]);
      } catch {
        /* vanished between listing and reading */
      }
      continue;
    }
    all.push(rec);
    if (!bySpec.has(rec.spec_id)) bySpec.set(rec.spec_id, []);
    bySpec.get(rec.spec_id)!.push(rec);
    if (pins.has(rec.run_id)) keep(rec.run_id, "pinned");
    if (rec.at > youngBefore) keep(rec.run_id, "young");
  }

  for (const runs of bySpec.values()) {
    runs.sort((a, b) => a.at - b.at || a.run_id.localeCompare(b.run_id));
    for (const r of runs.slice(-options.keepLast)) keep(r.run_id, "recent");
    const flips: number[] = [];
    for (let i = 1; i < runs.length; i++) if (runs[i].overall !== runs[i - 1].overall) flips.push(i);
    for (const i of options.keepFlips ? flips.slice(-options.keepFlips) : []) {
      keep(runs[i - 1].run_id, "flip");
      keep(runs[i].run_id, "flip");
    }
    const seen = new Set<number>();
    for (const r of runs) if (!seen.has(r.spec_version)) (seen.add(r.spec_version), keep(r.run_id, "first"));
  }

  const doomed = all.filter((r) => !reasons.has(r.run_id)).sort((a, b) => a.at - b.at || a.run_id.localeCompare(b.run_id));
  const doomedIds = new Set(doomed.map((r) => r.run_id));
  for (const r of all) if (!doomedIds.has(r.run_id) && r.snapshot) keptShas.add(r.snapshot);

  // zips a kept run's sidecar also lists stay
  const keptZips = new Set<string>();
  const sidecars: string[] = [];
  const zips = new Set<string>();
  for (const r of all) if (!doomedIds.has(r.run_id)) for (const z of sidecarZips(archives, r.run_id)) keptZips.add(z);
  for (const r of doomed) {
    const side = join(archives, `${r.run_id}.json`);
    if (existsSync(side)) sidecars.push(side);
    for (const z of sidecarZips(archives, r.run_id)) if (!keptZips.has(z)) zips.add(z);
  }

  const referenced = new Set(all.map((r) => r.snapshot).filter(Boolean));
  // retainSnapshot names files by the full sha; older homes may hold 12-hex short names (archive.ts reads both)
  const byShort = new Map([...referenced].map((s) => [s.slice(0, 12), s]));
  const snapFiles = names(snapsDir).filter((f) => f.endsWith(".sqlite"));
  const delSnaps: string[] = [];
  let orphan = 0;
  let orphanBytes = 0;
  const doomedShas = new Set(doomed.map((r) => r.snapshot).filter((s) => s && !keptShas.has(s)));
  for (const f of snapFiles) {
    const stem = basename(f, ".sqlite");
    const full = stem.length === 64 ? stem : byShort.get(stem) ?? "";
    if (full && doomedShas.has(full)) delSnaps.push(join(snapsDir, f));
    else if (!full || !referenced.has(full)) {
      orphan++;
      orphanBytes += size(join(snapsDir, f));
    }
  }

  const kept_by = Object.fromEntries(KEEP_REASONS.map((k) => [k, 0])) as Record<KeepReason, number>;
  for (const s of reasons.values()) for (const k of s) kept_by[k]++;
  const bytes = {
    reports: doomed.reduce((n, r) => n + size(join(reportsDir, `${r.run_id}.json`)), 0),
    archives: sidecars.reduce((n, f) => n + size(f), 0) + [...zips].reduce((n, f) => n + size(f), 0),
    snapshots: delSnaps.reduce((n, f) => n + size(f), 0),
    total: 0,
  };
  bytes.total = bytes.reports + bytes.archives + bytes.snapshots;

  const specs = [...bySpec.entries()].map(([spec_id, runs]) => {
    const gone = runs.filter((r) => doomedIds.has(r.run_id));
    return { spec_id, total: runs.length, keep: runs.length - gone.length, delete: gone.length, oldest_deleted: gone[0]?.finished ?? "", newest_deleted: gone.at(-1)?.finished ?? "" };
  }).sort((a, b) => b.delete - a.delete || a.spec_id.localeCompare(b.spec_id));

  return {
    root,
    options,
    reports: { total: all.length + unreadable, keep: all.length + unreadable - doomed.length, delete: doomed.length, unreadable },
    kept_by,
    pinned_runs: pins.size,
    archives: { sidecars, zips: [...zips] },
    snapshots: { total: snapFiles.length, keep: snapFiles.length - delSnaps.length - orphan, delete: delSnaps, orphan, orphan_bytes: orphanBytes },
    bytes,
    specs,
    delete: doomed.map((r) => r.run_id),
    keptShas,
  };
}

export interface PruneResult {
  deleted: { reports: number; sidecars: number; zips: number; snapshots: number };
  failed: string[];
  log: string;
}

/** Carry out a plan. Reports that appeared after planning are never touched, and the snapshots they name stay. */
export function applyPrune(plan: PrunePlan, dropFromIndex: (runIds: string[]) => void, now = new Date()): PruneResult {
  const { root } = plan;
  const reportsDir = join(root, "reports");
  const planned = new Set(plan.delete);
  const keptShas = new Set(plan.keptShas);
  for (const n of names(reportsDir).filter((f) => f.endsWith(".json"))) {
    const id = basename(n, ".json");
    if (planned.has(id)) continue;
    const rec = readReport(join(reportsDir, n));
    if (rec?.snapshot) keptShas.add(rec.snapshot);
  }
  const deleted = { reports: 0, sidecars: 0, zips: 0, snapshots: 0 };
  const failed: string[] = [];
  const rm = (file: string): boolean => {
    try {
      unlinkSync(file);
      return true;
    } catch (e: any) {
      if (e?.code !== "ENOENT") failed.push(`${file}: ${e?.code || e?.message || e}`);
      return false;
    }
  };
  for (const z of plan.archives.zips) if (rm(z)) deleted.zips++;
  for (const s of plan.archives.sidecars) if (rm(s)) deleted.sidecars++;
  const gone: string[] = [];
  for (const id of plan.delete) if (rm(join(reportsDir, `${id}.json`))) (deleted.reports++, gone.push(id));
  const keptShort = new Set([...keptShas].map((s) => s.slice(0, 12)));
  for (const f of plan.snapshots.delete) {
    const stem = basename(f, ".sqlite");
    if (stem.length === 64 ? keptShas.has(stem) : keptShort.has(stem)) continue;
    if (rm(f)) deleted.snapshots++;
  }
  dropFromIndex(gone);
  const log = join(root, "prune-log.jsonl");
  appendFileSync(log, JSON.stringify({
    at: now.toISOString(),
    policy: { keep_last: plan.options.keepLast, keep_flips: plan.options.keepFlips, min_age_minutes: plan.options.minAgeMinutes, pins: plan.options.pins },
    deleted,
    bytes: plan.bytes.total,
    specs: plan.specs.filter((s) => s.delete).map(({ spec_id, delete: n, oldest_deleted, newest_deleted }) => ({ spec_id, deleted: n, oldest_deleted, newest_deleted })),
    run_ids_sha256: createHash("sha256").update(gone.slice().sort().join("\n")).digest("hex"),
    failed: failed.length,
  }) + "\n", "utf8");
  return { deleted, failed, log };
}

/** The JSON face of a plan (sets and absolute file lists stay out; counts and bytes go in). */
export function planView(plan: PrunePlan) {
  return {
    root: plan.root,
    policy: { keep_last: plan.options.keepLast, keep_flips: plan.options.keepFlips, min_age_minutes: plan.options.minAgeMinutes, pins: plan.options.pins, pinned_runs: plan.pinned_runs },
    reports: plan.reports,
    kept_by: plan.kept_by,
    archives: { sidecars_delete: plan.archives.sidecars.length, zips_delete: plan.archives.zips.length },
    snapshots: { total: plan.snapshots.total, keep: plan.snapshots.keep, delete: plan.snapshots.delete.length, orphan: plan.snapshots.orphan, orphan_bytes: plan.snapshots.orphan_bytes },
    bytes: plan.bytes,
    specs: plan.specs,
  };
}
