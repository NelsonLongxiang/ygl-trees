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
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/post-release-check.mjs <version>");
  process.exit(2);
}
const REPO = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const WORK = mkdtempSync(join(REPO, "tmp", "post-release-"));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 45 * 60_000, ...opts });
const steps = [];
const step = (name, fn) => {
  const t0 = Date.now();
  try { const detail = fn(); steps.push({ step: name, status: "pass", ms: Date.now() - t0, detail: detail || "" }); }
  catch (e) { steps.push({ step: name, status: "fail", ms: Date.now() - t0, detail: String(e?.message || e).slice(0, 300) }); }
};

try {
  mkdirSync(join(WORK, "npm-install"), { recursive: true });
  step("npm-bootstrap", () => {
    const r = sh("cmd", ["/c", "npm", "install", `ygl-trees@${version}`, "--no-fund", "--no-audit"], { cwd: join(WORK, "npm-install") });
    if (r.status !== 0) throw new Error("npm install rc=" + r.status + " " + String(r.stderr || "").slice(0, 150));
    const bin = join(WORK, "npm-install", "node_modules", ".bin", "ygl-trees");
    const home = join(WORK, "home");
    const b = sh("cmd", ["/c", "node", join(WORK, "npm-install", "node_modules", "ygl-trees", "dist", "bundle", "bin.cjs"), "db", "init"], { env: { ...process.env, YGL_HOME: home } });
    if (b.status !== 0) throw new Error("db init rc=" + b.status);
    return "npm install + db init rc0";
  });
  step("tag-clone-test", () => {
    const r = sh("git", ["clone", "-q", "-b", `v${version}`, "https://github.com/NelsonLongxiang/ygl-trees.git", join(WORK, "tag")]);
    if (r.status !== 0) throw new Error("tag clone rc=" + r.status);
    const i = sh("cmd", ["/c", "pnpm", "install", "--frozen-lockfile"], { cwd: join(WORK, "tag") });
    if (i.status !== 0) throw new Error("tag install rc=" + i.status);
    const t = sh("cmd", ["/c", "pnpm", "test"], { cwd: join(WORK, "tag") });
    if (t.status !== 0) throw new Error("tag pnpm test rc=" + t.status + " " + String(t.stdout || "").slice(-150));
    return "tag clone pnpm test rc0";
  });
  step("verify-meta", () => {
    const m = sh(process.execPath, [join(WORK, "tag", "scripts", "meta-tooling.mjs"), "--audit", "--against-git"], { cwd: join(WORK, "tag") });
    if (m.status !== 0) throw new Error("verify meta rc=" + m.status);
    return "meta-tooling --audit --against-git rc0";
  });
} finally {
  const failed = steps.filter((s) => s.status === "fail").length;
  const record = { gate: "G8", version, steps, rc: failed ? 1 : 0, at: new Date().toISOString() };
  console.log(JSON.stringify(record, null, 2));
  rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(failed ? 1 : 0);
}
