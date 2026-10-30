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
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
import { readdirSync, readFileSync, mkdirSync, writeFileSync, openSync, closeSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

export function pgSpecs(root = ROOT) {
  return ["packages/ops/tools/tests", "packages/research/pipeline/tests"].flatMap(dir =>
    readdirSync(join(root, dir)).filter(f => /^b8-pg-.+\.spec\.ts$/.test(f) && f !== "b8-pg-gate.spec.ts").map(f => dir + "/" + f)
  ).sort();
}
export function countPgReport(report, specs) {
  if (!report.success || !Array.isArray(report.testResults)) throw new Error("B8 suite did not finish successfully");
  const files = new Map(report.testResults.map(f => [f.name.replaceAll("\\", "/"), f]));
  let passed = 0, offline = 0;
  for (const spec of specs) {
    const found = [...files].filter(([name]) => name.endsWith("/" + spec) || name === spec);
    if (found.length !== 1 || !found[0][1].assertionResults?.length) throw new Error("B8 report missing suite: " + spec);
    for (const a of found[0][1].assertionResults) {
      if (a.status !== "passed") throw new Error("B8 gate rejects failed, skipped or pending cases: " + spec);
      if ((a.ancestorTitles || []).includes("B8 PG primitives")) offline++; else passed++;
    }
  }
  if (!passed) throw new Error("B8 gate collected no real PG cases");
  return { passed, skipped: 0, offline, files: specs.length };
}
export function b8TestTarget(raw) {
  // Test admin calls create/drop databases: numeric loopback only, with no target overrides.
  let target;
  try { target = new URL(raw); } catch { /* reject without echoing the connection string */ }
  if (!target || !["postgres:", "postgresql:"].includes(target.protocol) ||
      !["127.0.0.1", "[::1]"].includes(target.hostname) || target.search || target.hash ||
      target.pathname !== "/postgres" || !target.port) {
    throw new Error("B8_TEST_PG_ADMIN_URL must select an isolated loopback test target (127.0.0.1 or ::1, explicit port, /postgres, no query)");
  }
  return target.toString();
}
async function b8Main() {
  const url = b8TestTarget(process.env.B8_TEST_PG_ADMIN_URL);

  const { Client } = createRequire(import.meta.url)("pg");
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 4000 });
  try { await client.connect(); await client.query("SELECT 1"); }
  catch { throw new Error("B8 PG admin target unavailable (no skipped fallback)"); }
  finally { await client.end().catch(() => {}); }
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const dir = mkdtempSync(join(ROOT, "tmp/b8-pg-gate-"));
  const specs = pgSpecs();
  if (!specs.length) throw new Error("B8 PG specs not found");
  const log = openSync(join(dir, "vitest.log"), "w");
  let run;
  try {
    run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...specs, "--maxWorkers=1", "--reporter=json", "--outputFile=" + join(dir, "vitest.json")], {
      cwd: ROOT, env: { ...process.env, YGL_DB_URL: "", YGL_PG_URL: "", B8_TEST_PG_ADMIN_URL: url },
      stdio: ["ignore", log, log], timeout: 15 * 60_000,
    });
  } finally { closeSync(log); }
  if (run.error || run.status !== 0) throw new Error("B8 real PG tests failed; inspect " + relative(ROOT, dir));
  const result = countPgReport(JSON.parse(readFileSync(join(dir, "vitest.json"), "utf8")), specs);
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ b8_pg: result, report: relative(ROOT, join(dir, "vitest.json")) }, null, 2) + "\n");
  console.log("b8_pg: " + result.passed + " passed, 0 skipped; offline=" + result.offline + "; suites=" + result.files + "; report=" + relative(ROOT, dir));
}

export const SQLITE_BASELINE = Object.freeze({
  version: "0.117.1",
  url: "https://registry.npmjs.org/ygl-trees/-/ygl-trees-0.117.1.tgz",
  tar_sha256: "998ca839fbce3809f4975ae0ebb7db6f173d89b21a011c1b82012f3e71f7bcc3",
  bundle_sha256: "5f6ebe94025835496a71a4ac00858763a3d73a69b29cf69c20ccb612cbeeb1d7",
});
export function goldenHash(bytes, expected) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error("SQLite golden baseline sha256 mismatch");
  return actual;
}
export function goldenSpecs(root = ROOT) {
  const spec = "packages/ops/tools/tests/b8-sqlite-golden.spec.ts";
  if (!existsSync(join(root, spec))) throw new Error("SQLite golden spec is missing: " + spec);
  return [spec];
}
export function goldenArgv(reportPath) {
  return ["node_modules/vitest/vitest.mjs", "run", ...goldenSpecs(), "--maxWorkers=1", "--reporter=json", "--outputFile=" + reportPath];
}
export function goldenReport(report) {
  const [expected] = goldenSpecs();
  const rows = report.testResults;
  if (!report.success || !Array.isArray(rows) || rows.length !== 1 ||
      !rows[0].name.replaceAll("\\", "/").endsWith(expected) ||
      rows[0].assertionResults?.length !== 1 || rows[0].assertionResults[0].status !== "passed") {
    throw new Error("SQLite golden gate requires exactly one passed case and zero skipped");
  }
  return { passed: 1, skipped: 0 };
}
async function sqliteGoldenMain() {
  const gitRead = (...args) => {
    const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
    if (r.error || r.status !== 0) throw new Error("cannot record SQLite golden source identity");
    return r.stdout.trim();
  };
  const source = { head: gitRead("rev-parse", "HEAD"), tree: gitRead("rev-parse", "HEAD^{tree}"), dirty: !!gitRead("status", "--porcelain") };
  const candidateSha = createHash("sha256").update(readFileSync(join(ROOT, "dist/bundle/bin.cjs"))).digest("hex");
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const dir = mkdtempSync(join(ROOT, "tmp/b8-sqlite-gate-"));
  const arg = process.argv.indexOf("--baseline-tgz");
  let bytes;
  if (arg >= 0) {
    if (!process.argv[arg + 1] || process.argv[arg + 1].startsWith("--")) throw new Error("--baseline-tgz needs a verified local tarball path");
    bytes = readFileSync(resolve(process.argv[arg + 1]));
  } else {
    const response = await fetch(SQLITE_BASELINE.url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error("cannot obtain pinned npm SQLite golden baseline: HTTP " + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  goldenHash(bytes, SQLITE_BASELINE.tar_sha256);
  const tarball = join(dir, "baseline.tgz");
  writeFileSync(tarball, bytes);
  const unpack = spawnSync("tar", ["-xzf", "baseline.tgz", "package/dist/bundle", "package/package.json"], { cwd: dir, encoding: "utf8", timeout: 60000 });
  writeFileSync(join(dir, "extract.log"), String(unpack.error?.message || "") + "\n" + (unpack.stdout || "") + (unpack.stderr || ""));
  if (unpack.error || unpack.status !== 0) throw new Error("cannot extract verified npm baseline; inspect " + relative(ROOT, dir));
  const pkg = JSON.parse(readFileSync(join(dir, "package/package.json"), "utf8"));
  if (pkg.version !== SQLITE_BASELINE.version) throw new Error("SQLite golden baseline version mismatch");
  const bin = join(dir, "package/dist/bundle/bin.cjs");
  goldenHash(readFileSync(bin), SQLITE_BASELINE.bundle_sha256);
  const log = openSync(join(dir, "vitest.log"), "w");
  let run;
  try {
    run = spawnSync(process.execPath, goldenArgv(join(dir, "vitest.json")), {
      cwd: ROOT, env: { ...process.env, YGL_DB_URL: "", YGL_PG_URL: "", B8_SQLITE_BASELINE_BIN: bin },
      stdio: ["ignore", log, log], timeout: 15 * 60_000,
    });
  } finally { closeSync(log); }
  if (run.error || run.status !== 0) throw new Error("SQLite golden regression failed; inspect " + relative(ROOT, dir));
  const result = goldenReport(JSON.parse(readFileSync(join(dir, "vitest.json"), "utf8")));
  goldenHash(readFileSync(join(ROOT, "dist/bundle/bin.cjs")), candidateSha);
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ b8_sqlite_golden: result, baseline: SQLITE_BASELINE, source, candidate_bundle_sha256: candidateSha, report: relative(ROOT, join(dir, "vitest.json")) }, null, 2) + "\n");
  console.log("b8_sqlite_golden: 1 passed, 0 skipped (baseline ygl-trees@" + SQLITE_BASELINE.version + " sha256 " + SQLITE_BASELINE.bundle_sha256 + ") report=" + relative(ROOT, dir));
}

function matrixMain() {
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

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--b8-sqlite-only")) {
    sqliteGoldenMain().catch(e => { console.error("b8_sqlite_golden: FAIL — " + e.message); process.exitCode = 1; });
  } else if (process.argv.includes("--b8-pg-only")) {
    b8Main().catch(e => { console.error("b8_pg: FAIL — " + e.message); process.exitCode = 1; });
  } else matrixMain();
}
