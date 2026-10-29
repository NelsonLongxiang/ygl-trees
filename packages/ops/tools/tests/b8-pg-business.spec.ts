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

// These always register even without a configured server.
describe("B8 PG primitives", () => {
  it("duplicate lookup numbers placeholders independently of INSERT", () => {
    const sql = upsertSql({ table: "projects", cols: ["id", "name"], values: ["p", "x"], conflictCols: ["name"] }, { ph: i => "$" + (i + 1) });
    expect(sql.selectSql).toBe("SELECT * FROM projects WHERE name = $1");
  });
  it("target hash excludes credentials but rejects destination overrides", () => {
    expect(pgTargetHash("postgres://u:secret@localhost/db?password=other")).toBe(pgTargetHash("postgresql://localhost:5432/db"));
    expect(() => pgTargetHash("postgres://localhost/db?host=other")).toThrow(/overrides/);
    expect(() => pgTargetHash("postgres://localhost/db?dbname=other")).toThrow(/overrides/);
  });
  it("a PG-bound home refuses missing/mismatched env and SQLite target", () => {
    const d = mkdtempSync(join(ROOT, "tmp/b8-binding-"));
    try {
      writeFileSync(join(d, "pg-binding.json"), JSON.stringify({ mode: "pg", url_hash: pgTargetHash("postgres://localhost/a") }));
      expect(() => checkPgWorkspace(d, "")).toThrow(/conflicts/);
      expect(() => checkPgWorkspace(d, "postgres://localhost/b")).toThrow(/conflicts/);
      writeFileSync(join(d, "sqlite.db"), "existing");
      expect(() => checkPgWorkspace(d, "postgres://localhost/a", join(d, "sqlite.db"))).toThrow(/SQLite/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe.skipIf(!adminUrl)("B8 real PG CLI (isolated database)", () => {
  beforeAll(async () => {
    const { Client } = require("pg");
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    dir = mkdtempSync(join(ROOT, "tmp/b8-pg-")); home = join(dir, "home");
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

  it("project new writes PG, reads back, selects only the caller session, never creates SQLite", async () => {
    const a = cli(["project", "new", "alpha", "-q", "PG only", "--json"]);
    expect(a.rc, a.text).toBe(0);
    const p = JSON.parse(a.out); expect(p.session).toBe("b8-a");
    expect((await client.query("SELECT name FROM projects WHERE id=$1", [p.id])).rows[0].name).toBe("alpha");
    const show = cli(["project", "show", "--json"]);
    expect(show.rc, show.text).toBe(0); expect(JSON.parse(show.out).project.id).toBe(p.id);
    expect(readdirSync(home)).toEqual(["pg-binding.json"]);
    expect(existsSync(join(home, "ygl-trees.db"))).toBe(false);
  });
  it("kb add updates ngram/generated search + events in the same write and reads back via CLI", async () => {
    const a = cli(["kb", "add", "--title", "知识 B8", "--body", "atomic 中文", "--json"]);
    expect(a.rc, a.text).toBe(0); const row = JSON.parse(a.out); expect(row.verified).toBe(true);
    const pg = (await client.query("SELECT ngram,ngram_tsv FROM kb_notes WHERE id=$1", [row.id])).rows[0];
    expect(pg.ngram).toContain("atomic"); expect(pg.ngram_tsv).toContain("atomic");
    expect((await client.query("SELECT COUNT(*)::int AS n FROM events WHERE kind='kb.add' AND entity_id=$1", [row.id])).rows[0].n).toBe(1);
    const show = cli(["kb", "show", row.id, "--json"]);
    expect(show.rc, show.text).toBe(0); expect(JSON.parse(show.out).body).toBe("atomic 中文");
    const dup = cli(["kb", "add", "--title", "知识 B8", "--body", "atomic 中文", "--json"]);
    expect(dup.rc, dup.text).toBe(0); expect(JSON.parse(dup.out).duplicate).toBe(true);
  });
  it("kb --force retains separate copies while ordinary writes remain idempotent", async () => {
    for (let i=0; i<2; i++) {
      const r=cli(["kb","add","--title","forced","--body","same","--force","--json"]);
      expect(r.rc,r.text).toBe(0); expect(JSON.parse(r.out).duplicate).not.toBe(true);
    }
    expect((await client.query("SELECT COUNT(*)::int AS n FROM kb_notes WHERE title='forced'")).rows[0].n).toBe(2);
  });
  it("six concurrent same-content kb writes: one creator, remaining duplicate rc0", async () => {
    const runs = await Promise.all(Array.from({length: 6}, (_, i) => concurrent(["kb", "add", "--title", "race", "--body", "one-row", "--json"], "kb-race-" + i)));
    for (const r of runs) expect(r.rc, r.out + r.err).toBe(0);
    expect(runs.filter(r => !JSON.parse(r.out).duplicate)).toHaveLength(1);
    expect((await client.query("SELECT COUNT(*)::int AS n FROM kb_notes WHERE title='race'")).rows[0].n).toBe(1);
  });
  it("six concurrent project new calls: one row, duplicate receipts and isolated selection keys", async () => {
    const runs = await Promise.all(Array.from({length: 6}, (_, i) => concurrent(["project", "new", "race-project", "--json"], "project-race-" + i)));
    for (const r of runs) expect(r.rc, r.out + r.err).toBe(0);
    expect(runs.filter(r => !JSON.parse(r.out).duplicate)).toHaveLength(1);
    expect((await client.query("SELECT COUNT(*)::int AS n FROM projects WHERE name='race-project'")).rows[0].n).toBe(1);
    const second = cli(["project", "new", "beta", "--json"], {YGL_SESSION: "b8-b"}); expect(second.rc, second.text).toBe(0);
    expect(JSON.parse(cli(["project", "show", "--json"]).out).project.name).toBe("alpha");
    expect(JSON.parse(cli(["project", "show", "--json"], {YGL_SESSION: "b8-b"}).out).project.name).toBe("beta");
  });
  it("event failure rolls back kb row/search input and project row/session selection", async () => {
    await client.query("CREATE FUNCTION b8_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind IN ('kb.add','project.create') THEN RAISE EXCEPTION 'injected event failure'; END IF; RETURN NEW; END $$");
    await client.query("CREATE TRIGGER b8_fail BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION b8_fail_event()");
    try {
      const kb = cli(["kb", "add", "--title", "rolled-back", "--body", "x", "--json"]); expect(kb.rc).toBe(1);
      const project = cli(["project", "new", "rolled-back-project", "--json"]); expect(project.rc).toBe(1);
      expect((await client.query("SELECT COUNT(*)::int AS n FROM kb_notes WHERE title='rolled-back'")).rows[0].n).toBe(0);
      expect((await client.query("SELECT COUNT(*)::int AS n FROM projects WHERE name='rolled-back-project'")).rows[0].n).toBe(0);
      expect((await client.query("SELECT value FROM meta WHERE key='current_project@b8-a'")).rows[0].value).toBe("alpha");
    } finally { await client.query("DROP TRIGGER b8_fail ON events"); await client.query("DROP FUNCTION b8_fail_event()"); }
  });
  it("unreachable server, missing session, env/argv conflicts all refuse without fallback or leaking query credentials", () => {
    const secret = "b8-secret-probe";
    const dead = "postgres://127.0.0.1:1/none?user=u&password=" + secret;
    const a = cli(["kb", "add", "--title", "x", "--body", "x", "--json"], {YGL_HOME: join(dir,"dead-home"), YGL_DB_URL: dead});
    expect(a.rc).toBe(1); expect(a.text).not.toContain(secret); expect(existsSync(join(dir,"dead-home/ygl-trees.db"))).toBe(false);
    expect(cli(["project", "new", "nosid", "--json"], {YGL_SESSION: "", DSH_SESSION_ID: ""}).rc).toBe(2);
    expect(cli(["kb", "add", "--title", "x", "--body", "x", "--db", "other.db", "--json"]).rc).toBe(2);
    expect(cli(["kb", "add", "--title", "x", "--body", "x", "--db", dead, "--db", "other.db", "--json"]).rc).toBe(2);
    expect(cli(["project", "new", "x", "--json"], {YGL_DB_URL: ""}).rc).toBe(2); // sticky PG-bound home
    expect(cli(["project", "new", "x", "--json"], {YGL_DB_URL: target.replace(dbName,"other_db")}).rc).toBe(2);
    expect(cli(["kb", "add", "--title", "x", "--body", "x", "--json"], {YGL_DB_URL: "not-a-pg-url"}).rc).toBe(2);
  });
  it("fresh home binding publication is race-safe under concurrent CLI processes", async () => {
    const oldHome = home; home = join(dir, "fresh-race-home");
    try {
      const results = await Promise.all(Array.from({length:4}, (_,i) => concurrent(["project", "new", "fresh-race", "--json"], "fresh-race-"+i)));
      for (const r of results) expect(r.rc, r.out + r.err).toBe(0);
      expect(JSON.parse(readFileSync(join(home,"pg-binding.json"),"utf8")).mode).toBe("pg");
      expect(readdirSync(home)).toEqual(["pg-binding.json"]);
    } finally { home = oldHome; }
  });
  it("database binding mismatch refuses business writes without creating any business row", async () => {
    const original=(await client.query("SELECT value FROM meta WHERE key='backend_binding'")).rows[0].value;
    await client.query("UPDATE meta SET value=$1 WHERE key='backend_binding'",[JSON.stringify({mode:"pg",url_hash:"wrong-target"})]);
    try {
      const r=cli(["project","new","binding-must-refuse","--json"]);
      expect(r.rc).toBe(1);
      expect((await client.query("SELECT COUNT(*)::int AS n FROM projects WHERE name='binding-must-refuse'")).rows[0].n).toBe(0);
    } finally { await client.query("UPDATE meta SET value=$1 WHERE key='backend_binding'",[original]); }
  });
  it("list/show are read-only: a fresh unbound readback home stays absent", () => {
    const readerHome=join(dir,"reader-no-files");
    const r=cli(["kb","list","--json"],{YGL_HOME:readerHome});
    expect(r.rc,r.text).toBe(0); expect(Array.isArray(JSON.parse(r.out))).toBe(true);
    expect(existsSync(readerHome)).toBe(false);
  });
  it("existing SQLite workspace conflicts with PG business target without touching the SQLite bytes", () => {
    const h=join(dir,"sqlite-conflict"); mkdirSync(h);
    const file=join(h,"ygl-trees.db"); writeFileSync(file,"sentinel-SQLite-bytes");
    const r=cli(["project","new","must-refuse-sqlite","--json"],{YGL_HOME:h});
    expect(r.rc).toBe(2); expect(readFileSync(file,"utf8")).toBe("sentinel-SQLite-bytes");
    expect(existsSync(join(h,"pg-binding.json"))).toBe(false);
  });
  it("doctor bound PG checks pass; SQLite-only/verify-on-PG checks explicitly skip", () => {
    const r = cli(["doctor", "--json"]); expect(r.rc, r.text).toBe(0);
    const checks = JSON.parse(r.out); expect(checks.filter((c:any) => c.status === "fail" || c.status === "warn")).toEqual([]);
    expect(checks.find((c:any) => c.name === "backend_binding").status).toBe("pass");
    expect(checks.find((c:any) => c.name === "verify_on_pg").status).toBe("skip");
  });
});
