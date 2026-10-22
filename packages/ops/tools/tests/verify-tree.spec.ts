/**
 * A1 契约 v1.0 · `verify tree prepare`（prepare 期冻结/校验）。
 * 覆盖 V5 环、V12 深度、V16 未知算子、V17 同轮 pinned 自引用（prepare 面）、Q6 空组，
 * 以及悬空/重复 id/不可达/缺 spec/pinned 形状。run/report 面随后续施工补。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
let HOME = "";
let WORK = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    cwd: HOME, // outside the verifier repo: no meta gate dependency
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, YGL_HOME: HOME, YGL_SESSION: "tree-prepare" },
  });
  let j: any = null;
  try { j = JSON.parse((r.stdout || "").trim()); } catch { j = null; }
  return { rc: r.status ?? -1, j, out: (r.stdout || "").trim() };
}

let n = 0;
function submitTree(obj: unknown, extraArgs: string[] = []) {
  const file = join(WORK, `tree-${++n}.json`);
  writeFileSync(file, JSON.stringify(obj));
  const sub = run(["verify", "submit", "--title", `树 ${n}`, "--text", file]);
  expect(sub.rc).toBe(0);
  return run(["verify", "tree", "prepare", sub.j.material_id, ...extraArgs]);
}

const leaf = (id: string, spec = "spec_a") => ({ id, kind: "leaf", spec_id: spec });
const group = (id: string, children: string[], aggregate = "all_pass") => ({ id, kind: "group", aggregate, children });

describe.skipIf(!HAS_BIN)("verify tree prepare (A1)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-tree-prepare-"));
    WORK = mkdtempSync(join(tmpdir(), "ygl-tree-files-"));
    // minimal frozen specs so leaf references resolve
    for (const sid of ["spec_a", "spec_b"]) {
      mkdirSync(join(HOME, "verify", "specs", sid), { recursive: true });
      writeFileSync(join(HOME, "verify", "specs", sid, "spec.json"), JSON.stringify({ spec_id: sid, verifier: { spec_version: 1 } }));
    }
    expect(run(["db", "init"]).rc).toBe(0);
    expect(run(["project", "new", "p"]).rc).toBe(0);
  });
  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("valid tree freezes: id/sha/nodes + file written", () => {
    const r = submitTree({ tree_spec_version: 1, root: "root", nodes: [group("root", ["a", "b"]), leaf("a"), leaf("b")] });
    expect(r.rc).toBe(0);
    expect(String(r.j.tree_spec_id)).toMatch(/^ts_[0-9a-f]{12}$/);
    expect(String(r.j.tree_spec_sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(r.j.nodes).toBe(3);
    expect(existsSync(r.j.path)).toBe(true);
  });

  it("V5 cycle → rc=2", () => {
    const r = submitTree({ tree_spec_version: 1, root: "a", nodes: [group("a", ["b"]), group("b", ["a"])] });
    expect(r.rc).toBe(2);
    expect(String(r.j.error)).toMatch(/cycle detected/);
  });

  it("V16 unknown aggregate → rc=2", () => {
    const r = submitTree({ tree_spec_version: 1, root: "root", nodes: [group("root", ["a"], "median"), leaf("a")] });
    expect(r.rc).toBe(2);
    expect(String(r.j.error)).toMatch(/unknown aggregate 'median'/);
  });

  it("Q6 empty group → rc=2", () => {
    const r = submitTree({ tree_spec_version: 1, root: "root", nodes: [group("root", [])] });
    expect(r.rc).toBe(2);
    expect(String(r.j.error)).toMatch(/empty group rejected/);
  });

  it("V12 depth > 16 → rc=2", () => {
    const nodes: any[] = [];
    for (let i = 0; i < 17; i++) nodes.push(group(`g${i}`, i === 16 ? ["leaf"] : [`g${i + 1}`]));
    nodes.push(leaf("leaf"));
    const r = submitTree({ tree_spec_version: 1, root: "g0", nodes });
    expect(r.rc).toBe(2);
    expect(String(r.j.error)).toMatch(/depth exceeds 16/);
  });

  it("dangling child / duplicate id / unreachable node → rc=2", () => {
    expect(submitTree({ tree_spec_version: 1, root: "root", nodes: [group("root", ["nope"])] }).rc).toBe(2);
    expect(submitTree({ tree_spec_version: 1, root: "root", nodes: [group("root", ["a"]), leaf("a"), leaf("a")] }).rc).toBe(2);
    const unreach = submitTree({
      tree_spec_version: 1,
      root: "root",
      nodes: [group("root", ["a"]), leaf("a"), leaf("orphan")],
    });
    expect(unreach.rc).toBe(2);
    expect(String(unreach.j.error)).toMatch(/unreachable node/);
  });

  it("missing leaf spec → rc=2", () => {
    const r = submitTree({ tree_spec_version: 1, root: "root", nodes: [group("root", ["a"]), leaf("a", "spec_missing")] });
    expect(r.rc).toBe(2);
    expect(String(r.j.error)).toMatch(/spec not found: spec_missing/);
  });

  it("V17 pinned target unknown / bad sha / archive absent → rc=2", () => {
    const base = { tree_spec_version: 1, root: "root", nodes: [group("root", ["a"]), leaf("a")] };
    expect(submitTree({ ...base, pinned: { nope: "a".repeat(64) } }).rc).toBe(2);
    expect(submitTree({ ...base, pinned: { a: "zz" } }).rc).toBe(2);
    const good = "b".repeat(64);
    const r = submitTree(base, ["--pinned", `a=${good}`]);
    expect(r.rc).toBe(2);
    expect(String(r.j.error)).toMatch(/archive not found for sha256/);
  });

  it("V20 same canonical tree is idempotent (same tree_spec_id)", () => {
    const tree = { tree_spec_version: 1, root: "root", nodes: [group("root", ["a"]), leaf("a")] };
    const first = submitTree(tree);
    expect(first.rc).toBe(0);
    const second = submitTree(tree);
    expect(second.rc).toBe(0);
    expect(second.j.tree_spec_id).toBe(first.j.tree_spec_id);
    expect(second.j.tree_spec_sha256).toBe(first.j.tree_spec_sha256);
  });

  it("V16 malformed aggregates rejected: quorum2 / quorum(2 / quorum() / all_pass()", () => {
    for (const agg of ["quorum2", "quorum(2", "quorum()", "all_pass()", "count_fail(1)"]) {
      const r = submitTree({
        tree_spec_version: 1,
        root: "root",
        nodes: [group("root", ["a", "b"], agg), leaf("a"), leaf("b")],
      });
      expect(r.rc, agg).toBe(2);
      expect(String(r.j.error), agg).toMatch(/unknown aggregate/);
    }
  });
});
