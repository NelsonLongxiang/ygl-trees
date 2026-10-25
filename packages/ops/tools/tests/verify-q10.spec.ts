/**
 * A1 v1.2 Q10 返工回归：五值矩阵（V15 5×5）/ V22 target 失配 STALE / Q11 run id 唯一 / G8 JCS
 * 全部按契约 v1.2（docs/reviews/verify-tree-run-contract-v1.2.md）钉死。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { aggregateTreeVerdict } from "../src/verify-cmds";
import { jcsCanonical } from "../src/jcs";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

function run(args: string[], home: string, cwd = REPO) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
    cwd, encoding: "utf8", env: { ...process.env, YGL_HOME: home, YGL_SESSION: "q10-spec" } as any,
  });
  let j: any = null;
  try { j = JSON.parse(r.stdout); } catch { /* not json */ }
  return { rc: r.status ?? -1, j, out: r.stdout + r.stderr };
}

describe.skipIf(!HAS_BIN)("A1 v1.2 Q10 rework (5-value / STALE / Q11 / JCS)", () => {
  let home = "";
  let snap = "";

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "ygl-q10-"));
    run(["db", "init"], home);
    run(["project", "new", "p"], home);
    // leaf spec
    const sid = "spec_q10";
    mkdirSync(join(home, "verify", "specs", sid), { recursive: true });
    mkdirSync(join(home, "verify", "materials", "mat_q10"), { recursive: true });
    writeFileSync(join(home, "verify", "materials", "mat_q10", "material.txt"), "q10 fixture");
    writeFileSync(join(home, "verify", "materials", "mat_q10", "material.json"),
      JSON.stringify({ material_id: "mat_q10", title: "q10", created: "2026-10-22T00:00:00.000Z", text_sha256: "", text_path: "material.txt", files: [] }));
    writeFileSync(join(home, "verify", "specs", sid, "prepare.json"), JSON.stringify({ material_id: "mat_q10" }));
    writeFileSync(join(home, "verify", "specs", sid, "spec.json"), JSON.stringify({
      contract_version: "1.2", spec_id: sid, spec_version: 1, title: "q10", domain: "general",
      created: "2026-10-22T00:00:00.000Z", runtime_min: "",
      verifier: { engine_version: "0.114.31", corpus_version: "1.2" },
      as_of: { kind: "snapshot", value: "2026-10-19T00:00:00.000Z" },
      attachments: [], sealed: { review: false },
      vu: [{ id: "V1", role: "assert", title: "q10", severity: "S3", source_clause: "x",
        expected_from: { quote: "x", locator: "m:1" },
        checker: { type: "exists", sql: "select 1 from t where id=1", expect: true } }],
    }));
    snap = join(home, "snap.db");
    const db = new DatabaseSync(snap);
    db.exec("CREATE TABLE t(id INTEGER); INSERT INTO t VALUES(1);");
    db.close();
  });

  afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("Q11: tree_run_id is unique across runs (run idempotency removed); digest stays equal", () => {
    const treeMat = {
      tree_spec_id: "ts_q10", tree_spec_version: 1, title: "q10 tree", root: "root",
      nodes: [
        { id: "root", kind: "group", aggregate: "all_pass", children: ["leaf"] },
        { id: "leaf", kind: "leaf", spec_id: "spec_q10" },
      ],
    };
    mkdirSync(join(home, "verify", "materials", "mat_tree_q10"), { recursive: true });
    writeFileSync(join(home, "verify", "materials", "mat_tree_q10", "material.txt"), JSON.stringify(treeMat));
    writeFileSync(join(home, "verify", "materials", "mat_tree_q10", "material.json"),
      JSON.stringify({ material_id: "mat_tree_q10", title: "q10 tree", created: "2026-10-22T00:00:00.000Z", text_sha256: "", text_path: "material.txt", files: [] }));

    const prep = run(["verify", "tree", "prepare", "mat_tree_q10"], home);
    expect(prep.rc, prep.out).toBe(0);
    const tsId = prep.j.tree_spec_id;

    const r1 = run(["verify", "tree", "run", tsId, "--db", snap, "--no-archive"], home);
    const r2 = run(["verify", "tree", "run", tsId, "--db", snap, "--no-archive"], home);
    expect(r1.rc, r1.out).toBe(0);
    expect(r2.rc, r2.out).toBe(0);
    // Q11: run ids must differ (no idempotency claim)
    expect(r1.j.tree_run_id).not.toBe(r2.j.tree_run_id);
    // V7: same input → same digest
    expect(r1.j.verdict_digest).toBe(r2.j.verdict_digest);
  }, 120_000);

  it("V22: leaf target mismatch → STALE, propagates to root (not PASS)", () => {
    const prep = run(["verify", "tree", "prepare", "mat_tree_q10"], home);
    expect(prep.rc, prep.out).toBe(0);
    const tsId = prep.j.tree_spec_id;
    // declare a target that cannot match the leaf's data_source id
    const r = run(["verify", "tree", "run", tsId, "--db", snap, "--no-archive", "--target", "sqlite-snapshot:other-node"], home);
    expect(r.rc, r.out).toBe(0);
    expect(r.j.verdict).toBe("STALE");
    const leaf = (r.j.nodes ?? []).find((n: any) => n.node_id === "leaf");
    expect(leaf?.verdict).toBe("STALE");
    expect(leaf?.report_verdict).toBeTruthy(); // original 4-value preserved
    expect(String(leaf?.stale_reason)).toMatch(/target mismatch/);
  }, 120_000);

  it("Q13-A: pinned sha unknown to this workspace registry → prepare rc2 (cross-workspace rejected)", () => {
    // Q13-A：pinned 只解析本 workspace registry；外来/未知归档 → prepare rc2。
    const r = run(["verify", "tree", "prepare", "mat_tree_q10", "--pinned", "leaf=sha256:" + "0".repeat(64)], home);
    expect(r.rc).toBe(2);
    expect(String(r.j?.error)).toMatch(/pinned leaf: archive verification failed|archive not found/);
  }, 120_000);

  it("Q8: target frozen in tree spec enters canonical (prepare-time freeze, not run flag)", () => {
    // 同一 tree material + 不同冻结 target → 不同 tree_spec_id（target 进 canonical）
    const matDir = join(home, "verify", "materials", "mat_tree_target");
    mkdirSync(matDir, { recursive: true });
    const treeMat = {
      tree_spec_id: "ts_target", tree_spec_version: 1, title: "t", root: "leaf",
      target: { kind: "sqlite-snapshot", id: "bound-node" },
      nodes: [{ id: "leaf", kind: "leaf", spec_id: "spec_q10" }],
    };
    writeFileSync(join(matDir, "material.txt"), JSON.stringify(treeMat));
    writeFileSync(join(matDir, "material.json"),
      JSON.stringify({ material_id: "mat_tree_target", title: "t", created: "2026-10-22T00:00:00.000Z", text_sha256: "", text_path: "material.txt", files: [] }));
    const prep = run(["verify", "tree", "prepare", "mat_tree_target"], home);
    expect(prep.rc, prep.out).toBe(0);
    const spec = JSON.parse(readFileSync(prep.j.path, "utf8"));
    expect(spec.target).toEqual({ kind: "sqlite-snapshot", id: "bound-node" });

    // 无 target 的同结构 tree → 不同 digest
    const matDir2 = join(home, "verify", "materials", "mat_tree_noget");
    mkdirSync(matDir2, { recursive: true });
    const treeMat2 = { ...treeMat, target: undefined };
    writeFileSync(join(matDir2, "material.txt"), JSON.stringify(treeMat2));
    writeFileSync(join(matDir2, "material.json"),
      JSON.stringify({ material_id: "mat_tree_noget", title: "t", created: "2026-10-22T00:00:00.000Z", text_sha256: "", text_path: "material.txt", files: [] }));
    const prep2 = run(["verify", "tree", "prepare", "mat_tree_noget"], home);
    expect(prep2.rc, prep2.out).toBe(0);
    expect(prep2.j.tree_spec_id).not.toBe(prep.j.tree_spec_id);
  }, 120_000);

  it("Q9: leaf spec_version drift vs frozen tree version → STALE (not FAIL)", () => {
    // tree 冻结 leaf spec_version=2，实际 spec v1 → STALE
    const matDir = join(home, "verify", "materials", "mat_tree_ver");
    mkdirSync(matDir, { recursive: true });
    writeFileSync(join(matDir, "material.txt"), JSON.stringify({
      tree_spec_id: "ts_ver", tree_spec_version: 1, title: "v", root: "leaf",
      nodes: [{ id: "leaf", kind: "leaf", spec_id: "spec_q10", spec_version: 2 }],
    }));
    writeFileSync(join(matDir, "material.json"),
      JSON.stringify({ material_id: "mat_tree_ver", title: "v", created: "2026-10-22T00:00:00.000Z", text_sha256: "", text_path: "material.txt", files: [] }));
    const prep = run(["verify", "tree", "prepare", "mat_tree_ver"], home);
    expect(prep.rc, prep.out).toBe(0);
    const r = run(["verify", "tree", "run", prep.j.tree_spec_id, "--db", snap, "--no-archive"], home);
    expect(r.rc, r.out).toBe(0);
    expect(r.j.verdict).toBe("STALE");
    const leaf = (r.j.nodes ?? []).find((n: any) => n.node_id === "leaf");
    expect(leaf?.verdict).toBe("STALE");
    expect(String(leaf?.stale_reason)).toMatch(/spec_version drift/);
  }, 120_000);

  it("五值: leaf ERROR/NEEDS-MATERIAL do not leak into nodes[].verdict (mapped to INFRA_BLOCKED)", () => {
    // 空库 → count 查询报错 → 叶 report ERROR → 树 verdict 必须是五值内的 INFRA_BLOCKED
    const emptyDb = join(home, "empty.db");
    const db = new DatabaseSync(emptyDb);
    db.close();
    const prep = run(["verify", "tree", "prepare", "mat_tree_q10"], home);
    expect(prep.rc, prep.out).toBe(0);
    const r = run(["verify", "tree", "run", prep.j.tree_spec_id, "--db", emptyDb, "--no-archive"], home);
    expect(r.rc, r.out).toBe(0);
    const FIVE = new Set(["PASS", "FAIL", "NEUTRALIZED", "INFRA_BLOCKED", "STALE"]);
    for (const n of r.j.nodes ?? []) expect(FIVE.has(n.verdict), `node ${n.node_id} verdict ${n.verdict}`).toBe(true);
    const leaf = (r.j.nodes ?? []).find((n: any) => n.node_id === "leaf");
    expect(leaf?.report_verdict).toBe("ERROR"); // 原四值保留
    expect(leaf?.verdict).toBe("INFRA_BLOCKED"); // 五值映射
  }, 120_000);

  it("G8: tree spec pins engine/corpus/contract into canonical", () => {
    const matDir = join(home, "verify", "materials", "mat_tree_pin");
    mkdirSync(matDir, { recursive: true });
    writeFileSync(join(matDir, "material.txt"), JSON.stringify({
      tree_spec_id: "ts_pin", tree_spec_version: 1, title: "p", root: "leaf",
      engine_version: "0.115.0", corpus_version: "1.2", contract_version: "1.2",
      nodes: [{ id: "leaf", kind: "leaf", spec_id: "spec_q10" }],
    }));
    writeFileSync(join(matDir, "material.json"),
      JSON.stringify({ material_id: "mat_tree_pin", title: "p", created: "2026-10-22T00:00:00.000Z", text_sha256: "", text_path: "material.txt", files: [] }));
    const prep = run(["verify", "tree", "prepare", "mat_tree_pin"], home);
    expect(prep.rc, prep.out).toBe(0);
    const spec = JSON.parse(readFileSync(prep.j.path, "utf8"));
    expect(spec.engine_version).toBe("0.115.0");
    expect(spec.corpus_version).toBe("1.2");
    expect(spec.contract_version).toBe("1.2");
  }, 120_000);

  it("G8: jcsCanonical sorts keys and emits no whitespace", () => {
    expect(jcsCanonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(jcsCanonical({ z: [3, 1], a: "x" })).toBe('{"a":"x","z":[3,1]}');
    // number formatting: shortest representation
    expect(jcsCanonical(1.0)).toBe("1");
    expect(jcsCanonical(1.5)).toBe("1.5");
  });
});
