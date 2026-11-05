/**
 * #222: `verify prune` — retention for `$YGL_HOME/verify/` (reports, archive sidecars and zips, retained snapshots).
 *
 * Every `verify run` leaves a report, an archive and a retained snapshot that used to stay forever; verifier homes
 * reached tens of GiB, mostly self-check injection runs. Prune keeps the runs that carry evidence and drops the rest:
 *
 *   recent      the newest N reports of each spec (--keep-last, default 10)
 *   flip        both sides of the last F changes of `overall` per spec (--keep-flips, default 10; 0 = none)
 *   first       the first report of each spec_version
 *   pinned      a run id named anywhere in a --keep-runs-in file or folder (any file type, binary included), a
 *               graduation record, a tree report, an unreadable report, or the registry's verifier_runs
 *   cited       named by the retained snapshot of a run that is kept (an aggregate's children), transitively
 *   young       finished less than M minutes ago (--min-age-minutes, default 60) — protects runs in flight
 *   unreadable  a report that cannot be parsed is never deleted
 *
 * The default is a dry run that changes no file. `--apply` deletes, per pruned run, the archive zips its sidecar lists
 * inside `archives/`, then the sidecar, then the report (an interrupted apply leaves a plain unarchived report that the
 * next prune still sees), and last the retained snapshots no remaining report references — re-read after the report
 * deletions, so a report that could not be deleted keeps its snapshot. A zip is deleted only when its real path (links
 * and junctions resolved) lies inside `archives/` and no other surviving sidecar lists it. Orphan snapshots are counted,
 * never deleted. Every usage check runs before any verify-root I/O (#175 ordering), and the command runs before the CLI
 * boots a workspace: no database is opened or migrated; the registry's run ids are read from the SQLite file read-only.
 *
 * `--repo <verifier-repo>` (repeatable) points prune at verifier repositories that follow the fleet layout
 * (`state/home/verify`, `work/results/latest.json` with contract ygl-verifier-latest/1, optional `ledger/`), so any
 * node can clean every verifier it hosts with one command. For each repo the pins come from the whole repository —
 * every file of any type outside `state/`, `.git/` and `node_modules/` (a ledger kept as SQL or a database counts) —
 * except the self-check working copies under `work/` (`selfcheck-*`) and the self-check history
 * (`work/results/selfcheck-<case>--run_<id>.json`, one per run), which keeps its newest file per case. The repo's own
 * workspace database is never opened.
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Ctx } from "../../../core/database/src/types";
import { bad, C, head, out, paint, table } from "../../../core/text/src/fmt";
import { dropFromListIndex } from "./verify-list-index";

export const PRUNE_FLAGS = ["keep-last", "keep-flips", "keep-runs-in", "min-age-minutes", "repo", "apply"];
export const USAGE_PRUNE = "usage: verify prune [--repo <verifier-repo>]... [--keep-last N] [--keep-flips N] [--keep-runs-in <file|dir>]... [--min-age-minutes M] [--apply]";
export const PRUNE_DEFAULTS = { keepLast: 10, keepFlips: 10, minAgeMinutes: 60 };
export const KEEP_REASONS = ["recent", "flip", "first", "pinned", "cited", "young", "unreadable"] as const;
export type KeepReason = (typeof KEEP_REASONS)[number];

export interface PruneOptions {
  keepLast: number;
  keepFlips: number;
  minAgeMinutes: number;
  pins: string[];
  repos: string[];
  apply: boolean;
}

/** Self-check history written once per run; the newest per case is kept. */
const SELFCHECK_HISTORY = /^selfcheck-(.+)--run_[0-9a-f]{12,64}\.json$/;

const RUN_TOKEN = /run_[0-9a-f]{12,64}/g;
const SHA_TOKEN = /[0-9a-f]{64}/g;
/** Directories a pin walk never enters, wherever they sit. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const CHUNK = 8 * 1024 * 1024;

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
  for (const repo of list(flags.repo)) {
    if (typeof repo !== "string" || !repo.trim()) return `--repo needs a verifier repository path — ${USAGE_PRUNE}`;
    for (const part of [["state", "home", "verify"], ["work", "results", "latest.json"]]) {
      if (!existsSync(join(repo, ...part))) return `--repo ${repo} is not a verifier repository: ${part.join("/")} is missing`;
    }
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
    repos: list(flags.repo).map((p) => resolve(String(p))),
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
  /** Files and folders scanned for pins beyond --keep-runs-in (a repo's results and ledger). */
  pin_paths: number;
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

/** Every run id a text names, plus the 16- and 12-hex prefixes of each token: an id glued to more hex (a binary
 *  neighbour, a longer token) is still that id. Over-pinning is harmless; a missed pin deletes evidence. */
function addRunTokens(text: string, into: Set<string>): void {
  for (const m of text.matchAll(RUN_TOKEN)) {
    into.add(m[0]);
    into.add(m[0].slice(0, 20));
    into.add(m[0].slice(0, 16));
  }
}

/** Scan one file of any type and size for run ids: bytes read as latin1 in chunks (ids inside SQLite ledgers and
 *  zips count), with an overlap so a token split across chunks is still seen. */
export function scanFileForRunIds(file: string, into: Set<string>): void {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return;
  }
  try {
    const buf = Buffer.alloc(CHUNK);
    let carry = "";
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      const text = carry + buf.toString("latin1", 0, n);
      addRunTokens(text, into);
      carry = text.slice(-80);
    }
  } finally {
    closeSync(fd);
  }
}

/** Every run id named in the given files and folders (recursively, any file type, symlinks followed once).
 *  `skip` leaves out paths the caller knows are not evidence (the verify root itself, self-check working copies). */
export function pinnedRunIds(paths: string[], into = new Set<string>(), skip: (path: string) => boolean = () => false): Set<string> {
  const seen = new Set<string>();
  const visit = (p: string) => {
    if (skip(p)) return;
    let real: string;
    let st;
    try {
      real = realpathSync(p);
      st = statSync(real);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    if (st.isFile()) return scanFileForRunIds(real, into);
    if (!st.isDirectory()) return;
    for (const name of readdirSync(real)) if (!SKIP_DIRS.has(name)) visit(join(p, name));
  };
  for (const p of paths) visit(p);
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

/** True when `file` exists and its real path (symlinks and junctions resolved) lies inside the real `dirReal`. */
function realInside(dirReal: string, file: string): boolean {
  try {
    const rel = relative(dirReal, realpathSync(file));
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/** The zips a sidecar lists, kept only when their real path lies inside `archives/` (a sidecar written on another
 *  machine falls back to its file name there; a zip written with `archive --out` elsewhere, or reached through a link
 *  or junction that leaves `archives/`, is never touched). */
function sidecarZips(archives: string, archivesReal: string, sidecar: string): string[] {
  let entries: any[] = [];
  try {
    entries = JSON.parse(readFileSync(sidecar, "utf8"))?.archives ?? [];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const a of Array.isArray(entries) ? entries : []) {
    for (const cand of [String(a?.path ?? ""), join(archives, basename(String(a?.filename ?? "")))]) {
      if (!cand) continue;
      const abs = resolve(cand);
      if (archivesReal && realInside(archivesReal, abs)) {
        out.push(realpathSync(abs));
        break;
      }
    }
  }
  return out;
}

/** Decide what prune keeps and deletes. Reads only; `extraPins` carries run ids from outside the verify root
 *  (the registry's verifier_runs); `skip` leaves paths out of the pin walk. */
export function planPrune(root: string, options: PruneOptions, extraPins: Iterable<string> = [], now = Date.now(), pinPaths: string[] = [], skip?: (path: string) => boolean): PrunePlan {
  const reportsDir = join(root, "reports");
  const archives = join(root, "archives");
  const snapsDir = join(root, "snapshots");

  const pins = pinnedRunIds([...options.pins, ...pinPaths], new Set(extraPins), skip);
  const keptShas = new Set<string>();
  for (const dir of ["graduations", "tree-reports"]) {
    for (const n of names(join(root, dir)).filter((f) => f.endsWith(".json"))) {
      const text = readFileSync(join(root, dir, n), "utf8");
      addRunTokens(text, pins);
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
  const byId = new Map<string, RunRecord>();
  let unreadable = 0;
  const youngBefore = now - options.minAgeMinutes * 60_000;
  for (const n of names(reportsDir).filter((f) => f.endsWith(".json"))) {
    const rec = readReport(join(reportsDir, n));
    if (!rec) {
      unreadable++;
      keep(basename(n, ".json"), "unreadable");
      // whatever an unreadable report names — runs or snapshots — stays
      try {
        const text = readFileSync(join(reportsDir, n), "latin1");
        addRunTokens(text, pins);
        for (const m of text.matchAll(SHA_TOKEN)) keptShas.add(m[0]);
      } catch {
        /* vanished between listing and reading */
      }
      continue;
    }
    all.push(rec);
    byId.set(rec.run_id, rec);
    if (!bySpec.has(rec.spec_id)) bySpec.set(rec.spec_id, []);
    bySpec.get(rec.spec_id)!.push(rec);
    if (rec.at > youngBefore) keep(rec.run_id, "young");
  }
  for (const rec of all) if (pins.has(rec.run_id)) keep(rec.run_id, "pinned");

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

  // cited: a kept run's retained snapshot names the runs it aggregates; keep them, and what they cite, transitively
  const scanned = new Set<string>();
  const queue = all.filter((r) => reasons.has(r.run_id));
  while (queue.length) {
    const r = queue.pop()!;
    if (!r.snapshot || scanned.has(r.snapshot)) continue;
    scanned.add(r.snapshot);
    const cited = new Set<string>();
    for (const f of [join(snapsDir, `${r.snapshot}.sqlite`), join(snapsDir, `${r.snapshot.slice(0, 12)}.sqlite`)]) if (existsSync(f)) scanFileForRunIds(f, cited);
    for (const id of cited) {
      const child = byId.get(id);
      if (!child || reasons.has(id)) continue;
      keep(id, "cited");
      queue.push(child);
    }
  }

  const doomed = all.filter((r) => !reasons.has(r.run_id)).sort((a, b) => a.at - b.at || a.run_id.localeCompare(b.run_id));
  const doomedIds = new Set(doomed.map((r) => r.run_id));
  for (const r of all) if (!doomedIds.has(r.run_id) && r.snapshot) keptShas.add(r.snapshot);

  // a zip stays while any surviving sidecar lists it — kept, unreadable and orphan runs alike
  let archivesReal = "";
  try {
    archivesReal = realpathSync(archives);
  } catch {
    /* no archives folder */
  }
  const keptZips = new Set<string>();
  const sidecars: string[] = [];
  const zips = new Set<string>();
  const doomedSidecars: string[] = [];
  for (const n of names(archives).filter((f) => f.endsWith(".json"))) {
    const id = basename(n, ".json");
    if (doomedIds.has(id)) doomedSidecars.push(join(archives, n));
    else for (const z of sidecarZips(archives, archivesReal, join(archives, n))) keptZips.add(z);
  }
  for (const side of doomedSidecars) {
    sidecars.push(side);
    for (const z of sidecarZips(archives, archivesReal, side)) if (!keptZips.has(z)) zips.add(z);
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
    pin_paths: pinPaths.length,
    archives: { sidecars, zips: [...zips] },
    snapshots: { total: snapFiles.length, keep: snapFiles.length - delSnaps.length - orphan, delete: delSnaps, orphan, orphan_bytes: orphanBytes },
    bytes,
    specs,
    delete: doomed.map((r) => r.run_id),
    keptShas,
  };
}

export interface PruneResult {
  deleted: { reports: number; sidecars: number; zips: number; snapshots: number; selfcheck_history: number };
  failed: string[];
  log: string;
}

/** Carry out a plan. Reports that appeared after planning are never touched, and the snapshots they name stay. */
export function applyPrune(plan: PrunePlan, dropFromIndex: (runIds: string[]) => void, history?: HistoryPlan, now = new Date()): PruneResult {
  const { root } = plan;
  const reportsDir = join(root, "reports");
  const deleted = { reports: 0, sidecars: 0, zips: 0, snapshots: 0, selfcheck_history: 0 };
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
  // snapshots go only when no report left on disk names them — read after the deletions, so a report that could not
  // be deleted (or arrived after planning) keeps its snapshot and a rerun picks up where this one stopped
  const keptShas = new Set(plan.keptShas);
  for (const n of names(reportsDir).filter((f) => f.endsWith(".json"))) {
    const rec = readReport(join(reportsDir, n));
    if (rec?.snapshot) keptShas.add(rec.snapshot);
    else if (!rec)
      try {
        for (const m of readFileSync(join(reportsDir, n), "latin1").matchAll(SHA_TOKEN)) keptShas.add(m[0]);
      } catch {
        /* vanished */
      }
  }
  const keptShort = new Set([...keptShas].map((s) => s.slice(0, 12)));
  for (const f of plan.snapshots.delete) {
    const stem = basename(f, ".sqlite");
    if (stem.length === 64 ? keptShas.has(stem) : keptShort.has(stem)) continue;
    if (rm(f)) deleted.snapshots++;
  }
  for (const f of history?.delete ?? []) if (rm(f)) deleted.selfcheck_history++;
  dropFromIndex(gone);
  const log = join(root, "prune-log.jsonl");
  appendFileSync(log, JSON.stringify({
    at: now.toISOString(),
    policy: { keep_last: plan.options.keepLast, keep_flips: plan.options.keepFlips, min_age_minutes: plan.options.minAgeMinutes, pins: plan.options.pins },
    deleted,
    bytes: plan.bytes.total + (history?.bytes ?? 0),
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
    policy: { keep_last: plan.options.keepLast, keep_flips: plan.options.keepFlips, min_age_minutes: plan.options.minAgeMinutes, pins: plan.options.pins, pin_paths: plan.pin_paths, pinned_runs: plan.pinned_runs },
    reports: plan.reports,
    kept_by: plan.kept_by,
    archives: { sidecars_delete: plan.archives.sidecars.length, zips_delete: plan.archives.zips.length },
    snapshots: { total: plan.snapshots.total, keep: plan.snapshots.keep, delete: plan.snapshots.delete.length, orphan: plan.snapshots.orphan, orphan_bytes: plan.snapshots.orphan_bytes },
    bytes: plan.bytes,
    specs: plan.specs,
  };
}

export interface RepoTarget {
  repo: string;
  /** The repo's verify root, `state/home/verify`. */
  root: string;
  /** Pin sources: the whole repository, filtered by `skip`. */
  pinPaths: string[];
  /** Leaves out `state/` (the verify root itself), self-check working copies under `work/` and the self-check history. */
  skip: (path: string) => boolean;
}

/** The fleet layout of a verifier repository (contract ygl-verifier-latest/1). Throws when latest.json says otherwise. */
export function repoTarget(repo: string): RepoTarget {
  const results = join(repo, "work", "results");
  let contract: unknown;
  try {
    contract = JSON.parse(readFileSync(join(results, "latest.json"), "utf8"))?.contract;
  } catch (e: any) {
    throw new Error(`${repo}: work/results/latest.json is unreadable (${e?.message || e})`);
  }
  if (contract !== "ygl-verifier-latest/1") throw new Error(`${repo}: work/results/latest.json is not ygl-verifier-latest/1 (contract ${JSON.stringify(contract)})`);
  const state = join(repo, "state");
  const work = join(repo, "work") + sep;
  const skip = (p: string) => {
    if (p === state) return true;
    if (!p.startsWith(work)) return false;
    const name = basename(p);
    // self-check rounds write their raw/snap/results under selfcheck-*; the per-case latest file and the fixture
    // summary in results are files, kept as pins unless they are history (one file per run)
    return SELFCHECK_HISTORY.test(name) || (name.startsWith("selfcheck-") && !name.endsWith(".json"));
  };
  return { repo, root: join(repo, "state", "home", "verify"), pinPaths: [repo], skip };
}

export interface HistoryPlan {
  total: number;
  keep: number;
  delete: string[];
  bytes: number;
}

/** Self-check history in `work/results`: keep the newest file of each case, list the rest. */
export function planSelfcheckHistory(repo: string): HistoryPlan {
  const results = join(repo, "work", "results");
  const byCase = new Map<string, Array<{ file: string; mtime: number }>>();
  for (const n of names(results)) {
    const m = SELFCHECK_HISTORY.exec(n);
    if (!m) continue;
    const file = join(results, n);
    let mtime: number;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (!byCase.has(m[1])) byCase.set(m[1], []);
    byCase.get(m[1])!.push({ file, mtime });
  }
  const del: string[] = [];
  let total = 0;
  for (const files of byCase.values()) {
    total += files.length;
    files.sort((a, b) => b.mtime - a.mtime || b.file.localeCompare(a.file));
    for (const f of files.slice(1)) del.push(f.file);
  }
  return { total, keep: total - del.length, delete: del, bytes: del.reduce((n, f) => n + size(f), 0) };
}

/** The registry's run ids, read from the workspace SQLite file read-only (never migrated). A missing file or a
 *  workspace without the registry table pins nothing; a file that exists but cannot be read is an error, never a
 *  silent "no pins". */
export function registryPins(home: string): string[] {
  const file = join(home, "ygl-trees.db");
  if (!existsSync(file) || statSync(file).size === 0) return [];
  // @ts-ignore — existing runtime dependency has no in-repo type declarations.
  const Sqlite = require("better-sqlite3");
  let db: any;
  try {
    db = new Sqlite(file, { readonly: true, fileMustExist: true });
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='verifier_runs'").get();
    return has ? db.prepare("SELECT id FROM verifier_runs").all().map((r: any) => String(r.id)) : [];
  } catch (e: any) {
    throw new Error(`cannot read the registry's run ids from ${file} (read-only): ${e?.message || e}`);
  } finally {
    db?.close();
  }
}

const gib = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`);

/** `verify prune` (#222). Runs before the CLI boots a workspace: no database is opened, created or migrated. Without
 *  --repo it prunes `<home>/verify` and pins the registry's run ids; with --repo it prunes each verifier repository,
 *  planning every target before anything is deleted. A dry run unless --apply. */
export function runPruneCommand(ctx: Ctx, home: string, rest: string[], flags: Record<string, unknown>): number {
  const usage = rest.length ? `verify prune takes no positional arguments (got ${rest.join(" ")})` : prunePreflight(flags);
  if (usage) {
    bad(ctx, usage);
    return 2;
  }
  const opts = parsePruneOptions(flags);
  type Target = { repo: string | null; plan: PrunePlan; history: HistoryPlan | null };
  const targets: Target[] = [];
  try {
    if (!opts.repos.length) targets.push({ repo: null, plan: planPrune(join(home, "verify"), opts, registryPins(home)), history: null });
    for (const repo of opts.repos) {
      const t = repoTarget(repo);
      targets.push({ repo, plan: planPrune(t.root, opts, [], Date.now(), t.pinPaths, t.skip), history: planSelfcheckHistory(repo) });
    }
  } catch (e: any) {
    bad(ctx, `verify prune: ${e?.message || e}`);
    return 1;
  }
  const rows = targets.map((t) => {
    const view = planView(t.plan);
    const history = t.history ? { total: t.history.total, keep: t.history.keep, delete: t.history.delete.length, bytes: t.history.bytes } : null;
    const result = opts.apply ? applyPrune(t.plan, (ids) => dropFromListIndex(t.plan.root, ids), t.history ?? undefined) : null;
    return { repo: t.repo, view, history, result, bytes: view.bytes.total + (history?.bytes ?? 0) };
  });
  const failed = rows.some((r) => r.result?.failed.length);
  const face = (r: (typeof rows)[number]) => ({
    ...(r.repo ? { repo: r.repo } : {}),
    ...r.view,
    ...(r.history ? { selfcheck_history: r.history } : {}),
    ...(r.result ? { deleted: r.result.deleted, failed: r.result.failed, log: r.result.log } : {}),
  });
  if (ctx.json) {
    const body = opts.repos.length ? { apply: opts.apply, repos: rows.map(face), bytes_total: rows.reduce((n, r) => n + r.bytes, 0) } : { apply: opts.apply, ...face(rows[0]) };
    console.log(JSON.stringify(body, null, 2));
    return failed ? 1 : 0;
  }
  head(ctx, opts.apply ? "Verify prune — applied" : "Verify prune — dry run (nothing deleted; pass --apply to delete)");
  for (const { repo, view, history, result } of rows) {
    const k = view.kept_by;
    if (repo) out(ctx, paint(C.bold, `  ${repo}`, ctx.color));
    out(ctx, `  root       ${view.root}`);
    out(ctx, `  reports    ${view.reports.total} total · keep ${view.reports.keep} · delete ${view.reports.delete}${view.reports.unreadable ? ` · unreadable ${view.reports.unreadable}` : ""}`);
    out(ctx, `  kept by    recent ${k.recent} · flip ${k.flip} · first ${k.first} · pinned ${k.pinned} (${view.policy.pinned_runs} pinned ids) · cited ${k.cited} · young ${k.young}`);
    out(ctx, `  archives   delete ${view.archives.sidecars_delete} sidecars · ${view.archives.zips_delete} zips`);
    out(ctx, `  snapshots  ${view.snapshots.total} total · keep ${view.snapshots.keep} · delete ${view.snapshots.delete}${view.snapshots.orphan ? ` · orphan ${view.snapshots.orphan} (${gib(view.snapshots.orphan_bytes)}, kept)` : ""}`);
    if (history) out(ctx, `  self-check history  ${history.total} files · keep ${history.keep} (newest per case) · delete ${history.delete} (${gib(history.bytes)})`);
    out(ctx, `  ${opts.apply ? "freed" : "frees"}      ${gib(view.bytes.total + (history?.bytes ?? 0))} (reports ${gib(view.bytes.reports)} · archives ${gib(view.bytes.archives)} · snapshots ${gib(view.bytes.snapshots)}${history ? ` · self-check history ${gib(history.bytes)}` : ""})`);
    const specs = view.specs.filter((s) => s.delete).slice(0, repo ? 5 : 20);
    if (specs.length) table(ctx, specs, ["spec_id", "total", "keep", "delete", "oldest_deleted", "newest_deleted"], []);
    if (result) {
      out(ctx, `  deleted    ${result.deleted.reports} reports · ${result.deleted.sidecars} sidecars · ${result.deleted.zips} zips · ${result.deleted.snapshots} snapshots${history ? ` · ${result.deleted.selfcheck_history} self-check history files` : ""} — logged to ${result.log}`);
      for (const f of result.failed.slice(0, 10)) out(ctx, paint(C.red, `  ✗ ${f}`, ctx.color));
    }
  }
  if (rows.length > 1) out(ctx, `  total ${opts.apply ? "freed" : "frees"} ${gib(rows.reduce((n, r) => n + r.bytes, 0))} across ${rows.length} repositories`);
  return failed ? 1 : 0;
}
