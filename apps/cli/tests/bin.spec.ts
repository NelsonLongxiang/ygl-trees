import { describe, it, expect } from "vitest";
import { loadBundle, repoRoot, appVersion } from "../src/bin";

describe("apps/cli 入口工具（DSH bin.ts 典范）", () => {
  it("repoRoot 向上探测到仓库根", () => {
    expect(repoRoot()).toMatch(/ygl-trees$/);
    expect(loadBundle().length).toBe(5);
  });
  it("loadBundle 返回 base 组合五插件（含 timer 弹药启用）", () => {
    expect(loadBundle()).toEqual(["database", "research", "techtree", "web-app", "timer"]);
  });
  it("appVersion 从仓库根 package.json 解析", () => {
    expect(appVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
