#!/usr/bin/env node
/**
 * A1 tree fixture builder (verification handoff).
 *
 * Materializes a throwaway YGL_HOME with:
 *   - two minimal prepared leaf specs (spec_a PASS, spec_b FAIL) + materials
 *   - a snapshot sqlite db (table t; id=1 exists)
 *   - a frozen tree spec: root(all_pass) -> a(spec_a), b(spec_b)
 *   - a second pinned tree spec pointing at a real leaf archive (for V6 tamper)
 *
 * Usage:
 *   node scripts/tree-fixture.mjs [--keep]
 * Prints JSON: {home, tree_spec_id, pinned_tree_spec_id, db, leaf_archive_path, run}
 * Leaves the home on disk (pass --clean to remove it after printing? default keep).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const REPO = resolve(process.cwd());
const BIN = join(REPO, "dist/bundle/bin.cjs");
const HOME = mkdtempSync(join(tmpdir(), "ygl-tree-fixture-"));
const env = { ...process.env, YGL_HOME: HOME, YGL_SESSION: "tree-fixture" };

function run(args) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { cwd: HOME, env, encoding: "utf8" });
  let j = null;
  try { j = JSON.parse((r.stdout || "").trim()); } catch { j = null; }
  if (r.status !== 0) throw new Error(`${args.join(" ")} failed rc=${r.status}: ${(r.stdout || "") + (r.stderr || "")}`);
  return j;
}

run(["db", "init"]);
run(["project", "new", "p"]);

const snapshot = join(HOME, "snap.db");
{
  const db = new DatabaseSync(snapshot);
  db.exec("CREATE TABLE t(id INTEGER); INSERT INTO t VALUES(1);");
  db.close();
}

function leafSpec(sid, sql) {
  const specDir = join(HOME, "verify", "specs", sid);
  const matId = "mat_" + sid;
  mkdirSync(specDir, { recursive: true });
  mkdirSync(join(HOME, "verify", "materials", matId), { recursive: true });
  writeFileSync(join(HOME, "verify", "materials", matId, "material.txt"), `材料 ${sid}\n`);
  writeFileSync(join(HOME, "verify", "materials", matId, "material.json"), JSON.stringify({
    material_id: matId, title: sid, created: "2026-10-22T00:00:00.000Z", text_sha256: "", text_path: "material.txt", files: [],
  }));
  writeFileSync(join(specDir, "prepare.json"), JSON.stringify({ material_id: matId }));
  writeFileSync(join(specDir, "spec.json"), JSON.stringify({
    contract_version: "1.2", spec_id: sid, spec_version: 1, title: sid, domain: "general",
    created: "2026-10-22T00:00:00.000Z", runtime_min: "",
    verifier: { engine_version: "0.114.20", corpus_version: "1.2" },
    as_of: { kind: "snapshot", value: "2026-10-19T00:00:00.000Z" },
    attachments: [], sealed: { review: false },
    vu: [{ id: "V1", role: "assert", title: sid, severity: "S3", source_clause: "x",
      expected_from: { quote: "x", locator: "m:1" },
      checker: { type: "exists", sql, expect: true } }],
  }));
}
leafSpec("spec_a", "select 1 from t where id=1"); // PASS
leafSpec("spec_b", "select 1 from t where id=2"); // FAIL

function makeTree(nodes, pinned) {
  const file = join(HOME, `tree-${Date.now().toString(36)}.json`);
  writeFileSync(file, JSON.stringify({ tree_spec_version: 1, root: "root", nodes, ...(pinned ? { pinned } : {}) }));
  const sub = run(["verify", "submit", "--title", "tree fixture", "--text", file, "--no-meta"]);
  return run(["verify", "tree", "prepare", sub.material_id]);
}

const tree = makeTree([
  { id: "root", kind: "group", aggregate: "all_pass", children: ["a", "b"] },
  { id: "a", kind: "leaf", spec_id: "spec_a" },
  { id: "b", kind: "leaf", spec_id: "spec_b" },
]);

// run once to produce a real leaf archive, then pin it into a second tree (V6)
const firstRun = run(["verify", "tree", "run", tree.tree_spec_id, "--db", snapshot]);
const leafNode = firstRun.nodes.find((n) => n.node_id === "a");
if (!leafNode?.archive_sha256) throw new Error("fixture: leaf archive missing");
const pinned = { a: leafNode.archive_sha256.replace(/^sha256:/, "") };
const pinnedTree = makeTree([
  { id: "root", kind: "group", aggregate: "all_pass", children: ["a"] },
  { id: "a", kind: "leaf", spec_id: "spec_a" },
], pinned);

const out = {
  home: HOME,
  tree_spec_id: tree.tree_spec_id,
  pinned_tree_spec_id: pinnedTree.tree_spec_id,
  db: snapshot,
  leaf_archive_path: leafNode.archive_path,
  run: `YGL_HOME=${HOME} node ${BIN} verify tree run ${tree.tree_spec_id} --db ${snapshot} --json`,
  note: "V6: tamper leaf_archive_path, then run pinned_tree_spec_id -> subtree NEUTRALIZED, root must not PASS",
};
console.log(JSON.stringify(out, null, 2));
