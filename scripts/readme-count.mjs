#!/usr/bin/env node
/**
 * #75 根除法：README unit 计数自动写（单一事实源 = vitest 测量值）。
 * 发布流程调用：pnpm readme:count（跑 vitest → 提取 total → 更新 README → 提交）。
 * 消灭「加了测试忘改 README」——计数不再由人维护。
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const out = execSync("npx vitest run --maxWorkers=1", { encoding: "utf8", timeout: 30 * 60_000, cwd: process.cwd(), stdio: ["pipe","pipe","pipe"] });
// vitest 输出: "Tests  983 passed | 1 skipped (984)" — 取括号内 total
const m = out.match(/Tests\s+\d+ passed.*\((\d+)\)/);
if (!m) { console.error("readme-count: cannot extract test total from vitest output"); process.exit(1); }
const total = m[1];

let s = readFileSync("README.md", "utf8");
const before = s.match(/vitest (\d+) 例/)?.[1];
s = s.replace(/vitest \d+ 例/, `vitest ${total} 例`);
writeFileSync("README.md", s);
console.log(`readme-count: ${before ?? "?"} → ${total}${before === total ? " (unchanged)" : ""}`);
