/**
 * CompareSpec 求值器（评审 B5）——所有比较器的唯一入口。
 *
 * 纪律：
 * - 有 currency+scale 时一律化到最小单位整数再比（禁止浮点直比）；
 * - NULL 语义显式：默认 error（NULL ≠ 0，不静默放过）；
 * - 容差有域：tolerance_abs/window 用绝对值，tolerance_rel 用相对值，
 *   负容差/NaN 一律视为构造错误（ERROR，不落 PASS）。
 */
import type { CompareSpec } from "./contract";

export type CompareOutcome = { equal: boolean } | { error: string };

/** 货币化：四舍五入到最小单位整数（分）。非数/NaN → null（由调用方判错）。 */
export function toMinorUnits(v: unknown, scale: number): number | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return Math.round(v * Math.pow(10, scale));
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * Math.pow(10, scale));
  }
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function setOf(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") return v.split(",").map((x) => x.trim()).filter((x) => x !== "");
  return null;
}

/**
 * 单值比较。返回 {equal} 或 {error}（error = 构造/数据问题，调用方应判 ERROR 或 NEEDS-MATERIAL，
 * 绝不落 PASS）。
 */
export function compareValues(left: unknown, right: unknown, spec: CompareSpec): CompareOutcome {
  const nullMode = spec.null ?? "error";
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;

  // range：期望值是「区间」而非标量——区间来自 spec.value/value_max，左侧为实际值，右侧忽略。
  if (spec.mode === "range") {
    if (typeof spec.value !== "number" || typeof spec.value_max !== "number") {
      return { error: 'range mode requires "value" (min) and "value_max" (max)' };
    }
    if (leftNull) return { error: "null value under range compare (null is never inside a band)" };
    const actual = asNumber(left);
    if (actual === null) return { error: `non-numeric value under range (${String(left)})` };
    const lo = Math.min(spec.value, spec.value_max);
    const hi = Math.max(spec.value, spec.value_max);
    return { equal: actual >= lo && actual <= hi };
  }

  if (leftNull || rightNull) {
    if (leftNull && rightNull) return { equal: true }; // 两侧都缺 = 同构缺失
    if (nullMode === "ignore") return { equal: true };
    if (nullMode === "equal") return { equal: true };
    return { error: `null value compared under mode "${spec.mode}" (null=${nullMode})` };
  }

  const scale = spec.scale;
  const currency = spec.currency;

  switch (spec.mode) {
    case "exact": {
      if (currency !== undefined && scale !== undefined) {
        const l = toMinorUnits(left, scale);
        const r = toMinorUnits(right, scale);
        if (l === null || r === null) return { error: `non-numeric value under currency compare (${String(left)} vs ${String(right)})` };
        return { equal: l === r };
      }
      const ls = asString(left);
      const rs = asString(right);
      if (ls !== null && rs !== null) return { equal: ls === rs };
      return { equal: left === right };
    }
    case "tolerance_abs":
    case "window": {
      if (spec.mode === "window" && !spec.unit) return { error: 'window mode requires "unit" (d|h|s)' };
      if (typeof spec.value !== "number" || !Number.isFinite(spec.value) || !(spec.value > 0)) {
        return { error: `invalid tolerance value: ${String(spec.value)} (must be > 0; ε=0 is exact)` };
      }
      if (currency !== undefined && scale !== undefined) {
        const l = toMinorUnits(left, scale);
        const r = toMinorUnits(right, scale);
        if (l === null || r === null) return { error: "non-numeric value under currency tolerance compare" };
        const tol = Math.round(spec.value * Math.pow(10, scale));
        return { equal: Math.abs(l - r) <= tol };
      }
      const l = asNumber(left);
      const r = asNumber(right);
      if (l === null || r === null) return { error: `non-numeric value under tolerance (${String(left)} vs ${String(right)})` };
      return { equal: Math.abs(l - r) <= spec.value };
    }
    case "tolerance_rel": {
      if (typeof spec.value !== "number" || !Number.isFinite(spec.value) || spec.value < 0) {
        return { error: `invalid relative tolerance: ${String(spec.value)}` };
      }
      const l = asNumber(left);
      const r = asNumber(right);
      if (l === null || r === null) return { error: "non-numeric value under relative tolerance" };
      const base = Math.abs(r);
      if (base === 0) return { equal: l === 0 };
      return { equal: Math.abs(l - r) / base <= spec.value };
    }
    case "subset":
    case "superset": {
      const l = setOf(left);
      const r = setOf(right);
      if (l === null || r === null) return { error: "subset/superset requires array or comma-separated values" };
      const ls = new Set(l);
      const rs = new Set(r);
      if (spec.mode === "subset") {
        // left ⊆ right
        for (const x of ls) if (!rs.has(x)) return { equal: false };
        return { equal: true };
      }
      // left ⊇ right
      for (const x of rs) if (!ls.has(x)) return { equal: false };
      return { equal: true };
    }
    case "regex": {
      const ls = asString(left);
      const rs = asString(right);
      if (ls === null || rs === null) return { error: "regex requires string values" };
      try {
        return { equal: new RegExp(rs).test(ls) };
      } catch (e) {
        return { error: `invalid regex: ${String((e as Error).message)}` };
      }
    }
    default:
      return { error: `unknown compare mode: ${String((spec as { mode?: string }).mode)}` };
  }
}

/** 构造期校验：CompareSpec 自身是否可判（不许静默合法）。 */
export function validateCompareSpec(spec: CompareSpec): string[] {
  const errs: string[] = [];
  const known = new Set(["exact", "tolerance_abs", "tolerance_rel", "window", "subset", "superset", "range", "regex"]);
  if (!known.has(spec.mode)) errs.push(`unknown compare mode: ${spec.mode}`);
  if ((spec.currency === undefined) !== (spec.scale === undefined)) errs.push("currency and scale must be provided together");
  if (spec.scale !== undefined && (!Number.isInteger(spec.scale) || spec.scale < 0 || spec.scale > 6)) errs.push("scale must be an integer 0..6");
  // R7：单一形状——exact 无 ε；tolerance/window 的 ε 必须 0<ε（ε=0 是 exact，别混）；
  // unit 只属 window，取值 d|h|s。
  const tol = spec.mode === "tolerance_abs" || spec.mode === "tolerance_rel" || spec.mode === "window";
  if (spec.mode === "exact" && spec.value !== undefined) errs.push("exact takes no tolerance value (use tolerance_abs for ε)");
  if (tol && typeof spec.value !== "number") errs.push(`${spec.mode} requires numeric value (ε)`);
  if (tol && typeof spec.value === "number" && !(spec.value > 0)) errs.push(`${spec.mode} requires ε > 0 (ε=0 is exact)`);
  if (spec.mode === "window" && !spec.unit) errs.push("window requires unit (d|h|s)");
  if (spec.unit !== undefined && spec.mode !== "window") errs.push("unit only applies to window mode");
  if (spec.unit !== undefined && !["d", "h", "s"].includes(String(spec.unit))) errs.push("unit must be d|h|s");
  if (spec.mode === "range" && (typeof spec.value !== "number" || typeof spec.value_max !== "number")) errs.push("range requires value and value_max");
  if (spec.cardinality === "1:N" && !spec.agg) errs.push('cardinality "1:N" requires agg (sum|max|min)');
  return errs;
}
