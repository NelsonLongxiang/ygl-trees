/** Real PG acceptance. Supply an isolated admin URL: the suite creates/drops its own random database. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DB } from "../../../core/database/src/db";
import { migrateToPg } from "../src/pgsync";
import { pgTargetHash, checkPgWorkspace } from "../../../core/database/src/pg-workspace";
import { upsertSql } from "../../../core/database/src/upsert";

const ROOT = resolve(__dirname, "../../../..");
const BIN = join(ROOT, "dist/bundle/bin.cjs");
const adminUrl = process.env.B8_TEST_PG_ADMIN_URL || "";
let dir = "", home = "", target = "", dbName = "";
let admin: any, client: any;
const cleanEnv = () => {
  const env = { ...process.env };
  for (const key of ["YGL_DB_URL", "YGL_PG_URL", "YGL_PROJECT", "YGL_SESSION", "DSH_SESSION_ID", "NODE_OPTIONS"]) delete env[key];
  return env;
};
function cli(args: string[], overrides: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 20000,
    env: { ...cleanEnv(), YGL_HOME: home, YGL_DB_URL: target, YGL_SESSION: "b8-a", YGL_NO_UPDATE_CHECK: "1", ...overrides },
  });
  return { rc: r.status, out: r.stdout || "", err: r.stderr || "", text: (r.stdout || "") + (r.stderr || "") };
}
async function concurrent(args: string[], sid: string) {
  return new Promise<{rc: number | null; out: string; err: string}>((resolve, reject) => {
    const p = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, env: { ...cleanEnv(), YGL_HOME: home, YGL_DB_URL: target, YGL_SESSION: sid, YGL_NO_UPDATE_CHECK: "1" } });
    let out = "", err = "";
    const timeout = setTimeout(() => p.kill(), 20000);
    p.stdout.on("data", d => out += d); p.stderr.on("data", d => err += d);
    p.on("error", reject); p.on("close", rc => { clearTimeout(timeout); resolve({rc, out, err}); });
  });
}

describe.skipIf(!adminUrl)("B8 batch 3 A query CLI (official migration)", () => {
  beforeAll(async () => {
    const { Client } = require("pg");
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    dir = mkdtempSync(join(ROOT, "tmp/b8-query-")); home = join(dir, "home");
    dbName = "b8_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    admin = new Client({ connectionString: adminUrl }); await admin.connect();
    await admin.query('CREATE DATABASE "' + dbName + '"');
    const u = new URL(adminUrl); u.pathname = "/" + dbName; target = u.toString();
    const seed = new DB(join(dir, "seed.sqlite"), { lock: false });
    try { await migrateToPg(seed, target); } finally { seed.close(); }
    client = new Client({ connectionString: target }); await client.connect();
  }, 60000);
  afterAll(async () => {
    await client?.end();
    if (admin) { if (dbName) await admin.query('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)'); await admin.end(); }
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const json=(r:ReturnType<typeof cli>)=>{expect(r.rc,r.text).toBe(0);return JSON.parse(r.out);};
  let project="",q="",source="";
  it("query add/list uses the PG backend, duplicate keeps id and no SQLite business file",()=>{
    project=json(cli(["project","new","query-project","--json"])).id;
    q=json(cli(["research","query","add","research 中文","--engine","manual","--json"])).id;
    expect(json(cli(["research","query","add","research 中文","--engine","manual","--json"]))).toMatchObject({id:q,duplicate:true});
    const rows=json(cli(["research","query","list","--json"]));expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({id:q,sources:0,engine:"manual"});
    expect(readdirSync(home)).toEqual(["pg-binding.json"]);
  });
  it("six concurrent identical query adds arbitrate to one row and duplicate rc0",async()=>{
    const runs=await Promise.all(Array.from({length:6},(_,i)=>concurrent(["research","query","add","concurrent-query","-p","query-project","--json"],"query-"+i)));
    for(const r of runs)expect(r.rc,r.out+r.err).toBe(0);
    expect(new Set(runs.map(r=>JSON.parse(r.out).id)).size).toBe(1);expect(runs.filter(r=>!JSON.parse(r.out).duplicate)).toHaveLength(1);
  });
  it("query attach validates project ownership, logs once and counts a duplicate attachment once",async()=>{
    source=json(cli(["research","source","add","--title","source","--url","https://example.test/query-fixture","--json"])).id;
    const first=json(cli(["research","query","attach",q,source,"--json"]));expect(first.source).toBe(source);
    expect(json(cli(["research","query","attach",q,source,"--json"]))).toMatchObject({source,duplicate:true});
    expect(json(cli(["research","query","list","--json"])).find((r:any)=>r.id===q).sources).toBe(1);
    expect((await client.query("SELECT COUNT(*)::int n FROM events WHERE kind='query.attach' AND entity_id=$1",[q])).rows[0].n).toBe(1);
    const missing=cli(["research","query","attach","missing",source,"--json"]);expect(missing.rc).toBe(1);expect(JSON.parse(missing.out).error).toContain("query not found");
    json(cli(["project","new","other","--json"],{YGL_SESSION:"other-session"}));
    const foreign=cli(["research","query","attach",q,source,"-p","other","--json"]);expect(foreign.rc).toBe(1);expect(foreign.text).toContain("query-project");
  });
  it("six concurrent query attachments create one association and one event",async()=>{
    const id=json(cli(["research","query","add","attach-race","--json"])).id;
    const runs=await Promise.all(Array.from({length:6},(_,i)=>concurrent(["research","query","attach",id,source,"-p","query-project","--json"],"attach-"+i)));
    for(const r of runs)expect(r.rc,r.out+r.err).toBe(0);
    expect(runs.filter(r=>!JSON.parse(r.out).duplicate)).toHaveLength(1);
    expect((await client.query("SELECT COUNT(*)::int n FROM query_sources WHERE query_id=$1",[id])).rows[0].n).toBe(1);
    expect((await client.query("SELECT COUNT(*)::int n FROM events WHERE kind='query.attach' AND entity_id=$1",[id])).rows[0].n).toBe(1);
  });
  it("mid-event failure rolls back query add and attachment",async()=>{
    const id=json(cli(["research","query","add","attach-rollback","--json"])).id;
    await client.query("CREATE FUNCTION b8_query_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind IN ('query.add','query.attach') THEN RAISE EXCEPTION 'query event failure'; END IF; RETURN NEW; END $$");
    await client.query("CREATE TRIGGER b8_query_abort BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION b8_query_abort()");
    try{
      expect(cli(["research","query","add","must-not-land","--json"]).rc).toBe(1);
      expect(cli(["research","query","attach",id,source,"--json"]).rc).toBe(1);
      expect((await client.query("SELECT id FROM queries WHERE text='must-not-land'")).rows).toEqual([]);
      expect((await client.query("SELECT query_id FROM query_sources WHERE query_id=$1",[id])).rows).toEqual([]);
    }finally{await client.query("DROP TRIGGER b8_query_abort ON events");await client.query("DROP FUNCTION b8_query_abort()");}
  });
  it("missing command-required column is named before any writes and never repaired automatically",async()=>{
    await client.query("ALTER TABLE queries RENAME COLUMN engine TO b8_hidden_engine");
    const before=(await client.query("SELECT COUNT(*)::int n FROM events")).rows[0].n;
    try{
      const r=cli(["research","query","add","column-refusal","--json"]);expect(r.rc).toBe(1);
      expect(JSON.parse(r.out).error).toContain("queries.engine");expect(r.text).toContain("no changes made");
      expect((await client.query("SELECT id FROM queries WHERE text='column-refusal'")).rows).toEqual([]);
      expect((await client.query("SELECT COUNT(*)::int n FROM events")).rows[0].n).toBe(before);
    }finally{await client.query("ALTER TABLE queries RENAME COLUMN b8_hidden_engine TO engine");}
  });
  it("query done and still-unimplemented B/C/D faces remain refused during A slice",()=>{
    for(const args of [["research","query","done",q],["research","claim","evaluate","missing"],["research","source","fetch","https://example.test"],["kb","ingest","missing"]])expect(cli([...args,"--json"]).rc).toBe(2);
  });
});
