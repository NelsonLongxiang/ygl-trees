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

describe.skipIf(!adminUrl)("B8 batch 3 B claim CLI (official migration)", () => {
  beforeAll(async () => {
    const { Client } = require("pg");
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    dir = mkdtempSync(join(ROOT, "tmp/b8-claim-cli-")); home = join(dir, "home");
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
  let c="",pred="",e1="",e2="",source="";
  it("executes full query/source/evidence/claim loop with ordinary stance changes and prediction preservation",()=>{
    json(cli(["project","new","claims-project","--json"]));
    source=json(cli(["research","source","add","--title","s","--url","session://claims-cli","--json"])).id;
    e1=json(cli(["research","evidence","add",source,"--quote","e1","--json"])).id;e2=json(cli(["research","evidence","add",source,"--quote","e2","--json"])).id;
    c=json(cli(["research","claim","add","ordinary","--json"])).id;pred=json(cli(["research","claim","add","[预测·7天] fixture only","--json"])).id;
    expect(json(cli(["research","claim","link",c,e1,"--json"]))).toMatchObject({status:"supported",auto_promote:true});
    expect(json(cli(["research","claim","link",c,e1,"--stance","refutes","--json"]))).toMatchObject({status:"refuted",duplicate:true});
    expect(json(cli(["research","claim","link",c,e2,"--json"]))).toMatchObject({status:"contested"});
    const before=json(cli(["research","claim","show",pred,"--json"]));
    expect(json(cli(["research","claim","link",pred,e1,"--json"]))).toMatchObject({status:"unverified",auto_promote:false});
    expect(json(cli(["research","claim","show",pred,"--json"])).updated).toBe(before.updated);
  });
  it("manual lock survives CLI unlink and known unverified/unresolve edge is mirrored",()=>{
    json(cli(["research","claim","resolve",c,"--as","refuted","--note","isolated fixture only","--json"]));
    const before=json(cli(["research","claim","show",c,"--json"]));
    expect(json(cli(["research","claim","unlink",c,e1,"--json"]))).toMatchObject({status:"refuted",recalculated:false});
    expect(json(cli(["research","claim","show",c,"--json"])).updated).toBe(before.updated);
    expect(json(cli(["research","claim","unresolve",c,"--json"]))).toMatchObject({status:"unverified",duplicate:false});
    expect(json(cli(["research","claim","link",c,e2,"--json"]))).toMatchObject({status:"supported",duplicate:true});
    json(cli(["research","claim","resolve",c,"--as","unverified","--json"]));
    expect(json(cli(["research","claim","unresolve",c,"--json"]))).toMatchObject({duplicate:true});
    expect(json(cli(["research","claim","link",c,e2,"--json"]))).toMatchObject({status:"unverified",auto_promote:false});
  });
  it("cross-project link is workspace-wide but scoped unlink/resolve refuse foreign ids",()=>{
    json(cli(["project","new","other","--json"],{YGL_SESSION:"other"}));
    const foreign=json(cli(["research","claim","add","foreign","-p","other","--json"])).id;
    expect(json(cli(["research","claim","link",foreign,e1,"-p","claims-project","--json"]))).toMatchObject({cross_project:{claim:"other",evidence:"claims-project"}});
    const unlink=cli(["research","claim","unlink",foreign,e1,"-p","claims-project","--json"]);expect(unlink.rc).toBe(1);expect(unlink.text).toContain("other");
    expect(cli(["research","claim","resolve",foreign,"--as","supported","-p","claims-project","--json"]).rc).toBe(1);
  });
  it("six concurrent CLI link receipts arbitrate one creator; duplicate does not mean stance no-op",async()=>{
    const id=json(cli(["research","claim","add","race-cli","--json"])).id;
    const runs=await Promise.all(Array.from({length:6},(_,i)=>concurrent(["research","claim","link",id,e1,"-p","claims-project","--json"],"claim-cli-"+i)));
    for(const r of runs)expect(r.rc,r.out+r.err).toBe(0);expect(runs.filter(r=>!JSON.parse(r.out).duplicate)).toHaveLength(1);
    expect((await client.query("SELECT stance FROM claim_evidence WHERE claim_id=$1",[id])).rows).toEqual([{stance:"supports"}]);
    expect(json(cli(["research","claim","link",id,e1,"--stance","refutes","--json"]))).toMatchObject({duplicate:true,status:"refuted"});
  });
  it("by-source links all evidence without eval; missing-link and unknown stance fail correctly",async()=>{
    const id=json(cli(["research","claim","add","by-source-cli","--json"])).id;
    expect(json(cli(["research","claim","link",id,source,"--by-source","--json"]))).toMatchObject({linked:2,duplicates:0,status:"supported"});
    expect(json(cli(["research","claim","link",id,source,"--by-source","--json"]))).toMatchObject({linked:0,duplicates:2});
    const bad=cli(["research","claim","link",id,e1,"--stance","unknown","--json"]);expect(bad.rc).toBe(2);
    json(cli(["research","claim","unlink",id,e1,"--json"]));const missing=cli(["research","claim","unlink",id,e1,"--json"]);expect(missing.rc).toBe(1);expect(missing.text).toContain("link not found");
    expect((await client.query("SELECT id FROM events WHERE kind='claim.eval'")).rows).toEqual([]);
  });
});
