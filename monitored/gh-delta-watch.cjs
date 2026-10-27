#!/usr/bin/env node
// gh-delta-watch.cjs — GitHub 面增量检测器（v3 2026-10-27：+匿名 REST 兜底双通道）
// 契约：manual=只读比对；--commit=比对+写 state（仅 job）；gh CLI 失败→自动降级匿名 api.github.com（只读面，
//       60req/h 限流）；双通道全断才 exit 1 GH-DETECTOR-UNAVAILABLE（大声失败）。
// 输出：GH-FACE-STEADY n/n 或 GITHUB-DELTA-DETECTED + 逐行（作者 zhujun200409-cloud 标 ★优先）。
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const REPO = "NelsonLongxiang/ygl-trees";
const STATE = path.join(__dirname, "gh-watch-state.json");
const FIELDS = ["number", "title", "author", "updatedAt"];
// 2026-10-27: gh 认证恢复于 Roaming 配置目录（.config\gh 早失）；gh 默认只找 .config\gh，故显式给默认。
const GH_ENV = Object.assign({}, process.env, { GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || "C:\\Users\\Administrator\\AppData\\Roaming\\GitHub CLI" });

function viaGh(kind) {
  try {
    const out = execFileSync("gh", [kind, "list", "-R", REPO, "--state", "open", "--json", FIELDS.join(","),
      "--limit", "200"], { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"], env: GH_ENV });
    const arr = JSON.parse(out);
    if (!Array.isArray(arr)) throw new Error("non-array payload");
    return arr;
  } catch { return null; }
}

function viaCurl() {
  try {
    const out = execFileSync("curl", ["-s", "-m", "45",
      "https://api.github.com/repos/" + REPO + "/issues?state=open&per_page=100"],
      { encoding: "utf8", timeout: 70000, stdio: ["ignore", "pipe", "pipe"] });
    const arr = JSON.parse(out);
    if (!Array.isArray(arr)) return null;
    return arr.map(i => ({ number: i.number, title: i.title, author: { login: i.user.login },
      updatedAt: i.updated_at, pull_request: i.pull_request ? {} : undefined }));
  } catch { return null; }
}

const commit = process.argv.includes("--commit");
let channel = "gh";
let issues = viaGh("issue");
let prs = viaGh("pr");
if (issues === null || prs === null) {
  channel = "curl-anonymous";
  const all = viaCurl();
  if (all === null) {
    process.stderr.write("GH-DETECTOR-UNAVAILABLE (gh auth + anonymous REST both failed) — face NOT swept\n");
    process.exit(1);
  }
  issues = all.filter(i => !i.pull_request);
  prs = all.filter(i => i.pull_request);
}
const key = (it) => "#" + it.number;
const cur = {
  baseline_at: new Date().toISOString(),
  issues: Object.fromEntries(issues.map(i => [key(i), { title: i.title, author: i.author?.login || "?", updated: i.updatedAt }])),
  prs: Object.fromEntries(prs.map(p => [key(p), { title: p.title, author: p.author?.login || "?", updated: p.updatedAt }]))
};
let prev = null;
try { prev = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
if (!prev) {
  if (commit) { fs.writeFileSync(STATE, JSON.stringify(cur, null, 1)); console.log("GH-STATE-SEEDED issues=" + issues.length + " prs=" + prs.length + " via " + channel); }
  else console.log("GH-STATE-ABSENT issues=" + issues.length + " prs=" + prs.length + " (" + channel + "; manual read-only)");
  process.exit(0);
}
const lines = [];
for (const scope of ["issues", "prs"]) {
  const before = prev[scope] || {}, now = cur[scope];
  for (const k of Object.keys(now)) if (!before[k]) lines.push("NEW   " + scope.slice(0, -1) + " " + k + " [" + now[k].author + "] " + now[k].title.slice(0, 70) + (now[k].author === "zhujun200409-cloud" ? "  ★优先" : ""));
  for (const k of Object.keys(before)) if (!now[k]) lines.push("GONE  " + scope.slice(0, -1) + " " + k + " [" + before[k].author + "] " + before[k].title.slice(0, 70));
}
if (lines.length) {
  console.log("GITHUB-DELTA-DETECTED " + lines.length + " item(s) via " + channel + ":");
  for (const l of lines) console.log("  " + l);
} else {
  console.log("GH-FACE-STEADY issues=" + issues.length + " prs=" + prs.length + " via " + channel);
}
if (commit) fs.writeFileSync(STATE, JSON.stringify(cur, null, 1));
process.exit(0);
