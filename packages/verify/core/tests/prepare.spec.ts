import { describe, expect, it } from "vitest";

import { checkCoverage, clauseInventory, compileClausePattern, lintCandidates, prepareSpec, type PrepareCandidate, type PrepareRunner } from "../src/prepare";
import { CORPUS_VERSION, type ReviewFinding, type ReviewRunner } from "../src/contract";

/** 条件④：as_of 必须由调用方给（快照口径），测试统一钉一个确定时刻 */
const AS_OF = { kind: "snapshot" as const, value: "2026-07-01T00:00:00.000Z" };

// #34: this material numbers no criteria (`<id> <text>`), so it declares no
// clauses and coverage is not enforced on it; the #34 tests use their own.
const MATERIAL = `运费对账材料（2026-07） 账单合计 1,290.40 元，申报合计 1,290.40 元。 第七行：账单金额 1290.40 元。`;

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
    asOf: AS_OF,
      runner: runnerOf([goodCandidate()]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
    });
    expect(res.verdict).toBe("ready");
    expect(res.spec?.vu).toHaveLength(1);
    expect(res.spec?.materials_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.spec?.spec_version).toBe(1);
    // r17 P3②：prepare 必须写当前语料版本（曾硬编码 "1.0" 而 manifest 已 1.1）
    expect(res.spec?.verifier.corpus_version).toBe(CORPUS_VERSION);
    expect(res.units[0].checker.type).toBe("sql-pair");
    expect(res.diagnostics.some((d) => d.stage === "P5")).toBe(true);
  });

  it("P1：source_clause 不是材料原文 → 拒（防编造判据）", async () => {
    const res = await prepareSpec(MATERIAL, {
    asOf: AS_OF,
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
    asOf: AS_OF,
      runner: runnerOf([goodCandidate()]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
      materialIndex: { files: [{ path: "bills.xlsx", sha256: "x", mime: "application/vnd.ms-excel", locators: ["bills!C7"] }], text: MATERIAL },
    });
    expect(res.verdict).toBe("needs-material");
    expect(res.rejected[0].reason).toMatch(/not declared by the material index/);
  });

  it("#21 确定性 P1 拒跨轮不重放：1 候选 → rejected 1 条、rounds=1", async () => {
    const bad = goodCandidate({ source_clause: "账单合计必须等于申报合计" });
    const res = await prepareSpec(MATERIAL, {
      asOf: AS_OF,
      runner: runnerOf([bad]), // same candidate every round = replay scenario
      reviewer: reviewerOf(okReview),
      redteam: () => [],
    });
    expect(res.verdict).toBe("needs-material");
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].stage).toBe("P1");
    expect(res.rounds).toBe(1); // no candidate reached P3 → short-circuit
  });

  it("#21 有候选过 P3 时提前收敛，确定性拒只记一次", async () => {
    const bad = goodCandidate({ source_clause: "账单合计必须等于申报合计" });
    const res = await prepareSpec(MATERIAL, {
      asOf: AS_OF,
      runner: runnerOf([bad, goodCandidate()]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
    });
    expect(res.verdict).toBe("ready");
    expect(res.rejected.filter((r) => r.stage === "P1")).toHaveLength(1);
  });

  it("P1：不可判措辞（应尽量/建议）→ 拒", async () => {
    const res = await prepareSpec(MATERIAL + "应尽量核对全部单据。", {
    asOf: AS_OF,
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
    asOf: AS_OF,
      runner: runnerOf([goodCandidate({ checker: { type: "sql", sql: "select * from bills where batch='2026-07'" } })]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
    });
    expect(res.verdict).toBe("needs-material");
    expect(res.rejected[0].stage).toBe("P2");
    expect(res.rejected[0].reason).toMatch(/hand-written sql is not allowed/);
  });

  it("P2：未知谓词 op 是注入面 → 构造期拒绝（#19，闭集）", async () => {
    const res = await prepareSpec(MATERIAL, {
      asOf: AS_OF,
      runner: runnerOf([
        goodCandidate({
          checker: {
            type: "sql",
            predicate: {
              from: "bills",
              select: ["id"],
              where: { op: "and", conditions: [{ col: "batch", op: "= 1 OR 1=(SELECT 1)" as any, value: "x" }] },
            },
          } as any,
        }),
      ]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
    });
    expect(res.verdict).toBe("needs-material");
    expect(res.rejected[0].stage).toBe("P2");
    expect(res.rejected[0].reason).toMatch(/unknown predicate op/);
  });

  it("P2：schema 探针里不存在的表/列 → 拒", async () => {
    const res = await prepareSpec(MATERIAL, {
    asOf: AS_OF,
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
    asOf: AS_OF,
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
    asOf: AS_OF,
      runner: runnerOf([goodCandidate()]),
      reviewer: reviewerOf((id) => [{ vu_id: id, question: "faithful", verdict: "ok", reason: "ok", anchor: { quote: "账单合计 1,290.40 元", locator: "bills!B7" } }]),
      redteam: () => [],
    });
    expect(missing.verdict).toBe("needs-material");
    expect(missing.rejected[0].reason).toMatch(/self-review incomplete/);

    const wrongAnchor = await prepareSpec(MATERIAL, {
    asOf: AS_OF,
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
    const res = await prepareSpec(MATERIAL, { asOf: AS_OF, runner: runnerOf([goodCandidate()]), redteam: () => [] });
    expect(res.verdict).toBe("error");
    expect(res.diagnostics[0].stage).toBe("P3");
  });

  it("无红队门禁 → 不落 ready；红队失败 → ERROR", async () => {
    const noGate = await prepareSpec(MATERIAL, { asOf: AS_OF, runner: runnerOf([goodCandidate()]), reviewer: reviewerOf(okReview) });
    expect(noGate.verdict).toBe("error");
    expect(noGate.diagnostics[0].stage).toBe("P4");
    expect(noGate.spec).toBeUndefined();

    const failed = await prepareSpec(MATERIAL, {
    asOf: AS_OF,
      runner: runnerOf([goodCandidate()]),
      reviewer: reviewerOf(okReview),
      redteam: () => ["恒真谓词未被拒绝"],
    });
    expect(failed.verdict).toBe("error");
    expect(failed.diagnostics[0].message).toMatch(/恒真/);
    expect(failed.spec).toBeUndefined();
  });

  it("材料为空 → needs-material（P0）", async () => {
    const res = await prepareSpec("   ", { asOf: AS_OF, runner: runnerOf([]), reviewer: reviewerOf(okReview), redteam: () => [] });
    expect(res.verdict).toBe("needs-material");
    expect(res.diagnostics[0].stage).toBe("P0");
  });

  it("E5①：count/exists 的 sql 形态一律拒（只允许机械谓词）", async () => {
    const res = await prepareSpec(MATERIAL, {
    asOf: AS_OF,
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
    asOf: AS_OF,
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
    asOf: AS_OF,
      runner: runnerOf([goodCandidate({ requires_execution: true })]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
    });
    expect(res.rejected[0].reason).toMatch(/requires_execution is only meaningful for agent checkers/);
  });

  it("E5④：$ 守卫收窄为 $vu:（金额字面量 '$50' 不误伤）", async () => {
    const res = await prepareSpec(MATERIAL + "备注写 $50。", {
    asOf: AS_OF,
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

  // #34 follow-up: clauses are lines matching the declared clause pattern
  // (default `^([A-Z][0-9]+) `); titles, headings and prose are out of scope.
  const NL = String.fromCharCode(10);
  const ID_MATERIAL = [
    "# 对账验收（bills）",
    "",
    "验收对象：运费账单与申报表。",
    "",
    "## 判据",
    "",
    "S1 账面必须平衡：bills 合计等于 declared 合计。",
    "L2 金额不得为负。",
    "S3 日期必须完整。",
    "",
    "## 纪律",
    "- 本验证器只读。",
  ].join(NL);
  const clauseCand = (id: string, text: string, locator = `material.md#${id}`) =>
    goodCandidate({ source_clause: `${id} ${text}`, anchor: { quote: `${id} ${text}`, locator } });
  const ALL3 = [clauseCand("S1", "账面必须平衡：bills 合计等于 declared 合计。"), clauseCand("L2", "金额不得为负。"), clauseCand("S3", "日期必须完整。")];
  const idReview = (vuId: string): ReviewFinding[] => [
    { vu_id: vuId, question: "faithful", verdict: "ok", reason: "逐字复读", anchor: { quote: "L2 金额不得为负。", locator: "material.md#L2" } },
    { vu_id: vuId, question: "decidable", verdict: "ok", reason: "可判" },
    { vu_id: vuId, question: "not-vacuous", verdict: "ok", reason: "非空转" },
  ];
  const prep = (candidates: PrepareCandidate[], extra: Partial<Parameters<typeof prepareSpec>[1]> = {}) =>
    prepareSpec(ID_MATERIAL, { runner: runnerOf(candidates), reviewer: reviewerOf(idReview), redteam: () => [], asOf: AS_OF, ...extra });

  it("#34: headings, blank lines and prose are not clauses — a material with title + prose + ids is ready", async () => {
    const inv = clauseInventory(ID_MATERIAL);
    expect(inv.clauses.map((c) => c.id)).toEqual(["S1", "L2", "S3"]);
    const res = await prep(ALL3);
    expect(res.verdict).toBe("ready");
    expect(res.diagnostics.find((d) => d.stage === "P1c")?.message).toMatch(/3 clause\(s\) match/);
    expect(res.coverage).toMatchObject({ enforced: true, clauses: 3, covered: 3 });
  });

  it("#34: #S<n>/#L<n> resolve as clause ids, not line numbers (fleet locators)", () => {
    const lint = lintCandidates(ALL3, { materialText: ID_MATERIAL });
    expect(lint.issues).toEqual([]);
    expect(lint.ok).toBe(true);
    expect(lint.coverage).toMatchObject({ clauses: 3, covered: 3, exempted: 0, uncovered: [] });
  });

  it("#34: a dropped clause blocks ready (P1c, named by id); an exemption by id or exact text does not", async () => {
    const two = ALL3.slice(0, 2);
    const res = await prep(two);
    expect(res.verdict).toBe("error");
    expect(res.spec).toBeUndefined();
    const diag = res.diagnostics.find((d) => d.stage === "P1c");
    expect(diag?.message).toMatch(/clause S3 is not covered/);

    expect((await prep(two, { coverageExempt: [{ id: "S3", reason: "rule enforced upstream" }] })).verdict).toBe("ready");
    expect((await prep(two, { coverageExempt: [{ text: "S3 日期必须完整。", reason: "rule enforced upstream" }] })).verdict).toBe("ready");
    expect((await prep(two, { coverageExempt: [{ locator: "material.md#S3", reason: "rule enforced upstream" }] })).verdict).toBe("ready");
  });

  it("#34: exemptions never anchor on line numbers, need a reason and must name a declared clause", () => {
    const two = ALL3.slice(0, 2);
    const byLine = checkCoverage(ID_MATERIAL, two, [{ locator: "#line=9", reason: "x" }]);
    expect(byLine.problems[0]).toMatch(/line number/);
    expect(byLine.uncovered.map((u) => u.id)).toEqual(["S3"]);
    expect(checkCoverage(ID_MATERIAL, two, [{ id: "S3" }]).problems[0]).toMatch(/needs a reason/);
    expect(checkCoverage(ID_MATERIAL, two, [{ id: "S9", reason: "x" }]).problems[0]).toMatch(/names no declared clause/);
    expect(checkCoverage(ID_MATERIAL, ALL3, [{ id: "S3", reason: "x" }]).problems[0]).toMatch(/already covers/);
  });

  it("#34: a locator naming an undeclared clause is a P1 rejection that counts clauses, not lines", async () => {
    const res = await prep([...ALL3, clauseCand("S1", "账面必须平衡：bills 合计等于 declared 合计。", "material.md#S9")]);
    const r = res.rejected.find((x) => x.stage === "P1");
    expect(r?.reason).toMatch(/names clause "S9", which the frozen material does not declare \(3 clause\(s\): S1, L2, S3\)/);
    const wrong = lintCandidates([clauseCand("S1", "账面必须平衡：bills 合计等于 declared 合计。", "material.md#L2")], { materialText: ID_MATERIAL });
    expect(wrong.issues[0]).toMatchObject({ stage: "P1" });
    expect(wrong.issues[0].reason).toMatch(/is clause L2 .* not in that clause/);
  });

  it("#34: #line=<n> is the distinct line syntax; its diagnostics speak in lines", () => {
    const ok = lintCandidates([clauseCand("L2", "金额不得为负。", "material.md#line=8")], { materialText: ID_MATERIAL });
    expect(ok.issues.filter((i) => i.stage === "P1")).toEqual([]);
    expect(ok.coverage?.uncovered.map((u) => u.id)).toEqual(["S1", "S3"]);
    const far = lintCandidates([clauseCand("L2", "金额不得为负。", "#line=99")], { materialText: ID_MATERIAL });
    expect(far.issues[0].reason).toMatch(/names line 99 but the frozen material has 12 line\(s\)/);
    const blank = lintCandidates([clauseCand("L2", "金额不得为负。", "#line=2")], { materialText: ID_MATERIAL });
    expect(blank.issues[0].reason).toMatch(/line 2, which is blank/);
  });

  it("#34: a fragment quote without a resolving locator claims nothing (S1 must not cover S10)", () => {
    const text = ["S1 第一条。", "S10 第十条。"].join(NL);
    const frag = goodCandidate({ source_clause: "第一条。", anchor: { quote: "第一条。", locator: "bills!B7" } });
    const cov = checkCoverage(text, [frag]);
    expect(cov.covered).toBe(0);
    expect(checkCoverage(text, [goodCandidate({ source_clause: "S1 第一条。", anchor: { quote: "S1 第一条。", locator: "bills!B7" } })]).uncovered.map((u) => u.id)).toEqual(["S10"]);
  });

  it("#34: duplicate clause ids are a coverage problem", () => {
    const cov = checkCoverage(["S1 一。", "S1 二。"].join(NL), []);
    expect(cov.problems[0]).toMatch(/S1 is declared more than once \(lines 1 and 2\)/);
  });

  it("#34: no line matching the default pattern is a named skip (SKIP ≠ OK), never invented clauses", async () => {
    const res = await prepareSpec(MATERIAL, { runner: runnerOf([goodCandidate()]), reviewer: reviewerOf(okReview), redteam: () => [], asOf: AS_OF });
    expect(res.verdict).toBe("ready");
    expect(res.diagnostics.find((d) => d.stage === "P1c")?.message).toMatch(/^no clause lines matched pattern \^\(\[A-Z\]\+\[0-9\]\+\)  — clause coverage not enforced/);
    expect(res.coverage).toMatchObject({ enforced: false, clauses: 0 });
    const lint = lintCandidates([goodCandidate({ anchor: { quote: "账单合计 1,290.40 元", locator: "material.md#Q7" } })], { materialText: MATERIAL });
    expect(lint).toMatchObject({ ok: true, coverage_skipped: true, coverage: { enforced: false, clauses: 0 } });
    // a gate that reads issues sees the skip: one COVERAGE warning (not a rejection, so ok stays the prepare projection)
    expect(lint.issues).toEqual([expect.objectContaining({ stage: "COVERAGE", level: "warning", reason: expect.stringMatching(/^no clause lines matched pattern/) })]);
    expect(lintCandidates(ALL3, { materialText: ID_MATERIAL }).coverage_skipped).toBe(false);
  });

  it("#34: a declared pattern that matches no line is an error, not a skip", async () => {
    const res = await prepareSpec(MATERIAL, {
      runner: runnerOf([goodCandidate()]),
      reviewer: reviewerOf(okReview),
      redteam: () => [],
      asOf: AS_OF,
      clausePattern: compileClausePattern("^(R-[0-9]+)：") as RegExp,
      clausePatternDeclared: true,
    });
    expect(res.verdict).toBe("error");
    expect(res.diagnostics.find((d) => d.stage === "P1c")?.message).toMatch(/no clause lines matched pattern .* misconfiguration/);
    const lint = lintCandidates([goodCandidate()], { materialText: MATERIAL, clausePattern: compileClausePattern("^(R-[0-9]+)：") as RegExp, clausePatternDeclared: true });
    expect(lint.ok).toBe(false);
    expect(lint.coverage_skipped).toBe(false);
  });

  it("#34: the default convention is letters + digits (^[A-Z]+[0-9]+ )", () => {
    expect(clauseInventory(["AB12 多字母 id。", "S1 单字母。", "s2 小写不算。", "S3: 冒号不算。"].join(NL)).clauses.map((c) => c.id)).toEqual(["AB12", "S1"]);
  });

  it("#34: a declared clause pattern replaces the default convention; a pattern without a capture group is refused", () => {
    const text = ["R-1：账面必须平衡。", "R-2：金额不得为负。"].join(NL);
    const pattern = compileClausePattern("^(R-[0-9]+)：");
    expect(pattern).toBeInstanceOf(RegExp);
    const cand = goodCandidate({ source_clause: "R-1：账面必须平衡。", anchor: { quote: "R-1：账面必须平衡。", locator: "material.md#R-1" } });
    const lint = lintCandidates([cand], { materialText: text, clausePattern: pattern as RegExp });
    expect(lint.coverage).toMatchObject({ clauses: 2, covered: 1 });
    expect(lint.coverage?.uncovered[0].id).toBe("R-2");
    expect(compileClausePattern("^R-[0-9]+：")).toMatch(/capture group/);
    expect(compileClausePattern("(")).toMatch(/not a valid regular expression/);
  });

  it("#34: an orphan review (no candidate carries its source_clause) blocks ready", async () => {
    const res = await prep(ALL3, { reviewedClauses: [...ALL3.map((c) => c.source_clause), "S4 已删除的判据。"] });
    expect(res.verdict).toBe("error");
    expect(res.diagnostics.find((d) => d.stage === "P3")?.message).toMatch(/orphan review/);
    expect((await prep(ALL3, { reviewedClauses: ALL3.map((c) => c.source_clause) })).verdict).toBe("ready");
  });
});
