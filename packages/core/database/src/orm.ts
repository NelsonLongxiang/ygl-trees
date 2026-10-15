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

let cached: { file: string; ds: DataSource } | null = null;

export async function getOrm(dbFile: string): Promise<DataSource> {
  if (cached && cached.file === dbFile) return cached.ds;
  const ds = new DataSource({
    type: "better-sqlite3",
    database: dbFile,
    synchronize: false, // NEVER — migrations live on the user_version track
    entities: [...RESEARCH_ENTITIES, ...CORE_ENTITIES],
  });
  await ds.initialize();
  // synchronous is per-connection (WAL is sticky in the file, this is not):
  // keep the ORM's better-sqlite3 connection on the same WAL+NORMAL policy
  // as the wasm DB — per-commit fsync otherwise dominates write latency.
  await ds.query("PRAGMA synchronous=NORMAL");
  cached = { file: dbFile, ds };
  return ds;
}
