#!/usr/bin/env node
/**
 * A1 tree contract matrix generator (fdc Phase 1.2).
 *
 * Status is NEVER hand-written: it is derived from the vitest JSON result file
 * plus git. Rows marked `planned` stay `planned` until a test exists.
 *
 * Usage:
 *   node scripts/tree-contract-matrix.mjs --results tmp/vitest-tree.json \
 *     [--out docs/reviews/tree-contract-matrix.md]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const resultsFile = flag("results") || "tmp/vitest-tree.json";
const outFile = flag("out") || "docs/reviews/tree-contract-matrix.md";
const manifestFile = "docs/reviews/tree-contract-matrix.json";

const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
const results = JSON.parse(readFileSync(resultsFile, "utf8"));
const tests = (results.testResults ?? []).flatMap((file) =>
  (file.assertionResults ?? []).map((a) => ({
    file: String(file.name ?? "").replace(/\\/g, "/"),
    name: String(a.fullName ?? a.title ?? ""),
    status: String(a.status ?? ""),
  })),
);

const git = (a) => spawnSync("git", a, { encoding: "utf8" }).stdout?.trim() || "";
const commit = git(["rev-parse", "--short", "HEAD"]);
const tag = git(["describe", "--tags", "--always"]);

function statusOf(row) {
  if (row.planned) return { status: "planned", test: "—" };
  if (!row.test || !row.test_title) return { status: "missing", test: "—" };
  const hit = tests.find((t) => t.file.endsWith(row.test) && t.name.includes(row.test_title));
  if (!hit) return { status: "missing", test: "—" };
  if (hit.status !== "passed") return { status: "red", test: hit.name };
  return { status: row.partial ? "partial" : "green", test: hit.name };
}

const rows = manifest.rows.map((row) => {
  const { status, test } = statusOf(row);
  return { ...row, _status: status, _test: test };
});

const order = { green: 0, partial: 1, planned: 2, missing: 3, red: 4 };
rows.sort((a, b) => (order[a._status] ?? 9) - (order[b._status] ?? 9) || a.id.localeCompare(b.id, "en"));

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|");
const md = [
  "---",
  "name: tree-contract-matrix",
  "description: A1 tree run 契约对照表（机器生成，禁手改；status 来自 vitest JSON + git）",
  "kind: 评审",
  "---",
  "",
  "# A1 tree run 契约对照表（机器生成）",
  "",
  `> 生成：\`node scripts/tree-contract-matrix.mjs --results <vitest.json>\`；commit **${commit}**，tag **${tag}**。`,
  `> 状态口径：green=对应测试通过；partial=有测试但断言面未全覆盖；planned=尚未落码；missing=清单有、测试未找到；red=测试失败。`,
  "> **不得手改本表**——改清单 `docs/reviews/tree-contract-matrix.json` 后重跑。",
  "",
  "| # | 断言 | 来源 | 状态 | 测试 | 探针 | 证据 |",
  "|---|---|---|---|---|---|---|",
  ...rows.map((r) =>
    `| ${cell(r.id)} | ${cell(r.assertion)} | ${cell(r.source)} | **${cell(r._status)}** | ${cell(r._test)} | ${cell(r.probe)} | ${cell(r.evidence)} |`,
  ),
  "",
  "## 汇总",
  "",
  ...["green", "partial", "planned", "missing", "red"].map(
    (s) => `- ${s}: **${rows.filter((r) => r._status === s).length}**`,
  ),
  "",
].join("\n");
writeFileSync(outFile, md + "\n");
console.log(`wrote ${outFile} (${rows.length} rows, commit ${commit})`);
