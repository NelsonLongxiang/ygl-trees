import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { runVerify, renderPredicate } from "../src/engine";
import { SqliteRunner } from "../src/sqlite-runner";
import type { VerifySpec, VerifyUnit } from "../src/contract";

const dir = mkdtempSync(join(tmpdir(), "ygl-r8-"));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function seeded(): string {
  const path = join(dir, `db-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new DatabaseSync(path);
  db.exec(`
    create table bills(batch text, amount_cents integer, created text);
    create table expected(batch text, amount_cents integer);
    insert into bills values ('2026-07', 120000, '2026-07-31T00:00:00Z');
    insert into bills values ('2026-07', 80000,  '2026-08-01T00:00:00Z');
    insert into bills values ('2026-06', 50000,  '2026-06-30T00:00:00Z');
    insert into expected values ('2026-07', 200000);
  `);
  db.close();
  return path;
}

const runner = new SqliteRunner(seeded());
afterAll(() => runner.close());

function spec(vu: VerifyUnit[]): VerifySpec {
  return {
    contract_version: "0.4",
    spec_id: "spec_r8",
    spec_version: 1,
    verifier: { engine_version: "0.1.0", corpus_version: "1" },
    as_of: { kind: "snapshot", value: "2026-10-19T00:00:00.000Z" },
    attachments: [],
    sealed: { review: false },
    vu,
  } as VerifySpec;
}

function unit(partial: Partial<VerifyUnit> & Pick<VerifyUnit, "id" | "checker">): VerifyUnit {
  return {
    role: "assert",
    title: partial.id,
    severity: "S1",
    source_clause: "clause",
    expected_from: { quote: "q", locator: "l" },
    ...partial,
  } as VerifyUnit;
}

describe("r8 F1：agg 是活特性（只聚合、别名唯一、禁止混排）", () => {
  it("纯聚合渲染出合法的 SELECT SUM(...)（无 GROUP BY 也合法）", () => {
    const r = renderPredicate({ from: "bills", select: [], agg: [{ fn: "sum", col: "amount_cents", as: "total" }] });
    expect(r.findSql).toBe("SELECT SUM(amount_cents) AS total FROM bills");
    expect(r.scopeSql).toBe("SELECT count(*) AS n FROM bills");
  });

  it("列与聚合混排直接拒绝（PG 上就是非法形状）", () => {
    expect(() => renderPredicate({ from: "bills", select: ["batch"], agg: [{ fn: "sum", col: "amount_cents" }] })).toThrow(/mixes select columns with agg/);
  });

  it("聚合别名重复拒绝（含自动名撞名）", () => {
    expect(() => renderPredicate({ from: "bills", select: [], agg: [{ fn: "count" }, { fn: "count", as: "count_all" }] })).toThrow(/duplicated/);
  });

  it("sql-pair 双侧谓词聚合（总额对总额）：相等 PASS、差一分 FAIL", async () => {
    const left = { predicate: { from: "bills", select: [], agg: [{ fn: "sum", col: "amount_cents", as: "total" }], where: { op: "and" as const, conditions: [{ col: "batch", op: "=" as const, value: "2026-07" }] } } };
    const right = { predicate: { from: "expected", select: [], agg: [{ fn: "sum", col: "amount_cents", as: "total" }], where: { op: "and" as const, conditions: [{ col: "batch", op: "=" as const, value: "2026-07" }] } } };
    const pass = await runVerify(
      spec([unit({ id: "V1", checker: { type: "sql-pair", left, right, compare: { mode: "exact" } } })]),
      { runner },
    );
    expect(pass.vu[0].verdict).toBe("PASS");
    expect(pass.vu[0].evidence?.compared).toBe(1);

    const second = new SqliteRunner(seeded());
    try {
      const fail = await runVerify(
        spec([unit({ id: "V1", checker: { type: "sql-pair", left, right, compare: { mode: "tolerance_abs", value: 0.01 } } })]),
        { runner: second },
      );
      expect(fail.vu[0].verdict).toBe("PASS"); // 差 0 在容差内也是 PASS（对照）
    } finally {
      second.close();
    }
  });

  it("sql-pair 谓词侧必须恰好一列 agg、且只产出一行", async () => {
    const bad = await runVerify(
      spec([
        unit({
          id: "V1",
          checker: {
            type: "sql-pair",
            left: { predicate: { from: "bills", select: [], agg: [{ fn: "sum", col: "amount_cents" }, { fn: "count" }] } },
            right: { predicate: { from: "expected", select: [], agg: [{ fn: "sum", col: "amount_cents" }] } },
            compare: { mode: "exact" },
          },
        }),
      ]),
      { runner },
    );
    expect(bad.vu[0].verdict).toBe("ERROR");
    expect(String(bad.vu[0].evidence?.reason)).toMatch(/exactly one agg/);
  });
});

describe("r8 F2：exists / count 支持谓词形态（禁手写 sql）", () => {
  it("exists 谓词形态：命中 = PASS，未命中按 expect 反转", async () => {
    const present = await runVerify(
      spec([unit({ id: "V1", checker: { type: "exists", predicate: { from: "bills", select: [], where: { op: "and", conditions: [{ col: "batch", op: "=", value: "2026-07" }] } }, expect: true } })]),
      { runner },
    );
    expect(present.vu[0].verdict).toBe("PASS");
    const absent = await runVerify(
      spec([unit({ id: "V1", checker: { type: "exists", predicate: { from: "bills", select: [], where: { op: "and", conditions: [{ col: "batch", op: "=", value: "2099-01" }] } }, expect: false } })]),
      { runner },
    );
    expect(absent.vu[0].verdict).toBe("PASS");
  });

  it("count 谓词形态：按 where 计数并与期望比", async () => {
    const ok = await runVerify(
      spec([unit({ id: "V1", checker: { type: "count", predicate: { from: "bills", select: [], where: { op: "and", conditions: [{ col: "batch", op: "=", value: "2026-07" }] } }, op: "==", value: 2 } })]),
      { runner },
    );
    expect(ok.vu[0].verdict).toBe("PASS");
    expect(ok.vu[0].evidence?.count).toBe(2);
  });

  it("count 声明多种形态 = ERROR（必须恰好一个）", async () => {
    const bad = await runVerify(
      spec([unit({ id: "V1", checker: { type: "count", sql: "select 1", predicate: { from: "bills", select: [] }, op: "==", value: 1 } as never })]),
      { runner },
    );
    expect(bad.vu[0].verdict).toBe("ERROR");
    expect(String(bad.vu[0].evidence?.reason)).toMatch(/exactly one/);
  });
});

describe("r8 F3/F4/F5：元素同型、is null 不带值、时区规范化", () => {
  it("in / between 混型拒绝", () => {
    expect(() => renderPredicate({ from: "b", select: ["id"], where: { op: "and", conditions: [{ col: "k", op: "in", value: [1, "2"] }] } })).toThrow(/mixes numbers and strings/);
    expect(() => renderPredicate({ from: "b", select: ["id"], where: { op: "and", conditions: [{ col: "k", op: "between", value: [1, "2026-01-01"] }] } })).toThrow(/mixes numbers and strings/);
  });

  it("is null / is not null 带 value 是构造错误（不再静默忽略）", () => {
    expect(() => renderPredicate({ from: "b", select: ["id"], where: { op: "and", conditions: [{ col: "k", op: "is null", value: 1 }] } })).toThrow(/must not carry a value/);
  });

  it("带偏移的时间字面量折成 UTC Z（+08 / +0800 都认）", () => {
    const a = renderPredicate({ from: "bills", select: ["batch"], where: { op: "and", conditions: [{ col: "created", op: ">=", value: "2026-07-01T00:00:00+08:00" }] } });
    expect(a.findSql).toContain("'2026-06-30T16:00:00.000Z'");
    const b = renderPredicate({ from: "bills", select: ["batch"], where: { op: "and", conditions: [{ col: "created", op: ">=", value: "2026-07-01T00:00:00+0800" }] } });
    expect(b.findSql).toContain("'2026-06-30T16:00:00.000Z'");
  });

  it("同一批数据上带偏移与带 Z 的时间窗给出一致结论", async () => {
    const checker = (value: string) =>
      ({ type: "count" as const, predicate: { from: "bills", select: [] as string[], where: { op: "and" as const, conditions: [{ col: "created", op: ">=" as const, value }] } }, op: "==" as const, value: 2 });
    const a = await runVerify(spec([unit({ id: "V1", checker: checker("2026-07-01T00:00:00+08:00") })]), { runner });
    const b = await runVerify(spec([unit({ id: "V1", checker: checker("2026-06-30T16:00:00Z") })]), { runner });
    expect(a.vu[0].verdict).toBe(b.vu[0].verdict);
    expect(a.vu[0].evidence?.count).toBe(b.vu[0].evidence?.count);
  });
});

describe("r9 E1–E4：谓词侧键、空批、agg 归属、偏移形态", () => {
  it("E1：谓词侧键名正确（两侧 total 相对，PASS；不再出现 undefined 键）", async () => {
    const side = { predicate: { from: "bills", select: [], agg: [{ fn: "sum", col: "amount_cents", as: "total" }], where: { op: "and" as const, conditions: [{ col: "batch", op: "=" as const, value: "2026-07" }] } } };
    const r = await runVerify(
      spec([unit({ id: "V1", checker: { type: "sql-pair", left: side, right: { predicate: { ...side.predicate } }, compare: { mode: "exact" } } })]),
      { runner },
    );
    expect(r.vu[0].verdict).toBe("PASS");
    expect(r.vu[0].witness?.rows_matched).toBe(0);
  });

  it("E1：谓词侧与 rowset 侧混用 → ERROR（键空间不相交）", async () => {
    const r = await runVerify(
      spec([
        unit({
          id: "V1",
          checker: {
            type: "sql-pair",
            left: { predicate: { from: "bills", select: [], agg: [{ fn: "sum", col: "amount_cents" }] } },
            right: { table: "expected", key: "batch", value: "amount_cents" },
            compare: { mode: "exact" },
          },
        }),
      ]),
      { runner },
    );
    expect(r.vu[0].verdict).toBe("ERROR");
    expect(String(r.vu[0].evidence?.reason)).toMatch(/same shape family/);
  });

  it("E3：空批总额对总额 → NEEDS-MATERIAL（不是 PASS）", async () => {
    const side = (batch: string) => ({ predicate: { from: "bills", select: [], agg: [{ fn: "sum", col: "amount_cents", as: "total" }], where: { op: "and" as const, conditions: [{ col: "batch", op: "=" as const, value: batch }] } } });
    const r = await runVerify(
      spec([unit({ id: "V1", checker: { type: "sql-pair", left: side("2099-01"), right: side("2099-01"), compare: { mode: "exact" } } })]),
      { runner },
    );
    expect(r.vu[0].verdict).toBe("NEEDS-MATERIAL");
    expect(String(r.vu[0].evidence?.reason)).toMatch(/zero rows/);
  });

  it("E2：sql 型带 agg → ERROR；count 谓词带 agg → ERROR", async () => {
    const sqlAgg = await runVerify(
      spec([unit({ id: "V1", checker: { type: "sql", predicate: { from: "bills", select: [], agg: [{ fn: "sum", col: "amount_cents" }], where: { op: "and", conditions: [{ col: "batch", op: "=", value: "2026-07" }] } }, fail_when: "rows>0" } })]),
      { runner },
    );
    expect(sqlAgg.vu[0].verdict).toBe("ERROR");
    expect(String(sqlAgg.vu[0].evidence?.reason)).toMatch(/belongs to sql-pair/);

    const countAgg = await runVerify(
      spec([unit({ id: "V1", checker: { type: "count", predicate: { from: "bills", select: [], agg: [{ fn: "sum", col: "amount_cents" }] }, op: "==", value: 1 } })]),
      { runner },
    );
    expect(countAgg.vu[0].verdict).toBe("ERROR");
    expect(String(countAgg.vu[0].evidence?.reason)).toMatch(/must not carry agg/);
  });

  it("E4：+08（只有小时偏移）不再 NaN——与 +08:00 结论一致", async () => {
    const mk = (value: string) => ({ type: "count" as const, predicate: { from: "bills", select: [] as string[], where: { op: "and" as const, conditions: [{ col: "created", op: ">=" as const, value }] } }, op: "==" as const, value: 2 });
    const a = await runVerify(spec([unit({ id: "V1", checker: mk("2026-07-01T00:00:00+08") })]), { runner });
    const b = await runVerify(spec([unit({ id: "V1", checker: mk("2026-07-01T00:00:00+08:00") })]), { runner });
    expect(a.vu[0].verdict).toBe("PASS");
    expect(a.vu[0].evidence?.count).toBe(b.vu[0].evidence?.count);
  });
});
