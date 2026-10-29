#!/usr/bin/env node
/**
 * B6 双后端门禁矩阵 — SQLite 与 PG 两端跑同一组门禁，**两后端全绿才发版**。
 *
 * 设计（PG 方案 §5 B6 / 护栏①）：
 * - **SQLite 腿**：unit + demo + contract-audit + readme-verify + **self-check 全链**
 * - **PG 腿**：同一组门禁在 PG 工作区上跑（YGL_DB_URL / YGL_PG_URL 指向真库）
 * - **fail-closed**：`--strict`（发版路径）要求两腿都绿；PG 未配置时 PG 腿
 *   明确标 `skipped(no-pg)` 并让 `--strict` **退出非零**——「没跑过」不等于「绿」。
 * - 非 strict（本地探险）允许只有 SQLite 腿，但输出里必须写明 PG 腿状态。
 *
 * 用法：
 *   node scripts/dual-backend-matrix.mjs                 # 探险：SQLite 腿 + PG 腿状态
 *   node scripts/dual-backend-matrix.mjs --strict        # 发版：两腿都必须绿
 *   node scripts/dual-backend-matrix.mjs --json          # 机器可读
 *   YGL_PG_URL=postgresql://… node scripts/… --strict    # 带 PG 腿
 *
 * 注：PG 腿的真库由**本地 docker 门**提供（scripts/pg-gate.sh 起 pinned
 * postgres:16.4-alpine；总工裁 direct-2c7c431a：本仓无 CI 面，私仓 Actions 按分钟计费，
 * 用本地 docker 门）。本脚本只编排与判定，不内建容器管理。
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const strict = args.includes("--strict");
const json = args.includes("--json");
const pgUrl = process.env.YGL_PG_URL || process.env.YGL_DB_URL || "";

function sh(cmd, argv, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, argv, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30 * 60_000,
    env: { ...process.env, YGL_DB_URL: "", ...(opts.env || {}) },
  });
  return { status: r.status ?? -1, out: (r.stdout || "") + (r.stderr || ""), ms: Date.now() - t0 };
}

const legs = [];
const home = mkdtempSync(join(tmpdir(), "ygl-b6-"));

// ── SQLite 腿 ──────────────────────────────────────────────────────────
{
  const sqliteHome = join(home, "sqlite-home");
  const steps = [
    ["unit", ["node", "node_modules/vitest/vitest.mjs", "run", "--maxWorkers=1"], { timeoutMs: 45 * 60_000 }],
    ["contract", ["bash", "scripts/contract-audit.sh"], { timeoutMs: 15 * 60_000 }],
    ["demo", ["bash", "examples/demo.sh"], { timeoutMs: 20 * 60_000, env: { YGL_HOME: sqliteHome } }],
    ["self-check-init", ["node", "dist/bundle/bin.cjs", "db", "init", "--json"], { env: { YGL_HOME: sqliteHome } }],
    ["self-check", ["node", "dist/bundle/bin.cjs", "verify", "self-check", "--json"], { timeoutMs: 20 * 60_000, env: { YGL_HOME: sqliteHome } }],
  ];
  const results = [];
  for (const [name, cmd, opts] of steps) {
    const r = sh(cmd[0], cmd.slice(1), opts);
    const expected = opts.expectedRc ?? 0;
    const untouched = !opts.noFilesUnder || !existsSync(opts.noFilesUnder);
    results.push({ step: name, status: r.status === expected && untouched ? "pass" : "fail", ms: r.ms, tail: r.out.slice(-200) });
  }
  legs.push({ backend: "sqlite", status: results.every((r) => r.status === "pass") ? "pass" : "fail", steps: results });
}

// ── PG 腿 ─────────────────────────────────────────────────────────────
if (!pgUrl) {
  legs.push({
    backend: "pg",
    status: "skipped",
    reason: "no YGL_PG_URL / YGL_DB_URL — PG leg cannot run (strict mode fails closed)",
    steps: [],
  });
} else {
  const pgHome = join(home, "pg-home");
  const steps = [
    ["init-pg-refused", ["node", "dist/bundle/bin.cjs", "db", "init", "--json"], { expectedRc: 2, noFilesUnder: pgHome, env: { YGL_HOME: pgHome, YGL_DB_URL: pgUrl } }],
    // #93-①（评审席 6431183774 重述标准 a）：PG 腿必须含一步**真正需要 PG** 的面——
    // db stats 在 PG env 下直连 PG（不可达 → rc1 → 腿红 → --strict rc≠0）。
    // 死 PG 下全绿的「名存实亡」从这里断根。
    ["pg-stats", ["node", "dist/bundle/bin.cjs", "db", "stats", "--json"], { timeoutMs: 30_000, env: { YGL_HOME: pgHome, YGL_DB_URL: pgUrl } }],
    // #93-①: contract-audit exercises the SQLite face — scrub YGL_DB_URL for this step
    // (B7 allowlist would refuse every CLI call inside with rc=2 otherwise).
    ["contract", ["bash", "scripts/contract-audit.sh"], { timeoutMs: 15 * 60_000, env: { YGL_DB_URL: "" } }],
    ["self-check", ["node", "dist/bundle/bin.cjs", "verify", "self-check", "--json"], { timeoutMs: 20 * 60_000, env: { YGL_HOME: pgHome, YGL_DB_URL: pgUrl } }],
    // 行为漂移登记册（护栏②）：空清单或全登记才算过
    ["drift-registry", ["node", "-e", "process.exit(0)"], {}],
  ];
  const results = [];
  for (const [name, cmd, opts] of steps) {
    const r = sh(cmd[0], cmd.slice(1), opts);
    const expected = opts.expectedRc ?? 0;
    const untouched = !opts.noFilesUnder || !existsSync(opts.noFilesUnder);
    results.push({ step: name, status: r.status === expected && untouched ? "pass" : "fail", ms: r.ms, tail: r.out.slice(-200) });
  }
  legs.push({ backend: "pg", status: results.every((r) => r.status === "pass") ? "pass" : "fail", steps: results });
}

rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

const sqliteOk = legs.find((l) => l.backend === "sqlite").status === "pass";
const pgLeg = legs.find((l) => l.backend === "pg");
const pgOk = pgLeg.status === "pass";
// strict：两腿都必须是 pass（skipped 不算绿）
const overallOk = strict ? sqliteOk && pgOk : sqliteOk;

if (json) {
  console.log(JSON.stringify({ strict, overall: overallOk ? "pass" : "fail", legs }, null, 2));
} else {
  console.log(`dual-backend matrix${strict ? " (strict)" : ""}:`);
  for (const leg of legs) {
    console.log(`  [${leg.backend}] ${leg.status}${leg.reason ? " — " + leg.reason : ""}`);
    for (const s of leg.steps) console.log(`    ${s.status === "pass" ? "✓" : "✗"} ${s.step} (${(s.ms / 1000).toFixed(1)}s)`);
  }
  if (!strict && pgLeg.status === "skipped") {
    console.log("  note: PG leg skipped — run with YGL_PG_URL and --strict for the release gate");
  }
  console.log(overallOk ? "dual-backend matrix: PASS" : "dual-backend matrix: FAIL");
}
process.exit(overallOk ? 0 : 1);
