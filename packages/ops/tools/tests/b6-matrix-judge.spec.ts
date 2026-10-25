/**
 * B6 门禁矩阵判定逻辑（fail-closed 口径）。
 *
 * 矩阵 runner 的判定规则必须可单测（不依赖真跑 unit/demo）：
 *  - strict 模式：SQLite 腿 pass 且 PG 腿 pass（skipped 不算绿）
 *  - 探险模式：SQLite 腿 pass 即可，但 PG 腿 skipped 必须显式呈现
 *  - 任一腿 fail → overall fail
 */
import { describe, it, expect } from "vitest";

/** 与 dual-backend-matrix.mjs 相同的判定规则（复制语义以便单测；脚本自身是执行面）。 */
function judge(legs: Array<{ backend: string; status: "pass" | "fail" | "skipped" }>, strict: boolean) {
  const sqlite = legs.find((l) => l.backend === "sqlite");
  const pg = legs.find((l) => l.backend === "pg");
  const sqliteOk = sqlite?.status === "pass";
  const pgOk = pg?.status === "pass";
  const overallOk = strict ? sqliteOk && pgOk : sqliteOk;
  return { overallOk, sqliteOk, pgOk, pgSkipped: pg?.status === "skipped" };
}

describe("B6 dual-backend matrix judgement (fail-closed)", () => {
  it("strict + both green → pass", () => {
    expect(judge([{ backend: "sqlite", status: "pass" }, { backend: "pg", status: "pass" }], true).overallOk).toBe(true);
  });

  it("strict + PG skipped → fail (not run is not green)", () => {
    const r = judge([{ backend: "sqlite", status: "pass" }, { backend: "pg", status: "skipped" }], true);
    expect(r.overallOk).toBe(false);
    expect(r.pgSkipped).toBe(true);
  });

  it("strict + PG fail → fail even if SQLite green", () => {
    expect(judge([{ backend: "sqlite", status: "pass" }, { backend: "pg", status: "fail" }], true).overallOk).toBe(false);
  });

  it("exploratory + PG skipped → pass (SQLite leg only), skip is surfaced", () => {
    const r = judge([{ backend: "sqlite", status: "pass" }, { backend: "pg", status: "skipped" }], false);
    expect(r.overallOk).toBe(true);
    expect(r.pgSkipped).toBe(true);
  });

  it("SQLite leg fail → fail in both modes", () => {
    expect(judge([{ backend: "sqlite", status: "fail" }, { backend: "pg", status: "pass" }], true).overallOk).toBe(false);
    expect(judge([{ backend: "sqlite", status: "fail" }, { backend: "pg", status: "skipped" }], false).overallOk).toBe(false);
  });
});
