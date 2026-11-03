#!/usr/bin/env node
/**
 * G8 发布后复跑基线（roadmap/#96 条目 7）——npm 包 + v* 标签克隆双面复跑。
 *
 * 面上三件：①bootstrap（npm 装的 bin db init）②tag 克隆里 pnpm test ③verify meta .
 * 结果（JSON）贴进发布记录 / 对应 issue。
 *
 * #178：每一步的**完整** stdout/stderr 落盘（不再只留末尾 150 字符），失败时保留工作目录
 * 与全部日志并把路径打进记录——G8 在 Windows 发版机失败过两次且失败行被截断，无法定根因。
 *
 * 用法：node scripts/post-release-check.mjs <version>   # 例 0.116.0
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const LOGS = join(WORK, "logs");
mkdirSync(LOGS, { recursive: true });
// #98: 平台分流——win 用 .cmd 垫片经 shell，非 win 直接可执行（npm/pnpm 带 shebang）。
const isWin = process.platform === "win32";

/**
 * 跑一条命令，**把 stdout+stderr 原样写进日志文件**（stdio 直连 fd，不经内存缓冲），
 * 因此不受 spawnSync maxBuffer 限制，也不会丢行。返回 rc 与日志路径/字节数。
 */
function run(cmd, args, { cwd, env, logName, timeout = 45 * 60_000 } = {}) {
  const logFile = join(LOGS, logName);
  const fd = openSync(logFile, "a");
  try {
    const r = isWin
      ? spawnSync("cmd", ["/c", cmd, ...args], { cwd, env, stdio: ["ignore", fd, fd], timeout })
      : spawnSync(cmd, args, { cwd, env, stdio: ["ignore", fd, fd], timeout });
    const bytes = (() => { try { return statSync(logFile).size; } catch { return 0; } })();
    return { status: r.status, signal: r.signal, error: r.error, logFile, bytes };
  } finally {
    closeSync(fd);
  }
}

/**
 * 克隆内跑 pnpm/git 用的**净化环境**（#178）：G8 常在 pnpm/宿主工具的 lifecycle 环境里被调用，
 * process.env 会带上 npm_lifecycle_event=dsh、npm_package_json=<别的仓>、PNPM_SCRIPT_SRC_DIR、
 * npm_config_user_agent 之类，以及宿主的 YGL_SESSION——它们会漏进被验证仓库的构建与测试，
 * 让「干净机器上能过」的链在这里红。这里只去掉属于**调用方工具链**的键，保留 PATH/HOME/TEMP 等。
 */
const droppedEnv = new Set();
function cloneEnv() {
  const drop = /^(npm_|pnpm_|PNPM_|YGL_|INIT_CWD$)/i;
  const e = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (drop.test(k)) droppedEnv.add(k);
    else e[k] = v;
  }
  return e;
}

/** 失败时把日志尾部带回记录里（仅作摘要，完整日志在 logFile）。 */
function tail(logFile, n = 400) {
  try {
    const s = readFileSync(logFile, "utf8");
    return s.length > n ? "…" + s.slice(-n) : s;
  } catch { return ""; }
}

/**
 * 失败现场的轻量快照（#178）：失败是间歇的，必须把「当时的树长什么样」留下来——
 * 尤其是 dist/bundle 清单（skills-audit 的 rc=2 只在 bin.cjs 缺失时出现）与临时目录状态。
 * 纯 fs 读取，不跑子进程，失败也不影响主记录。
 */
function diagnostics() {
  const diag = { at: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, work: WORK, work_exists: existsSync(WORK) };
  const tagDir = join(WORK, "tag");
  diag.tag_exists = existsSync(tagDir);
  try { diag.tag_head = readFileSync(join(tagDir, ".git", "HEAD"), "utf8").trim(); } catch (e) { diag.tag_head = `unreadable (${e.code})`; }
  const bundleDir = join(tagDir, "dist", "bundle");
  try {
    diag.dist_bundle = readdirSync(bundleDir).map((f) => { try { return `${f}:${statSync(join(bundleDir, f)).size}`; } catch { return f; } });
  } catch (e) { diag.dist_bundle = `MISSING (${e.code})`; }
  diag.node_modules_bin = existsSync(join(tagDir, "node_modules", ".bin"));
  try {
    diag.logs = readdirSync(LOGS).map((f) => `${f}:${statSync(join(LOGS, f)).size}`);
  } catch (e) { diag.logs = `unreadable (${e.code})`; }
  return diag;
}

const steps = [];
const step = (name, fn) => {
  const t0 = Date.now();
  const logs = [];
  const rec = (logFile) => { if (logFile) logs.push(logFile); };
  try {
    const detail = fn(rec);
    steps.push({ step: name, status: "pass", ms: Date.now() - t0, detail: detail || "", logs });
  } catch (e) {
    const detail = String(e?.message || e);
    steps.push({ step: name, status: "fail", ms: Date.now() - t0, detail, logs, tail: logs.length ? tail(logs[logs.length - 1]) : "" });
  }
};

/** 命令失败就抛，消息里点名 rc + 日志路径（不再截断 stdout）。 */
function must(label, r, extra = "") {
  if (r.status !== 0) {
    const why = r.error ? `${r.error.message}` : `rc=${r.status}${r.signal ? ` signal=${r.signal}` : ""}`;
    throw new Error(`${label} ${why}${extra ? " " + extra : ""} — log: ${r.logFile}`);
  }
  return r;
}

console.error(`[G8] version=${version} work=${WORK}`);

try {
  mkdirSync(join(WORK, "npm-install"), { recursive: true });
  // 再兜一层：该目录写最小 package.json（私有、无依赖），npm 不会向上继承任何 workspace
  writeFileSync(join(WORK, "npm-install", "package.json"), JSON.stringify({ name: "post-release-probe", version: "0.0.0", private: true }, null, 2));

  step("npm-bootstrap", (rec) => {
    const inst = run("npm", ["install", `ygl-trees@${version}`, "--no-fund", "--no-audit"], { cwd: join(WORK, "npm-install"), env: process.env, logName: "npm-install.log" });
    rec(inst.logFile); // #178: 先记账再判 rc——失败的命令也要留下日志路径
    must("npm install", inst);
    const home = join(WORK, "home");
    const b = run(process.execPath, [join(WORK, "npm-install", "node_modules", "ygl-trees", "dist", "bundle", "bin.cjs"), "db", "init"], { env: { ...process.env, YGL_HOME: home }, logName: "db-init.log" });
    rec(b.logFile);
    must("db init", b);
    return `npm install + db init rc0 (logs: npm-install.log, db-init.log)`;
  });

  step("tag-clone-test", (rec) => {
    const tagDir = join(WORK, "tag");
    const c = run("git", ["clone", "-q", "-b", `v${version}`, "https://github.com/NelsonLongxiang/ygl-trees.git", tagDir], { env: process.env, logName: "git-clone.log" });
    rec(c.logFile);
    must("tag clone", c);
    const i = run("pnpm", ["install", "--frozen-lockfile"], { cwd: tagDir, env: cloneEnv(), logName: "tag-install.log" });
    rec(i.logFile);
    must("tag install", i);
    const t = run("pnpm", ["test"], { cwd: tagDir, env: cloneEnv(), logName: "tag-test.log" });
    rec(t.logFile); // 失败时这条才是要看的日志
    must("tag pnpm test", t);
    return `tag clone pnpm test rc0 (log: tag-test.log, ${t.bytes} bytes)`;
  });

  step("verify-meta", (rec) => {
    // #98 复核更正：真跑 CLI 面 `verify meta <tag-root>`（此前跑的是 meta-tooling --audit——面不对）
    const tagRoot = join(WORK, "tag");
    const m = run(process.execPath, [join(tagRoot, "dist", "bundle", "bin.cjs"), "verify", "meta", tagRoot], { cwd: tagRoot, env: process.env, logName: "verify-meta.log" });
    rec(m.logFile);
    must("verify meta", m);
    return "CLI verify meta <tag-root> rc0";
  });
} finally {
  const failed = steps.filter((s) => s.status === "fail").length;
  // #178: 失败时把现场一并留下（dist/bundle 清单、tag 头、日志清单），下次复现可直接归因。
  let diagFile = null;
  if (failed) {
    try {
      diagFile = join(WORK, "diagnostics.json");
      writeFileSync(diagFile, JSON.stringify(diagnostics(), null, 2));
    } catch { diagFile = null; }
  }
  const record = {
    gate: "G8",
    version,
    steps,
    rc: failed ? 1 : 0,
    at: new Date().toISOString(),
    // #178: 成功时工作目录会被删掉，日志路径仅作当次定位；失败时整目录保留供取证。
    work_dir: failed ? WORK : null,
    logs_dir: failed ? LOGS : null,
    diagnostics: diagFile,
    // #178: 克隆内跑 pnpm 前被摘掉的调用方工具链键（可核对环境是否干净）
    env_dropped: [...droppedEnv].sort(),
  };
  console.log(JSON.stringify(record, null, 2));
  if (failed) {
    console.error(`\nG8: ${failed} step(s) failed — full stdout/stderr kept at ${LOGS}`);
    if (diagFile) console.error(`G8: failure snapshot at ${diagFile}`);
    process.exit(1);
  }
  rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(0);
}
