/**
 * A1 契约 v1.0 · `verify tree prepare`（prepare 期冻结/校验）。
 * 覆盖 V5 环、V12 深度、V16 未知算子、V17 同轮 pinned 自引用（prepare 面）、Q6 空组，
 * 以及悬空/重复 id/不可达/缺 spec/pinned 形状。run/report 面随后续施工补。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { aggregateTreeVerdict } from "../src/verify-cmds";

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
  return { rc: r.status ?? -1, j, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() + (r.error ? " SPAWNERR:" + r.error.message : "") };
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


describe("A1 tree run (runtime first cut)", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-tree-run-"));
    WORK = mkdtempSync(join(tmpdir(), "ygl-tree-run-files-"));
  });
  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // 契约 v1.2 Q10-B 五值矩阵（V15 5×5 表驱动；全序 NEUTRALIZED > STALE > FAIL > INFRA_BLOCKED > PASS）
  const matrix: Array<[string, string[], string]> = [
    // all_pass
    ["all_pass", ["PASS", "PASS"], "PASS"],
    ["all_pass", ["PASS", "FAIL"], "FAIL"],
    ["all_pass", ["PASS", "ERROR"], "INFRA_BLOCKED"], // Q10-B：any ERROR → 至多 INFRA_BLOCKED
    ["all_pass", ["ERROR", "ERROR"], "INFRA_BLOCKED"],
    // count_fail
    ["count_fail", ["PASS", "FAIL"], "FAIL"],
    ["count_fail", ["PASS", "ERROR"], "INFRA_BLOCKED"],
    // quorum：分母只计 PASS+FAIL；any-ERROR 优先
    ["quorum(2)", ["PASS", "FAIL", "PASS"], "PASS"],
    ["quorum(2)", ["PASS", "FAIL", "FAIL"], "FAIL"],
    ["quorum(2)", ["PASS", "PASS", "ERROR"], "INFRA_BLOCKED"],
    ["quorum(2)", ["PASS", "FAIL", "ERROR"], "INFRA_BLOCKED"],
    ["quorum(2)", ["FAIL", "FAIL", "ERROR"], "INFRA_BLOCKED"],
    // 遮蔽序
    ["all_pass", ["NEUTRALIZED", "FAIL"], "NEUTRALIZED"],
    ["all_pass", ["NEUTRALIZED", "STALE"], "NEUTRALIZED"],
    ["all_pass", ["STALE", "FAIL"], "STALE"],
    ["all_pass", ["STALE", "PASS"], "STALE"],
    ["all_pass", ["FAIL", "INFRA_BLOCKED"], "INFRA_BLOCKED"],
  ];
  for (const [op, vs, want] of matrix) {
    it(`aggregate ${op} ${vs.join("+")} => ${want}`, () => {
      expect(aggregateTreeVerdict(op, vs)).toBe(want);
    });
  }

  it("runs a two-leaf tree: verdict, per-leaf runs, deterministic digest, events", () => {
    expect(run(["db", "init"]).rc).toBe(0);
    expect(run(["project", "new", "p"]).rc).toBe(0);
    // leaf specs: a passes, b fails (exists id=2 absent)
    for (const [sid, sql] of [
      ["spec_a", "select 1 from t where id=1"],
      ["spec_b", "select 1 from t where id=2"],
    ] as const) {
      mkdirSync(join(HOME, "verify", "specs", sid), { recursive: true });
      mkdirSync(join(HOME, "verify", "materials", "mat_" + sid), { recursive: true });
      writeFileSync(join(HOME, "verify", "materials", "mat_" + sid, "material.txt"), "fixture " + sid);
      writeFileSync(
        join(HOME, "verify", "materials", "mat_" + sid, "material.json"),
        JSON.stringify({ material_id: "mat_" + sid, title: sid, created: "2026-10-22T00:00:00.000Z", text_sha256: "", text_path: "material.txt", files: [] })
      );
      writeFileSync(
        join(HOME, "verify", "materials", "mat_" + sid, "material.txt"), "fixture " + sid
      );
      writeFileSync(
        join(HOME, "verify", "specs", sid, "prepare.json"),
        JSON.stringify({ material_id: "mat_" + sid })
      );
      writeFileSync(
        join(HOME, "verify", "specs", sid, "spec.json"),
        JSON.stringify({
          contract_version: "1.2", spec_id: sid, spec_version: 1, title: sid, domain: "general",
          created: "2026-10-22T00:00:00.000Z", runtime_min: "",
          verifier: { engine_version: "0.114.18", corpus_version: "1.2" },
          as_of: { kind: "snapshot", value: "2026-10-19T00:00:00.000Z" },
          attachments: [], sealed: { review: false },
          vu: [{ id: "V1", role: "assert", title: sid, severity: "S3", source_clause: "x",
            expected_from: { quote: "x", locator: "m:1" },
            checker: { type: "exists", sql, expect: true } }],
        })
      );
    }
    const snap = join(HOME, "snap.db");
    const db = new DatabaseSync(snap);
    db.exec("CREATE TABLE t(id INTEGER); INSERT INTO t VALUES(1);");
    db.close();
    const tree = {
      tree_spec_version: 1, root: "root",
      nodes: [group("root", ["a", "b"]), leaf("a", "spec_a"), leaf("b", "spec_b")],
    };
    const prep = submitTree(tree);
    expect(prep.rc).toBe(0);
    const tid = prep.j.tree_spec_id as string;
    const r1 = run(["verify", "tree", "run", tid, "--db", snap]);
    expect(r1.rc, r1.out + r1.err).toBe(0);
    expect(r1.j.verdict).toBe("FAIL");
    expect(r1.j.nodes.find((n: any) => n.node_id === "root").verdict).toBe("FAIL");
    expect(r1.j.nodes.filter((n: any) => n.kind === "leaf").every((n: any) => n.report_id)).toBe(true);
    expect(existsSync(r1.j.report_path)).toBe(true);
    const rootNode = r1.j.nodes.find((n: any) => n.node_id === "root");
    expect(rootNode.archive_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    const av = run(["verify", "archive", "verify", rootNode.archive_path]);
    expect(av.rc, av.out).toBe(0);

    const r2 = run(["verify", "tree", "run", tid, "--db", snap]);
    expect(r2.rc).toBe(0);
    expect(r2.j.verdict_digest).toBe(r1.j.verdict_digest); // audit/time excluded (V7)
    // events appended (V10)
    const ev = new DatabaseSync(join(HOME, "ygl-trees.db"));
    const n = (ev.prepare("SELECT COUNT(*) c FROM events WHERE kind='verify.tree.run'").get() as any).c;
    ev.close();
    expect(Number(n)).toBe(2);

    // V6: a byte appended AFTER archiving changes the zip hash (the in-zip
    // manifest alone cannot see a trailer) -> pinned subtree NEUTRALIZED.
    const leafA = r1.j.nodes.find((x: any) => x.node_id === "a");
    const pinnedTree = submitTree({
      tree_spec_version: 1, root: "root",
      nodes: [group("root", ["a"]), leaf("a", "spec_a")],
      pinned: { a: leafA.archive_sha256 },
    });
    expect(pinnedTree.rc, JSON.stringify(pinnedTree.j) + pinnedTree.out + pinnedTree.err).toBe(0);
    appendFileSync(leafA.archive_path, Buffer.from("X"));
    const rv = run(["verify", "tree", "run", pinnedTree.j.tree_spec_id, "--db", snap]);
    expect(rv.rc, rv.out + rv.err).toBe(0);
    expect(rv.j.verdict).toBe("NEUTRALIZED");
    expect(rv.j.nodes.find((x: any) => x.node_id === "root").verdict).toBe("NEUTRALIZED");
  });
});
