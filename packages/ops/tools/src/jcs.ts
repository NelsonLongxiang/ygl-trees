/**
 * jcsCanonical — RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * 契约 v1.2 G8：verdict_digest 等判定投影必须走 JCS canonical（键全序、无空白、
 * 数字最短表示），而不是 JSON.stringify 的排序近似——后者在跨实现（TS/Rust、
 * 不同引擎）上会漂移。
 *
 * 实现要点（RFC 8785 §3.2）：
 * - 对象键按 UTF-16 code unit 序排序（JS 默认 sort 即符合）
 * - 无空白分隔
 * - 数字：ES6 Number::toString（JSON.stringify 默认即符合）
 * - 字符串：转义 ", \ 和控制字符；不转义非 ASCII（输出 UTF-8）
 */
export function jcsCanonical(value: unknown): string {
  return serialize(value);
}

function serialize(value: any): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS: non-finite number not allowed");
    return JSON.stringify(value); // ES6 Number::toString — RFC 8785 §3.2.2.3
  }
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => serialize(v)).join(",") + "]";
  if (t === "object") {
    const keys = Object.keys(value).sort(); // UTF-16 code unit order
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + serialize(value[k])).join(",") + "}";
  }
  throw new Error(`JCS: unsupported type ${t}`);
}
