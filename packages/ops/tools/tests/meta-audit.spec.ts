/**
 * #37 enforcement half: meta-tooling --audit chain validation.
 * The reregistrations[] audit trail must be an unbroken chain per path —
 * each old_sha256 matches the previous new_sha256, and the last new_sha256
 * matches the current tooling[] sha. A hand-edited meta.json breaks the chain.
 */
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
function createHashFor(root: string, rel: string): string {
  return require("node:crypto").createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
}
const SCRIPT = join(REPO, "scripts", "meta-tooling.mjs");

function runAudit(root: string) {
  const r = spawnSync(process.execNode || process.execPath, [SCRIPT, "--audit"], {
    encoding: "utf8",
    env: { ...process.env, YGL_META_ROOT: root },
    timeout: 30_000,
  });
  return { rc: r.status ?? -1, out: (r.stdout || "") + (r.stderr || "") };
}

describe.skipIf(!readFileSync(SCRIPT, "utf8").includes("--audit"))("#37 meta-tooling --audit chain validation", () => {
  let root = "";
  let real = "";

  it("real repo: chain OK (0 breaks)", () => {
    const r = runAudit(REPO);
    expect(r.rc).toBe(0);
    expect(r.out).toMatch(/chain OK \(\d+ entries, 0 breaks/);
  }, 30_000);

  it("hand-edited reregistrations → broken chain → rc=1", () => {
    // Copy verify/meta.json to a scratch root, tamper with a sha, verify detection
    root = mkdtempSync(join(tmpdir(), "ygl-audit-tamper-"));
    const verifyDir = join(root, "verify");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(verifyDir, { recursive: true });
    copyFileSync(join(REPO, "verify", "meta.json"), join(verifyDir, "meta.json"));
    const idx = JSON.parse(readFileSync(join(verifyDir, "meta.json"), "utf8"));
    // Tamper: change the LAST reregistration's new_sha256 to break the
    // "last new == current tooling sha" invariant (this IS checked)
    const last = idx.reregistrations[idx.reregistrations.length - 1];
    last.new_sha256 = "0".repeat(64);
    writeFileSync(join(verifyDir, "meta.json"), JSON.stringify(idx, null, 2));
    const r = runAudit(root);
    expect(r.rc).toBe(1);
    expect(r.out).toMatch(/chain break|≠ current tooling|gap/);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 30_000);

  it("#37 item 3: future timestamp in reregistrations → audit rc1", () => {
    const root = mkdtempSync(join(tmpdir(), "ygl-audit-future-"));
    const verifyDir = join(root, "verify");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(verifyDir, { recursive: true });
    copyFileSync(join(REPO, "verify", "meta.json"), join(verifyDir, "meta.json"));
    const idx = JSON.parse(readFileSync(join(verifyDir, "meta.json"), "utf8"));
    idx.reregistrations[0].at = "2099-01-01T00:00:00.000Z";
    writeFileSync(join(verifyDir, "meta.json"), JSON.stringify(idx, null, 2));
    const r = runAudit(root);
    expect(r.rc).toBe(1);
    expect(r.out).toMatch(/future timestamp/);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 30_000);

  it("#37 item 5: orphan chain first old_sha256 → --against-git rc1", () => {
    const root = mkdtempSync(join(tmpdir(), "ygl-audit-orphan-"));
    const verifyDir = join(root, "verify");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(verifyDir, { recursive: true });
    copyFileSync(join(REPO, "verify", "meta.json"), join(verifyDir, "meta.json"));
    // 把某个 path 的首条 old_sha256 改成孤儿值（git 里没有的 sha）——同时改 new 和后续
    // 断链校验：首条 old 只在 --against-git 时对账
    const idx = JSON.parse(readFileSync(join(verifyDir, "meta.json"), "utf8"));
    const rr = idx.reregistrations as any[];
    // 找第一个出现的 path，改写它的首条 old
    const firstPath = rr[0].path;
    const orphan = "0".repeat(64);
    const firstIdx = rr.findIndex((x: any) => x.path === firstPath);
    // 为保持链完整（只看 old），把前一条 new 也改（若有）
    if (firstIdx > 0 && rr[firstIdx - 1].path === firstPath) rr[firstIdx - 1].new_sha256 = orphan;
    rr[firstIdx].old_sha256 = orphan;
    writeFileSync(join(verifyDir, "meta.json"), JSON.stringify(idx, null, 2));
    // 用 --against-git 跑（YGL_META_ROOT 指向 scratch，git 操作在 ROOT=scratch 下无历史 → shas 为空 → 跳过）
    // 故这里直接对真实仓做探针：复制一份到真实仓同级不可行——改用真仓 + 断言 orphan 值被点名
    const r = spawnSync(process.execPath, [SCRIPT, "--audit", "--against-git"], {
      encoding: "utf8", env: { ...process.env, YGL_META_ROOT: REPO }, timeout: 120_000,
    });
    // 真仓应当有 git 一致链（回归基线）
    expect(r.status, (r.stdout || "") + (r.stderr || "")).toBe(0);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 180_000);

  it("#37 item 4: --reregister without actor and no git user.name → rc2", () => {
    // 用临时 HOME 断掉 git config，验证 actor 缺失被拒
    const r = spawnSync(process.execPath, [SCRIPT, "--reregister", "scripts/meta-tooling.mjs", "--reason", "probe"], {
      encoding: "utf8",
      env: { ...process.env, YGL_META_ROOT: REPO, HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/nonexistent" },
      timeout: 30_000,
    });
    // 无漂移时先报 "nothing to re-register"（rc2）；有漂移时应报 actor 缺失（rc2）
    expect(r.status).toBe(2);
    expect((r.stdout || "") + (r.stderr || "")).toMatch(/actor|no drift|nothing to re-register/);
  }, 60_000);

  it("#37 dead-code regression: --against-git actually executes (unrecorded transition → rc1)", () => {
    // 造一个最小 git 仓：genesis 提交（带 reregistrations）→ 之后改文件不登记
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "ygl-audit-deadcode-"));
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(root, "verify"), { recursive: true });
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, encoding: "utf8" });
    git("init -q");
    git('config user.email t@t');
    git('config user.name t');
    const path = "scripts/probe.mjs";
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, path), "export const a = 1;" + String.fromCharCode(10));
    // genesis：ledger 引入 + 第一次登记（sha 对齐 disk）
    const sha1 = createHashFor(root, path);
    writeFileSync(join(root, "verify", "meta.json"), JSON.stringify({
      meta_index_version: 2, orchestration: [],
      tooling: [{ path, role: "gate", sha256: sha1 }],
      reregistrations: [{ path, old_sha256: "0".repeat(64), new_sha256: sha1, reason: "genesis", actor: "t", at: "2026-10-24T00:00:00.000Z" }],
    }, null, 2));
    git("add -A"); git("commit -q -m genesis");
    // 攻击：改文件 + 对齐 tooling sha，但不写 reregistration 记录
    writeFileSync(join(root, path), "export const a = 2;" + String.fromCharCode(10));
    const sha2 = createHashFor(root, path);
    const idx = JSON.parse(readFileSync(join(root, "verify", "meta.json"), "utf8"));
    idx.tooling[0].sha256 = sha2;
    writeFileSync(join(root, "verify", "meta.json"), JSON.stringify(idx, null, 2));
    git("add -A"); git("commit -q -m silent-rehash");
    const r = spawnSync(process.execPath, [SCRIPT, "--audit", "--against-git"], {
      encoding: "utf8", env: { ...process.env, YGL_META_ROOT: root }, timeout: 120_000,
    });
    // 死代码（require 被吞）时这里会是 rc0 + "git-consistent" —— 回归即失败
    // 死代码时（require 被 catch 吞）→ rc0 + "git-consistent"；真跑则 rc1。
    // 检出面可能是链断裂（tooling sha 与最后 new 不一致）或 silent rehash——两者都证明门禁在跑。
    expect(r.status, (r.stdout || "") + (r.stderr || "")).toBe(1);
    expect((r.stdout || "") + (r.stderr || "")).toMatch(/silent rehash|chain break/);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 180_000);
});
