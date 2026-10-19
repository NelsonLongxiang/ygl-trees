import { describe, expect, it } from "vitest";

import { loadCases, runCorpus } from "../corpus/run";

describe("corpus: 七型语料骨架（契约 §3，G2 起点）", () => {
  it("语料目录覆盖七种 checker 型", () => {
    const types = new Set(loadCases().map((c) => String(c.meta.checker)));
    for (const t of ["sql", "sql-pair", "count", "exists", "file", "command", "agent"]) {
      expect(types.has(t), `corpus missing checker type: ${t}`).toBe(true);
    }
  });

  it("红队案例各自钉死拒绝理由（G3：逐例断言，不做 join 匹配）", () => {
    const throws = loadCases().filter((c) => Boolean(c.meta.expect_throw));
    expect(throws.length).toBeGreaterThanOrEqual(6);
    const patterns = throws.map((c) => String(c.meta.expect_throw));
    for (const want of ["no assert", "time function", "not supported", "as_of", "not the one being checked"]) {
      expect(patterns.join("|"), `missing red-team pattern: ${want}`).toContain(want);
    }
  });

  it("红队违规案例分别落在 ERROR / NEEDS-MATERIAL 两类", async () => {
    const runs = await runCorpus();
    const byName = new Map(runs.map((r) => [r.name, r.report.overall]));
    expect(byName.get("red-vacuous-no-where")).toBe("ERROR");
    expect(byName.get("red-wrong-batch-zero-scan")).toBe("NEEDS-MATERIAL");
    expect(byName.get("red-duplicate-key")).toBe("ERROR");
  });

  it("每个案例的实跑结果与 expected-report.json 投影一致", async () => {
    const runs = await runCorpus();
    expect(runs.length).toBeGreaterThanOrEqual(12);
    const bad = runs.filter((r) => r.diffs.length);
    expect(bad.map((r) => `${r.name}: ${r.diffs.join("; ")}`)).toEqual([]);
  });
});
