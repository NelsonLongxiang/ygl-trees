import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveDistRoot, openStatic, apply } from "../src/index";

describe("web-app 插件（spec R13.5）", () => {
  it("resolveDistRoot：构建产物存在时指向 apps/web/dist；未构建检出为 null", () => {
    const root = resolveDistRoot();
    const built = fs.existsSync(path.join(process.cwd(), "apps/web/dist/index.html"));
    expect(built).toBe(root !== null);
    if (root) expect(path.basename(root)).toBe("dist");
  });
  it("openStatic：/ 命中 html；未知路径 SPA 回落 html；遍历不逃出 dist", () => {
    if (!resolveDistRoot()) return; // fresh checkout without a build
    expect(openStatic("/")!.mime).toContain("text/html");
    expect(openStatic("/tasks/xyz")!.mime).toContain("text/html");
    const evil = openStatic("/../../package.json");
    // traversal resolves back to the SPA shell — never the repo file
    expect(evil === null || evil.mime.includes("text/html")).toBe(true);
  });
  it("插件形状：apply 可组合（ctx.plugin 入口）", () => {
    expect(typeof apply).toBe("function");
  });
});
