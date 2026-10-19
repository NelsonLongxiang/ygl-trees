/**
 * Canonical JSON（N4 / 评审 R10）：RFC 8785（JCS）子集，TS 与 Rust 共用同一规则。
 *
 * 为什么不用 JSON.stringify：键序依赖插入顺序、数字格式各异、找不到"同一份报告"
 * 的唯一字节形态，payload_sha256 在两种实现之间就对不上。封包/报告/语料四向 parity
 * 需要一个**逐字节**确定的序列化器。
 *
 * 规则（与 corpus/canonical/vectors.json 一一对应）：
 * - 对象键按 **UTF-16 code unit** 升序（与 Array.prototype.sort 的默认序一致）
 * - 数组保持原序；null / true / false 字面量
 * - 数字用 ECMAScript Number::toString 形态（`1e+21`、`1e-7`、`-0` → `0`），
 *   NaN / Infinity 属于非法 JSON，直接拒绝而不是静默写 null
 * - 字符串用 JSON 转义；非 ASCII 原样输出（输入先做 NFC，口径见 W16）
 * - 对象里值为 **undefined 的键视同不存在**（与 JSON.stringify 的可选字段语义一致：
 *   报告里的二进制锚、可选项在没有产出时就是不存在，不能因为"字段在内存里是 undefined"
 *   而让同一份数据算不出哈希）；数组里的 undefined 仍然拒绝
 * - function / symbol / bigint 不属于 JSON，直接拒绝
 * - 时间戳由生产方统一写成 RFC3339 UTC 毫秒（`2026-07-01T00:00:00.000Z`），
 *   序列化器不做时区换算——保证"报告里是什么就哈希什么"
 */
export function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new Error(`canonical JSON rejects non-finite number: ${String(value)}`);
      }
      // JSON.stringify 的数字形态就是 ECMAScript Number::toString；-0 归一为 0
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    }
    case "string":
      return JSON.stringify(value.normalize("NFC"));
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalStringify(v)).join(",")}]`;
      }
      // r10 F6：只序列化"纯对象"。Date/Map/类实例走 Object.keys 会得到 "{}"，
      // 那是把"没听懂"伪装成"空对象"——直接拒绝比静默产出错哈希强。
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error(`canonical JSON rejects non-plain object (${Object.prototype.toString.call(value)})`);
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const v = obj[key];
        // 可选字段缺省：与 JSON.stringify 一致地整键省略（否则报告里用不到的
        // binary_sha256/anchor 之类会让哈希跟着内存形状漂）
        if (v === undefined) continue;
        parts.push(`${JSON.stringify(key.normalize("NFC"))}:${canonicalStringify(v)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new Error(`canonical JSON rejects ${typeof value}`);
  }
}

/** 报告/footer 用的时间戳口径：RFC3339 UTC 毫秒 */
export function canonicalTimestamp(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (!Number.isFinite(d.getTime())) throw new Error(`canonical timestamp is not a valid date: ${String(date)}`);
  return d.toISOString();
}
