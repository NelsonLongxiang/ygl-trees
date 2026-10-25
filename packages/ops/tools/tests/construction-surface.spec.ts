/**
 * #18 构造面（GitHub）：DB-free 命令 + P4 诊断分流的 Done-when 钉子。
 *  1. example 空 home rc0 且**不建库**
 *  2. lint-candidates 空 home：有效候选 rc0 / 候选错误 rc1——永不 no database
 *  4. file 候选无附件 → P4 只给附件指引，不出现 construction bug
 *  5. 真构造错误（非 file 型 ERROR）→ construction bug 行仍在（回归钉）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");

function run(args: string[], home: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: REPO, encoding: "utf8", timeout: 180_000,
    env: { ...process.env, YGL_HOME: home, YGL_SESSION: "c18" } as any,
  });
  let j: any = null;
  try { j = JSON.parse(r.stdout); } catch { /* not json */ }
  return { rc: r.status ?? -1, j, out: r.stdout + r.stderr };
}

describe("#18 construction surface", () => {
  let home = "";
  beforeAll(() => { home = mkdtempSync(join(tmpdir(), "ygl-c18-")); });
  afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("item 1: verify example on an EMPTY home → rc0, JSON, and no db file created", () => {
    const r = run(["verify", "example", "--checker", "count", "--json"], home);
    expect(r.rc, r.out).toBe(0);
    expect(r.j).toBeTruthy();
    expect(existsSync(join(home, "ygl-trees.db"))).toBe(false); // #18: 不静默建库
  }, 120_000);

  it("item 2: lint-candidates on an EMPTY home → rc0 for a valid file (never no-database)", () => {
    const cands = join(home, "c.json");
    writeFileSync(cands, JSON.stringify([{
      source_clause: "S1 账单合计不得为负。",
      anchor: { quote: "S1 账单合计不得为负。", locator: "material.md#S1" },
      checker: { type: "count", predicate: { from: "claims", select: ["id"] }, op: ">=", value: 1 },
    }]));
    const mat = join(home, "m.md");
    writeFileSync(mat, "S1 账单合计不得为负。\n");
    const r = run(["verify", "lint-candidates", cands, "--text", mat, "--json"], home);
    expect(r.out).not.toMatch(/no database/);
    expect([0, 1]).toContain(r.rc); // rc0 或候选缺陷 rc1——都不是 no-database
  }, 120_000);

  it("items 4+5 (unit): minimalRedTeam splits file-attachment hints from real construction bugs", async () => {
    const { minimalRedTeam } = await import("../src/verify-cmds");
    const schema = ["CREATE TABLE claims (id TEXT)"];
    const specOf = (vu: any): any => ({
      spec_id: "spec_c18", spec_version: 1, contract_version: "1.2",
      title: "c18", domain: "general", created: "2026-10-25T00:00:00.000Z",
      runtime_min: "", verifier: { engine_version: "0.115.1", corpus_version: "1.2" },
      as_of: { kind: "snapshot", value: "2026-10-25T00:00:00.000Z" },
      attachments: [], sealed: { review: false }, vu,
    });
    // item 4：file 检查器 + 无 submissionDir → 只有附件指引，绝不 construction bug
    const fileSpec = specOf([{ id: "V1", role: "assert", title: "f", severity: "S3", source_clause: "S1",
      expected_from: { quote: "S1", locator: "m#S1" },
      checker: { type: "file", root: "attachments", require: [{ glob: "*.csv" }] } }]);
    const f4 = await minimalRedTeam(schema, undefined)(fileSpec);
    expect(f4.join(" ")).not.toMatch(/construction bug/);
    expect(f4.join(" ")).toMatch(/file checker: no attachments were staged/);
    // item 5（回归钉）：schema 外的表 → 运行期 ERROR（非 file 型）→ construction bug 仍在
    const ghostSpec = specOf([{ id: "V1", role: "assert", title: "g", severity: "S3", source_clause: "S1",
      expected_from: { quote: "S1", locator: "m#S1" },
      checker: { type: "sql", predicate: { from: "ghost", select: ["x"] }, fail_when: "rows>0" } }]);
    const f5 = await minimalRedTeam(schema, undefined)(ghostSpec);
    expect(f5.join(" ")).toMatch(/construction bug/);
  }, 60_000);
});
