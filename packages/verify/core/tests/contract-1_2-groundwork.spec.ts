/**
 * 契约 1.2 地面工程测试（类型/构造校验/渲染）。
 *
 * 版本仍是 1.1：这些形态在 runVerify 入口会被版本闸拒绝（1.1 spec 携带 1.2
 * 形态 → `version_shape`），语料与 Rust mirror 在 0.107.0 补齐后整体升 1.2。
 * 本文件钉住「渲染与构造拒绝」这一层，防止地面工程在升版前悄悄漂移。
 */
import { describe, expect, it } from "vitest";

import { renderPredicate, renderScan, runVerify, type QueryRunner, type Row } from "../src/engine";
import type { Predicate, VerifySpec } from "../src/contract";

function fakeRunner(tables: Record<string, Row[]> = {}): QueryRunner {
  return {
    query(sql: string) {
      const m = sql.match(/from\s+([A-Za-z_][A-Za-z0-9_]*)/i);
      return tables[m ? m[1] : ""] ?? [];
    },
    tableRows(t) {
      return (tables[t] ?? []).length;
    },
    schemaFingerprint: () => "sha256:fake",
  };
}

const colCol: Predicate = {
  from: "bills",
  select: ["id"],
  where: { op: "and", conditions: [{ col: "paid_cents", op: ">", value: { col: "due_cents" } }] },
};

describe("契约 1.2：col-to-col（构造期）", () => {
  it("同表列引用渲染为裸标识符", () => {
    expect(renderPredicate(colCol).findSql).toContain("paid_cents > due_cents");
  });

  it("带表限定但同表 → 允许，渲染去掉限定", () => {
    const p: Predicate = {
      from: "bills",
      select: ["id"],
      where: { op: "and", conditions: [{ col: "paid_cents", op: ">", value: { col: "bills.due_cents" } }] },
    };
    expect(renderPredicate(p).findSql).toContain("paid_cents > due_cents");
  });

  it("跨表列引用 → 构造期拒绝，点名 sql-pair 出路", () => {
    const p: Predicate = {
      from: "bills",
      select: ["id"],
      where: { op: "and", conditions: [{ col: "paid_cents", op: ">", value: { col: "policy.limit_cents" } }] },
    };
    expect(() => renderPredicate(p)).toThrow(/cross_table_col[\s\S]*sql-pair/);
  });

  it("is null / is not null 不接受 {col} 右值（null_rhs_for_null_op）", () => {
    const p: Predicate = {
      from: "bills",
      select: ["id"],
      where: { op: "and", conditions: [{ col: "paid_cents", op: "is null", value: { col: "due_cents" } }] },
    };
    expect(() => renderPredicate(p)).toThrow(/null_rhs_for_null_op/);
  });

  it("scan 域里的列引用同样走同表规则", () => {
    const p: Predicate = {
      from: "bills",
      select: ["id"],
      scan: { op: "and", conditions: [{ col: "batch", op: ">", value: { col: "bills.min_batch" } }] },
    };
    expect(renderScan(p).scanSql).toContain("batch > min_batch");
  });
});

describe("契约 1.2：版本闸（1.1 spec 不得携带 1.2 形态）", () => {
  const baseSpec = (vu: VerifySpec["vu"]): VerifySpec =>
    ({
      contract_version: "1.1",
      spec_id: "spec_v12_ground",
      spec_version: 1,
      verifier: { engine_version: "0.1.0", corpus_version: "1.1" },
      as_of: { kind: "snapshot", value: "2026-10-19T00:00:00.000Z" },
      attachments: [],
      sealed: { review: false },
      vu,
    }) as VerifySpec;

  const vuWith = (checker: Record<string, unknown>) =>
    ({
      id: "V1",
      role: "assert",
      title: "V1",
      severity: "S1",
      source_clause: "clause",
      expected_from: { quote: "q", locator: "l" },
      checker,
    }) as VerifySpec["vu"][number];

  it("1.1 + count.against → version_shape（入口拒绝，不产报告）", async () => {
    const spec = baseSpec([
      vuWith({ type: "count", predicate: { from: "executions", select: ["id"] }, against: { from: "policy", col: "max_executions", agg: "max" }, op: ">" }),
    ]);
    await expect(runVerify(spec, { runner: fakeRunner() })).rejects.toThrow(/version_shape/);
  });

  it("1.1 + {col} 右值 → version_shape", async () => {
    const spec = baseSpec([vuWith({ type: "sql", predicate: colCol })]);
    await expect(runVerify(spec, { runner: fakeRunner() })).rejects.toThrow(/version_shape/);
  });
});
