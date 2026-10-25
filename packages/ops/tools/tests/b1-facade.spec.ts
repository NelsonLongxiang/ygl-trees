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

  it("#77③: sync delegation fails closed on a non-sqlite dialect", async () => {
    const { SqliteAsyncDb, assertSyncDelegationAllowed } = await import("../../../core/database/src/asyncdb");
    const db = new DB(join(home, "ygl-trees.db"));
    const adb = new SqliteAsyncDb(db);
    expect(adb.dialect).toBe("sqlite");
    const fakePg: any = { dialect: "pg", get: async () => null, all: async () => [] };
    expect(() => assertSyncDelegationAllowed(fakePg, "probe")).toThrow(/sync delegation/);
    db.close();
  }, 30_000);

  it("#77-2: AsyncTreeStore facade — every declared read method resolves", async () => {
    const db = new DB(join(home, "ygl-trees.db"));
    const ts = new AsyncTreeStore(db);
    await expect(ts.treeList()).resolves.toBeInstanceOf(Array);
    await expect(ts.treeByName("nope")).resolves.toBeNull();
    await expect(ts.trees()).resolves.toBeInstanceOf(Array);
    // 无树时 treeResolve 抛「no tree selected」——断言拒绝而不是静默空
    await expect(ts.treeResolve()).rejects.toThrow(/no tree selected|tree not found/);
    await expect(ts.query("SELECT 1 AS one")).resolves.toBeInstanceOf(Array);
    db.close();
  }, 30_000);

  it("#77-2: AsyncResearchStore facade — every declared read method resolves", async () => {
    const db = new DB(join(home, "ygl-trees.db"));
    const rs = new AsyncResearchStore(db);
    await expect(rs.projectList()).resolves.toBeInstanceOf(Array);
    await expect(rs.projectByName("nope")).resolves.toBeNull();
    await expect(rs.tail(5)).resolves.toBeInstanceOf(Array);
    await expect(rs.skillList()).resolves.toBeInstanceOf(Array);
    await expect(rs.stats()).resolves.toBeTruthy();
    await expect(rs.query("SELECT 1 AS one")).resolves.toBeInstanceOf(Array);
    db.close();
  }, 30_000);
});
