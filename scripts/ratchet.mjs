#!/usr/bin/env node
/**
 * Ratchet 门禁 —— 只降不升的度量闸。
 *
 * 背景：测量一旦存在，就只能往好的方向走。任何一次「这次先慢一点/大一点」的放行，
 * 都会变成下一次比较的基准。所以这里把三条可机械测量的指标钉在 ratchet-baseline.json：
 *
 *   bundle_bytes    发布产物 dist/bundle/bin.cjs 的字节数（确定值，容差 2%）
 *   web_dist_bytes  dist/apps/web/dist 的字节数合计（确定值，容差 2%）
 *   cold_start_ms   `--version` 冷启动中位数（预热 1 次不计 + 5 次取中位；容差 30%，只看大滑坡）
 *
 * 变好：自动收紧基线（棘轮齿），并在输出里写明旧值 → 新值。
 * 变坏：超容差即失败（rc=1），要么优化，要么显式 `--write` 认账重设基线。
 *
 * 不测墙钟总量（单测总时长）——并行负载下它测的是机器忙闲，不是产品快慢；
 * 与墙钟不相关的测量点一律先修测量方式再上闸（评测文章的反面教训）。
 *
 * 用法：node scripts/ratchet.mjs [--write] [--json]
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const BASELINE = join(ROOT, "ratchet-baseline.json");
const BIN = join(ROOT, "dist/bundle/bin.cjs");
const WEB = join(ROOT, "dist/apps/web/dist");

const args = process.argv.slice(2);
const write = args.includes("--write");
const asJson = args.includes("--json");

function dirBytes(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    total += st.isDirectory() ? dirBytes(p) : st.size;
  }
  return total;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function coldStartMs() {
  // 预热一次不计入：干净检出（新 worktree / 新机器）首次触碰 bundle 与 node_modules
  // 会被杀毒扫描与磁盘冷缓存放大成一次性成本，那不是产品变慢。否则同一 commit
  // 在主树 held、在干净检出 regressed，闸门测的是「路径新不新」而不是「启动快不快」。
  const warm = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" });
  if (warm.status !== 0) throw new Error(`cold start warmup failed: ${warm.stderr || warm.status}`);
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" });
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    if (r.status !== 0) throw new Error(`cold start probe failed: ${r.stderr || r.status}`);
    samples.push(dt);
  }
  return Math.round(median(samples));
}

const METRICS = [
  { key: "bundle_bytes", label: "bundle (dist/bundle/bin.cjs)", measure: () => statSync(BIN).size, toleranceRel: 0.02 },
  { key: "web_dist_bytes", label: "web dist (dist/apps/web/dist)", measure: () => dirBytes(WEB), toleranceRel: 0.02 },
  { key: "cold_start_ms", label: "cold start (--version, median of 5)", measure: coldStartMs, toleranceRel: 0.3 },
];

if (!existsSync(BIN)) {
  console.error("ratchet: 缺少 dist/bundle/bin.cjs —— 先 pnpm build");
  process.exit(1);
}

const previous = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
const metrics = previous?.metrics ? { ...previous.metrics } : {};
const report = [];
let failed = false;

for (const m of METRICS) {
  const value = m.measure();
  const base = metrics[m.key]?.value;
  const tolerance = base === undefined ? 0 : Math.max(0, Math.round(base * m.toleranceRel));

  if (base === undefined) {
    metrics[m.key] = { value, tolerance_rel: m.toleranceRel, measured_at: new Date().toISOString() };
    report.push({ metric: m.key, label: m.label, value, base: null, status: "seeded" });
    continue;
  }

  if (value > base + tolerance) {
    if (write) {
      // 作者席显式认账：adopt 新值并重设基线（能力新增导致的体积/时延增长走这条）
      metrics[m.key] = { ...metrics[m.key], value, tolerance_rel: m.toleranceRel, measured_at: new Date().toISOString() };
      report.push({ metric: m.key, label: m.label, value, base, tolerance, status: "accepted" });
    } else {
      failed = true;
      report.push({ metric: m.key, label: m.label, value, base, tolerance, status: "regressed" });
    }
    continue;
  }

  if (value < base) {
    metrics[m.key] = { ...metrics[m.key], value, measured_at: new Date().toISOString() };
    report.push({ metric: m.key, label: m.label, value, base, tolerance, status: "tightened" });
    continue;
  }

  report.push({ metric: m.key, label: m.label, value, base, tolerance, status: "held" });
}

const next = {
  version: 1,
  node: process.version,
  platform: process.platform,
  measured_at: new Date().toISOString(),
  metrics,
};

if (write || report.some((r) => r.status === "tightened" || r.status === "seeded")) {
  // 收紧与建基线都落盘；回归不自动改写（要人显式 --write 认账）
  if (write || !failed) writeFileSync(BASELINE, JSON.stringify(next, null, 2) + "\n", "utf8");
}

if (asJson) {
  console.log(JSON.stringify({ ok: !failed, baseline: BASELINE, report }, null, 2));
} else {
  for (const r of report) {
    const mark = r.status === "regressed" ? "✗" : r.status === "held" ? "·" : r.status === "accepted" ? "!" : "✓";
    const delta = r.base === null ? "seed" : r.status === "tightened" ? `${r.base} → ${r.value}` : r.status === "regressed" ? `${r.base} → ${r.value} (tolerance +${r.tolerance})` : r.status === "accepted" ? `${r.base} → ${r.value} (accepted)` : String(r.value);
    console.log(`  ${mark} ${r.label.padEnd(44)} ${delta}  [${r.status}]`);
  }
  console.log(failed ? "\nratchet: 指标回归 —— 优化，或显式 --write 认账重设基线" : "\nratchet: 全部指标未退化");
}

process.exit(failed ? 1 : 0);
