#!/usr/bin/env node
/**
 * G9 合并祖先守卫·事后复核（roadmap/#96 条目 8）——验证 <sha> 在远端基线分支上。
 * 用法：node scripts/merge-check.mjs <sha> [base]   # base 缺省 origin/master
 * 防「回执是真的、代码却不在主干上」（dad595b 丢失为第二例）。
 */
import { execFileSync } from "node:child_process";
const sha = process.argv[2];
const base = process.argv[3] || "origin/master";
if (!sha) { console.error("usage: node scripts/merge-check.mjs <sha> [base]"); process.exit(2); }
try {
  execFileSync("git", ["merge-base", "--is-ancestor", sha, base], { stdio: "ignore" });
  console.log(`merge-check: ${sha.slice(0, 8)} is an ancestor of ${base} (G9 ok)`);
  process.exit(0);
} catch {
  console.error(`merge-check: ${sha.slice(0, 8)} is NOT on ${base} — the receipt may be real but the code is not on the trunk (G9)`);
  process.exit(1);
}
