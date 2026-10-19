import { describe, expect, it } from "vitest";

import { compareValues, toMinorUnits, validateCompareSpec } from "../src/compare";

describe("compare: CompareSpec 契约（评审 B5）", () => {
  it("货币按最小单位整数比较，浮点陷阱不误判", () => {
    const spec = { mode: "exact" as const, currency: "CNY", scale: 2 };
    expect(compareValues(0.1 + 0.2, 0.3, spec)).toEqual({ equal: true });
    expect(toMinorUnits(1290.4, 2)).toBe(129040);
    expect(compareValues(412.5, 412.49, spec)).toEqual({ equal: false });
  });

  it("容差模式：abs 用绝对值、rel 用相对值、必须非负", () => {
    expect(compareValues(1204.0, 1204.01, { mode: "tolerance_abs", value: 0.01 })).toEqual({ equal: true });
    expect(compareValues(1204.0, 1204.02, { mode: "tolerance_abs", value: 0.01 })).toEqual({ equal: false });
    expect(compareValues(2.35, 2.36, { mode: "tolerance_rel", value: 0.01 })).toEqual({ equal: true });
    expect(compareValues(2.35, 2.4, { mode: "tolerance_rel", value: 0.01 })).toEqual({ equal: false });
    expect(compareValues(1, 1, { mode: "tolerance_abs", value: -1 })).toMatchObject({ error: expect.stringContaining("invalid tolerance") });
  });

  it("NULL 默认 error（NULL ≠ 0，不静默放过）；equal/ignore 显式才放行", () => {
    expect(compareValues(null, 0, { mode: "exact" })).toMatchObject({ error: expect.stringContaining("null value") });
    expect(compareValues(null, null, { mode: "exact" })).toEqual({ equal: true });
    expect(compareValues(null, 0, { mode: "exact", null: "ignore" })).toEqual({ equal: true });
  });

  it("window 模式缺 unit 即构造错误", () => {
    expect(validateCompareSpec({ mode: "window", value: 7 })).toContain("window requires unit (d|h|s)");
    expect(validateCompareSpec({ mode: "window", value: 7, unit: "d" })).toEqual([]);
  });

  it("subset/superset/range/regex 语义", () => {
    expect(compareValues("a,b", "a,b,c", { mode: "subset" })).toEqual({ equal: true });
    expect(compareValues("a,b,c", "a,b", { mode: "subset" })).toEqual({ equal: false });
    expect(compareValues("a,b,c", "a,b", { mode: "superset" })).toEqual({ equal: true });
    expect(compareValues(5, undefined, { mode: "range", value: 0, value_max: 10 })).toEqual({ equal: true });
    expect(compareValues(15, undefined, { mode: "range", value: 0, value_max: 10 })).toEqual({ equal: false });
    expect(compareValues("INV-2026-1187", "^INV-\\d{4}-\\d+$", { mode: "regex" })).toEqual({ equal: true });
  });

  it("cardinality 1:N 必须带 agg（构造守卫）", () => {
    expect(validateCompareSpec({ mode: "exact", cardinality: "1:N" })).toContain('cardinality "1:N" requires agg (sum|max|min)');
    expect(validateCompareSpec({ mode: "exact", cardinality: "1:N", agg: "sum" })).toEqual([]);
  });
});
