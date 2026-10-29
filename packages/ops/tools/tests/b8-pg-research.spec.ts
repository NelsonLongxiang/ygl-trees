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

describe.skipIf(!adminUrl)("B8 batch 2 real PG CLI (official migration)", () => {
  beforeAll(async () => {
    const { Client } = require("pg");
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    dir = mkdtempSync(join(ROOT, "tmp/b8-batch2-")); home = join(dir, "home");
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
  let projectId="", sourceId="", claimId="", evidenceId="";
  const json=(r:ReturnType<typeof cli>)=>{expect(r.rc,r.text).toBe(0);return JSON.parse(r.out);};
  const batch=(kind:string,rows:any[],extra:string[]=[])=>{
    const path=join(dir,kind+"-"+Date.now()+"-"+Math.random()+".jsonl");writeFileSync(path,rows.map(r=>JSON.stringify(r)).join("\n"));
    return cli(["research",kind,"add","--batch",path,"--json",...extra]);
  };
  it("official migration supplies only the existing source/evidence search surfaces",async()=>{
    const rows=(await client.query("SELECT table_name,is_generated FROM information_schema.columns WHERE table_schema='public' AND column_name='ngram_tsv' AND table_name IN ('sources','evidence','claims') ORDER BY 1")).rows;
    expect(rows).toEqual([{table_name:"evidence",is_generated:"ALWAYS"},{table_name:"sources",is_generated:"ALWAYS"}]);
    projectId=json(cli(["project","new","alpha","--json"])).id;
    json(cli(["project","new","beta","--json"],{YGL_SESSION:"b8-b"}));
  });
  it("project use preserves prior and isolates sessions; global/archived selection refuse",async()=>{
    expect(json(cli(["project","use","beta","--json"]))).toMatchObject({prior:"alpha",scope:"session",session:"b8-a"});
    expect(json(cli(["project","use","alpha","--json"]))).toMatchObject({prior:"beta",selected:"alpha"});
    expect(json(cli(["project","show","--json"],{YGL_SESSION:"b8-b"})).project.name).toBe("beta");
    const g=cli(["project","use","alpha","--global","--json"]);expect(g.rc).toBe(2);expect(g.text).toContain("--global");
    await client.query("UPDATE projects SET status='archived' WHERE name='beta'");
    const a=cli(["project","use","beta","--archived","--json"]);expect(a.rc).toBe(1);expect(a.text).toContain("archived");
    expect((await client.query("SELECT value FROM meta WHERE key='current_project@b8-a'")).rows[0].value).toBe("alpha");
    await client.query("UPDATE projects SET status='active' WHERE name='beta'");
  });
  it("source/evidence/claim true CLI chain writes+reads; only source/evidence have generated retrieval",async()=>{
    const s=json(cli(["research","source","add","--title","材料","--url","https://example.test/s","--content","searchable 中文","--json"]));sourceId=s.id;
    const e=json(cli(["research","evidence","add",sourceId,"--quote","searchable quote 中文","--json"]));evidenceId=e.id;
    const c=json(cli(["research","claim","add","claim 中文","--channel","manual","--json"]));claimId=c.id;
    for(const [kind,id] of [["source",sourceId],["evidence",evidenceId],["claim",claimId]]){
      expect(json(cli(["research",kind,"show",id,"--json"])).id).toBe(id);
      expect(json(cli(["research",kind,"list","--json"])).some((r:any)=>r.id===id)).toBe(true);
    }
    for(const [table,id] of [["sources",sourceId],["evidence",evidenceId]]){
      const row=(await client.query('SELECT ngram,ngram_tsv FROM "'+table+'" WHERE id=$1',[id])).rows[0];expect(row.ngram).toContain("searchable");expect(row.ngram_tsv).toContain("searchable");
      expect((await client.query('SELECT id FROM "'+table+'" WHERE id=$1 AND ngram_tsv @@ to_tsquery(' + "'simple','searchable'" + ')',[id])).rows).toEqual([{id}]);
    }
    expect((await client.query("SELECT COUNT(*)::int AS n FROM events WHERE kind IN ('source.add','evidence.add','claim.add') AND entity_id=ANY($1)",[[sourceId,evidenceId,claimId]])).rows[0].n).toBe(3);
    expect(readdirSync(home)).toEqual(["pg-binding.json"]);
  });
  for(const kind of ["source","evidence","claim"]){
    it(kind+" six concurrent duplicates: one creator/one row, rest duplicate rc0",async()=>{
      const args=kind==="source"?["--title","race-source","--url","https://example.test/race"]:kind==="evidence"?[sourceId,"--quote","race-evidence"]:["race-claim"];
      const runs=await Promise.all(Array.from({length:6},(_,i)=>concurrent(["research",kind,"add",...args,"-p","alpha","--json"],"race-"+i)));
      for(const r of runs)expect(r.rc,r.out+r.err).toBe(0);
      expect(runs.filter(r=>!JSON.parse(r.out).duplicate)).toHaveLength(1);
      const ids=new Set(runs.map(r=>JSON.parse(r.out).id));expect(ids.size).toBe(1);
    });
    it(kind+" batch accepts duplicate, rejects bad row before writes and rolls back on mid-event failure",async()=>{
      const row=kind==="source"?{title:"batch-source",url:"https://example.test/batch"}:kind==="evidence"?{source_id:sourceId,quote:"batch-evidence"}:{text:"batch-claim"};
      expect(json(batch(kind,[row,row]))).toMatchObject({added:1,duplicates:1});
      const bad=kind==="source"?{title:"bad",relevance:0.2}:kind==="evidence"?{source_id:sourceId}:{confidence:"bad"};
      const invalid=batch(kind,[row,bad]);expect(invalid.rc).toBe(2);expect(JSON.parse(invalid.out).error).toContain("line 2");
      const table=kind==="source"?"sources":kind==="claim"?"claims":"evidence";
      const count=async()=>Number((await client.query('SELECT COUNT(*)::int n FROM "'+table+'"')).rows[0].n);
      const before=await count();const events=Number((await client.query("SELECT COUNT(*)::int n FROM events WHERE kind=$1",[kind+".add"])).rows[0].n);
      await client.query("CREATE FUNCTION b8_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='"+kind+".add' AND NEW.payload LIKE '%abort-batch%' THEN RAISE EXCEPTION 'test mid-event'; END IF; RETURN NEW; END $$");
      await client.query("CREATE TRIGGER b8_abort BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION b8_abort()");
      try{
        const rows=kind==="source"?[{title:"okay-batch",url:"https://example.test/okay-"+kind},{title:"abort-batch",url:"https://example.test/abort-"+kind}]:kind==="evidence"?[{source_id:sourceId,quote:"okay-batch"},{source_id:sourceId,quote:"abort-batch"}]:[{text:"okay-batch"},{text:"abort-batch"}];
        const failed=batch(kind,rows);expect(failed.rc,failed.text).toBe(1);expect(await count()).toBe(before);
        expect(Number((await client.query("SELECT COUNT(*)::int n FROM events WHERE kind=$1",[kind+".add"])).rows[0].n)).toBe(events);
      }finally{await client.query("DROP TRIGGER b8_abort ON events");await client.query("DROP FUNCTION b8_abort()");}
    });
  }
  it("file inputs mirror existing per-type meaning and reject missing files / conflicts",()=>{
    const sf=join(dir,"source.json"),cf=join(dir,"claim.json"),ef=join(dir,"quote.txt");
    writeFileSync(sf,JSON.stringify({title:"source-file",url:"https://example.test/file",ignored:"visible"}));writeFileSync(cf,JSON.stringify({text:"claim-file",confidence:"A"}));writeFileSync(ef," quote-file 中文 \n");
    expect(json(cli(["research","source","add","--file",sf,"--json"])).ignored_fields).toEqual(["ignored"]);
    expect(json(cli(["research","claim","add","--file",cf,"--json"])).confidence).toBe("A");
    expect(json(cli(["research","evidence","add",sourceId,"--file",ef,"--json"])).quote).toBe("quote-file 中文");
    for(const k of ["source","claim","evidence"]){expect(cli(["research",k,"add",...(k==="evidence"?[sourceId]:[]),"--file",join(dir,"missing"),"--json"]).rc).toBe(1);}
    expect(cli(["research","claim","add","--file",cf,"--text","mixed","--json"]).rc).toBe(2);
  });
  it("same content is independently valid across projects; cross-project source reference refuses",()=>{
    const b=json(cli(["research","source","add","--title","材料","--url","https://example.test/s","-p","beta","--json"]));expect(b.id).not.toBe(sourceId);
    const c=json(cli(["research","claim","add","claim 中文","-p","beta","--json"]));expect(c.id).not.toBe(claimId);
    const bad=cli(["research","evidence","add",sourceId,"--quote","forbidden","-p","beta","--json"]);expect(bad.rc).toBe(1);expect(bad.text).toContain("source");
    const e=json(cli(["research","evidence","add",b.id,"--quote","searchable quote 中文","-p","beta","--json"]));expect(e.id).not.toBe(evidenceId);
    const show=cli(["research","source","show",sourceId,"-p","beta","--json"]);expect(show.rc).toBe(1);expect(show.text).toContain("alpha");
  });
  it("archived writes and ambiguous fresh sessions refuse, explicit project does not mutate selection",async()=>{
    await client.query("UPDATE projects SET status='archived' WHERE name='beta'");
    for(const k of ["source","evidence","claim"]){const flags=k==="source"?["--title","archived"]:k==="evidence"?[sourceId,"--quote","archived"]:["archived"];const r=cli(["research",k,"add",...flags,"-p","beta","--json"]);expect(r.rc).toBe(1);expect(r.text).toContain("archived");}
    await client.query("UPDATE projects SET status='active' WHERE name='beta'");
    const fresh=cli(["research","claim","list","--json"],{YGL_SESSION:"fresh"});expect(fresh.rc).toBe(2);
    json(cli(["research","claim","list","-p","alpha","--json"],{YGL_SESSION:"fresh"}));
    expect((await client.query("SELECT value FROM meta WHERE key='current_project@fresh'")).rows).toEqual([]);
  });
  it("out-of-scope verbs and global selection remain refused",()=>{
    for(const args of [["research","claim","resolve",claimId],["research","claim","link",claimId,evidenceId],["research","source","fetch","https://example.test"],["research","evidence","rm",evidenceId],["project","rm","alpha"]])expect(cli([...args,"--json"]).rc).toBe(2);
  });
  it("missing generated source search column fails before any business insert",async()=>{
    await client.query("ALTER TABLE sources RENAME COLUMN ngram_tsv TO b8_saved_tsv");
    try{const r=cli(["research","source","add","--title","must-not-write","--json"]);expect(r.rc).toBe(1);expect(r.text).toContain("sources.ngram_tsv");expect((await client.query("SELECT id FROM sources WHERE title='must-not-write'")).rows).toEqual([]);}finally{await client.query("ALTER TABLE sources RENAME COLUMN b8_saved_tsv TO ngram_tsv");}
  });
  it("source query option attaches inside the same transaction and bad refs do not half-write",async()=>{
    await client.query("INSERT INTO queries(id,project_id,text,engine,status,note,content_hash,created) VALUES('existing-query',$1,'existing query','','pending','','existing-query','now')",[projectId]);
    const src=json(cli(["research","source","add","--title","with query","--url","https://example.test/query","--query","existing-query","--json"]));
    expect((await client.query("SELECT source_id FROM query_sources WHERE query_id='existing-query'")).rows).toEqual([{source_id:src.id}]);
    const bad=cli(["research","source","add","--title","bad query must not land","--url","https://example.test/bad-query","--query","missing-query","--json"]);
    expect(bad.rc).toBe(1);expect(bad.text).toContain("query not found");
    expect((await client.query("SELECT id FROM sources WHERE title='bad query must not land'")).rows).toEqual([]);
  });
  it("force creates distinct evidence/claims; source remains URL-idempotent",()=>{
    for(const kind of ["evidence","claim"]){
      const args=kind==="evidence"?[sourceId,"--quote","forced-quote"]:["forced-claim"];
      const a=json(cli(["research",kind,"add",...args,"--force","--json"]));const b=json(cli(["research",kind,"add",...args,"--force","--json"]));
      expect(a.id).not.toBe(b.id);expect(b.duplicate).not.toBe(true);
    }
  });
  it("research connection and binding failures are single errors, never SQLite fallback or driver credential echoes",()=>{
    const args=["research","claim","add","must-refuse","--json"];
    const missing=cli(args,{YGL_DB_URL:""});expect(missing.rc).toBe(2);expect(JSON.parse(missing.out).error).toContain("binding");
    expect(cli(args,{YGL_SESSION:"",DSH_SESSION_ID:""}).rc).toBe(2);
    const dead=cli(args,{YGL_HOME:join(dir,"dead"),YGL_DB_URL:"postgres://user:secret-batch2@127.0.0.1:1/missing"});
    expect(dead.rc).toBe(1);expect(JSON.parse(dead.out).error).toContain("no SQLite fallback");expect(dead.text).not.toContain("secret-batch2");expect(existsSync(join(dir,"dead","ygl-trees.db"))).toBe(false);
    expect(cli([...args,"--db","postgres://u:p@localhost/db","--db","sqlite.db"]).rc).toBe(2);
    expect(cli(args,{YGL_DB_URL:target.replace(dbName,"other")}).rc).toBe(2);
  });
  it("project use event failure rolls back the session pointer",async()=>{
    await client.query("CREATE FUNCTION b8_use_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='project.use' THEN RAISE EXCEPTION 'use abort'; END IF; RETURN NEW; END $$");
    await client.query("CREATE TRIGGER b8_use_abort BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION b8_use_abort()");
    try{const r=cli(["project","use","beta","--json"]);expect(r.rc).toBe(1);expect((await client.query("SELECT value FROM meta WHERE key='current_project@b8-a'")).rows[0].value).toBe("alpha");}
    finally{await client.query("DROP TRIGGER b8_use_abort ON events");await client.query("DROP FUNCTION b8_use_abort()");}
  });
  it("PG doctor passes applicable items and explicitly skips verify-on-PG",()=>{
    const checks=json(cli(["doctor","--json"]));expect(checks.filter((r:any)=>r.status==="fail")).toEqual([]);expect(checks.find((r:any)=>r.name==="verify_on_pg").status).toBe("skip");
  });
});
