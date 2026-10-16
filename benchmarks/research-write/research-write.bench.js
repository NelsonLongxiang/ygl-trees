/** User path: research write — transactional claim writes + dedupe hits. */
"use strict";
const path = require("node:path");
const { suite, now, fmtUs, freshWorkspace, scale } = require("../support/helpers");

module.exports = async function runResearchWrite(root, quick) {
  const N = scale(quick, 200, 50);
  const ws = freshWorkspace(root, "rwrite");
  const dbFile = path.join(ws, "bench.db");
  const { DB } = require(path.join(root, "dist/packages/core/database/src/db"));
  const { getOrm } = require(path.join(root, "dist/packages/core/database/src/orm"));
  const writes = require(path.join(root, "dist/packages/research/pipeline/src/writes"));
  const db = new DB(dbFile);
  const ds = await getOrm(dbFile);
  const proj = await writes.projectCreate(ds, "bench", "基准");

  await suite("claim-write", async () => {
    const texts = Array.from({ length: N }, (_, i) => `bench 断言 #${i}：第 ${i} 条事务化写入路径度量`);
    const t0 = now();
    for (const t of texts) await writes.claimAdd(ds, proj.id, t, "B");
    const total = now() - t0;
    return { unit: "total", total, note: `${texts.length} txns, ${fmtUs(total / texts.length)}/op` };
  });

  await suite("claim-dedupe", async () => {
    const texts = Array.from({ length: N }, (_, i) => `bench 断言 #${i}：第 ${i} 条事务化写入路径度量`);
    const t0 = now();
    let dups = 0;
    for (const t of texts) if ((await writes.claimAdd(ds, proj.id, t, "B")).dup) dups++;
    const total = now() - t0;
    return { unit: "total", total, note: `${dups}/${texts.length} dup-hits, ${fmtUs(total / texts.length)}/op` };
  });

  return { db, ws };
};
