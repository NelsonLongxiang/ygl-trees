/** as_of 双侧校验 + 构造记录路径（0.102.3，r22 ② / P3①）。
 *
 * 这里的判据来自评审 r22：as_of 必须可解析——R13 要求锚定冻结值，不可解析的时间锚
 * 会把报告变成不可对质；CLI 与 HTTP 共用 `normalizeAsOf`，一个 rc=2、一个 400。
 * 另钉 attempts 文件名同毫秒碰撞不覆盖（只追加、加短序号）。
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AsOfError, normalizeAsOf, prepareRecordPath } from "../src/verify-cmds";

describe("normalizeAsOf", () => {
  it("带 +08 偏移 → 归一 UTC（同一个瞬间，存盘形态唯一）", () => {
    expect(normalizeAsOf("2026-10-20T09:00:00+08:00", "")).toBe("2026-10-20T01:00:00.000Z");
  });

  it("已是 toISOString() 形态 → 原样返回", () => {
    expect(normalizeAsOf("2026-01-02T03:04:05.000Z", "")).toBe("2026-01-02T03:04:05.000Z");
  });

  it("未给（undefined / null / 空串）→ 回落调用方时刻", () => {
    const fallback = "2026-10-20T00:00:00.000Z";
    expect(normalizeAsOf(undefined, fallback)).toBe(fallback);
    expect(normalizeAsOf(null, fallback)).toBe(fallback);
    expect(normalizeAsOf("", fallback)).toBe(fallback);
  });

  it("不可解析 → 抛 AsOfError，消息点名 ISO-8601 与原始值", () => {
    let caught: unknown;
    try {
      normalizeAsOf("not-a-time", "");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AsOfError);
    expect(String((caught as Error).message)).toMatch(/not a parseable ISO-8601 timestamp: not-a-time/);
  });

  it("非字符串 → 抛 AsOfError（不猜类型）", () => {
    expect(() => normalizeAsOf(123 as any, "")).toThrow(/must be an ISO-8601 string, got number/);
  });
});

describe("prepareRecordPath（attempts 只追加）", () => {
  it("ready 恒为 prepare.json；未 ready 落 attempts/<ts>.json 且同毫秒加短序号不覆盖", () => {
    const dir = mkdtempSync(join(tmpdir(), "ygl-attempts-"));
    try {
      expect(prepareRecordPath(dir, true, "2026-10-20T01:00:00.000Z")).toBe(join(dir, "prepare.json"));

      const first = prepareRecordPath(dir, false, "2026-10-20T01:00:00.000Z");
      expect(first).toBe(join(dir, "attempts", "2026-10-20T01-00-00-000Z.json"));
      writeFileSync(first, "{}", "utf8");

      const second = prepareRecordPath(dir, false, "2026-10-20T01:00:00.000Z");
      expect(second).toBe(join(dir, "attempts", "2026-10-20T01-00-00-000Z-2.json"));
      expect(existsSync(first)).toBe(true);
      writeFileSync(second, "{}", "utf8");

      const third = prepareRecordPath(dir, false, "2026-10-20T01:00:00.000Z");
      expect(third).toBe(join(dir, "attempts", "2026-10-20T01-00-00-000Z-3.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
