/**
 * AsyncTreeStore — B1 first-batch async read facade (PG plan).
 *
 * Wraps the sync TreeStore read methods with async signatures, backed by
 * the AsyncDb interface. SQLite is zero-cost (Promise.resolve wrap); PG
 * (B2/B3) implements the same AsyncDb without touching call sites.
 *
 * Write paths stay on TreeStore/writes.ts (transactional services) —
 * conventions §五 boundary unchanged.
 *
 * @module @ygl/techtree-model/async-store
 */
import { DB } from "../../../core/database/src/db";
import { AsyncDb, SqliteAsyncDb, getAsyncDb } from "../../../core/database/src/asyncdb";
import { TreeStore, Row } from "./reads";

export class AsyncTreeStore {
  private readonly sync: TreeStore;
  private readonly adb: AsyncDb;

  constructor(db: DB) {
    this.sync = new TreeStore(db);
    this.adb = getAsyncDb(db);
  }

  // ================================================================ trees

  async treeByName(name: string): Promise<Row | null> {
    return this.sync.treeByName(name);
  }

  async treeResolve(name?: string): Promise<Row> {
    return this.sync.treeResolve(name);
  }

  async trees(): Promise<Row[]> {
    return this.adb.all("SELECT * FROM trees ORDER BY created");
  }

  // ================================================================ nodes

  async nodesOfTree(treeId: string): Promise<Row[]> {
    return this.adb.all("SELECT * FROM nodes WHERE tree_id=? ORDER BY created", [treeId]);
  }

  async nodeByKey(treeId: string, key: string): Promise<Row | null> {
    return this.adb.get("SELECT * FROM nodes WHERE tree_id=? AND key=?", [treeId, key]);
  }

  async edgesOf(treeId: string): Promise<Row[]> {
    return this.adb.all("SELECT * FROM node_edges WHERE tree_id=? ORDER BY created", [treeId]);
  }

  async conditionsOf(treeId: string, nodeKey?: string): Promise<Row[]> {
    if (nodeKey) {
      return this.adb.all("SELECT * FROM node_conditions WHERE tree_id=? AND node_key=? ORDER BY created", [treeId, nodeKey]);
    }
    return this.adb.all("SELECT * FROM node_conditions WHERE tree_id=? ORDER BY created", [treeId]);
  }

  // ================================================================ reads (delegate)

  async nodeList(treeId: string, context?: string): Promise<Row[]> {
    return this.sync.nodeList(treeId, context);
  }

  async canUnlock(treeId: string, keyOrId: string, context?: string, state?: Record<string, any>): Promise<unknown> {
    return this.sync.canUnlock(treeId, keyOrId, context, state);
  }

  async ready(treeId: string, context?: string, state?: Record<string, any>): Promise<Row[]> {
    return this.sync.ready(treeId, context, state);
  }

  async exportTree(treeId: string): Promise<unknown> {
    return this.sync.exportTree(treeId);
  }

  // ================================================================ raw async (for new code)

  /** Direct async query — for B1+ new code paths that should not add sync reads. */
  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    return this.adb.all(sql, params);
  }

  /** Direct async single-row — same contract as DB.get. */
  async queryOne(sql: string, params: unknown[] = []): Promise<Row | null> {
    return this.adb.get(sql, params);
  }
}
