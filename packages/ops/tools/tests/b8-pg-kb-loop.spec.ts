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

describe.skipIf(!adminUrl)("B8 batch 3 D knowledge CLI (official migration)", () => {
  beforeAll(async () => {
    const { Client } = require("pg");
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    dir = mkdtempSync(join(ROOT, "tmp/b8-kb-loop-")); home = join(dir, "home");
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
  const json=(r:ReturnType<typeof cli>)=>{expect(r.rc,r.text).toBe(0);return JSON.parse(r.out);};let a="",b="";
  it("kb link validates both ends and is idempotent with one relation and one event",async()=>{
    a=json(cli(["kb","add","--title","note-a","--body","one","--json"])).id;b=json(cli(["kb","add","--title","note-b","--body","two","--json"])).id;
    const first=json(cli(["kb","link",a,b,"--rel","supports","--json"]));expect(first).toMatchObject({a:{id:a},b:{id:b},rel:"supports"});
    expect(json(cli(["kb","link",a,b,"--rel","supports","--json"]))).toEqual(first);
    expect((await client.query("SELECT * FROM kb_links WHERE from_id=$1 AND to_id=$2",[a,b])).rows).toHaveLength(1);
    expect((await client.query("SELECT id FROM events WHERE kind='kb.link'")).rows).toHaveLength(1);
    const bad=cli(["kb","link",a,"missing","--json"]);expect(bad.rc).toBe(1);expect(bad.text).toContain("both notes must exist");
  });
  it("Markdown import parses all files before one transaction, updates actual search and counts duplicates",async()=>{
    const folder=join(dir,"notes");mkdirSync(folder);writeFileSync(join(folder,"a.md"),"---\ntitle: imported-a\ntags: fixture\n---\nsearchable 中文 note");writeFileSync(join(folder,"b.md"),"# imported-b\nsecond note");
    expect(json(cli(["kb","import",folder,"--json"]))).toMatchObject({added:2,duplicates:0,files:2,target:folder});
    expect(json(cli(["kb","import",folder,"--json"]))).toMatchObject({added:0,duplicates:2});
    expect((await client.query("SELECT title FROM kb_notes WHERE ngram_tsv @@ to_tsquery('simple','searchable')")).rows).toEqual([{title:"imported-a"}]);
  });
  it("import runtime event failure rolls back the entire batch and generated search rows",async()=>{
    const folder=join(dir,"rollback");mkdirSync(folder);writeFileSync(join(folder,"a.md"),"# rollback-a\nfirst");writeFileSync(join(folder,"b.md"),"# rollback-b\nsecond");
    await client.query("CREATE FUNCTION b8_kb_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='kb.add' AND NEW.payload='rollback-b' THEN RAISE EXCEPTION 'fixture bulk'; END IF; RETURN NEW; END $$");await client.query("CREATE TRIGGER b8_kb_abort BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION b8_kb_abort()");
    try{const r=cli(["kb","import",folder,"--json"]);expect(r.rc).toBe(1);expect((await client.query("SELECT id FROM kb_notes WHERE title LIKE 'rollback-%'")).rows).toEqual([]);expect((await client.query("SELECT id FROM events WHERE kind='kb.add' AND payload LIKE 'rollback-%'")).rows).toEqual([]);}
    finally{await client.query("DROP TRIGGER b8_kb_abort ON events");await client.query("DROP FUNCTION b8_kb_abort()");}
  });
  it("large-file preflight and missing file reject before writes; force permits size but does not bypass dedup",()=>{
    const large=join(dir,"large.md");writeFileSync(large,"# large-note\n"+"x".repeat(1024*1024));
    const refusal=cli(["kb","import",large,"--json"]);expect(refusal.rc).toBe(1);expect(refusal.text).toContain("1MB");
    expect(json(cli(["kb","import",large,"--force","--json"]))).toMatchObject({added:1,duplicates:0});
    expect(json(cli(["kb","import",large,"--force","--json"]))).toMatchObject({added:0,duplicates:1});
    expect(cli(["kb","import",join(dir,"missing.md"),"--json"]).rc).toBe(1);
  });
  it("kb link event failure rolls back the association",async()=>{
    await client.query("CREATE FUNCTION b8_kblink_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='kb.link' THEN RAISE EXCEPTION 'fixture link'; END IF; RETURN NEW; END $$");await client.query("CREATE TRIGGER b8_kblink_abort BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION b8_kblink_abort()");
    try{expect(cli(["kb","link",b,a,"--rel","rollback","--json"]).rc).toBe(1);expect((await client.query("SELECT from_id FROM kb_links WHERE from_id=$1 AND to_id=$2 AND rel='rollback'",[b,a])).rows).toEqual([]);}
    finally{await client.query("DROP TRIGGER b8_kblink_abort ON events");await client.query("DROP FUNCTION b8_kblink_abort()");}
  });
});
