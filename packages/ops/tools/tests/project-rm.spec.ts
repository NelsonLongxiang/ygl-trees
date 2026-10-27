/**
 * #82 project rm（总工裁 direct-a7b1e30a + 复核 direct-9ea58cd0 B）：
 *  软删默认（status=archived，资产不动）· --force 只对空项目硬删 · 非空拒绝并按类型点名 · 无级联。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
let HOME = "";
const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 120_000, env: { ...process.env, YGL_HOME: HOME } });

describe.skipIf(!HAS_BIN)("#82 project rm（软删默认 / 拒绝级联 / 按类型点名）", () => {
  beforeAll(() => { HOME = mkdtempSync(join(tmpdir(), "ygl-82-")); run(["db", "init"]); });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("默认软删：status=archived，资产原样保留", () => {
    run(["project", "new", "soft-one", "-q", "q"]);
    run(["research", "claim", "add", "一条断言", "-p", "soft-one"]);
    const r = run(["project", "rm", "soft-one", "--json"]);
    expect(r.status).toBe(0);
    const j = JSON.parse(String(r.stdout || "{}"));
    expect(j).toMatchObject({ archived: true, status: "archived", soft: true });
    expect(j.remaining.claims).toBe(1); // 点名计数：资产未动
    // 断言仍然在（软删不是删资产）
    const claims = run(["research", "claim", "list", "-p", "soft-one", "--json"]);
    expect(JSON.parse(String(claims.stdout || "[]")).length).toBe(1);
  });

  it("--force 对非空项目：拒绝（无级联），按类型点名 claims N", () => {
    run(["project", "new", "busy-one", "-q", "q"]);
    run(["research", "claim", "add", "断言甲", "-p", "busy-one"]);
    run(["research", "claim", "add", "断言乙", "-p", "busy-one"]);
    const r = run(["project", "rm", "busy-one", "--force", "--json"]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/claims 2/);
    expect(r.stdout + r.stderr).toMatch(/no cascade/);
    // 资产仍在
    const claims = run(["research", "claim", "list", "-p", "busy-one", "--json"]);
    expect(JSON.parse(String(claims.stdout || "[]")).length).toBe(2);
  });

  it("--force 对空项目：真删（不再可查）", () => {
    run(["project", "new", "empty-del", "-q", "q"]);
    const r = run(["project", "rm", "empty-del", "--force", "--json"]);
    expect(r.status).toBe(0);
    const list = run(["project", "list", "--json"]);
    expect(JSON.parse(String(list.stdout || "[]")).map((p) => p.name)).not.toContain("empty-del");
  });

  it("不存在的项目点名 404（rc1）", () => {
    const r = run(["project", "rm", "nope-xyz", "--json"]);
    expect(r.status).toBe(1);
    expect(String(r.stdout || "")).toMatch(/project not found: nope-xyz/);
  });
});
