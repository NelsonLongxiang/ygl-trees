import { describe, expect, it } from "vitest";

import { renderPredicate, renderScan, runVerify, type QueryRunner, type Row } from "../src/engine";
import type { Predicate, VerifySpec, VerifyUnit } from "../src/contract";

function fakeRunner(tables: Record<string, Row[]>, sqlSink?: string[]): QueryRunner {
  return {
    query(sql: string) {
      sqlSink?.push(sql);
      const m = sql.match(/from\s+([A-Za-z_][A-Za-z0-9_]*)/i);
      const rows = tables[m ? m[1] : ""] ?? [];
      if (/count\(\*\)/i.test(sql)) return [{ n: rows.length }];
      return rows;
    },
    tableRows(t) {
      return (tables[t] ?? []).length;
    },
    schemaFingerprint() {
      return "sha256:fake";
    },
  };
}

function unit(id: string, checker: VerifyUnit["checker"]): VerifyUnit {
  return { id, role: "assert", title: id, severity: "S1", source_clause: "clause", expected_from: { quote: "q", locator: "l" }, checker } as VerifyUnit;
}

function spec(vu: VerifyUnit[], extra: Partial<VerifySpec> = {}): VerifySpec {
  return {
    contract_version: "1.0",
    spec_id: "spec_predicate",
    spec_version: 1,
    title: "predicate",
    domain: "test",
    created: "2026-10-19T00:00:00.000Z",
    runtime_min: "1",
    verifier: { engine_version: "0.1.0", corpus_version: "1" },
    as_of: { kind: "snapshot", value: "2026-10-19T00:00:00.000Z" },
    vu,
    attachments: [],
    sealed: { review: false },
    ...extra,
  } as VerifySpec;
}

const pred: Predicate = {
  from: "bills",
  select: ["id", "amount_cents"],
  where: { op: "and", conditions: [{ col: "batch", op: "=", value: "2026-07" }, { col: "amount_cents", op: ">", value: 100000 }] },
};

describe("谓词 AST 渲染（同源生成）", () => {
  it("find 含判据、scope 只含扫描域（rows_scanned 是看了多少行）", () => {
    const r = renderPredicate(pred);
    expect(r.findSql).toContain("FROM bills WHERE");
    // 判据（amount < 0）只进 find：干净表 find 命中 0 行不等于「没扫到数据」
    expect(r.scopeSql).toBe("SELECT count(*) AS n FROM bills");
    // 扫描域（scan）进两侧、且逐字同渲染器
    const base = { from: "bills", select: ["id"], where: { op: "and" as const, conditions: [{ col: "amount", op: "<" as const, value: 0 }] } };
    const withScan = renderPredicate({ ...base, scan: { op: "and", conditions: [{ col: "batch", op: "=", value: "2026-07" }] } });
    expect(withScan.scopeSql).toBe("SELECT count(*) AS n FROM bills WHERE (batch = '2026-07')");
    expect(withScan.findSql).toBe("SELECT id FROM bills WHERE ((batch = '2026-07') AND (amount < 0))");
    // 域与判据同一渲染器：差异只在「有没有判据」
    expect(renderScan(base).whereSql).toBe(" WHERE (amount < 0)");
    expect(renderScan({ ...base, scan: { op: "and", conditions: [{ col: "batch", op: "=", value: "2026-07" }] } }).scanSql).toBe(" WHERE (batch = '2026-07')");
  });

  it("AND/OR/NOT 嵌套渲染成括号分组", () => {
    const r = renderPredicate({
      from: "bills",
      select: ["id"],
      where: {
        op: "or",
        conditions: [
          { col: "batch", op: "in", value: ["2026-06", "2026-07"] },
          { op: "not", conditions: [{ col: "status", op: "=", value: "void" }] },
        ],
      },
    });
    expect(r.findSql).toBe("SELECT id FROM bills WHERE (batch IN ('2026-06', '2026-07') OR NOT (status = 'void'))");
  });

  it("agg 只允许纯聚合形态（r8 F1：混排会渲染出 PG 非法 SQL）；count(*) 允许省略列", () => {
    const r = renderPredicate({
      from: "bills",
      select: [],
      agg: [{ fn: "sum", col: "amount_cents", as: "total" }, { fn: "count" }],
      where: { op: "and", conditions: [{ col: "batch", op: "=", value: "2026-07" }] },
    });
    expect(r.findSql).toBe("SELECT SUM(amount_cents) AS total, COUNT(*) AS count_all FROM bills WHERE (batch = '2026-07')");
    expect(() => renderPredicate({ from: "bills", select: ["batch"], agg: [{ fn: "count" }] })).toThrow(/mixes select columns with agg/);
  });

  it("标识符守门：拒绝表达式、子查询与注入串", () => {
    expect(() => renderPredicate({ from: "bills where 1=1 --", select: ["id"] })).toThrow(/bare identifier/);
    expect(() => renderPredicate({ from: "bills", select: ["id; drop table bills"] })).toThrow(/bare identifier/);
    expect(() => renderPredicate({ from: "bills", select: ["id"], where: { op: "and", conditions: [{ col: "id", op: "=", value: "1' OR '1'='1" }] } })).not.toThrow();
  });

  it("字符串值按 '' 转义，注入值不会改变语义结构", () => {
    const r = renderPredicate({ from: "bills", select: ["id"], where: { op: "and", conditions: [{ col: "note", op: "=", value: "x' OR '1'='1" }] } });
    expect(r.findSql).toBe("SELECT id FROM bills WHERE (note = 'x'' OR ''1''=''1')");
  });

  it("in 空数组 / between 非二元数组 / 非有限数字一律拒绝", () => {
    expect(() => renderPredicate({ from: "b", select: ["id"], where: { op: "and", conditions: [{ col: "k", op: "in", value: [] }] } })).toThrow(/non-empty array/);
    expect(() => renderPredicate({ from: "b", select: ["id"], where: { op: "and", conditions: [{ col: "k", op: "between", value: [1] }] } })).toThrow(/two-element/);
    expect(() => renderPredicate({ from: "b", select: ["id"], where: { op: "and", conditions: [{ col: "k", op: "=", value: Number.NaN }] } })).toThrow(/finite number/);
  });
});

describe("谓词形态在引擎里的行为", () => {
  it("找违规：扫到行且命中 → FAIL，witness 来自 scope 渲染查询", async () => {
    const report = await runVerify(spec([unit("V1", { type: "sql", predicate: pred })]), {
      runner: fakeRunner({ bills: [{ id: 1, amount_cents: 200000, batch: "2026-07" }] }),
      nowIso: () => "2026-10-19T00:00:00.000Z",
    });
    expect(report.vu[0].verdict).toBe("FAIL");
    expect(report.vu[0].witness?.rows_scanned).toBe(1);
  });

  it("谓词没有 where → ERROR（整表非空不能冒充扫过本批）", async () => {
    const report = await runVerify(spec([unit("V1", { type: "sql", predicate: { from: "bills", select: ["id"] } })]), {
      runner: fakeRunner({ bills: [{ id: 1 }] }),
      nowIso: () => "2026-10-19T00:00:00.000Z",
    });
    expect(report.vu[0].verdict).toBe("ERROR");
    expect(JSON.stringify(report)).toContain("vacuous-pass");
  });

  it("authored=mechanical 的手写 sql → ERROR（机械 spec 只能用 predicate）", async () => {
    const report = await runVerify(spec([unit("V1", { type: "sql", sql: "select * from bills where batch = '2026-07'", authored: "mechanical" })]), {
      runner: fakeRunner({ bills: [{ id: 1 }] }),
      nowIso: () => "2026-10-19T00:00:00.000Z",
    });
    expect(report.vu[0].verdict).toBe("ERROR");
    expect(JSON.stringify(report)).toContain("must use predicate");
  });
});

describe("W9/W10/W11/W13/W15/W16 加固", () => {
  const agentUnit = (rubric: Array<{ id: string; ask: string }>) =>
    unit("V2", { type: "agent", rubric } as VerifyUnit["checker"]);

  function runnerWith(units: VerifyUnit[]) {
    return {
      runner: fakeRunner({ bills: [{ id: 1 }] }),
      nowIso: () => "2026-10-19T00:00:00.000Z",
      materialsText: "账单总额 1290.40 元",
    };
  }

  it("W9：agent 型 rubric 为空 → NEEDS-MATERIAL（没有检查点就没有判据）", async () => {
    const report = await runVerify(spec([agentUnit([])]), {
      ...runnerWith([]),
      reviewRunner: {
        async review() {
          // 三问都给 ok，但 rubric 是空的——"没有检查点"不等于"自动通过"
          return [
            { vu_id: "V2", question: "faithful", verdict: "ok", reason: "ok", anchor: { quote: "1290.40", locator: "p1" } },
            { vu_id: "V2", question: "decidable", verdict: "ok", reason: "ok" },
            { vu_id: "V2", question: "not-vacuous", verdict: "ok", reason: "ok" },
          ] as never;
        },
      },
    });
    expect(report.vu[0].verdict).toBe("NEEDS-MATERIAL");
    expect(JSON.stringify(report)).toContain("no rubric points");
  });

  it("W11：未知结论枚举 → ERROR（'maybe' 不得被静默忽略）", async () => {
    const report = await runVerify(spec([agentUnit([{ id: "c1", ask: "q" }])]), {
      ...runnerWith([]),
      reviewRunner: {
        async review() {
          return [
            { vu_id: "V2", question: "faithful", verdict: "maybe" as never, reason: "x" },
            { vu_id: "V2", question: "decidable", verdict: "ok", reason: "ok", checkpoint: "c1" } as never,
            { vu_id: "V2", question: "not-vacuous", verdict: "ok", reason: "ok" },
          ];
        },
      },
    });
    expect(report.vu[0].verdict).toBe("ERROR");
    expect(JSON.stringify(report)).toContain("unknown verdict");
  });

  it("W10/W13：只有本 VU 的 ok findings 才能覆盖 rubric 检查点", async () => {
    const report = await runVerify(spec([agentUnit([{ id: "c1", ask: "q" }])]), {
      ...runnerWith([]),
      reviewRunner: {
        async review() {
          return [
            { vu_id: "V2", question: "faithful", verdict: "ok", reason: "ok", anchor: { quote: "1290.40", locator: "p1" } },
            { vu_id: "V2", question: "decidable", verdict: "ok", reason: "ok" },
            { vu_id: "V2", question: "not-vacuous", verdict: "ok", reason: "ok" },
            { vu_id: "OTHER", question: "faithful", verdict: "ok", reason: "x", checkpoint: "c1" },
          ];
        },
      },
    });
    expect(report.vu[0].verdict).toBe("NEEDS-MATERIAL");
    expect(JSON.stringify(report)).toContain("rubric points without an ok finding: c1");
  });

  it("W15：spec.materials_sha256 与 materialsText 不符 → ERROR", async () => {
    const report = await runVerify(spec([agentUnit([{ id: "c1", ask: "q" }])], { materials_sha256: "deadbeef" }), {
      ...runnerWith([]),
      reviewRunner: {
        async review() {
          return [
            { vu_id: "V2", question: "faithful", verdict: "ok", reason: "ok", anchor: { quote: "1290.40", locator: "p1" } },
            { vu_id: "V2", question: "decidable", verdict: "ok", reason: "ok" },
            { vu_id: "V2", question: "not-vacuous", verdict: "ok", reason: "ok", checkpoint: "c1" },
          ];
        },
      },
    });
    expect(report.vu[0].verdict).toBe("ERROR");
    expect(JSON.stringify(report)).toContain("materials hash mismatch");
  });

  it("W16：锚点复读做 NFC 归一（全角/组合字符等价），但不是模糊匹配", async () => {
    const { containsVerbatim } = await import("../src/engine");
    expect(containsVerbatim("金额 1,290.40 元", "1,290.40")).toBe(true);
    // e + 组合重音符 vs é 预组合：NFC 后等价
    expect(containsVerbatim("cafe\u0301 total", "café")).toBe(true);
    expect(containsVerbatim("总额 1290.40", "总额 1290.4 元")).toBe(false);
  });
});

describe("r11 R4：scan 域与 $ 字面量（engine 级）", () => {
  it("干净批：scan 限定批次后 find 零命中仍是 PASS，且 rows_scanned = 域内行数（不是 0）", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { openDatabaseSync } = await import("../src/sqlite-bindings");
    const { SqliteRunner } = await import("../src/sqlite-runner");
    const dir = mkdtempSync(join(tmpdir(), "ygl-scan-"));
    const dbPath = join(dir, "s.sqlite");
    const db = openDatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE bills(id TEXT, amount_cents INTEGER, batch TEXT);" +
        "INSERT INTO bills VALUES ('A1',100,'2026-07'),('A2',200,'2026-07'),('B1',-50,'2026-08');",
    );
    db.close();
    const real = new SqliteRunner(dbPath);
    const report = await runVerify(
      spec([
        unit("V1", {
          type: "sql",
          predicate: {
            from: "bills",
            select: ["id", "amount_cents"],
            scan: { op: "and", conditions: [{ col: "batch", op: "=", value: "2026-07" }] },
            where: { op: "and", conditions: [{ col: "amount_cents", op: "<", value: 0 }] },
          },
        }),
      ]),
      { runner: real, nowIso: () => "2026-10-19T00:00:00.000Z" },
    );
    // 2026-08 的违规行不在域内：本批干净 → PASS；但扫描面证明了"看过这一批"
    expect(report.overall).toBe("PASS");
    const v = report.vu[0] as { verdict: string; witness?: { rows_scanned: number; rows_matched: number } };
    expect(v.verdict).toBe("PASS");
    expect(v.witness?.rows_scanned).toBe(2);
    expect(v.witness?.rows_matched).toBe(0);
    real.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("谓词字面量里的 '$'（如 '$50'、'US$'）不触发占位符守卫", async () => {
    const rows: Row[] = [{ id: "A1", currency: "USD", note: "$50" }];
    const report = await runVerify(
      spec([
        unit("V1", {
          type: "sql",
          predicate: {
            from: "bills",
            select: ["id"],
            where: { op: "and", conditions: [{ col: "note", op: "=", value: "$50" }] },
          },
        }),
      ]),
      { runner: fakeRunner({ bills: rows }), nowIso: () => "2026-10-19T00:00:00.000Z" },
    );
    expect(report.vu[0].verdict).toBe("FAIL"); // 命中一行 → 找违规成立
    expect(JSON.stringify(report)).not.toContain("not supported");
  });
});
