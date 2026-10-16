import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  initProfile, readUserBundle, writeUserBundle, installPlugin, removePlugin,
  listPlugins, loadUserPlugins, profileDir, userBundleFile,
} from "../src/plugins";

let home: string;
const demoDir = path.resolve("examples/plugin-demo");

beforeAll(() => {
  home = path.join(process.cwd(), "tmp", `plugins-unit-${Date.now()}`);
  fs.mkdirSync(home, { recursive: true });
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("插件 profile（spec R14 L3）", () => {
  it("initProfile 创建 profile 包（幂等）", () => {
    initProfile(home);
    initProfile(home);
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir(home), "package.json"), "utf8"));
    expect(pkg.name).toBe("ygl-user-plugins");
    expect(pkg.private).toBe(true);
  });
  it("install 本地目录（link:）→ bundle 记录 + 名字精确解析", async () => {
    const r = await installPlugin(home, demoDir);
    expect(r.name).toBe("ygl-plugin-demo");
    expect(r.spec.startsWith("link:")).toBe(true);
    const bundle = readUserBundle(home);
    expect(bundle).toEqual([{ name: "ygl-plugin-demo", spec: r.spec }]);
  });
  it("loadUserPlugins 解析 apply + commands（demo 命令组）", () => {
    const { plugins, issues } = loadUserPlugins(home);
    expect(issues).toEqual([]);
    expect(plugins.length).toBe(1);
    expect(typeof plugins[0].apply).toBe("function");
    expect(Object.keys(plugins[0].commands || {})).toContain("demo");
  });
  it("listPlugins 显示版本与可解析态", () => {
    const rows = listPlugins(home);
    expect(rows.length).toBe(1);
    expect(rows[0].version).toBe("0.1.0");
    expect(rows[0].resolvable).toBe(true);
  });
  it("坏条目进 issues 不炸（逐插件隔离）", () => {
    writeUserBundle(home, [{ name: "ygl-plugin-demo", spec: "link:x" }, { name: "no-such-pkg-zzz", spec: "no-such-pkg-zzz" }]);
    const { plugins, issues } = loadUserPlugins(home);
    expect(plugins.length).toBe(1);
    expect(issues.length).toBe(1);
    expect(issues[0].name).toBe("no-such-pkg-zzz");
    writeUserBundle(home, [{ name: "ygl-plugin-demo", spec: listPlugins(home)[0].spec }]);
  });
  it("removePlugin 卸依赖 + 清 bundle；未装名报错", async () => {
    await removePlugin(home, "ygl-plugin-demo");
    expect(readUserBundle(home)).toEqual([]);
    const deps = JSON.parse(fs.readFileSync(path.join(profileDir(home), "package.json"), "utf8")).dependencies || {};
    expect(deps["ygl-plugin-demo"]).toBeUndefined();
    await expect(removePlugin(home, "nope")).rejects.toThrow(/not in user bundle/);
    expect(fs.existsSync(userBundleFile(home))).toBe(true);
  });
});
