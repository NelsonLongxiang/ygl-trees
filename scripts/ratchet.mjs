#!/usr/bin/env node
/**
 * Ratchet 门禁 —— 只降不升的度量闸。
 *
 * 背景：测量一旦存在，就只能往好的方向走。任何一次「这次先慢一点/大一点」的放行，
 * 都会变成下一次比较的基准。所以这里把三条可机械测量的指标钉在 ratchet-baseline.json：
 *
 *   bundle_bytes    发布产物 dist/bundle/bin.cjs 的字节数（确定值，容差 2%）
 *   web_dist_bytes  dist/apps/web/dist 的字节数合计（确定值，容差 2%）
 *   cold_start_ms   `--version` 冷启动最小值（预热 2 次不计 + 7 次取最小；超容差延迟复测一次；容差 30%，只看大滑坡）
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
// G6（roadmap/#96 条目 5）：棘轮重锁必须归因——--write 拒绝无 --reason（rc2），
// 理由写进基线 _attribution（当日裁定号 + 增量拆分）。
const reasonIdx = args.indexOf("--reason");
const reason = reasonIdx >= 0 && args[reasonIdx + 1] ? args[reasonIdx + 1] : "";
if (write && !reason.trim()) {
  console.error("ratchet: --write refuses without --reason <ruling id>: <attribution> (G6: ratchet relock attribution)");
  process.exit(2);
}

function dirBytes(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    total += st.isDirectory() ? dirBytes(p) : st.size;
  }
  return total;
}

function coldStartMs() {
  // 预热两次不计入：干净检出（新 worktree / 新机器）首次触碰 bundle 与 node_modules
  // 会被杀毒扫描与磁盘冷缓存放大成一次性成本，那不是产品变慢。否则同一 commit
  // 在主树 held、在干净检出 regressed，闸门测的是「路径新不新」而不是「启动快不快」。
  //
  // 取最小值而非中位数：启动耗时存在可达下界，负载尖峰只会抬高个别样本（实测同一
  // commit 在 464–634ms 间摆动，中位数会被三五个尖峰顶穿 30% 容差）。真正的产品
  // 回归会把最小值一起抬上去——最小值是「最理想条件下仍然要花多久」，噪声方向是
  // 单侧的，所以这里用它。预热两次是为了让 JIT 与页缓存之外的首次系统调用也落位。
  for (let i = 0; i < 2; i++) {
    const warm = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" });
    if (warm.status !== 0) throw new Error(`cold start warmup failed: ${warm.stderr || warm.status}`);
  }
  const samples = [];
  for (let i = 0; i < 7; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" });
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    if (r.status !== 0) throw new Error(`cold start probe failed: ${r.stderr || r.status}`);
    samples.push(dt);
  }
  return Math.round(Math.min(...samples));
}

const METRICS = [
  { key: "bundle_bytes", label: "bundle (dist/bundle/bin.cjs)", measure: () => statSync(BIN).size, toleranceRel: 0.02, method: "stat-size-of-dist-bundle" },
  { key: "web_dist_bytes", label: "web dist (dist/apps/web/dist)", measure: () => dirBytes(WEB), toleranceRel: 0.02, method: "sum-file-sizes-recursive" },
  {
    key: "cold_start_ms",
    label: "cold start (--version, min of 7)",
    measure: coldStartMs,
    toleranceRel: 0.3,
    retryOnRegression: true,
    method: "warm2-min7-retry-once",
  },
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
  const base = metrics[m.key]?.value;
  const tolerance = base === undefined ? 0 : Math.max(0, Math.round(base * m.toleranceRel));
  let value = m.measure();
  let retried = false;

  // 时间型指标允许一次复测：在测完 494 例单测、demo、契约审计之后，机器可能还处在
  // 回收负载里，7 个连续样本一起被拖慢。真实回归两次都慢，噪声只会命中一次。
  if (!write && base !== undefined && value > base + tolerance && m.retryOnRegression) {
    retried = true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    value = Math.min(value, m.measure());
  }

  if (base === undefined) {
    metrics[m.key] = { value, tolerance_rel: m.toleranceRel, measured_at: new Date().toISOString(), method: m.method };
    report.push({ metric: m.key, label: m.label, value, base: null, status: "seeded" });
    continue;
  }

  if (write) {
    // 作者席显式认账 / 度量方法变更后的重烘：adopt 本次测量值并盖上 method 戳。
    // 重烘必须连 held 项一起写——否则同一份基线里新旧尺子的读数混住（r27 P3④：
    // 旧冷启动基线烘于 median-of-5，改成 min-of-7 后余量只剩十几毫秒）。
    const status = value > base + tolerance ? "accepted" : value < base ? "tightened" : "rebaked";
    metrics[m.key] = { ...metrics[m.key], value, tolerance_rel: m.toleranceRel, measured_at: new Date().toISOString(), method: m.method };
    report.push({ metric: m.key, label: m.label, value, base, tolerance, status });
    continue;
  }

  if (value > base + tolerance) {
    failed = true;
    report.push({ metric: m.key, label: m.label, value, base, tolerance, status: "regressed", retried });
    continue;
  }

  if (value < base) {
    metrics[m.key] = { ...metrics[m.key], value, measured_at: new Date().toISOString(), method: m.method };
    report.push({ metric: m.key, label: m.label, value, base, tolerance, status: "tightened", retried });
    continue;
  }

  report.push({ metric: m.key, label: m.label, value, base, tolerance, status: "held", retried });
}

const baselineRaw = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
const next = {
  version: 1,
  node: process.version,
  platform: process.platform,
  measured_at: new Date().toISOString(),
  ...(write ? { _attribution: reason } : {}),
  ...(baselineRaw && baselineRaw._note ? { _note: baselineRaw._note } : {}), // G6 复核：--write 不丢已有 _note
  metrics,
};

// Persist the baseline only when asked. Tightening used to be written back
// implicitly, which made a *measurement* mutate a tracked file: `pnpm test`
// (and any publish hook that runs it) left the tree dirty mid-release, and
// `pnpm publish` then refused with ERR_PNPM_GIT_UNCLEAN. A gate that changes
// what it measures is not a gate — `--write` is the operator's signature.
if (write) {
  writeFileSync(BASELINE, JSON.stringify(next, null, 2) + "\n", "utf8");
}
const tightened = report.filter((r) => r.status === "tightened").length;
if (tightened > 0 && !write) {
  console.log(`\nratchet: ${tightened} metric(s) measured tighter than the baseline — run \`node scripts/ratchet.mjs --write\` to lock them in (baseline left untouched)`);
}
// A missing baseline (fresh checkout, new metric) used to be measured and then
// silently dropped: nothing failed, nothing was written, and the next run
// repeated the same no-op. Name the state and the command that fixes it.
const seeded = report.filter((r) => r.status === "seeded").length;
if (seeded > 0 && !write) {
  console.log(`ratchet: ${seeded} metric(s) had no baseline — run \`node scripts/ratchet.mjs --write\` to seed the ratchet`);
}

if (asJson) {
  console.log(JSON.stringify({ ok: !failed, baseline: BASELINE, report }, null, 2));
} else {
  for (const r of report) {
    const mark = r.status === "regressed" ? "✗" : r.status === "held" ? "·" : r.status === "accepted" ? "!" : r.status === "rebaked" ? "~" : "✓";
    const delta = r.base === null ? "seed" : r.status === "tightened" ? `${r.base} → ${r.value}` : r.status === "regressed" ? `${r.base} → ${r.value} (tolerance +${r.tolerance})` : r.status === "accepted" ? `${r.base} → ${r.value} (accepted)` : String(r.value);
    console.log(`  ${mark} ${r.label.padEnd(44)} ${delta}  [${r.status}]`);
  }
console.log(failed ? "\nratchet: 指标回归 —— 优化，或显式 --write --reason '<ruling>: <why>' 认账重设基线（G6 归因）" : "\nratchet: 全部指标未退化");
}

process.exit(failed ? 1 : 0);
