/**
 * #27 Q3 / 方案 T6：渲染面透出语义边界。契约 ≤1.2 的报告没有 `semantic_scope` 字段，
 * `verify run` / `verify report` 的人类输出必须按最保守的 structural 读并标明缺省——
 * 父验证器的 PASS 不代表子结论为真。JSON 面原样（报告不可变、形状冻结）；看板列表投影透传 null。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { firstReportPage } from "../src/verify-web";
import { scopeLine } from "../src/verify-cmds";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let HOME = "";
const specId = "spec_scope000000001";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, YGL_HOME: HOME }, cwd: HOME });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

describe("scopeLine（纯函数）", () => {
  it("无字段 → structural 并标明缺省；闭集内 → 原样；闭集外 → structural 并点名未知值（不失败开放）", () => {
    expect(scopeLine({})).toMatch(/^semantic_scope structural/);
    expect(scopeLine({})).toMatch(/缺省/);
    expect(scopeLine({ semantic_scope: "factual" })).toBe("semantic_scope factual");
    expect(scopeLine({ semantic_scope: "semantic" })).toBe("semantic_scope semantic");
    expect(scopeLine({ semantic_scope: 42 })).toMatch(/^semantic_scope structural.*缺省/); // 非字符串不算声明
    const bogus = scopeLine({ semantic_scope: "Factual " });
    expect(bogus).toMatch(/^semantic_scope structural/);
    expect(bogus).toMatch(/未知值 "Factual "/);
    expect(bogus).not.toMatch(/^semantic_scope Factual/);
  });
});

describe.skipIf(!HAS_BIN)("semantic_scope 渲染面（发布产物）", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-scope-home-"));
    run(["db", "init"]);
    const dir = join(HOME, "verify", "specs", specId);
    mkdirSync(dir, { recursive: true });
    const MATERIAL = "账单金额不得为负。\n";
    const spec = {
      contract_version: "1.2",
      spec_id: specId,
      spec_version: 1,
      title: "scope render",
      domain: "probe",
      created: "2026-10-21T00:00:00.000Z",
      runtime_min: "0.113.2",
      verifier: { engine_version: "0.1.0", corpus_version: "1.2" },
      as_of: { kind: "snapshot", value: "2026-10-21T00:00:00.000Z" },
      attachments: [],
      sealed: { review: false },
      vu: [
        {
          id: "V1",
          role: "assert",
          title: "no negative",
          severity: "S1",
          source_clause: "账单金额不得为负。",
          expected_from: { kind: "material-extract", source_id: "materials", anchor: "m#1", quote: "账单金额不得为负。" },
          checker: { type: "sql", fail_when: "rows>0", predicate: { from: "bills", select: ["id"], where: { op: "and", conditions: [{ col: "amount", op: "<", value: 0 }] } } },
        },
      ],
    };
    writeFileSync(join(dir, "spec.json"), JSON.stringify(spec, null, 2), "utf8");
    const matId = "mat_scope0001";
    const mdir = join(HOME, "verify", "materials", matId);
    mkdirSync(mdir, { recursive: true });
    writeFileSync(join(mdir, "material.txt"), MATERIAL, "utf8");
    writeFileSync(join(mdir, "material.json"), JSON.stringify({ material_id: matId, title: "scope", created: "2026-10-21T00:00:00.000Z", text_sha256: sha(MATERIAL), text_path: "material.txt", files: [] }), "utf8");
    writeFileSync(join(dir, "prepare.json"), JSON.stringify({ material_id: matId }, null, 2), "utf8");
  });

  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("verify run / verify report 的人类输出首屏带边界行；JSON 面不变；看板投影透传 null", async () => {
    const db = join(HOME, "snap.db");
    const d = new DatabaseSync(db);
    d.exec("CREATE TABLE bills(id TEXT PRIMARY KEY, amount INTEGER); INSERT INTO bills VALUES ('a', 5);");
    d.close();

    const ran = run(["verify", "run", specId, "--db", db, "--no-archive", "--no-color"]);
    expect(ran.rc).toBe(0);
    expect(ran.out).toMatch(/PASS\s+run_[0-9a-f]+/);
    expect(ran.out).toMatch(/semantic_scope structural/);
    expect(ran.out).toMatch(/缺省/);
    const runId = ran.out.match(/(run_[0-9a-f]+)/)![1];

    const shown = run(["verify", "report", runId, "--no-color"]);
    expect(shown.rc).toBe(0);
    expect(shown.out).toMatch(/semantic_scope structural/);
    expect(shown.out).toMatch(/父 PASS 不代表子结论为真/);

    // JSON 面原样：报告不可变，没有凭空出现的字段
    const json = run(["verify", "report", runId, "--json"]);
    expect(json.rc).toBe(0);
    const report = JSON.parse(json.out);
    expect("semantic_scope" in report).toBe(false);
    expect(JSON.parse(readFileSync(join(HOME, "verify", "reports", `${runId}.json`), "utf8")).payload_sha256).toBe(report.payload_sha256);

    // 看板摘要行：无字段 → null（UI 按 structural 显示；服务端不替报告发明值）
    await (await import("../src/verify-list-index")).prepareListIndex(HOME);
    const row = (await firstReportPage({ home: HOME } as any)).find((r) => r.run_id === runId)!;
    expect(row).toBeTruthy();
    expect(row.semantic_scope).toBeNull();
  }, 60_000);
});
