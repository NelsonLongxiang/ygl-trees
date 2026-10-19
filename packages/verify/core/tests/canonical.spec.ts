import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalStringify, canonicalTimestamp } from "../src/canonical";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "../corpus/canonical/vectors.json"), "utf8")) as {
  version: string;
  cases: Array<{ name: string; input: unknown; expected: string }>;
};

describe("canonical JSON（N4 / R10：TS 与 Rust 共用同一字节形态）", () => {
  it("共用向量逐例逐字节一致（Rust 侧读同一份文件）", () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of vectors.cases) {
      expect(canonicalStringify(c.input), c.name).toBe(c.expected);
    }
  });

  it("键序与插入顺序无关：同一对象两种写法哈希相同", async () => {
    const { createHash } = await import("node:crypto");
    const a = { b: 1, a: { d: 2, c: [3, 4] } };
    const b = { a: { c: [3, 4], d: 2 }, b: 1 };
    const h = (v: unknown) => createHash("sha256").update(canonicalStringify(v)).digest("hex");
    expect(h(a)).toBe(h(b));
  });

  it("非法 JSON 值直接拒绝（不静默写 null / 丢键）", () => {
    expect(() => canonicalStringify(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalStringify(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => canonicalStringify([undefined])).toThrow(/undefined/);
    expect(() => canonicalStringify(() => 1)).toThrow(/function/);
    expect(() => canonicalStringify(10n as unknown)).toThrow(/bigint/);
  });

  it("时间戳口径：RFC3339 UTC 毫秒", () => {
    expect(canonicalTimestamp("2026-10-19T08:00:00+08:00")).toBe("2026-10-19T00:00:00.000Z");
    expect(canonicalTimestamp(new Date("2026-10-19T00:00:00Z"))).toBe("2026-10-19T00:00:00.000Z");
    expect(() => canonicalTimestamp("not-a-date")).toThrow(/not a valid date/);
  });
});
