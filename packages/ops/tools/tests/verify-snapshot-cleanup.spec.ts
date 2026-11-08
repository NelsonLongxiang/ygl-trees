import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * #228: verify run's working copy under <TEMP|TMPDIR>/ygl-verify-snapshots is
 * single-run scratch — it must be gone when the run is over (PASS, FAIL and
 * the throw path alike). The 7-day pruneSnapshots backstop and the
 * content-addressed retainSnapshot copy under $YGL_HOME/verify/snapshots/ are
 * NOT this test's subject and stay untouched.
 */
const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const EXAMPLE = join(REPO, "examples/verify-schema-snapshot");
const ROOT = join(REPO, "examples/verify-schema-snapshot");
const hasBundle = existsSync(BIN);
const home = hasBundle ? mkdtempSync(join(tmpdir(), "ygl-snap-clean-")) : "";
/** Fresh TEMP/TMPDIR pair: snapshotCopy prefers TEMP, so both must point here. */
const scratchTmp = hasBundle ? mkdtempSync(join(tmpdir(), "ygl-snap-tmp-")) : "";

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: home,
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: home, TEMP: scratchTmp, TMPDIR: scratchTmp, ...env },
  });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

const snapshotScratchDir = (): string => join(scratchTmp, "ygl-verify-snapshots");
const filesLeft = (): string[] => {
  const dir = snapshotScratchDir();
  return existsSync(dir) ? readdirSync(dir) : [];
};

/** Build one prepared spec + evidence db through the documented recipe. */
function preparedSpec(): { specId: string; db: string; producer: string } {
  const dir = mkdtempSync(join(home, "recipe-"));
  const input = join(dir, "source.sqlite");
  const db = new DatabaseSync(input);
  db.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL); PRAGMA user_version=7");
  db.close();
  const output = join(dir, "evidence.sqlite");
  const collector = spawnSync(process.execPath, [join(EXAMPLE, "collect.mjs"), input, output], { encoding: "utf8" });
  expect(collector.status, collector.stderr).toBe(0);
  const producer = join(dir, "producer.json");
  writeFileSync(producer, collector.stdout, "utf8");
  expect(run(["db", "init"]).rc).toBe(0);
  const submitted = JSON.parse(run(["verify", "submit", "--title", "snapshot cleanup", "--text", join(EXAMPLE, "material.md"), "--meta-repo", ROOT, "--json"]).out) as { material_id: string };
  const edb = new DatabaseSync(output, { readOnly: true });
  let asOf = "";
  try { asOf = String((edb.prepare("SELECT captured_at FROM collection_source").get() as any).captured_at); } finally { edb.close(); }
  const prepared = JSON.parse(run(["verify", "prepare", submitted.material_id, "--candidates", join(EXAMPLE, "candidates.json"), "--reviews", join(EXAMPLE, "reviews.json"), "--db", output, "--as-of", asOf, "--candidates-author", "snap-clean-test", "--reviews-author", "snap-clean-test", "--meta-repo", ROOT, "--json"]).out) as { verdict: string; spec_id: string };
  expect(prepared.verdict).toBe("ready");
  return { specId: prepared.spec_id, db: output, producer };
}

afterAll(() => {
  for (const d of [home, scratchTmp]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe.skipIf(!hasBundle)("verify run working-copy cleanup (#228)", () => {
  it("single run removes its snapshot copy on PASS, and a FAIL run does too", () => {
    const { specId, db, producer } = preparedSpec();
    const pass = JSON.parse(run(["verify", "run", specId, "--db", db, "--provenance", producer, "--json"]).out) as { overall: string };
    expect(pass.overall).toBe("PASS");
    expect(filesLeft(), "working copy must be gone after a PASS run").toEqual([]);

    const bad = db.replace("evidence.sqlite", "negative.sqlite");
    const ndb = new DatabaseSync(bad);
    ndb.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY)");
    ndb.close();
    const negInput = bad.replace("negative.sqlite", "negative-source.sqlite");
    require("node:fs").renameSync(bad, negInput);
    const negOut = bad.replace("negative.sqlite", "negative-evidence.sqlite");
    const collector = spawnSync(process.execPath, [join(EXAMPLE, "collect.mjs"), negInput, negOut], { encoding: "utf8" });
    expect(collector.status, collector.stderr).toBe(0);
    const fail = JSON.parse(run(["verify", "run", specId, "--db", negOut, "--provenance", producer, "--json"]).out) as { overall: string };
    expect(fail.overall).toBe("FAIL");
    expect(filesLeft(), "working copy must be gone after a FAIL run too").toEqual([]);
  }, 180000);

  it("the error path (spec missing) leaves no copy behind either", () => {
    const db = join(home, "err.sqlite");
    const edb = new DatabaseSync(db);
    edb.exec("CREATE TABLE t(x)");
    edb.close();
    const r = run(["verify", "run", "spec_nope228", "--db", db, "--json"]);
    expect(r.rc).toBe(1);
    expect(filesLeft(), "a run that errors before the engine still leaves no copy").toEqual([]);
  });

  it("tree run (group face) removes every working copy it made", () => {
    // Group face via the tree path: two leaves over one db. Build the smallest
    // tree spec through the CLI's own tree-spec acceptance (spec_id suffixed).
    const { specId, db } = preparedSpec();
    const treeSpecDir = join(home, "verify", "trees");
    const spec = {
      tree_spec_version: 1,
      tree_spec_id: "t_clean228",
      tree_spec_sha256: "sha256:" + "0".repeat(64),
      root: "n1",
      nodes: [
        { id: "n1", kind: "group", aggregate: "all", children: ["n2", "n3"] },
        { id: "n2", kind: "leaf", spec_id: specId },
        { id: "n3", kind: "leaf", spec_id: specId },
      ],
    };
    require("node:fs").mkdirSync(treeSpecDir, { recursive: true });
    writeFileSync(join(treeSpecDir, "t_clean228.json"), JSON.stringify(spec), "utf8");
    const r = run(["verify", "tree", "run", "t_clean228", "--db", "n2=" + db, "--db", "n3=" + db, "--json"]);
    expect(r.rc, r.out + r.err).toBe(0);
    expect(filesLeft(), "tree run drops every per-db working copy").toEqual([]);
  }, 180000);

  it("a WAL-mode source leaves no -shm/-wal sidecars behind (#228 full-suite caller)", () => {
    // The unlocated full-suite leftover: db snapshot output (WAL is a persistent
    // header property) used as --db. Read-only connections still create the
    // sidecars and a readonly closer never checkpoints them away — cleanup()
    // must remove the trio, not just the main file.
    const walDir = join(home, "wal-src");
    require("node:fs").mkdirSync(walDir, { recursive: true });
    const src = join(walDir, "wal-source.sqlite");
    const wdb = new DatabaseSync(src);
    wdb.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL); PRAGMA journal_mode=wal; PRAGMA user_version=7");
    wdb.close();
    const output = join(walDir, "wal-evidence.sqlite");
    const collector = spawnSync(process.execPath, [join(EXAMPLE, "collect.mjs"), src, output], { encoding: "utf8" });
    expect(collector.status, collector.stderr).toBe(0);
    expect(run(["db", "init"]).rc).toBe(0);
    const submitted = JSON.parse(run(["verify", "submit", "--title", "wal cleanup", "--text", join(EXAMPLE, "material.md"), "--meta-repo", ROOT, "--json"]).out) as { material_id: string };
    const edb = new DatabaseSync(output, { readOnly: true });
    let asOf = "";
    try { asOf = String((edb.prepare("SELECT captured_at FROM collection_source").get() as any).captured_at); } finally { edb.close(); }
    const prepared = JSON.parse(run(["verify", "prepare", submitted.material_id, "--candidates", join(EXAMPLE, "candidates.json"), "--reviews", join(EXAMPLE, "reviews.json"), "--db", output, "--as-of", asOf, "--candidates-author", "wal-test", "--reviews-author", "wal-test", "--meta-repo", ROOT, "--json"]).out) as { verdict: string; spec_id: string };
    expect(prepared.verdict).toBe("ready");
    const r = run(["verify", "run", prepared.spec_id, "--db", output, "--json"]);
    expect(r.rc, r.out + r.err).toBe(0);
    expect(filesLeft(), "WAL source: main copy AND its sidecars are gone").toEqual([]);
    expect(existsSync(snapshotScratchDir()), "the scratch dir itself is gone once empty").toBe(false);
  }, 180000);
});
