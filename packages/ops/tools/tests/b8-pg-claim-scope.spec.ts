import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DB } from "../../../core/database/src/db";
import { pgTargetHash } from "../../../core/database/src/pg-workspace";
import { createWorkspaceOrm } from "../../../../apps/cli/src/workspace-orm";
import { claimAdd } from "../../../research/pipeline/src/writes";
import { migrateToPg, syncToPg, upgradePgSchema } from "../src/pgsync";
const repo = resolve(__dirname, "../../../.."), bin = join(repo, "dist/bundle/bin.cjs"), adminUrl = process.env.B8_TEST_PG_ADMIN_URL || "";
let root = "", admin: any; const names: string[] = [];
async function database(tag: string) {
  const name = "scope16_" + tag + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  await admin.query('CREATE DATABASE "' + name + '"'); names.push(name); const u = new URL(adminUrl); u.pathname = "/" + name; return u.toString();
}
async function client<T>(url: string, work: (c: any) => Promise<T>) { const { Client } = require("pg"); const c = new Client({ connectionString: url }); await c.connect(); try { return await work(c); } finally { await c.end(); } }
function cli(url: string, home: string, args: string[], rc = 0) {
  const p = spawnSync(process.execPath, [bin, ...args, "--json"], { cwd: repo, encoding: "utf8", timeout: 60000,
    env: { ...process.env, YGL_HOME: home, YGL_DB_URL: url, YGL_PG_URL: "", YGL_PROJECT: "", YGL_SESSION: "claim-scope-pg", YGL_NO_UPDATE_CHECK: "1", YGL_EVAL_OFFLINE: "1" } });
  expect(p.error).toBeUndefined(); expect(p.signal).toBeNull(); expect(p.status, (p.stdout + p.stderr).replaceAll(new URL(adminUrl).password, "[redacted]")).toBe(rc); return JSON.parse(p.stdout);
}
describe.skipIf(!adminUrl)("B8 claims.scope v16 real PG", () => {
  beforeAll(async () => {
    const target = new URL(adminUrl); if (!["127.0.0.1", "[::1]"].includes(target.hostname) || target.pathname !== "/postgres" || !target.port || target.search) throw new Error("isolated numeric-loopback PG admin required");
    mkdirSync(join(repo, "tmp"), { recursive: true }); root = mkdtempSync(join(repo, "tmp/b8-claim-scope-"));
    const { Client } = require("pg"); admin = new Client({ connectionString: adminUrl }); await admin.connect(); vi.stubEnv("YGL_SESSION", "claim-scope-pg");
  });
  afterAll(async () => { if (admin) { for (const name of names) await admin.query('DROP DATABASE IF EXISTS "' + name + '"'); await admin.end(); } vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  it("upgrades a populated v15 target to v16 and leaves old claims and events intact", async () => {
    const url = await database("upgrade"), seed = new DB(join(root, "upgrade.sqlite"), { managed: true });
    try { seed.run("INSERT INTO projects(id,name,created,updated) VALUES('p','p','old','old')"); seed.run("INSERT INTO claims(id,project_id,text,content_hash,created,updated) VALUES('legacy','p','legacy','h','old','old')"); await migrateToPg(seed, url); } finally { seed.closeStrict(); }
    await client(url, async c => {
      await c.query("ALTER TABLE claims DROP COLUMN scope; DELETE FROM schema_migrations WHERE version>15; INSERT INTO schema_migrations(backend,version,applied_at,note) VALUES('postgres',15,'old','baseline') ON CONFLICT DO NOTHING");
      const before = (await c.query("SELECT * FROM claims")).rows;
      expect(await upgradePgSchema(c, 16)).toMatchObject({ from: 15, to: 16, steps: [16], duplicate: false });
      const rows = (await c.query("SELECT * FROM claims")).rows; expect(rows.map(({ scope, ...r }: any) => r)).toEqual(before); expect(rows[0].scope).toBe("");
      expect(await upgradePgSchema(c, 16)).toMatchObject({ steps: [], duplicate: true });
      expect((await c.query("SELECT is_nullable,column_default FROM information_schema.columns WHERE table_name='claims' AND column_name='scope'")).rows[0]).toMatchObject({ is_nullable: "NO", column_default: "''::text" });
    });
  });
  it("sync preserves empty and named grants and upgrades an existing v15 mirror column", async () => {
    const url = await database("mirror"), seed = new DB(join(root, "mirror.sqlite"), { managed: true });
    try {
      seed.run("INSERT INTO projects(id,name,created,updated) VALUES('p','p','old','old')");
      for (const [id, scope] of [["a", ""], ["b", "dept:ops"]]) seed.run("INSERT INTO claims(id,project_id,text,content_hash,scope,created,updated) VALUES(?,'p',?,?,?,'old','old')", [id, id, id, scope]);
      await syncToPg(seed, url, ["projects", "claims", "schema_migrations"]);
      await client(url, c => c.query("ALTER TABLE claims DROP COLUMN scope"));
      await syncToPg(seed, url, ["projects", "claims", "schema_migrations"]);
      expect(await client(url, async c => (await c.query("SELECT id,scope FROM claims ORDER BY id")).rows)).toEqual(seed.all("SELECT id,scope FROM claims ORDER BY id"));
    } finally { seed.closeStrict(); }
  });
  it("the actual PG CLI matches SQLite scope receipts, conflicts and rescope events", async () => {
    const url = await database("cli"), seedHome = join(root, "sqlite"), pgHome = join(root, "pg");
    cli("", seedHome, ["db", "init"]); cli("", seedHome, ["project", "new", "scope-p"]);
    const seed = new DB(join(seedHome, "ygl-trees.db"), { managed: true }); try { await migrateToPg(seed, url); } finally { seed.closeStrict(); }
    const sqlite = cli("", seedHome, ["research", "claim", "add", "same ruling", "--scope=dept:ops"]);
    const pg = cli(url, pgHome, ["research", "claim", "add", "same ruling", "--scope=dept:ops"]); expect(pg.scope).toBe(sqlite.scope);
    expect(cli(url, pgHome, ["research", "claim", "add", "same ruling", "--scope=dept:ops"])).toMatchObject({ id: pg.id, duplicate: true });
    expect(cli(url, pgHome, ["research", "claim", "add", "same ruling", "--scope=*"], 1).error).toContain("rescope " + pg.id);
    expect(cli(url, pgHome, ["research", "claim", "show", pg.id]).scope).toBe("dept:ops");
    expect(cli(url, pgHome, ["research", "claim", "list"])[0].scope).toBe("dept:ops");
    expect(cli(url, pgHome, ["research", "claim", "rescope", pg.id, "--scope=bench:x"]).scope).toBe("bench:x");
    expect(cli(url, pgHome, ["research", "claim", "rescope", pg.id, "--scope=bench:x"])).toMatchObject({ duplicate: true });
    const events = await client(url, async c => (await c.query("SELECT payload FROM events WHERE kind='claim.rescope' AND entity_id=$1", [pg.id])).rows); expect(events).toHaveLength(1); expect(JSON.parse(events[0].payload)).toMatchObject({ old_scope: "dept:ops", new_scope: "bench:x" });
    expect(existsSync(join(pgHome, "ygl-trees.db"))).toBe(false);
  });
  it("serializes different-scope concurrent adds through one transaction key", async () => {
    const url = await database("race"), seed = new DB(join(root, "race.sqlite"), { managed: true });
    try { seed.run("INSERT INTO projects(id,name,created,updated) VALUES('p','p','old','old')"); await migrateToPg(seed, url); } finally { seed.closeStrict(); }
    await client(url, c => c.query("INSERT INTO meta(key,value) VALUES('backend_binding',$1)", [JSON.stringify({ mode: "pg", url_hash: pgTargetHash(url) })]));
    const a = createWorkspaceOrm({ dialect: "postgres", url }), b = createWorkspaceOrm({ dialect: "postgres", url });
    try {
      const dsa = await a.getPgOrm(url), dsb = await b.getPgOrm(url);
      let release!: () => void, held!: () => void, attempted!: () => void;
      const continueFirst = new Promise<void>(r => { release = r; }), firstHeld = new Promise<void>(r => { held = r; });
      const secondAtLock = new Promise<void>(r => { attempted = r; });
      const pending: Promise<any>[] = [];
      const wrapped = (ds: any, first: boolean) => ({ transaction: (fn: any) => ds.transaction((mgr: any) => fn(new Proxy(mgr, {
        get(target, key) {
          if (key === "query") return async (sql: string, params: any[]) => {
            if (sql.includes("pg_advisory_xact_lock")) {
              if (!first) attempted();
              const rows = await target.query(sql, params);
              if (first) { held(); await continueFirst; }
              return rows;
            }
            return target.query(sql, params);
          };
          const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
        },
      }))) });
      try {
        const first = claimAdd(wrapped(dsa, true) as any, "p", "race ruling", "B", false, "", "dept:a");
        pending.push(first); first.catch(() => {});
        await Promise.race([firstHeld, first.then(() => { throw new Error("first transaction ended before lock barrier"); })]);
        const second = claimAdd(wrapped(dsb, false) as any, "p", "race ruling", "B", false, "", "dept:b");
        pending.push(second); const observed = second.catch(error => error);
        await Promise.race([secondAtLock, second.then(() => { throw new Error("second transaction ended before lock attempt"); })]);
        release();
        expect((await first).dup).toBe(false); expect(await observed).toMatchObject({ rc: 1, message: expect.stringContaining("rescope") });
      } finally { release(); await Promise.allSettled(pending); }
      expect(await client(url, async c => (await c.query("SELECT scope FROM claims")).rows)).toEqual([{ scope: "dept:a" }]);
    } finally { await a.close(); await b.close(); }
  });
});
