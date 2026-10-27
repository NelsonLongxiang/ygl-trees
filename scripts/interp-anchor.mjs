#!/usr/bin/env node
/**
 * G12 解释器锚（总工裁 direct-a2f54173 D；2026-10-27 18:0x 假红实证——pnpm 层 sh 漂到 WSL）。
 *
 * 两条：
 *  1. scripts/*.sh 首行 shebang 必须锚 bash（#!/usr/bin/env bash 或 #!/bin/bash；#!/bin/sh 不算）
 *  2. package.json scripts 含 shell 语法（&&/|/>/<、`、$()、glob）的条目必须显式 bash -c "…"（或 '…'）包裹，
 *     不裸依赖 pnpm 默认 shell 的 PATH 解析。
 * 违者红（rc1）。IDE/环境把 sh 漂到别的解释器 → 本门即红。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const dir = join(ROOT, "scripts");
let bad = 0;
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".sh")) continue;
  const first = readFileSync(join(dir, f), "utf8").split("\n")[0] || "";
  if (!/^#!.*(bash)/.test(first)) {
    bad++;
    console.error(`  ✗ interp-anchor: scripts/${f} shebang not bash-anchored: ${first} (G12)`);
  }
}
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
for (const [k, v] of Object.entries(pkg.scripts || {})) {
  const s = String(v);
  const shellish = /&&|\|\||[<>]|`|\$\(|\*/.test(s);
  // 裸 `bash x.sh` 在 win/cmd 下同样按 PATH 漂（本机实测漂到 WSL）——一律经 run-sh
  const bareBash = /^bash\s/.test(s);
  if ((shellish || bareBash) && !/^node scripts\/run-sh\.mjs /.test(s)) {
    bad++;
    console.error(`  ✗ interp-anchor: pnpm script '${k}' uses shell syntax without explicit bash -c wrap (G12): ${s.slice(0, 80)}`);
  }
}
if (bad) { console.error(`interp-anchor: ${bad} violation(s) (G12)`); process.exit(1); }
console.log("interp-anchor: scripts shebang + pnpm wraps all anchored to bash (G12)");
process.exit(0);
