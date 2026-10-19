import { describe, expect, it } from "vitest";

import { loadCases, runCorpus } from "../corpus/run";

describe("corpus: 七型语料骨架（契约 §3，G2 起点）", () => {
  it("语料目录覆盖七种 checker 型", () => {
    const types = new Set(loadCases().map((c) => String(c.meta.checker)));
    for (const t of ["sql", "sql-pair", "count", "exists", "file", "command", "agent"]) {
      expect(types.has(t), `corpus missing checker type: ${t}`).toBe(true);
    }
  });

  it("每个案例的实跑结果与 expected-report.json 投影一致", async () => {
    const runs = await runCorpus();
    expect(runs.length).toBeGreaterThanOrEqual(7);
    const bad = runs.filter((r) => r.diffs.length);
    expect(bad.map((r) => `${r.name}: ${r.diffs.join("; ")}`)).toEqual([]);
  });
});
