#!/usr/bin/env node
/**
 * ygl-trees benchmark suite — zero-dependency (node:perf_hooks + child_process).
 *
 * Suits measure the faces that actually cost in this CLI:
 *   startup          process + Cordis Context + wasm DB open + Store (subprocess)
 *   claim-write      transactional write path incl. idempotency probe
 *   claim-dedupe     duplicate-hit path (hash lookup, no insert)
 *   kb-import-batch  bulk markdown import, single transaction
 *   kb-search        FTS5 bm25 CJK search over seeded corpus
 *   node-index       closure rebuild + Kahn topo over a seeded DAG
 *   node-search      FTS5 node search with title boost
 *
 * Usage:  node benchmarks/bench.js [--quick]
 * Output: table to stdout + JSON artifact to tmp/bench-results.json
 * Requires a fresh build (pnpm build) — pnpm bench does that for you.
 */
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const ROOT = path.resolve(__dirname, "..");
const QUICK = process.argv.includes("--quick");
const N = (full, quick) => (QUICK ? quick : full);

// ── helpers ──────────────────────────────────────────────────────────
const now = () => performance.now();
const us = (ms) => ms * 1000;
const fmtUs = (ms) => {
  const v = us(ms);
  return v >= 1000 ? `${(v / 1000).toFixed(2)}ms` : `${v.toFixed(0)}µs`;
};
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`);
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const pick = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], p50: pick(0.5), p95: pick(0.95), max: s[s.length - 1] };
}
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

// ── workspace ────────────────────────────────────────────────────────
const WS = path.join(ROOT, "tmp", "bench-workspace");
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });
const DB_FILE = path.join(WS, "bench.db");

const { DB } = require(path.join(ROOT, "dist/packages/core/database/src/db"));
const { Store } = require(path.join(ROOT, "dist/packages/research/pipeline/src/reads"));
const { TreeStore } = require(path.join(ROOT, "dist/packages/techtree/model/src/reads"));
const { getOrm } = require(path.join(ROOT, "dist/packages/core/database/src/orm"));
const writes = require(path.join(ROOT, "dist/packages/research/pipeline/src/writes"));
const treeWrites = require(path.join(ROOT, "dist/packages/techtree/model/src/writes"));
const { ngram } = require(path.join(ROOT, "dist/packages/core/text/src/text"));

const db = new DB(DB_FILE);
const store = new Store(db);
const trees = new TreeStore(db);

(async () => {
  console.log(`ygl-trees benchmarks · node ${process.version} · ${process.platform}${QUICK ? " · QUICK" : ""}`);

  // 1. startup — full CLI process, db stats (spawn, excluded warmup)
  await suite("startup", async () => {
    const bin = path.join(ROOT, "dist/apps/cli/src/bin.js");
    const args = ["--no-color", "--home", WS, "db", "stats"];
    spawnSync(process.execPath, [bin, ...args], { stdio: "ignore" }); // warmup
    const samples = [];
    for (let i = 0; i < N(10, 5); i++) {
      const t0 = now();
      spawnSync(process.execPath, [bin, ...args], { stdio: "ignore" });
      samples.push(now() - t0);
    }
    const st = stats(samples);
    return { unit: "per-op", ...st, note: `n=${st.n} full CLI process` };
  });

  // 2+3. claim write + dedupe path
  const ds = await getOrm(DB_FILE);
  const proj = await writes.projectCreate(ds, "bench", "基准测试项目");
  await suite("claim-write", async () => {
    const texts = Array.from({ length: N(200, 50) }, (_, i) => `bench 断言 #${i}：第 ${i} 条事务化写入路径度量`);
    const t0 = now();
    for (const t of texts) await writes.claimAdd(ds, proj.id, t, "B");
    const total = now() - t0;
    return { unit: "total", total, note: `${texts.length} txns, ${fmtUs(total / texts.length)}/op` };
  });
  await suite("claim-dedupe", async () => {
    const texts = Array.from({ length: N(200, 50) }, (_, i) => `bench 断言 #${i}：第 ${i} 条事务化写入路径度量`);
    const t0 = now();
    let dups = 0;
    for (const t of texts) if ((await writes.claimAdd(ds, proj.id, t, "B")).dup) dups++;
    const total = now() - t0;
    return { unit: "total", total, note: `${dups}/${texts.length} dup-hits, ${fmtUs(total / texts.length)}/op` };
  });

  // 4. kb bulk import (single tx) + 5. kb search over the corpus
  const KB_N = N(500, 100);
  await suite("kb-import-batch", async () => {
    const items = Array.from({ length: KB_N }, (_, i) => ({
      title: `架构决策模式 ${i} · 模块${i % 10}`,
      body: `第 ${i} 条知识笔记：专属词${i} 与 模块${i % 10} 记录，共享段含 闭包表 拓扑序 BitSet 候选集，i%3==0 时含 灰带 pending，i%5==0 时含 解锁条件 与 cordis 插件 摘录。`,
      tags: i % 10 === 0 ? "bench,arch" : "bench",
    }));
    const t0 = now();
    const { added } = await writes.kbImportBulk(ds, items);
    const total = now() - t0;
    return { unit: "total", total, note: `${added} rows/1tx, ${(added / (total / 1000)).toFixed(0)} rows/s` };
  });
  await suite("kb-search", async () => {
    const pool = ["架构 决策", "闭包表", "专属词7", "灰带 pending", "模块3", "架构决策模式", "cordis 插件", "解锁条件"];
    const samples = [];
    for (let i = 0; i < N(100, 30); i++) {
      const q = pool[i % pool.length];
      const t0 = now();
      store.kbSearch(q, 20);
      samples.push(now() - t0);
    }
    const st = stats(samples);
    return { unit: "per-op", ...st, note: `corpus=${KB_N}` };
  });

  // 6. node index rebuild over a raw-seeded DAG (chain + skip links)
  const NODE_N = N(300, 80);
  const tree = await treeWrites.treeCreate(ds, "bench-tree", proj.id, "");
  await suite("node-index", async () => {
    db.exec("BEGIN");
    const ins = db.prepare
      ? null
      : null;
    const t0 = now();
    const nowIso = new Date().toISOString();
    for (let i = 0; i < NODE_N; i++) {
      const key = `n${String(i).padStart(4, "0")}`;
      db.run(
        `INSERT INTO nodes(id,tree_id,key,name,kind,tier,cost,cost_unit,payload,tags,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [`nd${key}`, tree.id, key, `节点${key}`, "tech", i % 7, i, "", "", "", nowIso]
      );
      db.run(
        `INSERT INTO nodes_fts(id,key,name,tags,ngram) VALUES(?,?,?,?,?)`,
        [`nd${key}`, key, `节点${key}`, "", ngram(`${key} 节点${key}`)]
      );
    }
    for (let i = 0; i < NODE_N; i++) {
      const add = (p, c, req) =>
        db.run(
          `INSERT INTO node_edges(id,tree_id,parent_id,child_id,rel,mode,required,min_level,weight,note) VALUES(?,?,?,?,?,?,?,1,1,'')`,
          [`e${i}_${p}-${c}`, tree.id, `ndn${String(p).padStart(4, "0")}`, `ndn${String(c).padStart(4, "0")}`, "prereq", "AND", req]
        );
      if (i + 1 < NODE_N) add(i, i + 1, 1);
      if (i + 3 < NODE_N) add(i, i + 3, i % 2); // mixed required/optional skip links
    }
    const seedMs = now() - t0;
    db.exec("COMMIT");
    // median of 3 rebuilds — one-shot timings swing hard on Windows
    // (Defender scans fresh files); the operation is idempotent.
    let out;
    const iters = [];
    for (let k = 0; k < 3; k++) {
      const t = now();
      out = await ds.transaction(async (mgr) => {
        await treeWrites.rebuildClosure(mgr, tree.id);
        return treeWrites.buildIndex(mgr, tree.id);
      });
      iters.push(now() - t);
    }
    const idxMs = iters.sort((a, b) => a - b)[Math.floor(iters.length / 2)];
    return {
      unit: "total",
      total: idxMs,
      note: `${NODE_N} nodes/${NODE_N * 2 - 4} edges, topo=${out.topo.length}, iters=[${iters.map((m) => m.toFixed(0)).join(",")}]ms, seed=${fmtMs(seedMs)} (excluded)`,
    };
  });

  // 7. node search
  await suite("node-search", async () => {
    const pool = ["n00", "节点n01", "tech", "n01 n05", "架构", "tier"];
    const samples = [];
    for (let i = 0; i < N(100, 30); i++) {
      const q = pool[i % pool.length];
      const t0 = now();
      trees.nodeSearch(tree.id, q, 20);
      samples.push(now() - t0);
    }
    const st = stats(samples);
    return { unit: "per-op", ...st, note: `tree=${NODE_N} nodes` };
  });

  // ── artifact ──
  const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  const artifact = {
    meta: {
      date: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      git: (git.stdout || "").trim(),
      quick: QUICK,
    },
    results,
  };
  const outPath = path.join(ROOT, "tmp", "bench-results.json");
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), "utf8");
  db.close();
  console.log(`  ${failures.length ? `⚠ ${failures.length} suite(s) failed` : "all suites ok"} · artifact: tmp/bench-results.json`);
  process.exitCode = failures.length ? 1 : 0;
})();
