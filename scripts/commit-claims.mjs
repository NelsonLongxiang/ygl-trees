#!/usr/bin/env node
/**
 * G4 提交说明对账门（roadmap/#96 条目 3）——提交说明声称的改动逐条对照 --stat。
 *
 * 抓的形态：5e4978d——message 说改了 skills/…，--stat 里没有任何 skills/ 文件。
 * 规则：message 里的**路径样 token**（含 / 的词、反引号内的路径、<path> 形）逐个
 * 对照该提交的变更文件列表（前缀匹配）；声称了却不在 = 红（rc1）。
 * 豁免面（#96 复核 comment 6440944943）：
 *   ① message 里的 `reads:<path>` 行显式声明「只读不称」——该 path 豁免；
 *   ② 命令行 --allow <path>[,<path>] 显式豁免（发版区间跑批用，须在发布记录注明理由）；
 *   ③ 不含 / 的普通词不检查（避免英文句子误报）。
 *
 * 用法：node scripts/commit-claims.mjs <commit-or-range> [--root <repo>] [--allow p1,p2]
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const root = args.includes("--root") ? args[args.indexOf("--root") + 1] : ".";
const allowIdx = args.indexOf("--allow");
const allow = new Set(allowIdx >= 0 && args[allowIdx + 1] ? args[allowIdx + 1].split(",").filter(Boolean) : []);
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
  // message 内显式「只读」声明（reads:<path>）——该 path 本提交不算声称
  const readsDeclared = new Set();
  for (const m of msg.matchAll(/^reads:\s*(\S+)/gim)) readsDeclared.add(m[1].replace(/^[.\/]+|[.,;:)\"'\]]+$/g, ""));
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
    if (allow.has(norm) || [...allow].some((a) => norm.startsWith(a))) continue; // ② 显式豁免
    if (readsDeclared.has(norm) || [...readsDeclared].some((a) => norm.startsWith(a + "/") || norm === a)) continue; // ① reads: 声明
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
