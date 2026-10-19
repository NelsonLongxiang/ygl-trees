#!/usr/bin/env node
/**
 * cordis-drift 一轮评审：扫描 → (可选) prepare → verify run。
 *
 * 一轮评审 = 一次 verify run；跨轮漂移 = 两次报告 diff。本脚本只做编排，
 * 判定仍由冻结 spec 完成（脚本不解释结果，失败原样抛出）。
 *
 * 用法：
 *   node scripts/cordis-drift.mjs                 # 扫描 + 跑冻结 spec（没有 spec 时自动 prepare）
 *   node scripts/cordis-drift.mjs --prepare       # 强制重新 prepare（材料变更后）
 *   node scripts/cordis-drift.mjs --root <dir>    # 扫别的目录（验收注入用）
 *   node scripts/cordis-drift.mjs --json
 *
 * 退出码：0 = overall PASS；1 = overall 非 PASS 或流程错误；2 = 用法错误。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const HOME = process.env.YGL_HOME ? resolve(process.env.YGL_HOME) : join(homedir(), ".ygl-trees");
const WORK = join(HOME, "verify", "cordis");
const MATERIAL = join(REPO, "scripts", "verify", "cordis-drift", "material.md");
const CANDIDATES = join(REPO, "scripts", "verify", "cordis-drift", "candidates.json");
const REVIEWS = join(REPO, "scripts", "verify", "cordis-drift", "reviews.json");
const SPEC_ID_FILE = join(WORK, "spec-id.txt");
const SCAN = join(WORK, "repo_scan.sqlite");

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const val = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const JSON_OUT = has("json");
const ROOT = resolve(val("root", REPO));
const FORCE_PREPARE = has("prepare");

const BIN = existsSync(join(REPO, "dist", "bundle", "bin.cjs"))
  ? join(REPO, "dist", "bundle", "bin.cjs")
  : join(REPO, "dist", "apps", "cli", "src", "bin.js");
if (!existsSync(BIN)) {
  console.error(`build first: missing ${BIN} (pnpm build)`);
  process.exit(2);
}
mkdirSync(WORK, { recursive: true });

function cli(argv, { json = true } = {}) {
  const res = spawnSync(process.execPath, [BIN, ...argv, ...(json ? ["--json"] : [])], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  const out = (res.stdout ?? "").trim();
  let parsed = null;
  if (json) {
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new Error(`non-JSON output from "verify ${argv.join(" ")}": ${out.slice(0, 400)}${res.stderr ? `\n${res.stderr.slice(0, 400)}` : ""}`);
    }
  }
  return { rc: res.status ?? 1, out, stderr: res.stderr ?? "", parsed };
}

// 1) 扫描（只写工作区的 tmp 快照，不碰业务库）
const scanArgs = [join(REPO, "scripts", "cordis-scan.mjs"), "--out", SCAN];
if (ROOT !== REPO) scanArgs.push("--root", ROOT);
const scan = spawnSync(process.execPath, scanArgs, { cwd: REPO, encoding: "utf8", env: { ...process.env, YGL_HOME: HOME } });
if (scan.status !== 0) {
  console.error(`scan failed (rc=${scan.status}): ${scan.stderr || scan.stdout}`);
  process.exit(1);
}

// 2) prepare（首次或强制）：材料 → 冻结 spec
let specId = existsSync(SPEC_ID_FILE) ? readFileSync(SPEC_ID_FILE, "utf8").trim() : "";
if (FORCE_PREPARE || !specId) {
  const submitted = cli(["verify", "submit", "--title", "Cordis 漂移守卫（cordis-drift）", "--text", MATERIAL]);
  if (submitted.rc !== 0) {
    console.error(`submit failed: ${submitted.out || submitted.stderr}`);
    process.exit(1);
  }
  const materialId = submitted.parsed.material_id;
  const prepared = cli([
    "verify", "prepare", materialId,
    "--candidates", CANDIDATES,
    "--reviews", REVIEWS,
    "--db", SCAN,
    "--title", "Cordis 漂移守卫",
    "--domain", "cordis",
    "--as-of", new Date().toISOString(),
  ]);
  if (prepared.rc !== 0 || prepared.parsed.verdict !== "ready") {
    console.error(`prepare not ready: ${prepared.out || prepared.stderr}`);
    process.exit(1);
  }
  specId = prepared.parsed.spec_id;
  writeFileSync(SPEC_ID_FILE, `${specId}\n`, "utf8");
}

// 3) run（判定在报告里，rc 只表达过程）
const run = cli(["verify", "run", specId, "--db", SCAN]);
if (run.rc !== 0) {
  console.error(`verify run failed: ${run.out || run.stderr}`);
  process.exit(1);
}
const summary = run.parsed;
const report = existsSync(summary.report_path) ? JSON.parse(readFileSync(summary.report_path, "utf8")) : null;

if (JSON_OUT) {
  console.log(JSON.stringify({
    spec_id: specId,
    run_id: summary.run_id,
    overall: summary.overall,
    summary: summary.summary,
    report_path: summary.report_path,
    archive: summary.archive,
    data_source: report?.data_source,
    units: (report?.vu ?? []).map((v) => ({ id: v.id, verdict: v.verdict, witness: v.witness, evidence: v.evidence })),
  }, null, 2));
} else {
  console.log(`cordis-drift: ${summary.overall}  (${Object.entries(summary.summary).map(([k, v]) => `${k}=${v}`).join(" ")})`);
  for (const v of report?.vu ?? []) {
    console.log(`  ${v.verdict.padEnd(15)} ${v.id}  ${v.title ?? ""}`.trimEnd());
  }
  console.log(`  report: ${summary.report_path}`);
  if (summary.archive) console.log(`  archive: ${summary.archive.filename}`);
}
process.exit(summary.overall === "PASS" ? 0 : 1);
