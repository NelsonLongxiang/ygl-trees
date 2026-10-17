import { describe, it, expect } from "vitest";
import { parsePrediction, measureCriterion, auditPredictions } from "../src/predict";

describe("predict backtest pipeline (pred-val/backtest-pipeline)", () => {
  it("parsePrediction: explicit date wins", () => {
    const { horizon, deadline } = parsePrediction("[预测·7天] 2026-10-24 前 npm 再发 ≥3 个版本——基线 0.77.0");
    expect(horizon).toBe("7天");
    expect(deadline).toBe("2026-10-24");
  });

  it("parsePrediction: infers deadline from created + horizon days", () => {
    const { deadline } = parsePrediction("[预测·90天] npm 周下载超 10", "2026-10-16 10:00:00");
    expect(deadline).toBe("2027-01-14");
  });

  it("parsePrediction: no date, no created → empty deadline", () => {
    expect(parsePrediction("[预测·90天] something").deadline).toBe("");
  });

  const db = {
    get: (_sql: string) => ({ c: 13 }),
  };
  it("measureCriterion: 树/kb with 或 semantics", () => {
    expect(measureCriterion("树≥13 或 kb≥30", db)).toEqual({ actual: "trees=13/13 · kb=13/30", hit: true });
    expect(measureCriterion("树≥20", db)).toEqual({ actual: "trees=13/20", hit: false });
  });

  it("measureCriterion: non-local criterion → null (manual)", () => {
    expect(measureCriterion("npm 周下载量超过 10", db)).toBeNull();
  });

  it("auditPredictions: verdicts hit/miss/pending/manual + criterion anchored at date", async () => {
    const rows = await auditPredictions({
      claims: [
        { id: "a", text: "[预测·7天] 2026-10-10 前 树≥13 或 kb≥30", status: "unverified", created: "2026-10-03 09:00:00" },
        { id: "b", text: "[预测·7天] 2026-10-10 前 树≥99", status: "unverified", created: "2026-10-03 09:00:00" },
        { id: "c", text: "[预测·7天] 2026-12-01 前 树≥99", status: "unverified", created: "2026-11-24 09:00:00" },
        { id: "d", text: "[预测·90天] 三支柱理论被外部引用", status: "unverified", created: "2026-10-16 10:00:00" },
      ],
      db,
      today: "2026-10-17",
      npmProbe: false,
    });
    expect(rows.find((r) => r.claim_id === "a")).toMatchObject({ verdict: "hit", criterion: "树≥13 或 kb≥30" });
    expect(rows.find((r) => r.claim_id === "b")).toMatchObject({ verdict: "miss" });
    expect(rows.find((r) => r.claim_id === "c")).toMatchObject({ verdict: "pending" });
    const d = rows.find((r) => r.claim_id === "d")!;
    expect(d.verdict).toBe("manual");
    expect(d.deadline).toBe("2027-01-14");
  });

  it("auditPredictions: pending + already-hit gets 已达标 marker", async () => {
    const rows = await auditPredictions({
      claims: [{ id: "x", text: "[预测·7天] 2026-12-01 前 树≥13", status: "unverified", created: "2026-11-24 09:00:00" }],
      db,
      today: "2026-11-25",
      npmProbe: false,
    });
    expect(rows[0].verdict).toBe("pending");
    expect(rows[0].actual).toContain("已达标");
  });
});
