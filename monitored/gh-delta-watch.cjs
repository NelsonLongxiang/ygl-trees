#!/usr/bin/env node
// gh-delta-watch.cjs — GitHub 面增量检测器（v2 重建 2026-10-26，原件 07:11-07:39 间被定向删除）
// 契约：manual（无参）=只读比对，不写 state；--commit=比对+写 state（仅 job 用，防 consumer race）；
//       gh 不可用→exit 1 GH-DETECTOR-UNAVAILABLE（大声失败，绝不静默空数组）。
// 输出：稳态一行 GH-FACE-STEADY n/n；增量 GITHUB-DELTA-DETECTED + 逐行（作者 zhujun200409-cloud 标 ★优先）。
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const REPO = "NelsonLongxiang/ygl-trees";
const STATE = path.join(__dirname, "gh-watch-state.json");
const FIELDS = ["number", "title", "author", "updatedAt"]; // 白名单：非法字段会炸整条 gh 调用（#37 家族教训）

function ghList(kind) {
  try {
    const out = execFileSync("gh", [kind, "list", "-R", REPO, "--state", "open", "--json", FIELDS.join(","),
      "--limit", "200"], { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
    const arr = JSON.parse(out);
    if (!Array.isArray(arr)) throw new Error("non-array payload");
    return arr;
  } catch (e) {
    const msg = ((e.stderr || "") + (e.message || "")).replace(/\s+/g, " ").slice(0, 160);
    process.stderr.write("GH-DETECTOR-UNAVAILABLE (gh auth/network fail) — face NOT swept :: " + msg + "\n");
    process.exit(1);
  }
}

const commit = process.argv.includes("--commit");
const issues = ghList("issue");
const prs = ghList("pr");
const key = (it) => "#" + it.number;
const cur = {
  baseline_at: new Date().toISOString(),
  issues: Object.fromEntries(issues.map(i => [key(i), { title: i.title, author: i.author?.login || "?", updated: i.updatedAt }])),
  prs: Object.fromEntries(prs.map(p => [key(p), { title: p.title, author: p.author?.login || "?", updated: p.updatedAt }]))
};

let prev = null;
try { prev = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}

if (!prev) {
  if (commit) {
    fs.writeFileSync(STATE, JSON.stringify(cur, null, 1));
    console.log("GH-STATE-SEEDED issues=" + issues.length + " prs=" + prs.length + " (baseline from now; deltas accrue hereafter)");
  } else {
    console.log("GH-STATE-ABSENT issues=" + issues.length + " prs=" + prs.length + " (manual run is read-only; job --commit will seed)");
  }
  process.exit(0);
}

const lines = [];
for (const scope of ["issues", "prs"]) {
  const before = prev[scope] || {}, now = cur[scope];
  for (const k of Object.keys(now)) if (!before[k]) lines.push("NEW   " + scope.slice(0, -1) + " " + k + " [" + now[k].author + "] " + now[k].title.slice(0, 70) + (now[k].author === "zhujun200409-cloud" ? "  ★优先" : ""));
  for (const k of Object.keys(before)) if (!now[k]) lines.push("GONE  " + scope.slice(0, -1) + " " + k + " [" + before[k].author + "] " + before[k].title.slice(0, 70));
}
if (prev.approximate) lines.unshift("(state 为 approximate 基线重建——首扫以现面为准，详见 state.note)");

if (lines.length) {
  console.log("GITHUB-DELTA-DETECTED " + lines.length + " item(s):");
  for (const l of lines) console.log("  " + l);
} else {
  console.log("GH-FACE-STEADY issues=" + issues.length + " prs=" + prs.length);
}
if (commit) fs.writeFileSync(STATE, JSON.stringify(cur, null, 1));
process.exit(0);
