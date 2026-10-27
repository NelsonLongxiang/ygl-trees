#!/usr/bin/env node
/**
 * G8 发布后复跑基线（roadmap/#96 条目 7）——npm 包 + v* 标签克隆双面复跑。
 *
 * 面上三件：①bootstrap（npm 装的 bin db init）②tag 克隆里 pnpm test ③verify meta .
 * 结果（JSON）贴进发布记录 / 对应 issue。
 *
 * 用法：node scripts/post-release-check.mjs <version>   # 例 0.116.0
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/post-release-check.mjs <version>");
  process.exit(2);
}
const REPO = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
// #98 复核（macOS）：工作目录**出仓**（os.tmpdir）——仓内会让 npm 向上找到仓库根的
// workspace package.json（同名 ygl-trees + workspace: 依赖）而崩溃。
const WORK = mkdtempSync(join(os.tmpdir(), "ygl-post-release-"));
// #98: 平台分流——win 用 .cmd 垫片经 shell，非 win 直接可执行（npm/pnpm 带 shebang）。
const isWin = process.platform === "win32";
const sh = (cmd, args, opts = {}) =>
  isWin
    ? spawnSync("cmd", ["/c", cmd, ...args], { encoding: "utf8", timeout: 45 * 60_000, ...opts })
    : spawnSync(cmd, args, { encoding: "utf8", timeout: 45 * 60_000, ...opts });
const steps = [];
const step = (name, fn) => {
  const t0 = Date.now();
  try { const detail = fn(); steps.push({ step: name, status: "pass", ms: Date.now() - t0, detail: detail || "" }); }
  catch (e) { steps.push({ step: name, status: "fail", ms: Date.now() - t0, detail: String(e?.message || e).slice(0, 300) }); }
};

try {
  mkdirSync(join(WORK, "npm-install"), { recursive: true });
  // 再兜一层：该目录写最小 package.json（私有、无依赖），npm 不会向上继承任何 workspace
  writeFileSync(join(WORK, "npm-install", "package.json"), JSON.stringify({ name: "post-release-probe", version: "0.0.0", private: true }, null, 2));
  step("npm-bootstrap", () => {
    const r = sh("npm", ["install", `ygl-trees@${version}`, "--no-fund", "--no-audit"], { cwd: join(WORK, "npm-install") });
    if (r.status !== 0) throw new Error("npm install rc=" + r.status + " " + String(r.stderr || "").slice(0, 150));
    const bin = join(WORK, "npm-install", "node_modules", ".bin", "ygl-trees");
    const home = join(WORK, "home");
    const b = sh(process.execPath, [join(WORK, "npm-install", "node_modules", "ygl-trees", "dist", "bundle", "bin.cjs"), "db", "init"], { env: { ...process.env, YGL_HOME: home } });
    if (b.status !== 0) throw new Error("db init rc=" + b.status);
    return "npm install + db init rc0";
  });
  step("tag-clone-test", () => {
    const r = sh("git", ["clone", "-q", "-b", `v${version}`, "https://github.com/NelsonLongxiang/ygl-trees.git", join(WORK, "tag")]);
    if (r.status !== 0) throw new Error("tag clone rc=" + r.status);
    const i = sh("pnpm", ["install", "--frozen-lockfile"], { cwd: join(WORK, "tag") });
    if (i.status !== 0) throw new Error("tag install rc=" + i.status);
    const t = sh("pnpm", ["test"], { cwd: join(WORK, "tag") });
    if (t.status !== 0) throw new Error("tag pnpm test rc=" + t.status + " " + String(t.stdout || "").slice(-150));
    return "tag clone pnpm test rc0";
  });
  step("verify-meta", () => {
    // #98 复核更正：真跑 CLI 面 `verify meta <tag-root>`（此前跑的是 meta-tooling --audit——面不对）
    const tagRoot = join(WORK, "tag");
    const m = sh(process.execPath, [join(tagRoot, "dist", "bundle", "bin.cjs"), "verify", "meta", tagRoot], { cwd: tagRoot });
    if (m.status !== 0) throw new Error("verify meta rc=" + m.status + " " + String(m.stdout || m.stderr || "").slice(0, 150));
    return "CLI verify meta <tag-root> rc0";
  });
} finally {
  const failed = steps.filter((s) => s.status === "fail").length;
  const record = { gate: "G8", version, steps, rc: failed ? 1 : 0, at: new Date().toISOString() };
  console.log(JSON.stringify(record, null, 2));
  rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(failed ? 1 : 0);
}
