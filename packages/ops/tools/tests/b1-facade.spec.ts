/**
 * #77/#78 回归：B1 面门禁 + research 命令 rc 契约。
 *
 * #77：AsyncOpsReads.runs() 列名错（runs 表无 created）+ stats/timeline 一致性。
 * #78：research source search / query done 的 rc 契约（await 链修复后不再 rc1）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DB } from "../../../core/database/src/db";
import { AsyncOpsReads } from "../src/async-reads";
import { AsyncDbCmds } from "../src/async-db-cmds";
import { AsyncTreeStore } from "../../../techtree/model/src/async-store";
import { AsyncResearchStore } from "../../../research/pipeline/src/async-store";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

describe("#77 async facade column parity + #78 rc contracts", () => {
  let home = "";

  function run(args: string[]) {
    const r = spawnSync(process.execPath, [BIN, ...args, "--json"], {
      cwd: REPO, encoding: "utf8", env: { ...process.env, YGL_HOME: home, YGL_SESSION: "b1-face" } as any,
    });
    let j: any = null;
    try { j = JSON.parse(r.stdout); } catch { /* not json */ }
    return { rc: r.status ?? -1, j, out: r.stdout + r.stderr };
  }

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "ygl-b1-face-"));
    run(["db", "init"]);
    run(["project", "new", "p1"]);
  });
  afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("#77: AsyncOpsReads.runs() does not throw on the real schema (started, not created)", async () => {
    const db = new DB(join(home, "ygl-trees.db"));
    const ops = new AsyncOpsReads(db);
    await expect(ops.runs()).resolves.toBeInstanceOf(Array);
    await expect(ops.counts()).resolves.toBeTruthy();
    db.close();
  }, 30_000);

  it("#77: AsyncOpsReads.stats counts match db stats surface (same tables)", async () => {
    const db = new DB(join(home, "ygl-trees.db"));
    const ops = new AsyncOpsReads(db);
    const counts = await ops.counts();
    const dbStats = run(["db", "stats"]);
    expect(dbStats.rc, dbStats.out).toBe(0);
    // db stats 的 projects 计数应与 facade counts 一致
    expect(counts.projects).toBe(dbStats.j.projects);
    db.close();
  }, 30_000);

  it("#78: research source search returns rc0 with JSON array (await chain intact)", () => {
    // 先建一个 source
    run(["research", "source", "add", "--title", "B1面源", "--url", "https://example.com/b1", "-p", "p1"]);
    const r = run(["research", "source", "search", "B1面源", "-p", "p1"]);
    expect(r.rc, r.out).toBe(0);
    expect(Array.isArray(r.j)).toBe(true);
  }, 30_000);

  it("#78: research query done returns rc0 and a single JSON object", () => {
    const added = run(["research", "query", "add", "B1 面检索式", "-p", "p1"]);
    expect(added.rc, added.out).toBe(0);
    const qid = added.j.id ?? added.j.row?.id;
    expect(qid).toBeTruthy();
    const done = run(["research", "query", "done", qid]);
    expect(done.rc, done.out).toBe(0);
    // --json 只输出一个 JSON 对象（不是数组、不是多行）
    expect(done.j && typeof done.j === "object" && !Array.isArray(done.j)).toBe(true);
  }, 30_000);

  it("#78: AsyncResearchStore.queryDone exists (async facade parity)", async () => {
    const db = new DB(join(home, "ygl-trees.db"));
    const s = new AsyncResearchStore(db);
    expect(typeof s.queryDone).toBe("function");
    db.close();
  }, 30_000);

  it("#77①: facade surface parity — every declared method resolves on real schema", async () => {
    const db = new DB(join(home, "ygl-trees.db"));
    const ops = new AsyncOpsReads(db);
    const dbc = new AsyncDbCmds(db);
    await expect(ops.counts()).resolves.toBeTruthy();
    await expect(ops.relsAll(5)).resolves.toBeInstanceOf(Array);
    await expect(ops.relsOf("nope")).resolves.toBeInstanceOf(Array);
    await expect(ops.jobs()).resolves.toBeInstanceOf(Array);
    await expect(ops.jobByName("nope")).resolves.toBeNull();
    await expect(ops.patrolChecks()).resolves.toBeInstanceOf(Array);
    await expect(ops.patrolFindings(5)).resolves.toBeInstanceOf(Array);
    await expect(ops.recentEvents(5)).resolves.toBeInstanceOf(Array);
    await expect(ops.runs()).resolves.toBeInstanceOf(Array);
    const st = await dbc.stats(join(home, "ygl-trees.db"));
    expect(Object.keys(st.counts).length).toBe(20);
    expect(st.file).toContain("ygl-trees.db");
    await expect(dbc.reportProjects()).resolves.toBeInstanceOf(Array);
    await expect(dbc.reportClaims()).resolves.toBeInstanceOf(Array);
    await expect(dbc.reportKb()).resolves.toBeInstanceOf(Array);
    await expect(dbc.reportTrees()).resolves.toBeInstanceOf(Array);
    await expect(dbc.treeNodeCount("nope")).resolves.toBe(0);
    await expect(dbc.timeline(7)).resolves.toBeInstanceOf(Array);
    await expect(dbc.recentEvents(5)).resolves.toBeInstanceOf(Array);
    await expect(dbc.projects()).resolves.toBeInstanceOf(Array);
    await expect(dbc.kbNotes()).resolves.toBeInstanceOf(Array);
    db.close();
  }, 60_000);

  it("#77-3: timeline parity — AsyncDbCmds vs db timeline CLI (shape + filters)", async () => {
    const db = new DB(join(home, "ygl-trees.db"));
    const dbc = new AsyncDbCmds(db);
    const facade = await dbc.timeline(7);
    const cliRaw = run(["db", "timeline"]);
    expect(cliRaw.rc, cliRaw.out).toBe(0);
    const cliRows = cliRaw.j?.timeline ?? [];
    if (facade.length || cliRows.length) {
      const fCols = Object.keys(facade[0] ?? {}).sort().join(",");
      const cCols = Object.keys(cliRows[0] ?? {}).sort().join(",");
      expect(fCols).toBe(cCols);
      const fDays = new Set(facade.map((r: any) => r.day));
      for (const r of cliRows) if (fDays.size) expect(fDays.has(r.day)).toBe(true);
    }
    const none = await dbc.timeline(7, { actor: "no-such-actor" });
    expect(none).toEqual([]);
    const sess = await dbc.timeline(7, { session: "b1-face" });
    expect(Array.isArray(sess)).toBe(true);
    db.close();
  }, 60_000);

  it("#77③: sync delegation fails closed on a non-sqlite dialect", async () => {
    const { SqliteAsyncDb, assertSyncDelegationAllowed } = await import("../../../core/database/src/asyncdb");
    const db = new DB(join(home, "ygl-trees.db"));
    const adb = new SqliteAsyncDb(db);
    expect(adb.dialect).toBe("sqlite");
    const fakePg: any = { dialect: "pg", get: async () => null, all: async () => [] };
    expect(() => assertSyncDelegationAllowed(fakePg, "probe")).toThrow(/sync delegation/);
    db.close();
  }, 30_000);

  it("#77-2: AsyncTreeStore facade — ALL 28 declared methods resolve (full surface)", async () => {
    const db = new DB(join(home, "ygl-trees.db"));
    const ts = new AsyncTreeStore(db);
    // 先建一棵最小树：t1 → n1(parent) → n2(child, prereq 边) + 一条条件
    const now = new Date().toISOString();
    db.run("INSERT INTO trees(id,name,note,created) VALUES('t1','t1','',?)", [now]);
    db.run("INSERT INTO nodes(id,tree_id,key,name,tier,created) VALUES('n1','t1','k1','节点一',1,?)", [now]);
    db.run("INSERT INTO nodes(id,tree_id,key,name,tier,created) VALUES('n2','t1','k2','节点二',2,?)", [now]);
    db.run("INSERT INTO node_edges(id,tree_id,parent_id,child_id,rel,mode) VALUES('e1','t1','n1','n2','unlock','AND')");
    db.run("INSERT INTO node_conditions(id,node_id,name,kind,expr,op,value) VALUES('c1','n2','条件一','expr','1=1','>=','1')");
    const rid = (rows) => Array.isArray(rows);
    // 全 28 个方法逐一调用（无树参数的用 t1/known-id；error 路径用 rejects）
    expect(rid(await ts.treeList())).toBe(true);                       // 1
    expect(rid(await ts.trees())).toBe(true);                          // 2
    expect(rid(await ts.nodesOfTree("t1"))).toBe(true);                // 3
    expect(rid(await ts.edgesOf("t1"))).toBe(true);                    // 4
    expect(rid(await ts.conditionsOf("t1", "k2"))).toBe(true);          // 5 监督席点名
    expect(await ts.treeByName("t1")).toBeTruthy();                    // 6
    expect(await ts.treeByName("nope")).toBeNull();                    // 7
    expect(await ts.treeSelection()).toBeTruthy();                      // 8
    expect(await ts.nodeGet("t1", "k1")).toBeTruthy();                  // 9
    expect(await ts.nodeByKey("t1", "k1")).toBeTruthy();               // 10
    expect(rid(await ts.nodeInOtherTrees("k1", "t1"))).toBe(true);     // 11
    expect(await ts.nodeStateOf("t1", "k1")).toBeTruthy();             // 12
    expect(rid(await ts.parents("t1", "k2"))).toBe(true);              // 13
    expect(rid(await ts.children("t1", "k1"))).toBe(true);             // 14
    expect(rid(await ts.ancestors("t1", "k2"))).toBe(true);            // 15
    expect(rid(await ts.descendants("t1", "k1"))).toBe(true);          // 16
    expect(rid(await ts.condList("t1", "k2"))).toBe(true);             // 17
    expect(await ts.evalContext("t1", "k2", {})).toBeTruthy();         // 18
    expect(rid(await ts.evalCandidates("t1"))).toBe(true);             // 19
    expect(await ts.pathTo("t1", "k2")).toBeTruthy();                  // 20
    expect(rid(await ts.validate("t1"))).toBe(true);                   // 21
    expect(rid(await ts.nodeList("t1"))).toBe(true);                   // 22
    expect(await ts.canUnlock("t1", "k2")).toBeTruthy();               // 23
    expect(await ts.ready("t1", "k2")).toBeTruthy();                   // 24
    expect(typeof (await ts.exportTree("t1"))).toBeTruthy();           // 25
    expect(rid(await ts.query("SELECT 1 AS one"))).toBe(true);         // 26
    expect(await ts.queryOne("SELECT 1 AS one")).toBeTruthy();         // 27
    expect(await ts.treeResolve()).toBeTruthy();                     // 28（有 t1 时解析为它）
    db.close();
  }, 60_000);

  it("#77-2: AsyncResearchStore facade — ALL 19 declared methods resolve (full surface)", async () => {
    const db = new DB(join(home, "ygl-trees.db"));
    const rs = new AsyncResearchStore(db);
    const rid = (rows) => Array.isArray(rows);
    expect(rid(await rs.projectList())).toBe(true);                    // 1
    expect(await rs.projectByName("p1")).toBeTruthy();                 // 2
    expect(await rs.projectByName("nope")).toBeNull();                 // 3
    expect(await rs.projectResolve("p1")).toBeTruthy();                // 4
    expect(rid(await rs.queryList("p1"))).toBe(true);                  // 5
    expect(rid(await rs.sourceList("p1"))).toBe(true);                 // 6
    expect(rid(await rs.sourceSearch("p1", "B1面源"))).toBe(true);     // 7
    expect(await rs.sourceGet("nope")).toBeNull();                     // 8
    expect(rid(await rs.evidenceList("p1"))).toBe(true);               // 9
    expect(rid(await rs.claimList("p1"))).toBe(true);                  // 10
    expect(rid(await rs.artifactList("p1"))).toBe(true);               // 11
    expect(await rs.artifactGet("nope")).toBeNull();                   // 12
    expect(rid(await rs.skillList())).toBe(true);                      // 13
    expect(await rs.skillGet("nope")).toBeNull();                      // 14
    expect(rid(await rs.skillMatch("任意"))).toBe(true);                // 15
    expect(rid(await rs.tail(5))).toBe(true);                          // 16
    expect(await rs.stats()).toBeTruthy();                             // 17
    expect(rid(await rs.query("SELECT 1 AS one"))).toBe(true);         // 18
    expect(await rs.queryOne("SELECT 1 AS one")).toBeTruthy();         // 19
    // queryDone 是写方法（第 19 面之外的 20 号）——b1-facade 首例已覆盖
    db.close();
  }, 60_000);
});
