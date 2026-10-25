/**
 * AsyncResearchStore — B1 second-batch async read facade (research domain).
 * Same delegate pattern as AsyncTreeStore: wraps sync Store reads with
 * async signatures, backed by AsyncDb. Write methods stay on Store/writes.ts.
 *
 * @module @ygl/research-pipeline/async-store
 */
import { DB } from "../../../core/database/src/db";
import { AsyncDb, getAsyncDb } from "../../../core/database/src/asyncdb";
import { Store, Row } from "./reads";

export class AsyncResearchStore {
  private readonly sync: Store;
  private readonly adb: AsyncDb;

  constructor(db: DB) {
    this.sync = new Store(db);
    this.adb = getAsyncDb(db);
  }

  // ================================================================ projects
  async projectByName(name: string): Promise<Row | null> { return this.sync.projectByName(name); }
  async projectResolve(name?: string): Promise<Row> { return this.sync.projectResolve(name); }
  async projectList(): Promise<Row[]> { return this.sync.projectList(); }

  // ================================================================ queries
  async queryList(projectId: string): Promise<Row[]> {
    return this.adb.all("SELECT * FROM queries WHERE project_id=? ORDER BY created DESC", [projectId]);
  }

  // ================================================================ sources
  async sourceList(projectId: string, minRelevance?: number): Promise<Row[]> {
    return this.sync.sourceList(projectId, minRelevance);
  }
  async sourceSearch(projectId: string, q: string): Promise<Row[]> {
    return this.sync.sourceSearch(projectId, q);
  }
  async sourceGet(id: string): Promise<Row | null> { return this.sync.sourceGet(id); }

  // ================================================================ evidence
  async evidenceList(projectId: string): Promise<Row[]> { return this.sync.evidenceList(projectId); }

  // ================================================================ claims
  async claimList(projectId: string): Promise<Row[]> { return this.sync.claimList(projectId); }

  // ================================================================ artifacts
  async artifactList(projectId: string): Promise<Row[]> { return this.sync.artifactList(projectId); }
  async artifactGet(id: string): Promise<Row | null> { return this.sync.artifactGet(id); }

  // ================================================================ skills
  async skillList(): Promise<Row[]> { return this.sync.skillList(); }
  async skillGet(name: string): Promise<Row | null> { return this.sync.skillGet(name); }
  async skillMatch(q: string, limit?: number): Promise<Row[]> { return this.sync.skillMatch(q, limit); }

  // ================================================================ events
  async tail(limit?: number): Promise<Row[]> { return this.sync.tail(limit); }

  // ================================================================ raw async
  async query(sql: string, params: unknown[] = []): Promise<Row[]> { return this.adb.all(sql, params); }
  async queryOne(sql: string, params: unknown[] = []): Promise<Row | null> { return this.adb.get(sql, params); }
}
