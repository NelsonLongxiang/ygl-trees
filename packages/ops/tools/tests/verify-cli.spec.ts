import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

/**
 * verify 命令面（M13-1）的 CLI 级契约：rc 只表达过程、--json 单对象/单数组、
 * 失败也机器可读（stdout 单 {"error":...}），用法错误 rc=2。
 *
 * 发布产物优先（demo/contract 同纪律）：dist/bundle/bin.cjs 不存在时跳过。
 */
const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const hasBundle = existsSync(BIN);
const home = hasBundle ? mkdtempSync(join(tmpdir(), "ygl-verify-cli-")) : "";

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: home,
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: home, ...env },
  });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

afterAll(() => {
  if (home && existsSync(home)) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe.skipIf(!hasBundle)("verify 命令面（发布产物）", () => {
  it("submit 落冻结材料并回单对象（含 text_sha256）", () => {
    expect(run(["db", "init"]).rc).toBe(0);
    const text = join(home, "material.txt");
    writeFileSync(text, "账单总额须等于申报总额。\n", "utf8");
    const r = run(["verify", "submit", "--title", "t", "--text", text, "--json"]);
    expect(r.rc).toBe(0);
    const obj = JSON.parse(r.out) as { material_id: string; text_sha256: string; files: unknown[] };
    expect(obj.material_id).toMatch(/^mat_[0-9a-f]{12}$/);
    expect(obj.text_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(obj.files).toEqual([]);
  });

  it("prepare 缺参数 → rc=2 且 --json 仍是单对象错误", () => {
    const r = run(["verify", "prepare", "mat_deadbeef0000", "--json"]);
    expect(r.rc).toBe(2);
    const obj = JSON.parse(r.out) as { error: string };
    expect(obj.error).toMatch(/usage: verify prepare/);
  });

  it("run 未知 spec → rc=1（运行错误，不是用法错误）", () => {
    const db = join(home, "snap.sqlite");
    const d = new DatabaseSync(db);
    d.exec("CREATE TABLE bills(id TEXT)");
    d.close();
    const r = run(["verify", "run", "spec_nope", "--db", db, "--json"]);
    expect(r.rc).toBe(1);
    expect((JSON.parse(r.out) as { error: string }).error).toMatch(/spec not found|not found/i);
  });

  it("list 空工作区 → rc=0 空数组（读命令的 JSON 纯净）", () => {
    const r = run(["verify", "list", "--json"]);
    expect(r.rc).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
  });

  it("report import 不是报告 → rc=1 且问题点名单条", () => {
    const fake = join(home, "fake-report.json");
    writeFileSync(fake, JSON.stringify({ run_id: "r1", summary: {} }), "utf8");
    const r = run(["verify", "report", "import", fake, "--json"]);
    expect(r.rc).toBe(1);
    const obj = JSON.parse(r.out) as { imported: boolean; problems: string[] };
    expect(obj.imported).toBe(false);
    expect(obj.problems.join(" ")).toMatch(/payload_sha256/);
  });

  it("archive 未知 run → rc=1 且点名（不产半包）", () => {
    const r = run(["verify", "archive", "run_deadbeef00000000", "--json"]);
    expect(r.rc).toBe(1);
    expect((JSON.parse(r.out) as { error: string }).error).toMatch(/run not found/);
  });

  it("archive verify 缺文件 → rc=1 且 problems 点名（机器可读）", () => {
    const r = run(["verify", "archive", "verify", join(home, "nope.zip"), "--json"]);
    expect(r.rc).toBe(1);
    const obj = JSON.parse(r.out) as { ok: boolean; problems?: string[]; error?: string };
    expect(obj.ok).toBe(false);
    expect((obj.problems ?? [obj.error ?? ""]).join(" ")).toMatch(/not found|ENOENT|no such file|cannot read/i);
  });

  it("archive verify 不是 zip → rc=1 且 problems 点名（判定不在 rc 里装）", () => {
    const fake = join(home, "fake.yglverify.zip");
    writeFileSync(fake, "not a zip at all", "utf8");
    const r = run(["verify", "archive", "verify", fake, "--json"]);
    expect(r.rc).toBe(1);
    const obj = JSON.parse(r.out) as { ok: boolean; problems: string[] };
    expect(obj.ok).toBe(false);
    expect(obj.problems.length).toBeGreaterThan(0);
  });

  it("self-check --no-cases → rc=0（环境/语料摘要/形状全绿，语料实跑显式 skip）", () => {
    const corpus = join(REPO, "packages", "verify", "core", "corpus");
    const r = run(["verify", "self-check", "--corpus", corpus, "--no-cases", "--json"]);
    expect(r.rc).toBe(0);
    const obj = JSON.parse(r.out) as { ok: boolean; items: Array<{ id: string; status: string }> };
    expect(obj.ok).toBe(true);
    expect(obj.items.find((i) => i.id === "corpus-cases")?.status).toBe("skip");
  }, 60_000);

  it("未知子命令 → rc=2（verify 组同其他组口径）", () => {
    const r = run(["verify", "frobnicate", "--json"]);
    expect(r.rc).toBe(2);
    expect((JSON.parse(r.out) as { error: string }).error).toMatch(/unknown/i);
  });
});
