/**
 * #176 W5b real-PG replay. Supply an isolated admin URL: the suite creates/drops its own random databases.
 * Baseline = fixtures/pg-baseline-v12.sql (the PG schema exactly as 0.119.0 migrated it). `db upgrade` must
 * bring it to the same structure as a fresh `db migrate pg`, be idempotent, and the business face must refuse
 * a PG schema whose ledger version differs from this engine's SCHEMA_VERSION.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DB, SCHEMA_VERSION } from "../../../core/database/src/db";
import { migrateToPg, PG_BASELINE_VERSION } from "../src/pgsync";

const ROOT = resolve(__dirname, "../../../..");
const BIN = join(ROOT, "dist/bundle/bin.cjs");
const adminUrl = process.env.B8_TEST_PG_ADMIN_URL || "";
const BASELINE = readFileSync(join(__dirname, "fixtures/pg-baseline-v12.sql"), "utf8");
let dir = "", admin: any;
const dbs: string[] = [];

const cleanEnv = () => {
  const env = { ...process.env };
  for (const key of ["YGL_DB_URL", "YGL_PG_URL", "YGL_PROJECT", "YGL_SESSION", "DSH_SESSION_ID", "NODE_OPTIONS"]) delete env[key];
  return env;
};
async function newDb(tag: string): Promise<string> {
  const name = "b8_up_" + tag + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  await admin.query('CREATE DATABASE "' + name + '"');
  dbs.push(name);
  const u = new URL(adminUrl); u.pathname = "/" + name; return u.toString();
}
async function withClient<T>(url: string, fn: (c: any) => Promise<T>): Promise<T> {
  const { Client } = require("pg");
  const c = new Client({ connectionString: url }); await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
function cli(url: string, home: string, args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 30000,
    env: { ...cleanEnv(), YGL_HOME: home, YGL_DB_URL: url, YGL_SESSION: "b8-upgrade", YGL_NO_UPDATE_CHECK: "1" },
  });
  const text = (r.stdout || "") + (r.stderr || "");
  expect(text).not.toContain(new URL(adminUrl).password); // credentials never reach output
  return { rc: r.status, out: r.stdout || "", text };
}
/** Structural fingerprint from the catalog: columns, constraints and indexes, names normalised where PG generates them. */
async function structure(url: string) {
  return withClient(url, async (c) => {
    const cols = (await c.query(`SELECT table_name, column_name, data_type, is_nullable, column_default, is_generated
      FROM information_schema.columns WHERE table_schema=current_schema() ORDER BY table_name, column_name`)).rows;
    const cons = (await c.query(`SELECT conrelid::regclass::text AS tbl, contype, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE connamespace=current_schema()::regnamespace ORDER BY 1, 2, 3`)).rows;
    const idx = (await c.query(`SELECT tablename, regexp_replace(indexdef, '^CREATE (UNIQUE )?INDEX \\S+ ON ', 'CREATE \\1INDEX ON ') AS def
      FROM pg_indexes WHERE schemaname=current_schema() ORDER BY 1, 2`)).rows;
    return { cols, cons, idx };
  });
}

describe.skipIf(!adminUrl)("#176 W5b PG upgrade replay (real PG)", () => {
  let baseline = "", fresh = "", home = "";
  beforeAll(async () => {
    const { Client } = require("pg");
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    dir = mkdtempSync(join(ROOT, "tmp/b8-pg-upgrade-")); home = join(dir, "home");
    admin = new Client({ connectionString: adminUrl }); await admin.connect();
    baseline = await newDb("base");
    await withClient(baseline, (c) => c.query(BASELINE));
    fresh = await newDb("fresh");
    const seed = new DB(join(dir, "seed.sqlite"), { lock: false });
    try { await migrateToPg(seed, fresh); } finally { seed.close(); }
  }, 90000);
  afterAll(async () => {
    if (admin) { for (const n of dbs) await admin.query('DROP DATABASE IF EXISTS "' + n + '" WITH (FORCE)'); await admin.end(); }
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("the frozen baseline is the oldest supported PG schema", async () => {
    const v = await withClient(baseline, (c) => c.query("SELECT MAX(version)::int AS v FROM schema_migrations WHERE backend='postgres'"));
    expect(v.rows[0].v).toBe(PG_BASELINE_VERSION);
  });

  it("db upgrade replays baseline → current and matches a fresh migration exactly", async () => {
    const r = cli(baseline, home, ["db", "upgrade", "--json"]);
    expect(r.rc, r.text).toBe(0);
    const res = JSON.parse(r.out);
    expect(res).toMatchObject({ from: PG_BASELINE_VERSION, to: SCHEMA_VERSION, duplicate: false });
    expect(res.indexes_created).toContain("idx_events_kind_entity");
    expect(await structure(baseline)).toEqual(await structure(fresh));
    const v = await withClient(baseline, (c) => c.query("SELECT MAX(version)::int AS v FROM schema_migrations WHERE backend='postgres'"));
    expect(v.rows[0].v).toBe(SCHEMA_VERSION);
  }, 60000);

  it("is idempotent: a second run reports duplicate and changes nothing", async () => {
    const before = await structure(baseline);
    const r = cli(baseline, home, ["db", "upgrade", "--json"]);
    expect(r.rc, r.text).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ steps: [], indexes_created: [], duplicate: true });
    expect(await structure(baseline)).toEqual(before);
  }, 60000);

  it("the business face refuses an older or newer PG schema with no changes, and works at the current version", async () => {
    const target = await newDb("guard");
    const seed = new DB(join(dir, "seed-guard.sqlite"), { lock: false });
    try { await migrateToPg(seed, target); } finally { seed.close(); }
    const guardHome = join(dir, "guard-home");
    await withClient(target, (c) => c.query("INSERT INTO schema_migrations(backend,version,applied_at,note) VALUES('postgres',$1,'x','test: newer')", [SCHEMA_VERSION + 1]));
    const newer = cli(target, guardHome, ["project", "new", "w5b-newer", "--json"]);
    expect(newer.rc).toBe(1);
    expect(JSON.parse(newer.out).error).toMatch(/newer than this engine/);
    await withClient(target, (c) => c.query("DELETE FROM schema_migrations WHERE backend='postgres'"));
    await withClient(target, (c) => c.query("INSERT INTO schema_migrations(backend,version,applied_at,note) VALUES('postgres',$1,'x','test: older')", [SCHEMA_VERSION - 1]));
    const older = cli(target, guardHome, ["project", "new", "w5b-older", "--json"]);
    expect(older.rc).toBe(1);
    expect(JSON.parse(older.out).error).toMatch(/db upgrade/);
    const projects = await withClient(target, (c) => c.query("SELECT count(*)::int AS n FROM projects WHERE name LIKE 'w5b-%'"));
    expect(projects.rows[0].n).toBe(0);
    await withClient(target, (c) => c.query("INSERT INTO schema_migrations(backend,version,applied_at,note) VALUES('postgres',$1,'x','test: current')", [SCHEMA_VERSION]));
    const ok = cli(target, guardHome, ["project", "new", "w5b-current", "--json"]);
    expect(ok.rc, ok.text).toBe(0);
  }, 90000);
});
