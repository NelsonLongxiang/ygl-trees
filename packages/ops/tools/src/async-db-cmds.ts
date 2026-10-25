/**
 * AsyncDbCmds — B1 final-batch async read facade (db-cmds domain).
 *
 * db-cmds reads (stats / timeline / report / dups) go through this facade
 * so the B1 call-site switch is uniform across all four domains. Write/admin
 * paths (init / reset / export / sync / migrate) stay on DB directly —
 * they are construction/migration faces, not agent read paths.
 *
 * @module @ygl/ops-tools/async-db-cmds
 */
import { DB } from "../../../core/database/src/db";
import { AsyncDb, getAsyncDb } from "../../../core/database/src/asyncdb";

export type Row = Record<string, any>;

export class AsyncDbCmds {
  private readonly adb: AsyncDb;

  constructor(db: DB) {
    this.adb = getAsyncDb(db);
  }

  // ================================================================ stats
  /** #77②：表全集与 Store.stats / db stats 一致（20 表），file 由调用方传入。 */
  async stats(file = ""): Promise<{ counts: Record<string, number>; file: string }> {
    const tables = [
      "skills", "skill_refs", "projects", "queries", "sources", "query_sources",
      "evidence", "claims", "claim_evidence", "artifacts", "kb_notes", "kb_links",
      "relations", "jobs", "runs", "events", "trees", "nodes", "node_edges", "node_conditions",
    ];
    const counts: Record<string, number> = {};
    for (const t of tables) {
      try {
        const r = await this.adb.get(`SELECT COUNT(*) AS n FROM ${t}`);
        counts[t] = r?.n ?? 0;
      } catch {
        counts[t] = 0;
      }
    }
    return { counts, file };
  }

  // ================================================================ report faces
  async reportProjects(limit = 10): Promise<Row[]> {
    return this.adb.all("SELECT name, question, created FROM projects ORDER BY created DESC LIMIT ?", [limit]);
  }

  async reportClaims(limit = 10): Promise<Row[]> {
    return this.adb.all("SELECT text, status, confidence FROM claims ORDER BY created DESC LIMIT ?", [limit]);
  }

  async reportKb(limit = 10): Promise<Row[]> {
    return this.adb.all("SELECT title, tags, confidence FROM kb_notes ORDER BY created DESC LIMIT ?", [limit]);
  }

  async reportTrees(): Promise<Row[]> {
    return this.adb.all("SELECT name FROM trees");
  }

  async treeNodeCount(treeName: string): Promise<number> {
    const r = await this.adb.get(
      "SELECT COUNT(*) AS n FROM nodes WHERE tree_id=(SELECT id FROM trees WHERE name=?)",
      [treeName],
    );
    return r?.n ?? 0;
  }

  // ================================================================ timeline
  /** #77②：方言中立——cutoff 在 JS 算（不用 datetime('now',…)），
   *  日粒度用 substr(ts,1,10)（SQLite 与 PG 都支持；ISO-8601 前缀即日期）。
   *  #77③：输出形状与 `db timeline` 对齐（day/events/projects/sources/claims/kb/nodes），
   *  不再是 (day,kind,n) 的原始分组——两处口径必须一致。 */
  async timeline(days: number): Promise<Row[]> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.adb.all(
      `SELECT substr(ts,1,10) AS day, COUNT(*) AS events,
         SUM(CASE WHEN kind LIKE 'project%' THEN 1 ELSE 0 END) AS projects,
         SUM(CASE WHEN kind LIKE 'source%' THEN 1 ELSE 0 END) AS sources,
         SUM(CASE WHEN kind LIKE 'claim%' THEN 1 ELSE 0 END) AS claims,
         SUM(CASE WHEN kind LIKE 'kb%' THEN 1 ELSE 0 END) AS kb,
         SUM(CASE WHEN kind LIKE 'node%' THEN 1 ELSE 0 END) AS nodes
         FROM events WHERE ts >= ? GROUP BY substr(ts,1,10) ORDER BY day`,
      [cutoff],
    );
  }

  /** #77②：去 rowid（SQLite 专有）——events.ts 有索引，按 ts 倒序等价。 */
  async recentEvents(limit = 20): Promise<Row[]> {
    return this.adb.all("SELECT ts, actor, kind, entity_id FROM events ORDER BY ts DESC LIMIT ?", [limit]);
  }

  // ================================================================ dups
  async projects(): Promise<Row[]> {
    return this.adb.all("SELECT * FROM projects");
  }

  async kbNotes(): Promise<Row[]> {
    return this.adb.all("SELECT * FROM kb_notes");
  }

  // ================================================================ raw async
  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    return this.adb.all(sql, params);
  }

  async queryOne(sql: string, params: unknown[] = []): Promise<Row | null> {
    return this.adb.get(sql, params);
  }
}
