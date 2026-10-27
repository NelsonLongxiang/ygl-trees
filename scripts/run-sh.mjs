#!/usr/bin/env node
/**
 * G12 解释器锚·运行器（总工裁 direct-a2f54173 D）——pnpm 层 shell 链的解释器钉在代码里。
 *
 * 为什么不是 bash -c '…' 直写：Windows 下 pnpm 经 cmd 解析，裸 bash 会按 PATH 序漂移
 * （本机实证漂到 WSL：/mnt/d 下旧 node 跑 tsc 报 SyntaxError?? ——2026-10-27 18:0x 假红
 * 同根）。本运行器把解释器选择钉死：
 *   win  : GIT_BASH env 优先 → "C:\\Program Files\\Git\\bin\\bash.exe"（缺则大声红，不猜）
 *   posix: /bin/bash
 * 用法：node scripts/run-sh.mjs "<shell chain>"
 */
import { spawnSync } from "node:child_process";
const chain = process.argv[2];
if (!chain) { console.error("run-sh: missing <chain> arg"); process.exit(2); }
const isWin = process.platform === "win32";
const bash = isWin
  ? (process.env.GIT_BASH || "C:\\Program Files\\Git\\bin\\bash.exe")
  : "/bin/bash";
const r = spawnSync(bash, ["-c", chain], { stdio: "inherit" });
if (r.error) {
  console.error(`run-sh: cannot spawn pinned bash at ${bash} (${r.error.code}) — set GIT_BASH or install Git for Windows (G12)`);
  process.exit(1);
}
process.exit(r.status ?? 1);
