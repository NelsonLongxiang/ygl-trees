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

describe("predict audit 0.79.1 — state bridge + resolved terminal state", () => {
  const db = { get: (_sql: string) => ({ c: 13 }) };

  it("measureCriterion: --state exact key binding", () => {
    expect(measureCriterion("y_imported≥12", db, { y_imported: 14 })).toEqual({ actual: "y_imported=14/12", hit: true });
    expect(measureCriterion("y_imported≥12", db, { y_imported: 3 })).toEqual({ actual: "y_imported=3/12", hit: false });
  });

  it("measureCriterion: bare key suffix-binds to nested flattened key (counts.y_imported)", () => {
    const m = measureCriterion("y_imported≥12", db, { "counts.y_imported": 14 });
    expect(m!.actual).toContain("y_imported=14/12");
    expect(m!.actual).toContain("(counts.y_imported)"); // provenance shown
    expect(m!.hit).toBe(true);
  });

  it("measureCriterion: exact match beats deeper dotted key; shallowest suffix wins on ambiguity", () => {
    // exact wins over suffix
    expect(measureCriterion("y≥5", db, { y: 7, "a.y": 1 })!.hit).toBe(true);
    // no exact: shallowest (fewest dots) suffix wins
    const m = measureCriterion("y≥5", db, { "a.b.y": 9, "a.y": 6 });
    expect(m!.actual).toContain("y=6/5 (a.y)");
  });

  it("measureCriterion: 树/kb take precedence; unknown keys stay manual(null)", () => {
    expect(measureCriterion("树≥13", db, { 树: 99 })).toEqual({ actual: "trees=13/13", hit: true });
    expect(measureCriterion("downloads≥10", db, { users: 4 })).toBeNull();
  });

  it("loadStateSource: file path → flattened numeric map; bad JSON / missing → null", async () => {
    const { loadStateSource } = await import("../src/predict");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const p = await import("node:path");
    const f = p.join(os.tmpdir(), `ygl-pstate-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify({ counts: { y_imported: 12 }, tag: "x", nested: { deep: { n: 3 } } }));
    const st = await loadStateSource(f);
    expect(st).toEqual({ "counts.y_imported": 12, "nested.deep.n": 3 }); // strings dropped, objects flattened
    expect(await loadStateSource(f + ".nope")).toBeNull();
    fs.writeFileSync(f + ".bad", "{not json");
    expect(await loadStateSource(f + ".bad")).toBeNull();
    fs.rmSync(f, { force: true }); fs.rmSync(f + ".bad", { force: true });
  });

  it("auditPredictions: resolved claim → verdict=resolved with 仲裁 hint, actual still measured", async () => {
    const rows = await auditPredictions({
      claims: [{ id: "r", text: "[预测·7天] 2026-10-10 前 树≥13", status: "supported", created: "2026-10-03 09:00:00" }],
      db,
      today: "2026-10-17",
      npmProbe: false,
    });
    expect(rows[0].verdict).toBe("resolved");
    expect(rows[0].hint).toContain("已人工仲裁：supported");
    expect(rows[0].actual).toContain("trees=13/13");
  });

  it("auditPredictions: --state bridges a criterion that DB counts can't see", async () => {
    const rows = await auditPredictions({
      claims: [{ id: "s", text: "[预测·7天] 2026-10-10 前 y_imported≥12 或 树≥99", status: "unverified", created: "2026-10-03 09:00:00" }],
      db,
      today: "2026-10-17",
      npmProbe: false,
      state: { "counts.y_imported": 14 },
    });
    expect(rows[0].verdict).toBe("hit"); // 或 semantics: state side satisfied
    expect(rows[0].actual).toContain("y_imported=14/12");
  });
});
