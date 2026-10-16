/**
 * Benchmark runner — thin orchestrator over per-user-path suites (DSH
 * benchmarks exemplar: one directory per path, not a flat file). Each suite
 * is a self-contained module exporting an async function.
 *
 * Usage: node benchmarks/bench.js [--quick]
 * Paths: startup/ research-write/ knowledge-search/ techtree-index/
 */
"use strict";
const path = require("node:path");
const { writeArtifact, failures } = require("./support/helpers");

const ROOT = path.resolve(__dirname, "..");
const QUICK = process.argv.includes("--quick");
// Measure the SHIPPED entry (tsdown bundle) when built, else the tsc tree.
const BUNDLE = path.join(ROOT, "dist/bundle/bin.cjs");
const BIN = require("node:fs").existsSync(BUNDLE) ? BUNDLE : path.join(ROOT, "dist/apps/cli/src/bin.js");

(async () => {
  console.log(`ygl-trees benchmarks · node ${process.version} · ${process.platform}${QUICK ? " · QUICK" : ""}`);

  const handles = [];

  // startup (subprocess; no db handle to clean)
  await require("./startup/startup.bench")(ROOT, BIN);

  // research-write
  const rw = await require("./research-write/research-write.bench")(ROOT);
  handles.push(rw);

  // knowledge-search
  const ks = await require("./knowledge-search/knowledge-search.bench")(ROOT);
  handles.push(ks);

  // techtree-index
  const ti = await require("./techtree-index/techtree-index.bench")(ROOT);
  handles.push(ti);

  // cleanup (EPERM-safe: Windows may hold handles past closeOrm)
  for (const h of handles) {
    try { h.db?.close(); } catch { /* */ }
  }
  const { closeOrm } = require(path.join(ROOT, "dist/packages/core/database/src/orm"));
  await closeOrm();
  for (const h of handles) {
    if (h.ws) { try { require("node:fs").rmSync(h.ws, { recursive: true, force: true }); } catch { /* EPERM: handle may linger on Windows */ } }
  }

  const out = writeArtifact(ROOT);
  console.log(`  ${failures.length ? `⚠ ${failures.length} suite(s) failed` : "all suites ok"} · artifact: ${out}`);
  process.exitCode = failures.length ? 1 : 0;
})();
