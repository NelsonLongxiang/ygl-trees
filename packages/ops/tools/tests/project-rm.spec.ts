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

  it("归档项目拒写：research claim add → rc1 带名错误（验证席 direct-08d214ee a）", () => {
    run(["project", "new", "arch-write", "-q", "q"]);
    run(["project", "rm", "arch-write"]);
    const r = run(["research", "claim", "add", "不应落库", "-p", "arch-write", "--json"]);
    expect(r.status).toBe(1);
    expect(String(r.stdout || "")).toMatch(/project arch-write is archived/);
    const claims = run(["research", "claim", "list", "-p", "arch-write", "--json"]);
    expect(JSON.parse(String(claims.stdout || "[]")).length).toBe(0);
  });

  it("归档项目拒选：project use → rc1；--archived 放行（只读巡查）（验证席 b）", () => {
    run(["project", "new", "arch-use", "-q", "q"]);
    run(["project", "rm", "arch-use"]);
    const denied = run(["project", "use", "arch-use", "--json"]);
    expect(denied.status).toBe(1);
    expect(String(denied.stdout || "")).toMatch(/is archived — run: ygl-trees project restore/);
    const allowed = run(["project", "use", "arch-use", "--archived", "--json"]);
    expect(allowed.status).toBe(0);
  });

  it("归档不清空资产但不标 current（验证席 c/d）", () => {
    run(["project", "new", "arch-cur", "-q", "q"]);
    run(["research", "claim", "add", "留证据", "-p", "arch-cur"]);
    run(["project", "rm", "arch-cur"]);           // 软删并清选择桶
    const list = run(["project", "list", "--json"]);
    const me = JSON.parse(String(list.stdout || "[]")).find((p) => p.name === "arch-cur");
    expect(me.status).toBe("archived");
    expect(me.current).toBe(false);
  });

  it("归档写闸覆盖 produce/task 面：produce outline 与 task add 在归档项目上 rc1（监督席 ①）", () => {
    run(["project", "new", "arch-produce", "-q", "q"]);
    run(["project", "rm", "arch-produce"]);
    const outline = run(["produce", "outline", "-p", "arch-produce", "--json"]);
    expect(outline.status).toBe(1);
    expect(String(outline.stdout || "")).toMatch(/is archived/);
    const task = run(["task", "add", "不该落库", "-p", "arch-produce", "--json"]);
    expect(task.status).toBe(1);
    expect(String(task.stdout || "")).toMatch(/is archived/);
  });

  it("project restore 是归档的出口：restore 后写入恢复（监督席 ②③）", () => {
    run(["project", "new", "arch-restore", "-q", "q"]);
    run(["project", "rm", "arch-restore"]);
    expect(run(["research", "claim", "add", "x", "-p", "arch-restore", "--json"]).status).toBe(1);
    const r = run(["project", "restore", "arch-restore", "--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(String(r.stdout || "{}"))).toMatchObject({ status: "active", restored: true });
    const after = run(["research", "claim", "add", "现在可以了", "-p", "arch-restore", "--json"]);
    expect(after.status).toBe(0);
  });

  it("#110 P1：破坏动词入闸——归档项目 claim unlink / unresolve 均 rc1（非只读即拒）", () => {
    run(["project", "new", "p1-gate", "-q", "q"]);
    const c = run(["research", "claim", "add", "断言甲", "-p", "p1-gate", "--json"]);
    const cid = JSON.parse(String(c.stdout || "{}")).id;
    run(["project", "rm", "p1-gate"]);
    for (const verb of ["unlink", "unresolve"]) {
      const r = run(["research", "claim", verb, cid, "-p", "p1-gate", "--json"]);
      expect(r.status, verb).toBe(1);
      expect(String(r.stdout || "")).toMatch(/is archived/);
    }
  });

  it("#110 P2：--global 指针随归档清除——rm 后无 -p 的破坏动词不再落到归档项目", () => {
    run(["project", "new", "p2-global", "-q", "q"]);
    run(["project", "use", "p2-global", "--global"]);
    run(["project", "rm", "p2-global"]);
    const r = run(["research", "claim", "unlink", "any", "--json"]);
    // 要么已无选择（rc2 ambiguous/no project），要么归档拒写（rc1）——都不许 rc0 写成功
    expect([1, 2]).toContain(r.status);
    expect(String(r.stdout || "")).not.toMatch(/"ok":\s*true/);
  });

  it("#110 P3：project 帮助串含 rm/restore", () => {
    const r = run(["project"]);
    const out = String(r.stdout || "");
    expect(out).toContain("rm <name>");
    expect(out).toContain("restore <name>");
  });
});
