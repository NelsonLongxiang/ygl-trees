/** User path: knowledge search — kb bulk import + FTS5 bm25 CJK search. */
"use strict";
const path = require("node:path");
const { suite, now, freshWorkspace, scale } = require("../support/helpers");

module.exports = async function runKnowledgeSearch(root, quick) {
  const ROWS = scale(quick, 500, 150);
  const SEARCHES = scale(quick, 100, 30);
  const ws = freshWorkspace(root, "ksearch");
  const dbFile = path.join(ws, "bench.db");
  const { DB } = require(path.join(root, "dist/packages/core/database/src/db"));
  const { Store } = require(path.join(root, "dist/packages/research/pipeline/src/reads"));
  const { getOrm } = require(path.join(root, "dist/packages/core/database/src/orm"));
  const writes = require(path.join(root, "dist/packages/research/pipeline/src/writes"));
  const db = new DB(dbFile);
  const store = new Store(db);
  const ds = await getOrm(dbFile);
  const proj = await writes.projectCreate(ds, "bench", "检索基准");

  await suite("kb-import-batch", async () => {
    const items = Array.from({ length: ROWS }, (_, i) => ({
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
    for (let i = 0; i < SEARCHES; i++) {
      const q = pool[i % pool.length];
      const t0 = now();
      store.kbSearch(q, 20);
      samples.push(now() - t0);
    }
    const st = require("../support/helpers").stats(samples);
    return { unit: "per-op", ...st, note: `corpus=${ROWS}` };
  });

  return { db, ws };
};
