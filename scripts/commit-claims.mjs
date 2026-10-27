#!/usr/bin/env node
/**
 * G4 提交说明对账门（roadmap/#96 条目 3）——提交说明声称的改动逐条对照 --stat。
 *
 * 抓的形态：5e4978d——message 说改了 skills/…，--stat 里没有任何 skills/ 文件。
 * 规则：message 里的**路径样 token**（含 / 的词、反引号内的路径、<path> 形）逐个
 * 对照该提交的变更文件列表（前缀匹配）；声称了却不在 = 红（rc1）。
 * 逃逸面（如实）：不含 / 的普通词不检查（避免英文句子误报）。
 *
 * 用法：node scripts/commit-claims.mjs <commit-or-range> [--root <repo>]
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const root = args.includes("--root") ? args[args.indexOf("--root") + 1] : ".";
const target = args.find((a) => !a.startsWith("--") && a !== root) || "";
if (!target) {
  console.error("usage: node scripts/commit-claims.mjs <commit-or-range> [--root <repo>]");
  process.exit(2);
}
const git = (a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });

// range → commit list; single rev → itself
const revs = target.includes("..")
  ? git(["log", "--format=%H", target]).split("\n").filter(Boolean)
  : [git(["rev-parse", target]).trim()];

const topLevel = new Set(
    git(["ls-tree", "--name-only", revs[0]])
      .split("\n")
      .filter(Boolean)
      .map((n) => n.replace(/\/$/, ""))
  );
let bad = 0;
for (const rev of revs) {
  const msg = git(["log", "-1", "--format=%B", rev]);
  const stat = git(["show", "--format=", "--name-only", rev]);
  const changed = stat.split("\n").filter(Boolean);
  // 路径样 token：反引号内含 / 的串、裸含 / 且不带空格的词、<path> 形
  const tokens = new Set();
  for (const m of msg.matchAll(/`([^`\n]+)`/g)) {
    const s = m[1].trim();
    if (s.includes("/")) tokens.add(s);
  }
  for (const m of msg.matchAll(/(^|[\s（(【\[；，、：）])\n?([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-/]+)/g)) tokens.add(m[2]);
  for (const m of msg.matchAll(/<([A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+)>/g)) tokens.add(m[1]);
  for (const tok of tokens) {
    // 归一：剥首尾标点；含通配/参数样尾部（=、空格）截断
    const norm = tok.replace(/^[.\/]+|[.,;:)\"'\]]+$/g, "");
    if (!norm || norm.length < 3) continue;
    // 明显非路径放行过检：纯版本号（0.116.0）、数字/数字（0.92/85、60/60 计分）、
    // 旗标（--batch/--file）、单字符目录段（a/b 试写）
    if (/^v?\d+(\.\d+)+$/.test(norm)) continue;
    if (/^[\d.]+(\/[\d.%]+)+$|^[\d.]+%?$/.test(norm)) continue; // 全数字段（0.92/85、60/60、14/14）
    // 只认「仓内路径样」token：首段必须是仓库顶层实体（目录或文件）——
    // "db/stats/--json"、"init-pg/self-check" 这类引述他文件内容的散文不报。
    const first = norm.split("/")[0];
    if (!topLevel.has(first)) continue;
    if (norm.startsWith("--")) continue;
    const hit = changed.some((f) => f === norm || f.startsWith(norm + "/") || f.startsWith(norm) || norm.startsWith(f + "/"));
    if (!hit) {
      bad++;
      console.error(`  ✗ claim miss: ${rev.slice(0, 8)} message names '${norm}' but the diff touches none of it (G4)`);
    }
  }
}
if (bad) {
  console.error(`commit-claims: ${bad} claimed-but-absent path(s) across ${revs.length} commit(s) (G4)`);
  process.exit(1);
}
console.log(`commit-claims: ${revs.length} commit(s) clean (G4)`);
process.exit(0);
