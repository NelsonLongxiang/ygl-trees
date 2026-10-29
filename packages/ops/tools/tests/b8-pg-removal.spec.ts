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

describe.skipIf(!adminUrl)("B8 batch 3 C removal CLI (official migration)", () => {
  beforeAll(async () => {
    const { Client } = require("pg");
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    dir = mkdtempSync(join(ROOT, "tmp/b8-removal-")); home = join(dir, "home");
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
  const json=(r:ReturnType<typeof cli>)=>{expect(r.rc,r.text).toBe(0);return JSON.parse(r.out);};let i=0;
  function fixture(){const key="removal-"+(++i);const s=json(cli(["research","source","add","--title",key,"--url","session://"+key,"--content","searchable","--json"])).id;const e=json(cli(["research","evidence","add",s,"--quote",key,"--json"])).id;const c=json(cli(["research","claim","add",key,"--json"])).id;json(cli(["research","claim","link",c,e,"--json"]));return{s,e,c};}
  it("default protects referenced evidence/source and force removes only the exact cone",async()=>{
    json(cli(["project","new","removal-project","--json"]));const a=fixture(),b=fixture();
    const e=cli(["research","evidence","rm",a.e,"--json"]);expect(e.rc).toBe(1);expect(e.text).toContain("linked to 1 claim");
    const s=cli(["research","source","rm",a.s,"--json"]);expect(s.rc).toBe(1);expect(s.text).toContain("still has 1 evidence");
    const out=json(cli(["research","source","rm",a.s,"--force","--json"]));expect(out).toMatchObject({id:a.s,evidence_removed:1,claims_recomputed:1,cascaded:1,forced:true});
    expect((await client.query("SELECT status FROM claims WHERE id=$1",[a.c])).rows[0].status).toBe("unverified");
    expect((await client.query("SELECT id FROM evidence WHERE id=$1",[a.e])).rows).toEqual([]);expect((await client.query("SELECT id FROM sources WHERE id=$1",[a.s])).rows).toEqual([]);
    expect(json(cli(["research","source","show",b.s,"--json"])).id).toBe(b.s);expect(json(cli(["research","claim","show",b.c,"--json"])).status).toBe("supported");
  });
  it("force evidence removal preserves manual arbitration and prediction states",()=>{
    const a=fixture();json(cli(["research","claim","resolve",a.c,"--as","refuted","--note","fixture only","--json"]));
    const pred=json(cli(["research","claim","add","[预测·7天] removal fixture","--json"])).id;json(cli(["research","claim","link",pred,a.e,"--json"]));
    const result=json(cli(["research","evidence","rm",a.e,"--force","--json"]));expect(result.forced).toBe(true);expect(result.cascaded).toBe(2);expect(result.statuses[a.c]).toBe("refuted");expect(result.statuses[pred]).toBe("unverified");
    expect(json(cli(["research","source","show",a.s,"--json"])).id).toBe(a.s);
  });
  it("event failure restores source/evidence/links/status and search rows atomically",async()=>{
    const a=fixture();await client.query("CREATE FUNCTION b8_rm_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind IN ('source.rm','evidence.rm') THEN RAISE EXCEPTION 'fixture deletion'; END IF; RETURN NEW; END $$");await client.query("CREATE TRIGGER b8_rm_abort BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION b8_rm_abort()");
    try{for(const [kind,id]of [["source",a.s],["evidence",a.e]]){const r=cli(["research",kind,"rm",id,"--force","--json"]);expect(r.rc).toBe(1);expect(json(cli(["research","claim","show",a.c,"--json"])).status).toBe("supported");expect((await client.query("SELECT evidence_id FROM claim_evidence WHERE claim_id=$1",[a.c])).rows).toEqual([{evidence_id:a.e}]);expect((await client.query("SELECT id FROM evidence WHERE id=$1 AND ngram_tsv IS NOT NULL",[a.e])).rows).toHaveLength(1);}}
    finally{await client.query("DROP TRIGGER b8_rm_abort ON events");await client.query("DROP FUNCTION b8_rm_abort()");}
  });
  it("project scope and archived owner block removals without touching other projects",async()=>{
    const a=fixture();json(cli(["project","new","other","--json"],{YGL_SESSION:"other"}));
    const cross=cli(["research","source","rm",a.s,"--force","-p","other","--json"]);expect(cross.rc).toBe(1);expect(cross.text).toContain("removal-project");
    await client.query("UPDATE projects SET status='archived' WHERE name='removal-project'");try{const r=cli(["research","evidence","rm",a.e,"--force","--json"]);expect(r.rc).toBe(1);expect(r.text).toContain("archived");}finally{await client.query("UPDATE projects SET status='active' WHERE name='removal-project'");}
  });
  it("delete vs new link serializes on the evidence fence; no committed dangling relation or stale state",async()=>{
    const a=fixture();const c=json(cli(["research","claim","add","racing-new-link","--json"])).id;
    const runs=await Promise.all([concurrent(["research","evidence","rm",a.e,"--force","-p","removal-project","--json"],"rm-race"),concurrent(["research","claim","link",c,a.e,"-p","removal-project","--json"],"link-race")]);
    expect(runs[0].rc,runs[0].out+runs[0].err).toBe(0);expect([0,1]).toContain(runs[1].rc);
    expect((await client.query("SELECT * FROM claim_evidence WHERE evidence_id=$1",[a.e])).rows).toEqual([]);expect((await client.query("SELECT status FROM claims WHERE id=$1",[c])).rows[0].status).toBe("unverified");
  });
});
