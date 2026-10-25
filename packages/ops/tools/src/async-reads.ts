/**
 * AsyncOpsReads — B1 third-batch async read facade (ops domain).
 *
 * Ops reads are scattered across doctor/agent/rels/patrol/verify modules as
 * standalone functions taking `DB`. This facade provides the async versions
 * for the B1 call-site switch; the write/admin paths stay on DB directly.
 *
 * @module @ygl/ops-tools/async-reads
 */
import { DB } from "../../../core/database/src/db";
import { AsyncDb, getAsyncDb } from "../../../core/database/src/asyncdb";

export type Row = Record<string, any>;

export class AsyncOpsReads {
  private readonly adb: AsyncDb;

  constructor(db: DB) {
    this.adb = getAsyncDb(db);
  }

  // ================================================================ counts (agent brief / doctor)
  async counts(): Promise<Row> {
    const tables = [
      "skills", "projects", "queries", "sources", "evidence", "claims",
      "artifacts", "kb_notes", "kb_links", "relations", "jobs", "runs", "trees", "nodes",
    ];
    const out: Row = {};
    for (const t of tables) {
      const r = await this.adb.get(`SELECT COUNT(*) AS n FROM ${t}`);
      out[t] = r?.n ?? 0;
    }
    return out;
  }

  // ================================================================ rels
  async relsOf(nodeKey: string): Promise<Row[]> {
    return this.adb.all("SELECT * FROM relations WHERE src_id=? ORDER BY created DESC", [nodeKey]);
  }

  async relsAll(limit = 50): Promise<Row[]> {
    return this.adb.all("SELECT * FROM relations ORDER BY created DESC LIMIT ?", [limit]);
  }

  // ================================================================ jobs
  async jobs(): Promise<Row[]> {
    return this.adb.all("SELECT * FROM jobs ORDER BY created");
  }

  async jobByName(name: string): Promise<Row | null> {
    return this.adb.get("SELECT * FROM jobs WHERE title=?", [name]);
  }

  // ================================================================ patrol
  async patrolChecks(): Promise<Row[]> {
    return this.adb.all("SELECT * FROM patrol_checks ORDER BY created");
  }

  async patrolFindings(limit = 50): Promise<Row[]> {
    return this.adb.all("SELECT * FROM patrol_findings ORDER BY last_seen DESC LIMIT ?", [limit]);
  }

  // ================================================================ events / runs
  async recentEvents(limit = 20): Promise<Row[]> {
    return this.adb.all("SELECT * FROM events ORDER BY ts DESC LIMIT ?", [limit]);
  }

  async runs(): Promise<Row[]> {
    return this.adb.all("SELECT * FROM runs ORDER BY created");
  }

  // ================================================================ raw async
  async query(sql: string, params: unknown[] = []): Promise<Row[]> { return this.adb.all(sql, params); }
  async queryOne(sql: string, params: unknown[] = []): Promise<Row | null> { return this.adb.get(sql, params); }
}
