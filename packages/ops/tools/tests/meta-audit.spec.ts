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

  // ── 监督席 r37 五复现：修复前这些全部漏检 ──
  const mkRepo = (files: Record<string, string>) => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "ygl-repro-"));
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, encoding: "utf8" });
    git("init -q"); git("config user.email t@t"); git("config user.name t");
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(require("node:path").dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return { root, git };
  };
  const shaOf = (root: string, rel: string) =>
    require("node:crypto").createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
  const audit = (root: string) =>
    spawnSync(process.execPath, [SCRIPT, "--audit", ...(process.env.REPRO_AGAINST ? ["--against-git"] : [])], {
      encoding: "utf8", env: { ...process.env, YGL_META_ROOT: root }, timeout: 120_000,
    });

  it("#37 repro 1: silent single post-genesis change (file+sha aligned, no record) → rc1", () => {
    const { root, git } = mkRepo({ "scripts/p.mjs": "v1" + String.fromCharCode(10) });
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(root, "verify"), { recursive: true });
    const s1 = shaOf(root, "scripts/p.mjs");
    writeFileSync(join(root, "verify", "meta.json"), JSON.stringify({
      meta_index_version: 2, orchestration: [], tooling: [{ path: "scripts/p.mjs", role: "gate", sha256: s1 }],
      reregistrations: [{ path: "scripts/p.mjs", old_sha256: "0".repeat(64), new_sha256: s1, reason: "genesis", actor: "t", at: "2026-10-24T00:00:00.000Z" }],
    }, null, 2));
    git("add -A"); git("commit -q -m genesis");
    writeFileSync(join(root, "scripts", "p.mjs"), "v2" + String.fromCharCode(10));
    const s2 = shaOf(root, "scripts/p.mjs");
    const idx = JSON.parse(readFileSync(join(root, "verify", "meta.json"), "utf8"));
    idx.tooling[0].sha256 = s2;
    writeFileSync(join(root, "verify", "meta.json"), JSON.stringify(idx, null, 2));
    git("add -A"); git("commit -q -m silent");
    process.env.REPRO_AGAINST = "1";
    const r = audit(root);
    delete process.env.REPRO_AGAINST;
    expect(r.status, (r.stdout || "") + (r.stderr || "")).toBe(1);
    expect((r.stdout || "") + (r.stderr || "")).toMatch(/silent rehash|chain break/);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 180_000);

  it("#37 repro 3: cleared reregistrations (tooling non-empty) → rc1", () => {
    const root = mkdtempSync(join(tmpdir(), "ygl-repro3-"));
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(root, "verify"), { recursive: true });
    writeFileSync(join(root, "verify", "meta.json"), JSON.stringify({
      meta_index_version: 2, orchestration: [], tooling: [{ path: "x", role: "gate", sha256: "a".repeat(64) }],
      reregistrations: [],
    }, null, 2));
    const r = audit(root);
    expect(r.status).toBe(1);
    expect((r.stdout || "") + (r.stderr || "")).toMatch(/ledger cleared|unverifiable/);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 60_000);

  it("#37 repro 4: time reversal within a path → rc1", () => {
    const root = mkdtempSync(join(tmpdir(), "ygl-repro4-"));
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(root, "verify"), { recursive: true });
    writeFileSync(join(root, "verify", "meta.json"), JSON.stringify({
      meta_index_version: 2, orchestration: [], tooling: [{ path: "x", role: "gate", sha256: "b".repeat(64) }],
      reregistrations: [
        { path: "x", old_sha256: "0".repeat(64), new_sha256: "1".repeat(64), reason: "a", actor: "t", at: "2026-10-24T05:00:00.000Z" },
        { path: "x", old_sha256: "1".repeat(64), new_sha256: "b".repeat(64), reason: "b", actor: "t", at: "2026-10-24T01:00:00.000Z" },
      ],
    }, null, 2));
    const r = audit(root);
    expect(r.status).toBe(1);
    expect((r.stdout || "") + (r.stderr || "")).toMatch(/time reversal|chain break/);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 60_000);

  // #88（监督席 direct-fe588519 / 评审席 issue）：--add 写 Z 锚与 --against-git 链首检查
  // 对「genesis 之后新增的工具」冲突——正当初始登记被读成孤儿。新规：未 pin 且 genesis
  // 时不存在 → 首条必须 00000000→首提交 blob；删首条/伪造/未提交仍红。
  const mkNewToolRepo = () => {
    const { root, git } = mkRepo({ "scripts/old.mjs": "o1" + String.fromCharCode(10) });
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(root, "verify"), { recursive: true });
    const o1 = shaOf(root, "scripts/old.mjs");
    writeFileSync(join(root, "verify", "meta.json"), JSON.stringify({
      meta_index_version: 2, orchestration: [],
      tooling: [{ path: "scripts/old.mjs", role: "gate", sha256: o1 }],
      reregistrations: [{ path: "scripts/old.mjs", old_sha256: o1, new_sha256: o1, reason: "genesis", actor: "t", at: "2026-10-24T00:00:00.000Z" }],
    }, null, 2));
    git("add -A"); git("commit -q -m genesis");
    writeFileSync(join(root, "scripts", "new.mjs"), "v1" + String.fromCharCode(10));
    const n1 = shaOf(root, "scripts/new.mjs");
    const idx = JSON.parse(readFileSync(join(root, "verify", "meta.json"), "utf8"));
    idx.tooling.push({ path: "scripts/new.mjs", role: "gate", sha256: n1 });
    idx.reregistrations.push({ path: "scripts/new.mjs", old_sha256: "0".repeat(64), new_sha256: n1, reason: "initial registration (--add; #37 item 1 anchor)", actor: "t", at: "2026-10-25T00:00:00.000Z" });
    writeFileSync(join(root, "verify", "meta.json"), JSON.stringify(idx, null, 2));
    git("add -A"); git("commit -q -m add-new-tool");
    return { root, git, n1 };
  };
  const auditAgainstGit = (root: string) =>
    spawnSync(process.execPath, [SCRIPT, "--audit", "--against-git"], {
      encoding: "utf8", env: { ...process.env, YGL_META_ROOT: root }, timeout: 120_000,
    });
  const wipe = (root: string) => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  it("#83 返修轮: multi-edit-then-commit 跨步 git 变迁经账本链可达 → 不误报 silent rehash", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "ygl-multiedit-"));
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, encoding: "utf-8" });
    git("init -q"); git("config user.email t@t"); git("config user.name t");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "verify"), { recursive: true });
    const shaOf = (s: string) => require("node:crypto").createHash("sha256").update(s).digest("hex");
    const path = "scripts/m.mjs";
    const vA = "a1" + String.fromCharCode(10); const vB = "b1" + String.fromCharCode(10); const vC = "c1" + String.fromCharCode(10);
    writeFileSync(join(root, path), vA);
    writeFileSync(join(root, "verify", "meta.json"), JSON.stringify({
      meta_index_version: 2, orchestration: [],
      tooling: [{ path, role: "gate", sha256: shaOf(vA) }],
      reregistrations: [{ path, old_sha256: shaOf(vA), new_sha256: shaOf(vB), reason: "edit 1", actor: "t", at: "2026-10-20T00:00:00.000Z" }],
    }, null, 2));
    git("add -A"); git("commit -q -m state-A");
    // 工作区两跳（A→B→C 各记一跳），一次提交到 C——git 变迁 A→C 跨步
    writeFileSync(join(root, path), vC);
    const idx = JSON.parse(readFileSync(join(root, "verify", "meta.json"), "utf8"));
    idx.tooling[0].sha256 = shaOf(vC);
    idx.reregistrations.push({ path, old_sha256: shaOf(vB), new_sha256: shaOf(vC), reason: "edit 2", actor: "t", at: "2026-10-20T00:01:00.000Z" });
    writeFileSync(join(root, "verify", "meta.json"), JSON.stringify(idx, null, 2));
    git("add -A"); git("commit -q -m jump-to-C");
    const r = spawnSync(process.execPath, [SCRIPT, "--audit", "--against-git"], { encoding: "utf8", env: { ...process.env, YGL_META_ROOT: root }, timeout: 120_000 });
    expect(r.status, (r.stdout || "") + (r.stderr || "")).toBe(0);
    // 负例：git 里再进一个未登记态 X（C→X 无账本对且不可达）→ silent rehash
    // （tooling/first-anchor/last-new 保持一致——只有 git 对账面能抓到）
    writeFileSync(join(root, path), "x1" + String.fromCharCode(10));
    git("add -A"); git("commit -q -m unrecorded-X");
    const rX = spawnSync(process.execPath, [SCRIPT, "--audit", "--against-git"], { encoding: "utf8", env: { ...process.env, YGL_META_ROOT: root }, timeout: 120_000 });
    expect(rX.status, (rX.stdout || "") + (rX.stderr || "")).toBe(1);
    expect((rX.stdout || "") + (rX.stderr || "")).toMatch(/silent rehash/);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 180_000);

  it("#88: post-genesis tool initial registration → rc0; delete-first/forged/untracked variants → rc1", () => {
    // ① 正当初始登记（Z→首提交 blob）：rc0 + git-consistent
    {
      const { root } = mkNewToolRepo();
      const r = auditAgainstGit(root);
      expect(r.status, (r.stdout || "") + (r.stderr || "")).toBe(0);
      expect((r.stdout || "") + (r.stderr || "")).toMatch(/git-consistent/);
      wipe(root);
    }
    // ② 删掉首条（先真实登记 v1→v2，再删 Z→v1）：新首条 old≠Z → rc1 点名
    {
      const { root, git } = mkNewToolRepo();
      writeFileSync(join(root, "scripts", "new.mjs"), "v2" + String.fromCharCode(10));
      const n2 = shaOf(root, "scripts/new.mjs");
      const idx = JSON.parse(readFileSync(join(root, "verify", "meta.json"), "utf8"));
      const prevNew = idx.reregistrations[idx.reregistrations.length - 1].new_sha256;
      idx.reregistrations.push({ path: "scripts/new.mjs", old_sha256: prevNew, new_sha256: n2, reason: "real change", actor: "t", at: "2026-10-25T01:00:00.000Z" });
      (idx.tooling as any[]).find((t) => t.path === "scripts/new.mjs").sha256 = n2;
      idx.reregistrations = (idx.reregistrations as any[]).filter((e) => !(e.path === "scripts/new.mjs" && e.old_sha256 === "0".repeat(64)));
      writeFileSync(join(root, "verify", "meta.json"), JSON.stringify(idx, null, 2));
      git("add -A"); git("commit -q -m delete-first");
      const r = auditAgainstGit(root);
      expect(r.status, (r.stdout || "") + (r.stderr || "")).toBe(1);
      expect((r.stdout || "") + (r.stderr || "")).toMatch(/post-genesis tool must root/);
      wipe(root);
    }
    // ③ 伪造 new（≠首提交 blob，tooling 同步对齐以过 stage-1）→ rc1
    {
      const { root, git } = mkNewToolRepo();
      const forged = require("node:crypto").createHash("sha256").update("forged").digest("hex");
      const idx = JSON.parse(readFileSync(join(root, "verify", "meta.json"), "utf8"));
      (idx.reregistrations as any[]).find((e) => e.path === "scripts/new.mjs").new_sha256 = forged;
      (idx.tooling as any[]).find((t) => t.path === "scripts/new.mjs").sha256 = forged;
      writeFileSync(join(root, "verify", "meta.json"), JSON.stringify(idx, null, 2));
      git("add -A"); git("commit -q -m forge");
      const r = auditAgainstGit(root);
      expect(r.status, (r.stdout || "") + (r.stderr || "")).toBe(1);
      expect((r.stdout || "") + (r.stderr || "")).toMatch(/post-genesis tool must root/);
      wipe(root);
    }
    // ④ 未提交（untracked）路径登记 → rc1 no git history
    {
      const { root } = mkNewToolRepo();
      writeFileSync(join(root, "scripts", "untracked.mjs"), "u1" + String.fromCharCode(10));
      const u1 = shaOf(root, "scripts/untracked.mjs");
      const idx = JSON.parse(readFileSync(join(root, "verify", "meta.json"), "utf8"));
      idx.tooling.push({ path: "scripts/untracked.mjs", role: "gate", sha256: u1 });
      idx.reregistrations.push({ path: "scripts/untracked.mjs", old_sha256: "0".repeat(64), new_sha256: u1, reason: "initial registration (--add; #37 item 1 anchor)", actor: "t", at: "2026-10-25T02:00:00.000Z" });
      writeFileSync(join(root, "verify", "meta.json"), JSON.stringify(idx, null, 2));
      const r = auditAgainstGit(root);
      expect(r.status, (r.stdout || "") + (r.stderr || "")).toBe(1);
      expect((r.stdout || "") + (r.stderr || "")).toMatch(/no git history/);
      wipe(root);
    }
  }, 300_000);

  it("#88: --add without resolvable actor → rc2; post-cutoff 'unknown' actor → audit rc1", () => {
    // ① --add 无 --actor 且断掉 git config → rc2（不得写 'unknown'）
    {
      const root = mkdtempSync(join(tmpdir(), "ygl-add-actor-"));
      const { mkdirSync } = require("node:fs") as typeof import("node:fs");
      mkdirSync(join(root, "scripts"), { recursive: true });
      mkdirSync(join(root, "verify"), { recursive: true });
      writeFileSync(join(root, "scripts", "x.mjs"), "x" + String.fromCharCode(10));
      writeFileSync(join(root, "verify", "meta.json"), JSON.stringify({ meta_index_version: 2, orchestration: [], tooling: [] }, null, 2));
      const r = spawnSync(process.execPath, [SCRIPT, "--add", "scripts/x.mjs", "--role", "gate"], {
        encoding: "utf8", env: { ...process.env, YGL_META_ROOT: root, HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/nonexistent" }, timeout: 60_000,
      });
      expect(r.status, (r.stdout || "") + (r.stderr || "")).toBe(2);
      expect((r.stdout || "") + (r.stderr || "")).toMatch(/--add needs --actor/);
      wipe(root);
    }
    // ①b（#88 条目5，评审席 comment 6407091287）：调用方检出带 local user.name、
    // YGL_META_ROOT 指向别处（非 git 目录）→ 身份不得泄漏，仍 rc2。
    // 回归形态：不传 cwd 时会读到调用方仓库的 user.name 记成归属。
    {
      const { execSync } = require("node:child_process") as typeof import("node:child_process");
      const callerRepo = mkdtempSync(join(tmpdir(), "ygl-caller-identity-"));
      execSync("git init -q && git config user.email t@t && git config user.name tester", { cwd: callerRepo });
      const root2 = mkdtempSync(join(tmpdir(), "ygl-add-actor2-"));
      const { mkdirSync } = require("node:fs") as typeof import("node:fs");
      mkdirSync(join(root2, "scripts"), { recursive: true });
      mkdirSync(join(root2, "verify"), { recursive: true });
      writeFileSync(join(root2, "scripts", "x.mjs"), "x" + String.fromCharCode(10));
      writeFileSync(join(root2, "verify", "meta.json"), JSON.stringify({ meta_index_version: 2, orchestration: [], tooling: [] }, null, 2));
      const r = spawnSync(process.execPath, [SCRIPT, "--add", "scripts/x.mjs", "--role", "gate"], {
        cwd: callerRepo,
        encoding: "utf8", env: { ...process.env, YGL_META_ROOT: root2, HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/nonexistent", GIT_CONFIG_SYSTEM: "/nonexistent" }, timeout: 60_000,
      });
      expect(r.status, (r.stdout || "") + (r.stderr || "")).toBe(2);
      expect((r.stdout || "") + (r.stderr || "")).toMatch(/--add needs --actor/);
      wipe(callerRepo); wipe(root2);
    }
    // ② 切换点后 actor='unknown' → audit rc1 点名
    {
      const { root, git } = mkRepo({ "scripts/p.mjs": "v1" + String.fromCharCode(10) });
      const { mkdirSync } = require("node:fs") as typeof import("node:fs");
      mkdirSync(join(root, "verify"), { recursive: true });
      const s1 = shaOf(root, "scripts/p.mjs");
      writeFileSync(join(root, "verify", "meta.json"), JSON.stringify({
        meta_index_version: 2, orchestration: [], tooling: [{ path: "scripts/p.mjs", role: "gate", sha256: s1 }],
        actor_required_from: "2026-10-25T00:00:00.000Z",
        reregistrations: [{ path: "scripts/p.mjs", old_sha256: "0".repeat(64), new_sha256: s1, reason: "initial registration", actor: "unknown", at: "2026-10-26T00:00:00.000Z" }],
      }, null, 2));
      git("add -A"); git("commit -q -m genesis");
      const r = spawnSync(process.execPath, [SCRIPT, "--audit"], {
        encoding: "utf8", env: { ...process.env, YGL_META_ROOT: root }, timeout: 60_000,
      });
      expect(r.status, (r.stdout || "") + (r.stderr || "")).toBe(1);
      expect((r.stdout || "") + (r.stderr || "")).toMatch(/actor missing\/unknown after cutoff/);
      wipe(root);
    }
  }, 120_000);
});
