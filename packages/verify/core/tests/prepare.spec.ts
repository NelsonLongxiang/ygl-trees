import { describe, expect, it } from "vitest";

import { prepareSpec, type PrepareCandidate, type PrepareRunner } from "../src/prepare";
import type { ReviewFinding, ReviewRunner } from "../src/contract";

const MATERIAL = `运费对账材料（2026-07）
账单合计 1,290.40 元，申报合计 1,290.40 元。
第七行：账单金额 1290.40 元。
`;

function runnerOf(candidates: PrepareCandidate[], seen: unknown[] = []): PrepareRunner {
  return {
    async prepare(req) {
      seen.push(req);
      return candidates;
    },
  };
}

function reviewerOf(findings: (vuId: string) => ReviewFinding[]): ReviewRunner {
  return {
    async review(req) {
      return findings(req.vu.id);
    },
  };
}

const okReview = (vuId: string): ReviewFinding[] => [
  { vu_id: vuId, question: "faithful", verdict: "ok", reason: "逐字复读", anchor: { quote: "账单合计 1,290.40 元", locator: "bills!B7" } },
  { vu_id: vuId, question: "decidable", verdict: "ok", reason: "可判" },
  { vu_id: vuId, question: "not-vacuous", verdict: "ok", reason: "非空转" },
];

const goodCandidate = (overrides: Partial<PrepareCandidate> = {}): PrepareCandidate => ({
  source_clause: "账单合计 1,290.40 元",
  anchor: { quote: "账单合计 1,290.40 元", locator: "bills!B7" },
  checker: {
    type: "sql-pair",
    left: {
      predicate: {
        from: "bills",
        select: [],
        agg: [{ fn: "sum", col: "amount_cents", as: "total" }],
        where: { op: "and", conditions: [{ col: "batch", op: "=", value: "2026-07" }] },
      },
    },
    right: {
      predicate: {
        from: "declared",
        select: [],
        agg: [{ fn: "sum", col: "amount_cents", as: "total" }],
        where: { op: "and", conditions: [{ col: "batch", op: "=", value: "2026-07" }] },
      },
    },
    compare: { mode: "exact", currency: "CNY", scale: 2 },
  },
  ...overrides,
});

describe("prepare：P0–P5 流水线（零人工确认，fail-closed）", () => {
  it("P1/P2/P3 全过 + 红队过 → ready，spec 带 materials_sha256 与版本", async () => {
    const res = await prepareSpec(MATERIAL, {
      runner: runnerOf([goodCandidate()]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
    });
    expect(res.verdict).toBe("ready");
    expect(res.spec?.vu).toHaveLength(1);
    expect(res.spec?.materials_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.spec?.spec_version).toBe(1);
    expect(res.units[0].checker.type).toBe("sql-pair");
    expect(res.diagnostics.some((d) => d.stage === "P5")).toBe(true);
  });

  it("P1：source_clause 不是材料原文 → 拒（防编造判据）", async () => {
    const res = await prepareSpec(MATERIAL, {
      runner: runnerOf([goodCandidate({ source_clause: "账单合计必须等于申报合计" })]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
    });
    expect(res.verdict).toBe("needs-material");
    expect(res.rejected[0].stage).toBe("P1");
    expect(res.rejected[0].reason).toMatch(/verbatim/);
  });

  it("P1：锚点 locator 不在材料索引声明的位置 → 拒（锚错格子）", async () => {
    const res = await prepareSpec(MATERIAL, {
      runner: runnerOf([goodCandidate()]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
      materialIndex: { files: [{ path: "bills.xlsx", sha256: "x", mime: "application/vnd.ms-excel", locators: ["bills!C7"] }], text: MATERIAL },
    });
    expect(res.verdict).toBe("needs-material");
    expect(res.rejected[0].reason).toMatch(/not declared by the material index/);
  });

  it("P1：不可判措辞（应尽量/建议）→ 拒", async () => {
    const res = await prepareSpec(MATERIAL + "应尽量核对全部单据。", {
      runner: runnerOf([goodCandidate({ source_clause: "应尽量核对全部单据" })]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
    });
    expect(res.verdict).toBe("needs-material");
    expect(res.rejected[0].stage).toBe("P1");
    expect(res.rejected[0].reason).toMatch(/undecidable/);
  });

  it("P2：手写 sql 一律拒（机械 spec 只能用谓词 AST）", async () => {
    const res = await prepareSpec(MATERIAL, {
      runner: runnerOf([goodCandidate({ checker: { type: "sql", sql: "select * from bills where batch='2026-07'" } })]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
    });
    expect(res.verdict).toBe("needs-material");
    expect(res.rejected[0].stage).toBe("P2");
    expect(res.rejected[0].reason).toMatch(/hand-written sql is not allowed/);
  });

  it("P2：schema 探针里不存在的表/列 → 拒", async () => {
    const res = await prepareSpec(MATERIAL, {
      runner: runnerOf([goodCandidate()]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
      schemaProbe: { tables: { bills: ["id", "batch", "note"] } },
    });
    expect(res.verdict).toBe("needs-material");
    expect(res.rejected[0].reason).toMatch(/not in bills/);
  });

  it("P3：盲审 reject / 缺问 / 锚点非原文 都不落 ready", async () => {
    const reject = await prepareSpec(MATERIAL, {
      runner: runnerOf([goodCandidate()]),
      reviewer: reviewerOf((id) => [
        { vu_id: id, question: "faithful", verdict: "reject", reason: "anchor 指向小计而非单价" },
        { vu_id: id, question: "decidable", verdict: "ok", reason: "ok" },
        { vu_id: id, question: "not-vacuous", verdict: "ok", reason: "ok" },
      ]),
      redteam: () => [],
    });
    expect(reject.verdict).toBe("needs-material");
    expect(reject.rejected[0].stage).toBe("P3");

    const missing = await prepareSpec(MATERIAL, {
      runner: runnerOf([goodCandidate()]),
      reviewer: reviewerOf((id) => [{ vu_id: id, question: "faithful", verdict: "ok", reason: "ok", anchor: { quote: "账单合计 1,290.40 元", locator: "bills!B7" } }]),
      redteam: () => [],
    });
    expect(missing.verdict).toBe("needs-material");
    expect(missing.rejected[0].reason).toMatch(/self-review incomplete/);

    const wrongAnchor = await prepareSpec(MATERIAL, {
      runner: runnerOf([goodCandidate()]),
      reviewer: reviewerOf((id) => [
        { vu_id: id, question: "faithful", verdict: "ok", reason: "ok", anchor: { quote: "账单合计 1290.4 元", locator: "bills!B7" } },
        { vu_id: id, question: "decidable", verdict: "ok", reason: "ok" },
        { vu_id: id, question: "not-vacuous", verdict: "ok", reason: "ok" },
      ]),
      redteam: () => [],
    });
    expect(wrongAnchor.verdict).toBe("needs-material");
    expect(wrongAnchor.rejected[0].reason).toMatch(/not verbatim/);
  });

  it("无盲审器 → 不落 ready（自审是构造契约的一半）", async () => {
    const res = await prepareSpec(MATERIAL, { runner: runnerOf([goodCandidate()]), redteam: () => [] });
    expect(res.verdict).toBe("error");
    expect(res.diagnostics[0].stage).toBe("P3");
  });

  it("无红队门禁 → 不落 ready；红队失败 → ERROR", async () => {
    const noGate = await prepareSpec(MATERIAL, { runner: runnerOf([goodCandidate()]), reviewer: reviewerOf(okReview) });
    expect(noGate.verdict).toBe("error");
    expect(noGate.diagnostics[0].stage).toBe("P4");
    expect(noGate.spec).toBeUndefined();

    const failed = await prepareSpec(MATERIAL, {
      runner: runnerOf([goodCandidate()]),
      reviewer: reviewerOf(okReview),
      redteam: () => ["恒真谓词未被拒绝"],
    });
    expect(failed.verdict).toBe("error");
    expect(failed.diagnostics[0].message).toMatch(/恒真/);
    expect(failed.spec).toBeUndefined();
  });

  it("材料为空 → needs-material（P0）", async () => {
    const res = await prepareSpec("   ", { runner: runnerOf([]), reviewer: reviewerOf(okReview), redteam: () => [] });
    expect(res.verdict).toBe("needs-material");
    expect(res.diagnostics[0].stage).toBe("P0");
  });

  it("E5①：count/exists 的 sql 形态一律拒（只允许机械谓词）", async () => {
    const res = await prepareSpec(MATERIAL, {
      runner: runnerOf([
        goodCandidate({ checker: { type: "count", sql: "select count(*) as n from bills", op: "==", value: 1 } as never }),
        goodCandidate({ checker: { type: "exists", sql: "select 1 from bills" } as never }),
      ]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
    });
    expect(res.verdict).toBe("needs-material");
    expect(res.rejected.map((r) => r.reason).join(" | ")).toMatch(/sql form is not allowed in prepared specs.*sql form is not allowed/);
  });

  it("E5②：sql-pair 谓词侧也要过 schema 探针（聚合列写错不许出 spec）", async () => {
    const res = await prepareSpec(MATERIAL, {
      runner: runnerOf([goodCandidate()]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
      schemaProbe: { tables: { bills: ["id", "batch", "amount_cents"], declared: ["id", "batch", "amount"] } },
    });
    expect(res.verdict).toBe("needs-material");
    expect(res.rejected[0].reason).toMatch(/sql-pair right column "amount_cents" is not in declared/);
  });

  it("E5③：requires_execution 只属于 agent 型（事实检查器必须可重跑）", async () => {
    const res = await prepareSpec(MATERIAL, {
      runner: runnerOf([goodCandidate({ requires_execution: true })]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
    });
    expect(res.rejected[0].reason).toMatch(/requires_execution is only meaningful for agent checkers/);
  });

  it("E5④：$ 守卫收窄为 $vu:（金额字面量 '$50' 不误伤）", async () => {
    const res = await prepareSpec(MATERIAL + "备注写 $50。", {
      runner: runnerOf([
        goodCandidate({
          source_clause: "备注写 $50",
          checker: {
            type: "sql-pair",
            left: { predicate: { from: "bills", select: [], agg: [{ fn: "sum", col: "amount_cents", as: "total" }], where: { op: "and", conditions: [{ col: "batch", op: "=", value: "$50" }] } } },
            right: { predicate: { from: "declared", select: [], agg: [{ fn: "sum", col: "amount_cents", as: "total" }], where: { op: "and", conditions: [{ col: "batch", op: "=", value: "$50" }] } } },
            compare: { mode: "exact" },
          },
        }),
      ]),
      reviewer: reviewerOf((id) => [
        { vu_id: id, question: "faithful", verdict: "ok", reason: "逐字", anchor: { quote: "备注写 $50", locator: "bills!B7" } },
        { vu_id: id, question: "decidable", verdict: "ok", reason: "ok" },
        { vu_id: id, question: "not-vacuous", verdict: "ok", reason: "ok" },
      ]),
      redteam: () => [],
    });
    expect(res.verdict).toBe("ready");
  });

  it("条件④：as_of / spec_version 由调用方给，附件 sha256 落进 spec（fdc F3）", async () => {
    const res = await prepareSpec(MATERIAL, {
      runner: runnerOf([goodCandidate()]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
      asOf: { kind: "snapshot", value: "2026-07-31T23:59:59.000Z" },
      specVersion: 3,
      materialIndex: {
        text: MATERIAL,
        files: [{ path: "bills.xlsx", sha256: "a".repeat(64), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 2048, locators: ["bills!B7"] }],
      },
    });
    expect(res.verdict).toBe("ready");
    expect(res.spec?.as_of).toEqual({ kind: "snapshot", value: "2026-07-31T23:59:59.000Z" });
    expect(res.spec?.spec_version).toBe(3);
    expect(res.spec?.attachments).toEqual([
      { role: "baseline", path: "bills.xlsx", sha256: "a".repeat(64), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 2048 },
    ]);
  });
});
