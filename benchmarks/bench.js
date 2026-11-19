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

  try {
  // startup (subprocess; no db handle to clean)
  await require("./startup/startup.bench")(ROOT, BIN, QUICK);

  // research-write
  const rw = await require("./research-write/research-write.bench")(ROOT, QUICK);
  handles.push(rw);

  // knowledge-search
  const ks = await require("./knowledge-search/knowledge-search.bench")(ROOT, QUICK);
  handles.push(ks);

  // techtree-index
  const ti = await require("./techtree-index/techtree-index.bench")(ROOT, QUICK);
  handles.push(ti);

  } finally {
    const results = await Promise.allSettled(handles.map(async handle => {
      await handle.close();
      require("node:fs").rmSync(handle.ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }));
    const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "benchmark cleanup failed");
  }

  const out = writeArtifact(ROOT);
  console.log(`  ${failures.length ? `⚠ ${failures.length} suite(s) failed` : "all suites ok"} · artifact: ${out}`);
  process.exitCode = failures.length ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
