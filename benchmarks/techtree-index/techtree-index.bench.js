/** User path: tech-tree index — closure rebuild + topo + FTS5 node search. */
"use strict";
const path = require("node:path");
const { suite, now, freshWorkspace } = require("../support/helpers");

module.exports = async function runTechtreeIndex(root) {
  const ws = freshWorkspace(root, "tindex");
  const dbFile = path.join(ws, "bench.db");
  const { DB } = require(path.join(root, "dist/packages/core/database/src/db"));
  const { TreeStore } = require(path.join(root, "dist/packages/techtree/model/src/reads"));
  const { getOrm } = require(path.join(root, "dist/packages/core/database/src/orm"));
  const treeWrites = require(path.join(root, "dist/packages/techtree/model/src/writes"));
  const { ngram } = require(path.join(root, "dist/packages/core/text/src/text"));
  const db = new DB(dbFile);
  const trees = new TreeStore(db);
  const ds = await getOrm(dbFile);
  const tree = await treeWrites.treeCreate(ds, "bt", "", "");
  const NODE_N = 300;

  await suite("node-index", async () => {
    db.exec("BEGIN");
    const nowIso = new Date().toISOString();
    for (let i = 0; i < NODE_N; i++) {
      const key = `n${String(i).padStart(4, "0")}`;
      db.run(`INSERT INTO nodes(id,tree_id,key,name,kind,tier,cost,cost_unit,payload,tags,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [`nd${key}`, tree.id, key, `节点${key}`, "tech", i % 7, i, "", "", "", nowIso]);
      db.run(`INSERT INTO nodes_fts(id,key,name,tags,ngram) VALUES(?,?,?,?,?)`,
        [`nd${key}`, key, `节点${key}`, "", ngram(`${key} 节点${key}`)]);
    }
    for (let i = 0; i < NODE_N; i++) {
      const add = (p, c, req) => db.run(
        `INSERT INTO node_edges(id,tree_id,parent_id,child_id,rel,mode,required,min_level,weight,note) VALUES(?,?,?,?,?,?,?,1,1,'')`,
        [`e${i}_${p}-${c}`, tree.id, `ndn${String(p).padStart(4, "0")}`, `ndn${String(c).padStart(4, "0")}`, "prereq", "AND", req]);
      if (i + 1 < NODE_N) add(i, i + 1, 1);
      if (i + 3 < NODE_N) add(i, i + 3, i % 2);
    }
    db.exec("COMMIT");
    let iters = [];
    for (let k = 0; k < 3; k++) {
      const t = now();
      await ds.transaction(async (mgr) => {
        await treeWrites.rebuildClosure(mgr, tree.id);
        return treeWrites.buildIndex(mgr, tree.id);
      });
      iters.push(now() - t);
    }
    const idxMs = iters.sort((a, b) => a - b)[Math.floor(iters.length / 2)];
    return { unit: "total", total: idxMs, note: `${NODE_N} nodes/${NODE_N * 2 - 4} edges, iters=[${iters.map((m) => m.toFixed(0)).join(",")}]ms` };
  });

  await suite("node-search", async () => {
    const pool = ["n00", "节点n01", "tech", "n01 n05", "架构", "tier"];
    const samples = [];
    for (let i = 0; i < 100; i++) {
      const q = pool[i % pool.length];
      const t0 = now();
      trees.nodeSearch(tree.id, q, 20);
      samples.push(now() - t0);
    }
    const st = require("../support/helpers").stats(samples);
    return { unit: "per-op", ...st, note: `tree=${NODE_N} nodes` };
  });

  return { db, ws };
};
