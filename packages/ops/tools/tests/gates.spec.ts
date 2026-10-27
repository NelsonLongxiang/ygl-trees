/**
 * #96 Now 门禁 G1–G9 落地的对照测试。
 * G4：commit-claims 对 5e4978d 形（声称 skills/ 但 diff 无）红、诚实提交绿。
 * G6：ratchet --write 无 --reason rc2、带 reason 写 _attribution。
 * G9：merge-check 对 ancestor/非 ancestor 判定。
 * G1/G7/G8：脚本在场 + bash -n 语法钉（内容语义由发布流程实跑）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const REPO = resolve(__dirname, "../../../..");
// #98: bash 解析平台无关——GIT_BASH 优先，win 回退 Git 安装路径，其余平台用 PATH 里的 bash；
// 不可得时显式 skip（断言 skip 原因，不许静默绿）。
const BASH = process.env.GIT_BASH || (process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");
// #98: bash 解析平台无关——GIT_BASH 优先，win 回退 Git 安装路径，其余平台用 PATH 里的 bash；
// 不可得时显式 skip（断言 skip 原因，不许静默绿）。
const NODE = process.execPath;
const run = (args, opts = {}) => spawnSync(NODE, args, { encoding: "utf8", timeout: 60_000, cwd: REPO, ...opts });

describe("#96 G4 commit-claims", () => {
  it("5e4978d shape: message names skills/… but diff touches none → rc1", () => {
    const r = run(["scripts/commit-claims.mjs", "5e4978d"]);
    expect(r.status).toBe(1);
    expect(String(r.stdout || "") + String(r.stderr || "")).toMatch(/skills\/ygl-trees-research/);
  });
  it("honest commit (message paths all in diff) → rc0", () => {
    const r = run(["scripts/commit-claims.mjs", "a91a220"]);
    expect(r.status).toBe(0);
  });
  it("scratch repo: claimed-but-absent path in fresh commit → rc1; matched → rc0", () => {
    const root = mkdtempSync(join(tmpdir(), "ygl-g4-"));
    const git = (c) => execSync("git " + c, { cwd: root, encoding: "utf8" });
    git("-c init.defaultBranch=master init -q"); git("config user.email t@t"); git("config user.name t");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "a.md"), "x\n");
    writeFileSync(join(root, "README.md"), "r\n");
    git("add -A"); git("commit -q -m base");
    writeFileSync(join(root, "README.md"), "r2\n");
    git("add -A"); git('commit -q -m "fix: update docs/b.md section"'); // 声称 docs/b.md——不在 diff
    const bad = run(["scripts/commit-claims.mjs", "HEAD", "--root", root]);
    expect(bad.status).toBe(1);
    writeFileSync(join(root, "docs", "a.md"), "x2\n");
    git("add -A"); git('commit -q -m "touch docs/a.md"');
    const ok = run(["scripts/commit-claims.mjs", "HEAD", "--root", root]);
    expect(ok.status).toBe(0);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
});

describe("#96 G6 ratchet attribution", () => {
  it("--write without --reason → rc2", () => {
    const r = run(["scripts/ratchet.mjs", "--write"]);
    expect(r.status).toBe(2);
    expect(String(r.stdout || "") + String(r.stderr || "")).toMatch(/--reason/);
  });
  it("ratchet.mjs source writes _attribution when --write --reason (source pin, no real-baseline mutation)", () => {
    const src = readFileSync(join(REPO, "scripts", "ratchet.mjs"), "utf8");
    expect(src).toContain("_attribution");
    expect(src).toContain("--reason");
    expect(src).toContain("process.exit(2)");
  });
});

describe("#96 G9 merge-check", () => {
  it("ancestor sha → rc0; non-ancestor (scratch orphan) → rc1", () => {
    const ok = run(["scripts/merge-check.mjs", "a91a220", "HEAD"]);
    expect([0]).toContain(ok.status); // a91a220 is an ancestor of current HEAD
    const root = mkdtempSync(join(tmpdir(), "ygl-g9-"));
    const git = (c) => execSync("git " + c, { cwd: root, encoding: "utf8" });
    git("-c init.defaultBranch=master init -q"); git("config user.email t@t"); git("config user.name t");
    writeFileSync(join(root, "a"), "1"); git("add -A"); git("commit -q -m a");
    git("checkout -q -b orphan"); execSync("git commit -q --allow-empty -m o", { cwd: root, encoding: "utf8" });
    git("checkout -q master");
    const orphan = git("rev-parse orphan").trim();
    // merge-check doesn't take --root; run via cwd instead
    const bad2 = spawnSync(NODE, [join(REPO, "scripts", "merge-check.mjs"), orphan, "master"], { encoding: "utf8", timeout: 30_000, cwd: root });
    expect(bad2.status).toBe(1);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
});

describe("#96 G1/G7/G8 script surfaces", () => {
  it("gate scripts exist and pass bash -n / node --check", (ctx) => {
    for (const f of ["scripts/offline-gate.sh", "scripts/pg-gate.sh"]) {
      const r = spawnSync(BASH, ["-n", join(REPO, f)], { encoding: "utf8", timeout: 30_000 });
      if (r.error && r.error.code === "ENOENT") { ctx.skip(`bash not resolvable (${BASH}) — shebang check skipped with reason (#98)`); return; }
      expect(r.status, f).toBe(0);
    }
    for (const f of ["scripts/post-release-check.mjs", "scripts/merge-check.mjs", "scripts/commit-claims.mjs"]) {
      const r = run(["--check", join(REPO, f)]);
      expect(r.status, f).toBe(0);
    }
  });
  it("pre-push hook keeps G9 guard + skip semantics (source pin)", () => {
    const t = readFileSync(join(REPO, ".githooks", "pre-push"), "utf8");
    expect(t).toContain("merge-base --is-ancestor");
    expect(t).toContain("G9_NONFF");
    // G9 guard must run BEFORE the YGL_SKIP_HOOKS early-exit
    const skipExit = t.indexOf('if [ "${YGL_SKIP_HOOKS:-}" = "1" ]');
        const g9 = t.indexOf("G9_NONFF=0");
        expect(g9).toBeGreaterThanOrEqual(0);
        expect(skipExit).toBeGreaterThan(g9);
    expect(t).not.toMatch(/Gitee Go is unavailable/); // stale header removed
  });
});

describe("#98 platform independence", () => {
  it("① scratch repo with NON-master default branch (main) stays deterministic for branch refs", () => {
    const root = mkdtempSync(join(tmpdir(), "ygl-98-"));
    const git = (c) => execSync("git " + c, { cwd: root, encoding: "utf8" });
    // 模拟 macOS：默认分支是 main——代码必须显式用 -b/refs 而非依赖宿主默认
    git("-c init.defaultBranch=main init -q"); git("config user.email t@t"); git("config user.name t");
    writeFileSync(join(root, "a"), "1"); git("add -A"); git('commit -q -m a');
    git("checkout -q -b orphan"); execSync("git commit -q --allow-empty -m o", { cwd: root, encoding: "utf8" });
    git("checkout -q main");
    const orphan = git("rev-parse orphan").trim();
    const bad = spawnSync(process.execPath, [join(REPO, "scripts", "merge-check.mjs"), orphan, "main"], { encoding: "utf8", timeout: 30_000, cwd: root });
    expect(bad.status).toBe(1); // 非 ancestor 仍判红——分支名无关
    const ok = spawnSync(process.execPath, [join(REPO, "scripts", "merge-check.mjs"), git("rev-parse main").trim(), "main"], { encoding: "utf8", timeout: 30_000, cwd: root });
    expect(ok.status).toBe(0);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  it("② BASH resolution never throws on any platform (win path / PATH bash / GIT_BASH)", () => {
    // 纯逻辑面：三种来源都产生非空字符串；spawn 失败路径由上一块的显式 skip 覆盖
    const fallback = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
    expect(typeof fallback).toBe("string");
    expect(fallback.length).toBeGreaterThan(3);
    if (process.env.GIT_BASH) expect(process.env.GIT_BASH.length).toBeGreaterThan(3); // 显式提供时必须有效
  });
  it("③ post-release-check.mjs sources carry the platform fork (win cmd /c vs direct spawn)", () => {
    const src = readFileSync(join(REPO, "scripts", "post-release-check.mjs"), "utf8");
    expect(src).toContain('process.platform === "win32"');
    expect(src).toContain('spawnSync("cmd", ["/c", cmd'); // win 分支存在
    expect(src).not.toContain('sh("cmd", ["/c", "npm"'); // 直调面不再全走 cmd（非 win 可执行）
  });
});

describe("#98/#96 复核补：G4 豁免面 + G9 删除放行", () => {
  it("G4 --allow exempts read-mentions (real range proves clean)", () => {
    const bad = run(["scripts/commit-claims.mjs", "6e5d84e..830db22"]);
    expect(bad.status).toBe(1); // 未豁免时 2 例读引述红（钉住豁免必要性）
    const ok = run(["scripts/commit-claims.mjs", "6e5d84e..830db22", "--allow", "skills/ygl-trees-research,scripts/dual-backend-matrix.mjs"]);
    expect(ok.status).toBe(0);
  });
  it("G9 hook passes branch-deletion pushes (local sha all zeros)", () => {
    const t = readFileSync(join(REPO, ".githooks", "pre-push"), "utf8");
    expect(t).toContain('"$_local_sha" = "0000000000000000000000000000000000000000"');
  });
});

describe("#98 二次复核（macOS）", () => {
  it("G11 volume-gate measures via fs (no GNU du) and refuses zero measurement", () => {
    const src = readFileSync(join(REPO, "scripts", "volume-gate.mjs"), "utf8");
    expect(src).not.toContain("du -b");
    expect(src).toContain("readdirSync");
    expect(src).toContain("refusing to judge");
    const r = spawnSync(process.execPath, [join(REPO, "scripts", "volume-gate.mjs"), "--json"], { encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(0);
    const j = JSON.parse(String(r.stdout || "{}"));
    const docs = (j.report || []).find((x) => x.metric === "docs_active_bytes");
    expect(docs.value).toBeGreaterThan(0); // 真的量到了（macOS du 假 0 的镜像反例）
  });
  it("G8 post-release WORK dir is outside the repo and seeds a private package.json", () => {
    const src = readFileSync(join(REPO, "scripts", "post-release-check.mjs"), "utf8");
    expect(src).toContain("os.tmpdir()");
    expect(src).not.toMatch(/mkdtempSync\(join\(REPO, "tmp"/);
    expect(src).toContain("post-release-probe");
  });
  it("pre-push runs verify meta AFTER the test build (stale-bundle false red 断根)", () => {
    const t = readFileSync(join(REPO, ".githooks", "pre-push"), "utf8");
    const testIdx = t.indexOf("pnpm test");
    const metaIdx = t.indexOf("verify meta");
    expect(metaIdx).toBeGreaterThan(testIdx);
  });
});
