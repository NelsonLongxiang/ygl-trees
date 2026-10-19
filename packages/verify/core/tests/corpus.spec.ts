import { describe, expect, it } from "vitest";

import { loadCases, runCorpus } from "../corpus/run";

describe("corpus: 七型语料骨架（契约 §3，G2 起点）", () => {
  it("语料目录覆盖七种 checker 型", () => {
    const types = new Set(loadCases().map((c) => String(c.meta.checker)));
    for (const t of ["sql", "sql-pair", "count", "exists", "file", "command", "agent"]) {
      expect(types.has(t), `corpus missing checker type: ${t}`).toBe(true);
    }
  });

  it("红队案例覆盖四类构造期拒绝（G3 起点）", () => {
    const throws = loadCases().filter((c) => Boolean(c.meta.expect_throw));
    expect(throws.length).toBeGreaterThanOrEqual(3);
    const patterns = throws.map((c) => String(c.meta.expect_throw));
    expect(patterns.join("|")).toMatch(/no assert|time function|not supported/);
  });

  it("每个案例的实跑结果与 expected-report.json 投影一致", async () => {
    const runs = await runCorpus();
    expect(runs.length).toBeGreaterThanOrEqual(12);
    const bad = runs.filter((r) => r.diffs.length);
    expect(bad.map((r) => `${r.name}: ${r.diffs.join("; ")}`)).toEqual([]);
  });
});
