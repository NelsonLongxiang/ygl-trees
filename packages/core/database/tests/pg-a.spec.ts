/** 0.89 (PG-A 单5): schema v10 — events.seq + schema_migrations ledger on
 *  both backends + orm dialect seam + FTS5 shadow gating. SQLite zero
 *  regression is the acceptance bar; PG-side behavior proved by probe/smoke. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB, SCHEMA_VERSION } from "../src/db";
import { getOrm, closeOrm, ormDialect } from "../src/orm";

let db: DB;
let dir: string;

beforeAll(() => {
  dir = path.join(process.cwd(), "tmp", `pg-a-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  db = new DB(path.join(dir, "t.db"));
});

afterAll(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("schema v10 (PG-A 地基)", () => {
  it("user_version = SCHEMA_VERSION（10）；schema_migrations 有 sqlite 当前行", () => {
    const v = db.get("PRAGMA user_version") as any;
    expect(v.user_version).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(10);
    const row = db.get("SELECT backend, version FROM schema_migrations WHERE backend='sqlite'") as any;
    expect(row.version).toBe(SCHEMA_VERSION);
    // replay-safe: one row per version (INSERT OR IGNORE)
    db.run("INSERT OR IGNORE INTO schema_migrations(backend,version,applied_at) VALUES('sqlite',?,?)", [SCHEMA_VERSION, "x"]);
    expect((db.get("SELECT COUNT(*) n FROM schema_migrations WHERE backend='sqlite'") as any).n).toBe(1);
  });

  it("events.seq 列存在且 SQLite 侧可空（rowid 是原生序）", () => {
    const has = db.get("SELECT 1 AS hit FROM pragma_table_info('events') WHERE name='seq'");
    expect(!!has).toBe(true);
    db.run("INSERT INTO events(id,ts,actor,kind) VALUES('v10probe','t','t','t')");
    const row = db.get("SELECT seq FROM events WHERE id='v10probe'") as any;
    expect(row.seq === null || row.seq === undefined).toBe(true);
  });

  it("ormDialect: sqlite 连接报 sqlite；getOrm 幂等", async () => {
    const ds = await getOrm(db.path!);
    expect(ormDialect(ds)).toBe("sqlite");
    const ds2 = await getOrm(db.path!);
    expect(ds2).toBe(ds);
    // FTS gating contract: same dialect check the write path performs
    expect(ormDialect({ connection: { options: { type: "postgres" } } })).toBe("postgres");
    expect(ormDialect(undefined)).toBe("other");
    await closeOrm();
  });

  it("v9 库开箱升级：老 events 表（无 seq）加列不炸", () => {
    // simulate a v9-shaped db: fresh db minus seq column
    const d2 = path.join(dir, "v9.db");
    const db2 = new DB(d2); // v10 schema
    db2.exec("CREATE TABLE events_v9 AS SELECT id,ts,actor,kind,entity,entity_id,payload,level FROM events");
    db2.exec("DROP TABLE events; ALTER TABLE events_v9 RENAME TO events");
    db2.exec("PRAGMA user_version=9");
    db2.close();
    // reopening triggers migrate(): upgrade9to10 adds seq
    const db3 = new DB(d2);
    const has = db3.get("SELECT 1 AS hit FROM pragma_table_info('events') WHERE name='seq'");
    expect(!!has).toBe(true);
    const v = db3.get("PRAGMA user_version") as any;
    expect(v.user_version).toBe(SCHEMA_VERSION);
    db3.close();
  });
});
