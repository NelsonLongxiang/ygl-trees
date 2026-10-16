/** Shared benchmark helpers — timing, stats, artifact. */

"use strict";
const { performance } = require("node:perf_hooks");

const now = () => performance.now();

const fmtUs = (ms) => {
  const v = ms * 1000;
  return v >= 1000 ? `${(v / 1000).toFixed(2)}ms` : `${v.toFixed(0)}µs`;
};

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`);

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const pick = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], p50: pick(0.5), p95: pick(0.95), max: s[s.length - 1] };
}

/** Suite runner: collects named results and reports them uniformly. */
const results = {};
const failures = [];
async function suite(name, fn) {
  const r = { ok: true };
  try {
    Object.assign(r, await fn());
  } catch (e) {
    r.ok = false;
    r.error = String((e && e.message) || e).slice(0, 200);
    failures.push(name);
  }
  results[name] = r;
  const cell = r.ok
    ? [r.unit === "per-op" ? `p50 ${fmtUs(r.p50)} · p95 ${fmtUs(r.p95)}` : fmtMs(r.total), r.note || ""].filter(Boolean).join(" · ")
    : `FAIL: ${r.error}`;
  console.log(`  ${name.padEnd(17)} ${cell}`);
}

/** Write the JSON artifact with environment metadata. */
function writeArtifact(root) {
  const { execSync } = require("node:child_process");
  const fs = require("node:fs");
  const path = require("node:path");
  let git = "";
  try { git = execSync("git rev-parse --short HEAD", { cwd: root, encoding: "utf8" }).trim(); } catch { /* */ }
  const artifact = {
    meta: {
      date: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      git,
    },
    results,
  };
  const out = path.join(root, "tmp", "bench-results.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(artifact, null, 2), "utf8");
  return out;
}

/** Fresh workspace dir under repo tmp/ (cleaned by caller). */
function freshWorkspace(root, label) {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(root, "tmp", `bench-${label}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { now, fmtUs, fmtMs, stats, suite, writeArtifact, freshWorkspace, results, failures };
