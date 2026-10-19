#!/usr/bin/env node
/**
 * verify 组合入口：make submission → prepare → run 一条命令串到底。
 *
 * 定位是 workspace 层 UX 胶水，不是新契约：判定仍由 verify 引擎与冻结 spec 完成。
 *
 * 两条硬约束（评审席合并结论）：
 *   1. 退出码只表达**过程**错误：run 结束即 rc=0，哪怕 overall=FAIL（判定在报告里）。
 *   2. --json 始终单对象（stdout 只有一个 JSON），过程错误也用单对象报。
 *
 * 用法：
 *   node scripts/verify-run.mjs --material <file> --candidates <json> --db <snapshot.sqlite> \
 *        [--reviews <json>] [--title <t>] [--domain <d>] [--as-of <iso>] [--no-archive] [--json]
 *
 * 退出码：0 = 流水线跑完（含 FAIL）；1 = 过程错误（submit/prepare 未 ready/运行失败）；2 = 用法错误。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const BIN = existsSync(join(REPO, "dist", "bundle", "bin.cjs"))
  ? join(REPO, "dist", "bundle", "bin.cjs")
  : join(REPO, "dist", "apps", "cli", "src", "bin.js");

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const val = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const JSON_OUT = has("json");

const USAGE = `verify-run — make submission → prepare → run (rc 只表达过程错误)

  node scripts/verify-run.mjs --material <file> --candidates <json> --db <snapshot.sqlite>
       [--reviews <json>] [--title <t>] [--domain <d>] [--as-of <iso>] [--no-archive] [--json]

  --material   提交材料正文（唯一人工产出）
  --candidates 构造候选（prepare 的输入；机械形态，见 docs/verify-contract.md §1.6）
  --reviews    盲审结论（缺省时 prepare 会因自审不完整而 needs-material）
  --db         被验数据源（SQLite 快照；verify 会再复制一份只读副本）
  --json       stdout 单对象

  退出码：0 流水线跑完（overall 不进退出码）/ 1 过程错误 / 2 用法错误`;

if (has("help") || args.length === 0) {
  console.log(USAGE);
  process.exit(has("help") ? 0 : 2);
}

const MATERIAL = val("material");
const CANDIDATES = val("candidates");
const REVIEWS = val("reviews");
const DB = val("db");
const TITLE = val("title");
const DOMAIN = val("domain");
const AS_OF = val("as-of");

function fail(code, message) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, stage: code, error: message }));
  else console.error(`verify-run: ${message}`);
  process.exit(1);
}

if (!MATERIAL || !CANDIDATES || !DB) fail("usage", "missing --material/--candidates/--db (use --help)");
for (const [name, p] of [["material", MATERIAL], ["candidates", CANDIDATES], ["db", DB], ...(REVIEWS ? [["reviews", REVIEWS]] : [])]) {
  if (!existsSync(resolve(p))) fail("usage", `--${name} not found: ${p}`);
}
if (!existsSync(BIN)) fail("build", `build first: missing ${BIN} (pnpm build)`);

function cli(argv) {
  const res = spawnSync(process.execPath, [BIN, ...argv, "--json"], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  const out = (res.stdout ?? "").trim();
  let parsed = null;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`non-JSON output from "verify ${argv.slice(0, 2).join(" ")}": ${out.slice(0, 400)}${res.stderr ? `\n${res.stderr.slice(0, 400)}` : ""}`);
  }
  return { rc: res.status ?? 1, parsed, stderr: res.stderr ?? "" };
}

// 1) submit：冻结材料（正文 + 附件 sha256）
const submitted = cli(["verify", "submit", "--title", TITLE ?? "verify-run", "--text", resolve(MATERIAL)]);
if (submitted.rc !== 0 || !submitted.parsed?.material_id) fail("submit", JSON.stringify(submitted.parsed ?? submitted.stderr));

// 2) prepare：抽取 → 盲审 → 冻版（非 ready 直接过程失败；报告里不留半成品 spec）
const prepArgs = ["verify", "prepare", submitted.parsed.material_id, "--candidates", resolve(CANDIDATES), "--db", resolve(DB)];
if (REVIEWS) prepArgs.push("--reviews", resolve(REVIEWS));
if (TITLE) prepArgs.push("--title", TITLE);
if (DOMAIN) prepArgs.push("--domain", DOMAIN);
if (AS_OF) prepArgs.push("--as-of", AS_OF);
const prepared = cli(prepArgs);
if (prepared.rc !== 0 || prepared.parsed?.verdict !== "ready") {
  fail("prepare", JSON.stringify({ verdict: prepared.parsed?.verdict, diagnostics: prepared.parsed?.diagnostics ?? prepared.parsed ?? prepared.stderr }));
}

// 3) run：判定写进报告，rc 只表达过程
const runArgs = ["verify", "run", prepared.parsed.spec_id, "--db", resolve(DB)];
if (has("no-archive")) runArgs.push("--no-archive");
const run = cli(runArgs);
if (run.rc !== 0) fail("run", JSON.stringify(run.parsed ?? run.stderr));

const { run_id, overall, summary, report_path, archive } = run.parsed;
if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: true,
    material_id: submitted.parsed.material_id,
    spec_id: prepared.parsed.spec_id,
    spec_version: prepared.parsed.spec_version,
    run_id,
    overall,
    summary,
    report_path,
    archive,
  }));
} else {
  const counts = Object.entries(summary ?? {}).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`verify-run: ${overall}  (${counts})`);
  console.log(`  material ${submitted.parsed.material_id}  spec ${prepared.parsed.spec_id} v${prepared.parsed.spec_version}  run ${run_id}`);
  console.log(`  report ${report_path}`);
  if (archive) console.log(`  archive ${archive.filename}`);
}
// 判定不进退出码（约束 1）：跑完即 0
process.exit(0);
