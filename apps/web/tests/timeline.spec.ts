import { describe, it, expect } from "vitest";
import {
  SERIES, dayTickIndexes, fillDays, fmtDay, labelledColumns, niceTicks, stackColumns, type TimelineRow,
} from "../src/timeline";

/** Overview activity timeline (user direction 2026-10-20: UI + sensible visualisation). Pure helpers; the SVG only draws these. */

const row = (day: string, research = 0, tree = 0, ev = 0, other = 0): TimelineRow => ({ day, research, tree, eval: ev, other });

describe("fillDays", () => {
  const today = new Date("2026-10-20T15:00:00Z");

  it("yields one column per UTC day, oldest first, zeros where the server sent no row", () => {
    const out = fillDays([row("2026-10-18", 3), row("2026-10-20", 0, 1)], 5, today);
    expect(out.map((r) => r.day)).toEqual(["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20"]);
    expect(out[2]).toEqual(row("2026-10-18", 3));
    expect(out[4]).toEqual(row("2026-10-20", 0, 1));
    expect(out[0]).toEqual(row("2026-10-16"));
  });

  it("ignores rows outside the window and survives an empty payload", () => {
    const out = fillDays([row("2026-09-01", 9), row("2027-01-01", 9)], 3, today);
    expect(out.every((r) => r.research === 0)).toBe(true);
    expect(fillDays([], 3, today)).toHaveLength(3);
  });
});

describe("stackColumns", () => {
  it("stacks in SERIES order (research → tree → eval → other) and drops zero segments", () => {
    const [c] = stackColumns([row("2026-10-20", 2, 1, 0, 4)]);
    expect(SERIES).toEqual(["research", "tree", "eval", "other"]);
    expect(c.total).toBe(7);
    expect(c.segments.map((s) => [s.key, s.y0, s.y1])).toEqual([
      ["research", 0, 2],
      ["tree", 2, 3],
      ["other", 3, 7],
    ]);
  });

  it("treats missing or negative counts as zero", () => {
    const [c] = stackColumns([{ day: "2026-10-20", research: -1, tree: NaN as unknown as number, eval: 2, other: 0 }]);
    expect(c.total).toBe(2);
    expect(c.segments).toEqual([{ key: "eval", value: 2, y0: 0, y1: 2 }]);
  });
});

describe("niceTicks", () => {
  it("picks 1/2/5 steps and always starts at 0", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(23)).toEqual([0, 10, 20, 30]);
    expect(niceTicks(1200)).toEqual([0, 500, 1000, 1500]);
  });
});

describe("labels", () => {
  it("date ticks: first column, then every 7th", () => {
    expect(dayTickIndexes(30)).toEqual([0, 7, 14, 21, 28]);
    expect(fmtDay("2026-10-20")).toBe("10-20");
  });

  it("direct labels only on the peak day and the latest active day", () => {
    const cols = stackColumns([row("d1", 5), row("d2", 9), row("d3", 1), row("d4")]);
    expect([...labelledColumns(cols)].sort()).toEqual([1, 2]);
    expect(labelledColumns(stackColumns([row("d1"), row("d2")])).size).toBe(0);
  });
});
