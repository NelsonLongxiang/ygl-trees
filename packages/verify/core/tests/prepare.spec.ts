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
    type: "sql",
    predicate: {
      from: "bills",
      select: [],
      agg: [{ fn: "sum", col: "amount_cents", as: "total" }],
      where: { op: "and", conditions: [{ col: "batch", op: "=", value: "2026-07" }] },
    },
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
    expect(res.units[0].checker.type).toBe("sql");
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
    expect(res.verdict).toBe("needs-material");
    expect(res.diagnostics[0].stage).toBe("P3");
  });

  it("无红队门禁 → 不落 ready；红队失败 → ERROR", async () => {
    const noGate = await prepareSpec(MATERIAL, { runner: runnerOf([goodCandidate()]), reviewer: reviewerOf(okReview) });
    expect(noGate.verdict).toBe("needs-material");
    expect(noGate.diagnostics[0].stage).toBe("P4");

    const failed = await prepareSpec(MATERIAL, {
      runner: runnerOf([goodCandidate()]),
      reviewer: reviewerOf(okReview),
      redteam: () => ["恒真谓词未被拒绝"],
    });
    expect(failed.verdict).toBe("error");
    expect(failed.diagnostics[0].message).toMatch(/恒真/);
  });

  it("材料为空 → needs-material（P0）", async () => {
    const res = await prepareSpec("   ", { runner: runnerOf([]), reviewer: reviewerOf(okReview), redteam: () => [] });
    expect(res.verdict).toBe("needs-material");
    expect(res.diagnostics[0].stage).toBe("P0");
  });
});
