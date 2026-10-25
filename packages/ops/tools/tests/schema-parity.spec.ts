/**
 * B2 门禁自腐化防护（fdc 补正：删列红测保留为 CI 常驻断言，不只验一次）。
 *
 * 三个断言：
 *  ① 当前仓两条 DDL 列集一致（green 基线）
 *  ② 删一列 → 必红（门禁不会因为自身 defect 静默放行）
 *  ③ 每表存在性双向检查（SQLite 专有 FTS 表白名单外缺表 = 红）
 */
import { describe, it, expect } from "vitest";
import { compare, loadSqliteDdl, loadPgDdl, parseColumns } from "../../../../scripts/schema-parity.mjs";

describe("B2 schema parity gate (SCHEMA_SQL vs MIGRATE_DDL)", () => {
  it("current repo: column sets match", () => {
    const r = compare(loadSqliteDdl(), loadPgDdl());
    expect(r.problems, JSON.stringify(r.problems)).toEqual([]);
    expect(r.sqliteTables).toBeGreaterThan(15);
    expect(r.pgTables).toBeGreaterThan(15);
  }, 30_000);

  it("delete a column from the PG DDL → gate turns red (self-corruption guard)", () => {
    const sqlite = loadSqliteDdl();
    // 从真实 PG DDL 里删掉 skills 表的 `body` 列，门禁必须抓到
    const pg = loadPgDdl().replace(/(CREATE TABLE skills \([^]*?)body[^,]*,\s*/, "$1");
    const r = compare(sqlite, pg);
    expect(r.problems.length, JSON.stringify(r.problems)).toBeGreaterThan(0);
    const skillsProblem = r.problems.find((p) => p.startsWith("skills:"));
    expect(skillsProblem).toBeTruthy();
    expect(String(skillsProblem)).toMatch(/only sqlite \[body\]/);
  }, 30_000);

  it("column parser handles multi-column lines, inline comments, and nested parens", () => {
    const cols = parseColumns(`
      id text PRIMARY KEY,
      amount numeric(10, 2) NOT NULL, -- 金额（注释里有逗号,和括号）
      note text DEFAULT ''
    `);
    expect([...cols].sort()).toEqual(["amount", "id", "note"]);
  });

  it("table present on only one side is reported", () => {
    const r = compare(
      "CREATE TABLE a (x text); CREATE TABLE only_here (y text);",
      "CREATE TABLE a (x text);",
      { sqliteOnly: new Set() },
    );
    expect(r.problems.some((p) => /only_here/.test(p))).toBe(true);
  });
});
