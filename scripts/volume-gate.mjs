#!/usr/bin/env node
/**
 * G11 仓内体量门（总工裁 direct-a2f54173 A 增项）——spec 总字节 + docs 活跃字节双阈值。
 *
 * docs 膨胀实感：plan.md 已两次拆分归档（每次 60KB+）。本门把「该归档了」从感觉变成
 * 机器判据：超阈 rc1，提示归档（docs/CHANGELOG|plan 拆分模式）；归档后活跃字节下降、
 * 阈值自动收紧（--write 认账，同 ratchet 纪律——收紧无需认账自动下压）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const BASE = join(ROOT, "volume-baseline.json");
const asJson = process.argv.includes("--json");
const write = process.argv.includes("--write");
// #98 复核（macOS）：GNU 专有的字节口径 du 不可移植——改纯 Node 走文件系统逐层量字节；
// 测量异常必须抛（rc≠0），绝不在「什么都没量」时报「未超上限」。
const walkMd = (dir) => {
  let total = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) { if (!/archive/.test(name.name)) total += walkMd(p); continue; }
    if (name.isFile() && name.name.endsWith(".md") && !/archive/.test(name.name)) total += statSync(p).size;
  }
  return total;
};

const base = JSON.parse(readFileSync(BASE, "utf8"));
const specBytes = readFileSync(join(ROOT, "docs", "spec.md")).length;
let docsActive;
try { docsActive = walkMd(join(ROOT, "docs")); }
catch (e) { console.error("volume-gate: measurement failed — " + String(e?.message || e) + " (G11)"); process.exit(1); }
if (!Number.isFinite(docsActive) || docsActive <= 0) { console.error("volume-gate: docs measurement produced " + docsActive + " — refusing to judge (G11)"); process.exit(1); }
const next = { ...base.ceilings };
let failed = false;
const report = [];
if (specBytes > base.ceilings.spec_bytes) { failed = true; report.push({ metric: "spec_bytes", value: specBytes, ceiling: base.ceilings.spec_bytes, status: "over" }); }
else { next.spec_bytes = specBytes; report.push({ metric: "spec_bytes", value: specBytes, ceiling: base.ceilings.spec_bytes, status: specBytes < base.ceilings.spec_bytes ? "tightened" : "held" }); }
if (docsActive > base.ceilings.docs_active_bytes) { failed = true; report.push({ metric: "docs_active_bytes", value: docsActive, ceiling: base.ceilings.docs_active_bytes, status: "over" }); }
else { next.docs_active_bytes = docsActive; report.push({ metric: "docs_active_bytes", value: docsActive, ceiling: base.ceilings.docs_active_bytes, status: docsActive < base.ceilings.docs_active_bytes ? "tightened" : "held" }); }
// 阈值是「上限」不是棘轮——下调阈值须显式改 volume-baseline.json 并携带裁定注（G11 归因面）。
if (write) console.log("volume-gate: --write accepted no-op (ceilings are caps, not a ratchet — lower them by hand with a ruling note)");
if (asJson) console.log(JSON.stringify({ ok: !failed, report }, null, 2));
else for (const r of report) console.log(`  ${r.status === "over" ? "✗" : r.status === "tightened" ? "~" : "·"} ${r.metric.padEnd(20)} ${r.value} / ${r.ceiling}  [${r.status}]`);
if (failed) { console.error("volume-gate: over ceiling — archive required (plan.md 拆分归档模式), then rerun (G11)"); process.exit(1); }
if (!asJson) console.log("volume-gate: within ceilings (G11)");
process.exit(0);
