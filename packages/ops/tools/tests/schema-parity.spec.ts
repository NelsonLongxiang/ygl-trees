/**
 * B2 门禁自腐化防护（fdc 补正：删列红测保留为 CI 常驻断言，不只验一次）。
 *
 * 三个断言：
 *  ① 当前仓两条 DDL 列集一致（green 基线）
 *  ② 删一列 → 必红（门禁不会因为自身 defect 静默放行）
 *  ③ 每表存在性双向检查（SQLite 专有 FTS 表白名单外缺表 = 红）
 *  ④ #176 W5a 结构层：当前仓结构一致（只剩已登记的方言差异）；对真实 PG DDL 做变异——
 *     去 NOT NULL、改 DEFAULT、改类型、去 ON DELETE、删唯一约束、删索引——每种都必红；
 *     未登记差异红、失效登记项红。
 */
import { describe, it, expect } from "vitest";
import { compare, compareStructure, DIALECT_EXCEPTIONS, loadSqliteDdl, loadPgDdl, loadPgIndexes, parseColumns, parseStructure } from "../../../../scripts/schema-parity.mjs";

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

  describe("#176 W5a structural parity", () => {
    const sqlite = loadSqliteDdl();
    const pg = loadPgDdl() + loadPgIndexes();

    it("current repo: structure matches except registered dialect exceptions", () => {
      const r = compareStructure(sqlite, pg);
      expect(r.problems, JSON.stringify(r.problems)).toEqual([]);
      expect(r.excepted.length).toBe(DIALECT_EXCEPTIONS.size);
    }, 30_000);

    it("parses both sides symmetrically (columns, uniques, foreign keys, indexes)", () => {
      const count = (ddl: string) => {
        let cols = 0, uniques = 0, refs = 0, indexes = 0;
        for (const [name, t] of parseStructure(ddl)) {
          if (name.startsWith("fts_")) continue;
          cols += t.cols.size; uniques += t.uniques.size; indexes += t.indexes.size;
          for (const c of t.cols.values()) if (c.ref) refs++;
        }
        return { cols, uniques, refs, indexes };
      };
      const a = count(sqlite);
      expect(a).toEqual(count(pg));
      expect(a.cols).toBeGreaterThan(150);
      expect(a.refs).toBeGreaterThan(15);
      expect(a.uniques).toBeGreaterThan(10);
      expect(a.indexes).toBeGreaterThan(15);
    }, 30_000);

    const mutations: Array<[string, (ddl: string) => string, RegExp]> = [
      ["not null", (d) => d.replace("name text NOT NULL, kind text NOT NULL DEFAULT 'tech'", "name text, kind text NOT NULL DEFAULT 'tech'"), /^nodes\.name: notnull/],
      ["default", (d) => d.replace("kind text NOT NULL DEFAULT 'tech'", "kind text NOT NULL DEFAULT 'skill'"), /^nodes\.kind: default/],
      ["type", (d) => d.replace("cost double precision", "cost text"), /^nodes\.cost: type/],
      ["on delete", (d) => d.replace("tree_id text NOT NULL REFERENCES trees(id) ON DELETE CASCADE,\n  key text", "tree_id text NOT NULL REFERENCES trees(id),\n  key text"), /^nodes\.tree_id: ref/],
      ["unique", (d) => d.replace("created text NOT NULL, UNIQUE (tree_id, key)", "created text NOT NULL"), /^nodes: unique \(tree_id,key\) missing in pg/],
      ["index", (d) => d.replace(/CREATE INDEX IF NOT EXISTS idx_nodes_tier[^\n]*\n/, ""), /^nodes: index \(tree_id,tier\) missing in pg/],
    ];
    it.each(mutations)("mutating the real PG DDL (%s) turns the gate red", (_kind, mutate, expected) => {
      const mutated = mutate(pg);
      expect(mutated).not.toBe(pg);
      const r = compareStructure(sqlite, mutated);
      expect(r.problems.some((p) => expected.test(p)), JSON.stringify(r.problems)).toBe(true);
    }, 30_000);

    it("an unregistered dialect difference is red, and a stale exception is red", () => {
      const unregistered = compareStructure(sqlite, pg, { exceptions: new Map() });
      expect(unregistered.problems).toEqual([...DIALECT_EXCEPTIONS.keys()]);
      const stale = compareStructure(sqlite, pg, { exceptions: new Map([...DIALECT_EXCEPTIONS, ["x.y: default sqlite=1 pg=2", "gone"]]) });
      expect(stale.problems).toEqual(["stale dialect exception (no longer observed, remove it): x.y: default sqlite=1 pg=2"]);
    }, 30_000);
  });
});
