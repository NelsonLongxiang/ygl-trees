/** as_of 严格 ISO 校验 + 构造记录原子占位（0.102.3 r22 ②；0.102.4 r23 收紧）。
 *
 * 判据来自评审 r23：纯日期可接受，但**无时区 datetime 不可**——同一串 `…T10:00:00`
 * 在本机 +08 与 CI UTC 会落成两个不同锚点；非法日历（2026-02-30）会被 Date 静默
 * 滚成 03-02 并以错误锚冻结。这两种都必须拒。attempts 用 `flag:"wx"` 原子占位，
 * 同毫秒第二个写者拿 EEXIST 续号，不靠 existsSync 预检（有 TOCTOU 窗口）。
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AsOfError, normalizeAsOf, writePrepareRecord } from "../src/verify-cmds";

describe("normalizeAsOf（严格 ISO）", () => {
  it("带 +08:00 偏移 → 归一 UTC（同一个瞬间，存盘形态唯一）", () => {
    expect(normalizeAsOf("2026-10-20T09:00:00+08:00", "")).toBe("2026-10-20T01:00:00.000Z");
  });

  it("±hh（无冒号）与引擎 ISO_DATETIME_TZ 同口径", () => {
    expect(normalizeAsOf("2026-10-20T09:00:00+0800", "")).toBe("2026-10-20T01:00:00.000Z");
  });

  it("已是 toISOString() 形态 → 原样返回", () => {
    expect(normalizeAsOf("2026-01-02T03:04:05.000Z", "")).toBe("2026-01-02T03:04:05.000Z");
  });

  it("纯日期 → UTC 00:00（跨机器同一个锚）", () => {
    expect(normalizeAsOf("2026-10-24", "")).toBe("2026-10-24T00:00:00.000Z");
  });

  it("未给（undefined / null / 空串）→ 回落调用方时刻", () => {
    const fallback = "2026-10-20T00:00:00.000Z";
    expect(normalizeAsOf(undefined, fallback)).toBe(fallback);
    expect(normalizeAsOf(null, fallback)).toBe(fallback);
    expect(normalizeAsOf("", fallback)).toBe(fallback);
  });

  it("无时区 datetime → 拒（本机 +08 与 CI UTC 会落成两个锚点）", () => {
    expect(() => normalizeAsOf("2026-10-20T10:00:00", "")).toThrow(/explicit zone/);
    expect(() => normalizeAsOf("2026-10-20T10:00", "")).toThrow(/explicit zone/);
  });

  it("空格分隔 / 非 ISO → 拒", () => {
    expect(() => normalizeAsOf("2026-10-20 10:00:00Z", "")).toThrow(/explicit zone/);
    expect(() => normalizeAsOf("Jan 1 2026", "")).toThrow(/explicit zone/);
    expect(() => normalizeAsOf("not-a-time", "")).toThrow(/explicit zone/);
  });

  it("非法日历 → 拒（2026-02-30 不许静默滚成 03-02）", () => {
    expect(() => normalizeAsOf("2026-02-30", "")).toThrow(/valid calendar date/);
    expect(() => normalizeAsOf("2026-13-01", "")).toThrow(/valid calendar date/);
    expect(() => normalizeAsOf("2026-02-30T00:00:00Z", "")).toThrow(/valid calendar date/);
    expect(() => normalizeAsOf("2026-10-20T25:00:00Z", "")).toThrow(/out-of-range time|valid calendar date/);
  });

  it("抛的是 AsOfError（HTTP 400 / CLI rc=2 都靠这个类型分派）", () => {
    let caught: unknown;
    try {
      normalizeAsOf("not-a-time", "");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AsOfError);
    expect(String((caught as Error).message)).toMatch(/not-a-time/);
  });

  it("非字符串 → 抛 AsOfError（不猜类型）", () => {
    expect(() => normalizeAsOf(123 as any, "")).toThrow(/must be an ISO-8601 string, got number/);
  });
});

describe("writePrepareRecord（wx 原子占位）", () => {
  it("ready → prepare.json，可被后一次成功准备覆盖（成功以最后一次为准）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ygl-record-"));
    try {
      const first = writePrepareRecord(dir, true, { verdict: "ready", n: 1 });
      expect(first).toBe(join(dir, "prepare.json"));
      expect(JSON.parse(readFileSync(first, "utf8")).n).toBe(1);

      const second = writePrepareRecord(dir, true, { verdict: "ready", n: 2 });
      expect(second).toBe(first);
      expect(JSON.parse(readFileSync(second, "utf8")).n).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("未 ready → attempts/<ts>.json 只追加；同毫秒靠 EEXIST 续号，不覆盖", () => {
    const dir = mkdtempSync(join(tmpdir(), "ygl-attempts-"));
    const now = "2026-10-20T01:00:00.000Z";
    try {
      const first = writePrepareRecord(dir, false, { verdict: "blocked", n: 1 }, now);
      expect(first).toBe(join(dir, "attempts", "2026-10-20T01-00-00-000Z.json"));

      const second = writePrepareRecord(dir, false, { verdict: "blocked", n: 2 }, now);
      expect(second).toBe(join(dir, "attempts", "2026-10-20T01-00-00-000Z-2.json"));
      expect(JSON.parse(readFileSync(first, "utf8")).n).toBe(1);
      expect(JSON.parse(readFileSync(second, "utf8")).n).toBe(2);

      const third = writePrepareRecord(dir, false, { verdict: "blocked", n: 3 }, now);
      expect(third).toBe(join(dir, "attempts", "2026-10-20T01-00-00-000Z-3.json"));
      for (const p of [first, second, third]) expect(existsSync(p)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
