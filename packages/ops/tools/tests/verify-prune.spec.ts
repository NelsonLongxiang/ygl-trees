/**
 * #222: `verify prune` keeps the runs that carry evidence (recent, verdict flips, first of each version, pinned,
 * young, unreadable) and drops the rest with their sidecars, zips and unshared snapshots. A dry run changes no file;
 * usage errors are rc=2 before the verify root is touched.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyPrune, parsePruneOptions, planPrune, prunePreflight, PRUNE_DEFAULTS, type PruneOptions } from "../src/verify-prune";
import { listIndexPath, prepareListIndex } from "../src/verify-list-index";
// @ts-ignore — existing runtime dependency has no in-repo type declarations.
import Sqlite from "better-sqlite3";

const ROOT = resolve(__dirname, "../../../..");
const BIN = join(ROOT, "dist/bundle/bin.cjs");
const NOW = Date.parse("2026-11-05T00:00:00Z");
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const rid = (n: number) => "run_" + n.toString(16).padStart(16, "0");
const sha = (n: number) => createHash("sha256").update(String(n)).digest("hex");
const day = (d: number, h = 0) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
const opts = (o: Partial<PruneOptions> = {}): PruneOptions => ({ ...PRUNE_DEFAULTS, pins: [], apply: false, ...o });

function home(): string {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const h = mkdtempSync(join(ROOT, "tmp/verify-prune-"));
  made.push(h);
  for (const d of ["reports", "archives", "snapshots"]) mkdirSync(join(h, "verify", d), { recursive: true });
  return h;
}

/** One run: report + retained snapshot + sidecar listing one zip (all inside the verify root). */
function addRun(root: string, n: number, spec: string, at: string, overall = "PASS", o: { ver?: number; snap?: string; zip?: boolean } = {}) {
  const id = rid(n);
  const snap = o.snap ?? sha(n);
  writeFileSync(join(root, "reports", `${id}.json`), JSON.stringify({ run_id: id, spec_id: spec, finished: at, overall, verifier: { spec_version: o.ver ?? 1 }, data_source: { kind: "sqlite-snapshot", sha256: "sha256:" + snap } }));
  writeFileSync(join(root, "snapshots", `${snap}.sqlite`), "snapshot-bytes");
  if (o.zip !== false) {
    const filename = `yglverify-${spec}-${id}.yglverify.zip`;
    writeFileSync(join(root, "archives", filename), "zip-bytes");
    writeFileSync(join(root, "archives", `${id}.json`), JSON.stringify({ run_id: id, spec_id: spec, spec_version: o.ver ?? 1, archives: [{ archive_id: "arc_" + n, filename, path: join(root, "archives", filename), created: at, with: ["materials"] }] }));
  }
  return id;
}

/** A series of runs of one spec, one per day from Oct 1, PASS unless listed in `fails`. */
function series(root: string, spec: string, from: number, count: number, fails: number[] = []) {
  return Array.from({ length: count }, (_, i) => addRun(root, from + i, spec, day(1 + i), fails.includes(i) ? "FAIL" : "PASS"));
}

const tree = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) (out.push(`${p}/`), walk(p));
      else {
        const s = statSync(p);
        out.push(`${p}|${s.size}|${s.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out;
};

describe("verify prune — keep rules", () => {
  it("recent: keeps the newest N per spec and deletes the rest with sidecar, zip and snapshot", () => {
    const v = join(home(), "verify");
    const ids = series(v, "spec_a", 1, 15);
    const plan = planPrune(v, opts({ keepFlips: 0 }), [], NOW);
    // first-of-version keeps run 1; recent keeps the last 10
    expect(plan.delete).toEqual(ids.slice(1, 5));
    expect(plan.archives.sidecars).toHaveLength(4);
    expect(plan.archives.zips).toHaveLength(4);
    expect(plan.snapshots.delete).toHaveLength(4);
    expect(plan.kept_by).toMatchObject({ recent: 10, first: 1, flip: 0, pinned: 0, young: 0, unreadable: 0 });
    const r = applyPrune(plan, () => {});
    expect(r.deleted).toEqual({ reports: 4, sidecars: 4, zips: 4, snapshots: 4 });
    expect(readdirSync(join(v, "reports"))).toHaveLength(11);
    for (const id of ids.slice(1, 5)) {
      expect(existsSync(join(v, "reports", `${id}.json`))).toBe(false);
      expect(existsSync(join(v, "archives", `${id}.json`))).toBe(false);
    }
  });

  it("flip: keeps both sides of the last F verdict changes, and --keep-flips 0 turns that off", () => {
    const v = join(home(), "verify");
    const ids = series(v, "spec_f", 1, 20, [3]); // PASS…PASS FAIL(3) PASS… → flips at 3 and 4
    const gone = new Set(planPrune(v, opts({ keepLast: 1 }), [], NOW).delete);
    for (const i of [2, 3, 4]) expect(gone.has(ids[i]), `run ${i}`).toBe(false);
    expect(gone.has(ids[5])).toBe(true);
    const off = new Set(planPrune(v, opts({ keepLast: 1, keepFlips: 0 }), [], NOW).delete);
    for (const i of [2, 3, 4]) expect(off.has(ids[i])).toBe(true);
    // only the last F flips count
    const one = new Set(planPrune(v, opts({ keepLast: 1, keepFlips: 1 }), [], NOW).delete);
    expect(one.has(ids[2])).toBe(true);
    expect(one.has(ids[3]) || one.has(ids[4])).toBe(false);
  });

  it("first: keeps the first report of every spec_version", () => {
    const v = join(home(), "verify");
    const a = addRun(v, 1, "spec_v", day(1), "PASS", { ver: 1 });
    const b = addRun(v, 2, "spec_v", day(2), "PASS", { ver: 1 });
    const c = addRun(v, 3, "spec_v", day(3), "PASS", { ver: 2 });
    const d = addRun(v, 4, "spec_v", day(4), "PASS", { ver: 2 });
    addRun(v, 5, "spec_v", day(5), "PASS", { ver: 2 });
    const plan = planPrune(v, opts({ keepLast: 1, keepFlips: 0 }), [], NOW);
    expect(plan.delete).toEqual([b, d]);
    expect(plan.delete).not.toContain(a);
    expect(plan.delete).not.toContain(c);
  });

  it("pinned: run ids named in a pin file, a pin folder, a graduation, a tree report or the registry are kept", () => {
    const h = home();
    const v = join(h, "verify");
    const ids = series(v, "spec_p", 1, 12);
    const pinFile = join(h, "latest.json");
    writeFileSync(pinFile, JSON.stringify({ root_run_id: ids[1] }));
    mkdirSync(join(h, "results", "deep"), { recursive: true });
    writeFileSync(join(h, "results", "deep", "round.json"), `{"root_run_id":"${ids[2]}","tree":["${ids[3]}"]}`);
    writeFileSync(join(h, "results", "skip.bin"), ids[4]); // not a text extension inside a folder
    mkdirSync(join(v, "graduations"));
    writeFileSync(join(v, "graduations", "spec_p.json"), JSON.stringify({ run_ids: [ids[5]] }));
    mkdirSync(join(v, "tree-reports"));
    writeFileSync(join(v, "tree-reports", "tr_x.json"), JSON.stringify({ nodes: [{ run_id: ids[6] }] }));
    const plan = planPrune(v, opts({ keepLast: 1, keepFlips: 0, pins: [pinFile, join(h, "results")] }), [ids[7]], NOW);
    const gone = new Set(plan.delete);
    for (const i of [1, 2, 3, 5, 6, 7]) expect(gone.has(ids[i]), `pinned run ${i}`).toBe(false);
    expect(gone.has(ids[4])).toBe(true);
    expect(gone.has(ids[8])).toBe(true);
    expect(plan.kept_by.pinned).toBe(6);
  });

  it("young: runs that finished within --min-age-minutes stay, so a probe in flight is never cut", () => {
    const v = join(home(), "verify");
    const old = addRun(v, 1, "spec_y", day(1));
    addRun(v, 2, "spec_y", day(2));
    const fresh = addRun(v, 3, "spec_y", new Date(NOW - 30 * 60_000).toISOString());
    addRun(v, 4, "spec_y", new Date(NOW - 5 * 60_000).toISOString());
    const plan = planPrune(v, opts({ keepLast: 1, keepFlips: 0, minAgeMinutes: 60 }), [], NOW);
    expect(plan.delete).toEqual([rid(2)]);
    expect(plan.delete).not.toContain(fresh);
    expect(plan.delete).not.toContain(old); // first of version
    expect(planPrune(v, opts({ keepLast: 1, keepFlips: 0, minAgeMinutes: 0 }), [], NOW).delete).toEqual([rid(2), fresh]);
  });

  it("unreadable: a report that does not parse, or names another run, is never deleted and its shas stay", () => {
    const v = join(home(), "verify");
    series(v, "spec_u", 1, 3);
    writeFileSync(join(v, "reports", `${rid(50)}.json`), `{"run_id":"${rid(50)}", broken ${sha(2)}`);
    writeFileSync(join(v, "reports", `${rid(51)}.json`), JSON.stringify({ run_id: rid(99), spec_id: "spec_u" }));
    const plan = planPrune(v, opts({ keepLast: 1, keepFlips: 0 }), [], NOW);
    expect(plan.reports.unreadable).toBe(2);
    expect(plan.kept_by.unreadable).toBe(2);
    expect(plan.delete).toEqual([rid(2)]);
    // run 2's snapshot is named by the unreadable report, so it stays
    expect(plan.snapshots.delete).toEqual([]);
  });
});

describe("verify prune — what it deletes", () => {
  it("a snapshot shared with a kept run survives; one used only by pruned runs goes; an orphan is counted, never deleted", () => {
    const v = join(home(), "verify");
    const shared = sha(900);
    addRun(v, 1, "spec_s", day(1), "PASS", { snap: sha(901) });
    addRun(v, 2, "spec_s", day(2), "PASS", { snap: shared });
    addRun(v, 3, "spec_s", day(3), "PASS", { snap: sha(903) });
    addRun(v, 4, "spec_s", day(4), "PASS", { snap: shared });
    writeFileSync(join(v, "snapshots", `${sha(999)}.sqlite`), "orphan");
    const plan = planPrune(v, opts({ keepLast: 1, keepFlips: 0 }), [], NOW);
    expect(plan.delete).toEqual([rid(2), rid(3)]);
    expect(plan.snapshots.delete.map((f) => f.slice(-71, -7))).toEqual([sha(903)]);
    expect(plan.snapshots.orphan).toBe(1);
    applyPrune(plan, () => {});
    expect(existsSync(join(v, "snapshots", `${shared}.sqlite`))).toBe(true);
    expect(existsSync(join(v, "snapshots", `${sha(903)}.sqlite`))).toBe(false);
    expect(existsSync(join(v, "snapshots", `${sha(999)}.sqlite`))).toBe(true);
  });

  it("legacy 12-hex snapshot names are matched to their report and pruned or kept the same way", () => {
    const v = join(home(), "verify");
    addRun(v, 1, "spec_l", day(1));
    const id2 = addRun(v, 2, "spec_l", day(2), "PASS", { snap: sha(702) });
    addRun(v, 3, "spec_l", day(3), "PASS", { snap: sha(703) });
    for (const n of [702, 703]) renameSync(join(v, "snapshots", `${sha(n)}.sqlite`), join(v, "snapshots", `${sha(n).slice(0, 12)}.sqlite`));
    const plan = planPrune(v, opts({ keepLast: 1, keepFlips: 0 }), [], NOW);
    expect(plan.delete).toEqual([id2]);
    expect(plan.snapshots.orphan).toBe(0);
    applyPrune(plan, () => {});
    expect(existsSync(join(v, "snapshots", `${sha(702).slice(0, 12)}.sqlite`))).toBe(false);
    expect(existsSync(join(v, "snapshots", `${sha(703).slice(0, 12)}.sqlite`))).toBe(true);
  });

  it("only zips inside archives/ are touched, and a zip a kept sidecar also lists stays", () => {
    const h = home();
    const v = join(h, "verify");
    addRun(v, 1, "spec_z", day(1));
    const outside = join(h, "elsewhere.zip");
    writeFileSync(outside, "zip");
    const sharedZip = join(v, "archives", "shared.yglverify.zip");
    writeFileSync(sharedZip, "zip");
    const id2 = addRun(v, 2, "spec_z", day(2), "PASS", { zip: false });
    writeFileSync(join(v, "archives", `${id2}.json`), JSON.stringify({ run_id: id2, archives: [{ filename: "x.zip", path: outside }, { filename: "shared.yglverify.zip", path: sharedZip }] }));
    const id3 = addRun(v, 3, "spec_z", day(3), "PASS", { zip: false });
    writeFileSync(join(v, "archives", `${id3}.json`), JSON.stringify({ run_id: id3, archives: [{ filename: "shared.yglverify.zip", path: "/Users/someone-else/old-home/verify/archives/shared.yglverify.zip" }] }));
    const plan = planPrune(v, opts({ keepLast: 1, keepFlips: 0 }), [], NOW);
    expect(plan.delete).toEqual([id2]);
    expect(plan.archives.zips).toEqual([]);
    applyPrune(plan, () => {});
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(sharedZip)).toBe(true);
  });

  it("a report written after planning is never deleted and keeps its snapshot", () => {
    const v = join(home(), "verify");
    series(v, "spec_r", 1, 3);
    const plan = planPrune(v, opts({ keepLast: 1, keepFlips: 0 }), [], NOW);
    expect(plan.delete).toEqual([rid(2)]);
    // a new run lands between plan and apply and reuses run 2's snapshot
    writeFileSync(join(v, "reports", `${rid(60)}.json`), JSON.stringify({ run_id: rid(60), spec_id: "spec_r", finished: day(20), overall: "PASS", data_source: { sha256: "sha256:" + sha(2) } }));
    const r = applyPrune(plan, () => {});
    expect(r.deleted.reports).toBe(1);
    expect(r.deleted.snapshots).toBe(0);
    expect(existsSync(join(v, "snapshots", `${sha(2)}.sqlite`))).toBe(true);
  });

  it("apply drops pruned runs from the list index and appends exactly one log line", async () => {
    const h = home();
    const v = join(h, "verify");
    const ids = series(v, "spec_i", 1, 6);
    await prepareListIndex(h);
    const count = () => {
      const db = new Sqlite(listIndexPath(v), { readonly: true });
      try {
        return { reports: db.prepare("SELECT COUNT(*) n FROM reports").get().n, archives: db.prepare("SELECT COUNT(*) n FROM archives").get().n };
      } finally {
        db.close();
      }
    };
    expect(count()).toEqual({ reports: 6, archives: 6 });
    const plan = planPrune(v, opts({ keepLast: 2, keepFlips: 0 }), [], NOW);
    expect(plan.delete).toEqual(ids.slice(1, 4));
    const { dropFromListIndex } = await import("../src/verify-list-index");
    const r = applyPrune(plan, (gone) => dropFromListIndex(v, gone));
    expect(count()).toEqual({ reports: 3, archives: 3 });
    const lines = readFileSync(r.log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ deleted: { reports: 3, sidecars: 3, zips: 3, snapshots: 3 }, failed: 0, specs: [{ spec_id: "spec_i", deleted: 3 }] });
    expect(entry.run_ids_sha256).toMatch(/^[0-9a-f]{64}$/);
    // a reconcile afterwards finds nothing new to drop
    await prepareListIndex(h);
    expect(count()).toEqual({ reports: 3, archives: 3 });
  });
});

describe("verify prune — usage and CLI", () => {
  it("preflight names usage problems; parse applies the defaults", () => {
    for (const [flags, re] of [
      [{ "keep-last": "abc" }, /--keep-last needs an integer ≥ 1/],
      [{ "keep-last": "0" }, /--keep-last needs an integer ≥ 1/],
      [{ "keep-last": true }, /--keep-last needs an integer/],
      [{ "keep-flips": "-1" }, /--keep-flips needs an integer ≥ 0/],
      [{ "min-age-minutes": "1.5" }, /--min-age-minutes needs an integer/],
      [{ apply: "yes" }, /--apply takes no value/],
      [{ "keep-runs-in": true }, /--keep-runs-in needs a file or folder path/],
      [{ "keep-runs-in": join(ROOT, "tmp", "no-such-pin-file.json") }, /--keep-runs-in path not found/],
    ] as Array<[Record<string, unknown>, RegExp]>) expect(prunePreflight(flags), JSON.stringify(flags)).toMatch(re);
    expect(prunePreflight({ "keep-flips": "0", "min-age-minutes": "0", apply: true })).toBeNull();
    expect(parsePruneOptions({})).toEqual({ keepLast: 10, keepFlips: 10, minAgeMinutes: 60, pins: [], apply: false });
  });

  it("usage errors are rc=2 with one JSON object, before the verify root is created", () => {
    const h = join(ROOT, "tmp", `verify-prune-absent-${process.pid}`);
    rmSync(h, { recursive: true, force: true });
    for (const argv of [["--keep-last", "0"], ["--bogus"], ["extra"], ["--keep-runs-in", join(h, "missing.json")]]) {
      const r = spawnSync(process.execPath, [BIN, "verify", "prune", ...argv, "--json"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, YGL_HOME: h, YGL_DB_URL: "", YGL_NO_UPDATE_CHECK: "1" } });
      expect(r.status, argv.join(" ") + r.stdout + r.stderr).toBe(2);
      expect(Object.keys(JSON.parse(r.stdout))).toEqual(["error"]);
      expect(existsSync(join(h, "verify"))).toBe(false);
    }
  });

  it("a dry run changes no file or folder; --apply deletes and reports the same plan", () => {
    const h = home();
    const env = { ...process.env, YGL_HOME: h, YGL_DB_URL: "", YGL_NO_UPDATE_CHECK: "1" };
    expect(spawnSync(process.execPath, [BIN, "db", "init", "--json"], { cwd: ROOT, encoding: "utf8", env }).status).toBe(0);
    const v = join(h, "verify");
    for (const d of ["reports", "archives", "snapshots"]) mkdirSync(join(v, d), { recursive: true });
    series(v, "spec_c", 1, 14, [6]);
    const before = tree(v);
    const dry = spawnSync(process.execPath, [BIN, "verify", "prune", "--keep-last", "5", "--json"], { cwd: ROOT, encoding: "utf8", env });
    expect(dry.status, dry.stdout + dry.stderr).toBe(0);
    const view = JSON.parse(dry.stdout);
    expect(view).toMatchObject({ apply: false, reports: { total: 14, delete: 5 }, archives: { sidecars_delete: 5, zips_delete: 5 }, snapshots: { delete: 5 } });
    expect(view.bytes.total).toBeGreaterThan(0);
    expect(tree(v)).toEqual(before);
    const applied = spawnSync(process.execPath, [BIN, "verify", "prune", "--keep-last", "5", "--apply", "--json"], { cwd: ROOT, encoding: "utf8", env });
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    const a = JSON.parse(applied.stdout);
    expect(a).toMatchObject({ apply: true, reports: { delete: 5 }, deleted: { reports: 5, sidecars: 5, zips: 5, snapshots: 5 }, failed: [] });
    expect(readdirSync(join(v, "reports"))).toHaveLength(9);
    const unarchived = spawnSync(process.execPath, [BIN, "verify", "list", "--unarchived", "--json"], { cwd: ROOT, encoding: "utf8", env });
    expect(JSON.parse(unarchived.stdout)).toEqual([]);
    const again = JSON.parse(spawnSync(process.execPath, [BIN, "verify", "prune", "--keep-last", "5", "--json"], { cwd: ROOT, encoding: "utf8", env }).stdout);
    expect(again.reports.delete).toBe(0);
  });
});
