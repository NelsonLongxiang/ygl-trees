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
  async stats(): Promise<{ counts: Record<string, number>; file: string }> {
    const tables = ["projects", "sources", "evidence", "claims", "kb_notes", "skills", "trees", "nodes", "artifacts", "events"];
    const counts: Record<string, number> = {};
    for (const t of tables) {
      try {
        const r = await this.adb.get(`SELECT COUNT(*) AS n FROM ${t}`);
        counts[t] = r?.n ?? 0;
      } catch {
        counts[t] = 0;
      }
    }
    return { counts, file: "" };
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
  async timeline(days: number): Promise<Row[]> {
    return this.adb.all(
      `SELECT date(ts) AS day, kind, COUNT(*) AS n FROM events
       WHERE ts >= datetime('now', ?) GROUP BY day, kind ORDER BY day`,
      [`-${days} days`],
    );
  }

  async recentEvents(limit = 20): Promise<Row[]> {
    return this.adb.all("SELECT ts, actor, kind, entity_id FROM events ORDER BY rowid DESC LIMIT ?", [limit]);
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
