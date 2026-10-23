/**
 * fdc P1 回归钉（0.114.27）：R3 tooling 执法不得随克隆平台配置漂移。
 *
 * 背景（fdc 干净 Windows 克隆实测，GitHub 检出验证）：core.autocrlf=true 全局默认下
 * `verify meta` R3 FAIL——8 个 tooling sha256 失配（benchmarks/*.js ×6 等）。根因：
 * 0.103 家族存量 blob 无 eol 约束，autocrlf 检出写 CRLF，而注册表 sha 按 LF 盘上
 * 字节冻结。0.108.0（884f3e2）`* text=auto eol=lf` 全仓统一后 HEAD 已不复发——
 * 本夹具钉住「autocrlf=true 干净克隆 → R3 PASS」，防未来回退。
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

const scratch: string[] = [];

describe.skipIf(!HAS_BIN)("R3 platform-stability regression (fdc P1, autocrlf=true)", () => {
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("clean clone with core.autocrlf=true keeps R3 PASS (tooling sha stable across platforms)", () => {
    const parent = mkdtempSync(join(tmpdir(), "ygl-r3-eol-"));
    scratch.push(parent);
    const clone = join(parent, "clone");
    // 复现 fdc 的确切环境组合：全局 autocrlf=true 默认（-c 覆盖本次克隆）
    execFileSync("git", ["-c", "core.autocrlf=true", "clone", "--quiet", REPO, clone], { timeout: 120_000 });

    // 夹具自检：克隆真实存在且携带 .gitattributes 的全仓 LF 规则
    expect(existsSync(join(clone, ".gitattributes"))).toBe(true);
    expect(existsSync(join(clone, "verify", "meta.json"))).toBe(true);

    // 判据 1：tooling 注册表 sha 与盘上字节一致（0 drift）
    const check = spawnSync(process.execPath, [join(clone, "scripts", "meta-tooling.mjs"), "--check"], {
      cwd: clone, encoding: "utf8", timeout: 120_000,
    });
    expect(check.status, check.stdout + check.stderr).toBe(0);
    expect(check.stdout).toMatch(/0 drift/);

    // 判据 2：完整 verify meta 的 R3 规则 PASS（隔离 YGL_HOME，不碰真实工作区）
    const home = join(parent, "home");
    const init = spawnSync(process.execPath, [BIN, "db", "init", "--json"], {
      encoding: "utf8", timeout: 120_000,
      env: { ...process.env, YGL_HOME: home, YGL_SESSION: "r3-eol-spec" },
    });
    expect(init.status, init.stdout).toBe(0);
    const meta = spawnSync(process.execPath, [BIN, "verify", "meta", clone, "--json"], {
      encoding: "utf8", timeout: 120_000,
      env: { ...process.env, YGL_HOME: home, YGL_SESSION: "r3-eol-spec" },
    });
    expect(meta.status, meta.stdout).toBe(0);
    const report = JSON.parse(meta.stdout);
    const r3 = report.rules.find((r: any) => r.id === "R3");
    expect(r3.verdict).toBe("PASS");
  }, 300_000);
});
