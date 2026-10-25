/**
 * AsyncDB — the async data-access layer for B1 read-path migration (PG plan).
 *
 * B1 goal: every read path works against an async interface so PG can slot in
 * later without touching call sites again. The SQLite implementation wraps
 * the existing sync `DB` in zero-cost `Promise.resolve()` — no behavioral
 * change, byte-identical output (golden reconciliation).
 *
 * The PG implementation (B2/B3) will implement the same interface with the
 * `pg` client. Write paths stay on the transactional services (conventions §五)
 * and are NOT converted here.
 *
 * @module @ygl/core/database/asyncdb
 */
import type { DB } from "./db";

export interface AsyncDb {
  /** Single-row read; null when no match (same contract as DB.get). */
  get(sql: string, params?: unknown[]): Promise<Record<string, any> | null>;
  /** Multi-row read; empty array when no match (same contract as DB.all). */
  all(sql: string, params?: unknown[]): Promise<Record<string, any>[]>;
}

/** SQLite adapter: wraps the sync DB in Promises (zero overhead — the
 *  underlying call is still synchronous, microtask hop only). */
export class SqliteAsyncDb implements AsyncDb {
  constructor(private readonly db: DB) {}

  async get(sql: string, params: unknown[] = []): Promise<Record<string, any> | null> {
    return this.db.get(sql, params);
  }

  async all(sql: string, params: unknown[] = []): Promise<Record<string, any>[]> {
    return this.db.all(sql, params);
  }
}

/** Factory: create the async adapter for the current workspace DB.
 *  PG mode (B2+) will return a PgAsyncDb here instead — same interface. */
export function getAsyncDb(db: DB): AsyncDb {
  return new SqliteAsyncDb(db);
}
