/**
 * Lazy TypeORM DataSource over the SAME SQLite file the CLI works on.
 *
 * Boundaries (see docs/plan.md "TypeORM boundaries"):
 *  - `synchronize` is permanently false — schema authority stays with
 *    SCHEMA_SQL + PRAGMA user_version migrations in src/db.ts. Entities in
 *    src/entities/ are a typed snapshot; change them in the same commit as
 *    SCHEMA_SQL.
 *  - TypeORM is a QUERY layer here, not a migration layer. FTS5 MATCH /
 *    bm25 loops, PRAGMA paths and the PG sync/migrate machinery stay raw
 *    SQL on the DB class.
 *  - CLI commands using the ORM must return a Promise (main() awaits) so
 *    the DataSource settles before the wasm DB closes.
 */
import "reflect-metadata";
import { DataSource } from "typeorm";
import { RESEARCH_ENTITIES } from "../../../research/pipeline/src/entities";
import { CORE_ENTITIES } from "./entities";
import { ormState } from "./db";

let cached: { file: string; ds: DataSource } | null = null;
let pgCached: { url: string; ds: DataSource } | null = null;

export async function getOrm(dbFile: string): Promise<DataSource> {
  if (cached && cached.file === dbFile) return cached.ds;
  // Batch-16: a second connection opening while a concurrent writer holds the
  // SQLite lock fails at initialize() ("database is locked") before any PRAGMA
  // can help. Bounded retry with jitter — high-concurrency imports (several
  // CLI workers) should queue, not fail; the lock is released in ms.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const ds = new DataSource({
      type: "better-sqlite3",
      database: dbFile,
      synchronize: false, // NEVER — migrations live on the user_version track
      entities: [...RESEARCH_ENTITIES, ...CORE_ENTITIES],
    });
    try {
      await ds.initialize();
      // synchronous is per-connection (WAL is sticky in the file, this is not):
      // keep the ORM's better-sqlite3 connection on the same WAL+NORMAL policy
      // as the wasm DB — per-commit fsync otherwise dominates write latency.
      await ds.query("PRAGMA synchronous=NORMAL");
      await ds.query("PRAGMA busy_timeout=10000");
      cached = { file: dbFile, ds };
      ormState.opened = true; // 0.87: lets plugin.ts stop() know without importing typeorm
      return ds;
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      // #54: typeorm's optional peer can lose the driver during npm upgrades
      // (peer ^12 vs our ^13 used to split the tree) — name the fix instead of
      // the bare "SQLite package has not been found".
      if (/SQLite package has not been found/i.test(msg)) {
        throw new Error(
          `ORM driver missing: typeorm cannot resolve better-sqlite3 (${msg}).
` +
            `  fix: npm dedupe  (or rm -rf node_modules && npm install) so better-sqlite3@^12 is installed once;
` +
            `  see the 0.114.14 upgrade note in CHANGELOG.md`
        );
      }
      if (attempt === 5 || !/database is locked|SQLITE_BUSY/i.test(msg)) throw e;
      try { await ds.destroy(); } catch { /* connection never opened */ }
      await new Promise((r) => setTimeout(r, 50 * 2 ** attempt + Math.random() * 80));
    }
  }
  throw lastErr;
}

/** Same entity registry over the single PG backend. Schema is explicitly migrated, never synchronized. */
export async function getPgOrm(url: string): Promise<DataSource> {
  if (pgCached && pgCached.url === url) return pgCached.ds;
  if (pgCached) { await pgCached.ds.destroy(); pgCached = null; }
  const ds = new DataSource({
    type: "postgres",
    url,
    synchronize: false, // NEVER — schema authority is SCHEMA_SQL / MIGRATE_DDL
    entities: [...RESEARCH_ENTITIES, ...CORE_ENTITIES],
    connectTimeoutMS: 4000,
  });
  try { await ds.initialize(); }
  catch (e) { if (ds.isInitialized) await ds.destroy(); throw e; }
  pgCached = { url, ds };
  ormState.opened = true;
  return ds;
}

/** Dialect of the connection a manager belongs to (FTS5 gating, PG-A ②). */
export function ormDialect(dsOrMgr: any): "sqlite" | "postgres" | "other" {
  const opts = dsOrMgr?.connection?.options ?? dsOrMgr?.options;
  const t = String(opts?.type ?? "");
  if (t === "better-sqlite3" || t === "sqlite") return "sqlite";
  if (t === "postgres") return "postgres";
  return "other";
}

/** Destroy the cached DataSource(s) (tests/scratch dirs cannot be removed on
 *  Windows while a better-sqlite3 handle keeps the file open — EPERM). */
export async function closeOrm(): Promise<void> {
  if (cached) {
    try {
      await cached.ds.destroy();
    } catch {
      /* best effort */
    }
    cached = null;
  }
  if (pgCached) {
    try {
      await pgCached.ds.destroy();
    } catch {
      /* best effort */
    }
    pgCached = null;
  }
}
