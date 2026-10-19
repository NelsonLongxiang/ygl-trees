import { describe, expect, it } from "vitest";

import { foldOverall, runVerify, topoOrder, type QueryRunner, type Row } from "../src/engine";
import type { VerifySpec, VerifyUnit } from "../src/contract";

function fakeRunner(tables: Record<string, Row[]>): QueryRunner {
  return {
    query(sql: string) {
      const m = sql.match(/from\s+([A-Za-z_][A-Za-z0-9_]*)/i);
      const table = m ? m[1] : "";
      const rows = tables[table] ?? [];
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

function spec(vu: VerifyUnit[]): VerifySpec {
  return {
    contract_version: "1.0",
    spec_id: "spec_test",
    spec_version: 1,
    verifier: { engine_version: "0.1.0", corpus_version: "1.0" },
    as_of: { kind: "snapshot", value: "2026-10-19T00:00:00.000Z" },
    attachments: [],
    sealed: { review: false },
    vu,
  };
}

describe("engine: 防空洞与折叠（评审 B1/B2/R1/R4）", () => {
  it("空表上的 sql 断言绝不落 PASS，降级 NEEDS-MATERIAL 并带 witness", async () => {
    const report = await runVerify(
      spec([unit({ id: "V1", checker: { type: "sql", sql: "select * from freight_bill where batch='2026-10'", fail_when: "rows>0" } })]),
      { runner: fakeRunner({ freight_bill: [] }) },
    );
    expect(report.overall).toBe("NEEDS-MATERIAL");
    const r = report.vu[0];
    expect(r.verdict).toBe("NEEDS-MATERIAL");
    expect(r.witness?.rows_scanned).toBe(0);
    expect(r.checker_type).toBe("sql");
  });

  it("有数据但无违规行 → PASS（fail_when=rows>0 的 matched=0 不是空洞）", async () => {
    const runner: QueryRunner = {
      query: () => [],
      tableRows: (t) => (t === "freight_bill" ? 5 : 0),
      schemaFingerprint: () => "sha256:fake",
    };
    const report = await runVerify(
      spec([unit({ id: "V1", checker: { type: "sql", sql: "select * from freight_bill where batch='2026-10'", fail_when: "rows>0" } })]),
      { runner },
    );
    expect(report.overall).toBe("PASS");
    expect(report.vu[0].witness?.rows_scanned).toBe(5);
    expect(report.vu[0].witness?.rows_matched).toBe(0);
  });

  it("overall 折叠：FAIL > NEEDS-MATERIAL > ERROR > PASS，只算 assert", () => {
    const mk = (id: string, verdict: string, role = "assert") =>
      ({ id, role, verdict, severity: "S1", source_clause: "c", checker_type: "sql" }) as never;
    expect(foldOverall([mk("a", "PASS"), mk("b", "ERROR")]).overall).toBe("ERROR");
    expect(foldOverall([mk("a", "ERROR"), mk("b", "NEEDS-MATERIAL")]).overall).toBe("NEEDS-MATERIAL");
    expect(foldOverall([mk("a", "NEEDS-MATERIAL"), mk("b", "FAIL")]).overall).toBe("FAIL");
    expect(foldOverall([mk("s", "ERROR", "source"), mk("a", "PASS")]).overall).toBe("PASS");
  });

  it("管线环检测直接报错（不静默跳过）", () => {
    const a = unit({ id: "A", checker: { type: "sql", sql: "select * from t from $vu:B" } });
    const b = unit({ id: "B", checker: { type: "sql", sql: "select * from t from $vu:A" } });
    const r = topoOrder([a, b]);
    expect("cycle" in r).toBe(true);
  });

  it("count from 上游行集：scanned=上游行数、matched=计数（R2 形状闭合）", async () => {
    const report = await runVerify(
      spec([
        unit({ id: "SRC", role: "source", checker: { type: "sql", sql: "select * from bills" } }),
        unit({ id: "C1", checker: { type: "count", from: "$vu:SRC", op: ">=", value: 1 } }),
      ]),
      { runner: fakeRunner({ bills: [{ id: 1 }, { id: 2 }] }) },
    );
    const c1 = report.vu.find((r) => r.id === "C1")!;
    expect(c1.verdict).toBe("PASS");
    expect(c1.witness?.rows_scanned).toBe(2);
    expect(c1.witness?.rows_matched).toBe(2);
  });

  it("sql-pair 1:1 重复键 → ERROR（fan-out 不静默）", async () => {
    const report = await runVerify(
      spec([
        unit({
          id: "P1",
          checker: {
            type: "sql-pair",
            left: { from: "$vu:SRC", key: "id", value: "amount" } as never,
            right: { table: "bill", key: "id", value: "amount" } as never,
            compare: { mode: "exact", currency: "CNY", scale: 2 },
          },
        }),
        unit({ id: "SRC", role: "source", checker: { type: "sql", sql: "select * from bills" } }),
      ]),
      { runner: fakeRunner({ bills: [{ id: 1, amount: 1 }, { id: 1, amount: 2 }], bill: [{ id: 1, amount: 1 }] }) },
    );
    const p1 = report.vu.find((r) => r.id === "P1")!;
    expect(p1.verdict).toBe("ERROR");
    expect(String(p1.evidence?.reason)).toContain("duplicate key");
  });
});

describe("engine: 评审 a–f 实现缺口守卫", () => {
  it("a) source 取数失败不吞：source=ERROR 且下游级联 ERROR", async () => {
    const runner: QueryRunner = {
      query(sql: string) {
        if (/from\s+bad_src/i.test(sql)) throw new Error("no such table: bad_src");
        return [{ v: 1 }];
      },
      tableRows() { return 1; },
      schemaFingerprint() { return "sha256:fake"; },
    };
    const report = await runVerify(
      spec([
        unit({ id: "S1", role: "source", outputs: ["rows"], checker: { type: "sql", sql: "select * from bad_src" } }),
        unit({ id: "V1", checker: { type: "count", from: "$vu:S1", op: ">=", value: 1 } }),
      ]),
      { runner },
    );
    expect(report.vu.find((v) => v.id === "S1")?.verdict).toBe("ERROR");
    expect(report.vu.find((v) => v.id === "V1")?.verdict).toBe("ERROR");
  });

  it("e) 没有 assert 的规范在构造期拒绝（不允许空规范判 PASS）", async () => {
    await expect(
      runVerify(spec([unit({ id: "S1", role: "source", checker: { type: "sql", sql: "select * from t where x=1" } })]), {
        runner: fakeRunner({ t: [{ x: 1 }] }),
      }),
    ).rejects.toThrow(/no assert/i);
  });

  it("c) schema 指纹漂移 → ERROR 并记 schema_drift", async () => {
    const s = spec([unit({ id: "V1", checker: { type: "sql", sql: "select * from t where x=1", fail_when: "rows>0" } })]);
    s.schema_fingerprint = "sha256:frozen_before_prepare";
    const report = await runVerify(s, { runner: fakeRunner({ t: [{ x: 1 }] }) });
    const r = report.vu[0];
    expect(r.verdict).toBe("ERROR");
    expect(JSON.stringify(r.evidence ?? {})).toContain("schema_drift");
  });

  it("② sql 找违规缺 WHERE 且无 scope_sql → ERROR（构造守卫）", async () => {
    const report = await runVerify(
      spec([unit({ id: "V1", checker: { type: "sql", sql: "select * from t", fail_when: "rows>0" } })]),
      { runner: fakeRunner({ t: [{ x: 1 }] }) },
    );
    expect(report.vu[0].verdict).toBe("ERROR");
  });

  it("R13 sql 出现 now()/current_timestamp → 构造期拒绝", async () => {
    await expect(
      runVerify(
        spec([unit({ id: "V1", checker: { type: "sql", sql: "select * from t where created < current_timestamp", fail_when: "rows>0" } })]),
        { runner: fakeRunner({ t: [] }) },
      ),
    ).rejects.toThrow(/time function|as_of/i);
  });
});
