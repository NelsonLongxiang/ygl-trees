import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  initProfile, readUserBundle, writeUserBundle, installPlugin, removePlugin,
  listPlugins, loadUserPlugins, profileDir, userBundleFile,
  setPluginEnabled, setPluginConfig,
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

describe("用户层 Entry-option 等价能力（0.40，adopt 能力不 adopt loader）", () => {
  it("config 往返：写入 → 读回 → loadUserPlugins 透传", async () => {
    initProfile(home);
    await installPlugin(home, demoDir);
    setPluginConfig(home, "ygl-plugin-demo", { greeting: "hi", limit: 3 });
    expect(readUserBundle(home).find((p) => p.name === "ygl-plugin-demo")?.config).toEqual({ greeting: "hi", limit: 3 });
    const { plugins } = loadUserPlugins(home);
    expect(plugins[0].config).toEqual({ greeting: "hi", limit: 3 });
    // empty object clears the block
    setPluginConfig(home, "ygl-plugin-demo", {});
    expect(readUserBundle(home).find((p) => p.name === "ygl-plugin-demo")?.config).toBeUndefined();
  });
  it("enabled=false：条目留在 bundle 但不再挂载", async () => {
    setPluginEnabled(home, "ygl-plugin-demo", false);
    expect(readUserBundle(home).find((p) => p.name === "ygl-plugin-demo")?.enabled).toBe(false);
    const off = loadUserPlugins(home);
    expect(off.plugins.length).toBe(0);
    expect(off.issues.length).toBe(0);
    // listPlugins still reports it (installed, just not mounted)
    const row = listPlugins(home).find((p) => p.name === "ygl-plugin-demo");
    expect(row?.enabled).toBe(false);
    setPluginEnabled(home, "ygl-plugin-demo", true);
    expect(loadUserPlugins(home).plugins.length).toBe(1);
    expect(listPlugins(home).find((p) => p.name === "ygl-plugin-demo")?.enabled).toBe(true);
  });
  it("未安装名报错（enable/config 同口径）", () => {
    expect(() => setPluginEnabled(home, "nope", false)).toThrow(/not in the user bundle/);
    expect(() => setPluginConfig(home, "nope", {})).toThrow(/not in the user bundle/);
  });
});
