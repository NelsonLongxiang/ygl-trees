/**
 * AsyncResearchStore — B1 second-batch async read facade (research domain).
 * Same delegate pattern as AsyncTreeStore: wraps sync Store reads with
 * async signatures, backed by AsyncDb. Write methods stay on Store/writes.ts.
 *
 * @module @ygl/research-pipeline/async-store
 */
import { DB } from "../../../core/database/src/db";
import { AsyncDb, getAsyncDb, assertSyncDelegationAllowed } from "../../../core/database/src/asyncdb";
import { Store, Row } from "./reads";

export class AsyncResearchStore {
  private readonly sync: Store | null;
  private readonly adb: AsyncDb;

  /** B7：传 PG URL 字符串 → PG 直连面（sync 委托面由 guard() 关闭——sqlite-only）。 */
  constructor(db: DB | string) {
    if (typeof db === "string") {
      this.sync = null;
      this.adb = getAsyncDb(null, db);
    } else {
      this.sync = new Store(db);
      this.adb = getAsyncDb(db);
    }
  }

  /** #77③: delegated sync calls are sqlite-only（PG 模式 sync=null，直接点名）。 */
  private guard(): void {
    if (this.sync === null) {
      throw new Error("AsyncResearchStore: this face delegates to the sync SQLite Store and is unavailable in PG mode (YGL_DB_URL); PG-direct faces: db stats / doctor / webui");
    }
    assertSyncDelegationAllowed(this.adb, "AsyncResearchStore");
  }

  // ================================================================ projects
  async projectByName(name: string): Promise<Row | null> {
    if (this.adb.dialect === "pg") return this.adb.get("SELECT * FROM projects WHERE name=?", [name]);
    this.guard(); return this.sync!.projectByName(name);
  }
  async projectResolve(name?: string): Promise<Row> { this.guard(); return this.sync!.projectResolve(name); }
  async projectList(): Promise<Row[]> {
    if (this.adb.dialect === "pg") return this.adb.all("SELECT p.name,p.status,(SELECT COUNT(*)::int FROM sources s WHERE s.project_id=p.id) AS sources,(SELECT COUNT(*)::int FROM claims c WHERE c.project_id=p.id) AS claims,(SELECT COUNT(*)::int FROM artifacts a WHERE a.project_id=p.id) AS artifacts,p.updated FROM projects p ORDER BY p.updated DESC");
    this.guard(); return this.sync!.projectList();
  }

  async kbGet(id: string): Promise<Row | null> {
    return this.adb.get("SELECT id,title,body,source_url,origin,tags,confidence,reuse,content_hash,created,updated FROM kb_notes WHERE id=? OR title=?", [id, id]);
  }

  async kbList(): Promise<Row[]> {
    return this.adb.all("SELECT id,title,tags,confidence,reuse,updated FROM kb_notes ORDER BY reuse DESC, updated DESC");
  }

  async configValue(key: string, fallback: string): Promise<string> {
    const r = await this.adb.get("SELECT value FROM config WHERE key=?", [key]);
    return r?.value || fallback;
  }

  async metaGet(key: string): Promise<string> {
    return (await this.adb.get("SELECT value FROM meta WHERE key=?", [key]))?.value || "";
  }

  async close(): Promise<void> {
    if (this.adb.dialect === "pg") await (this.adb as import("../../../core/database/src/asyncdb").PgAsyncDb).close();
  }

  // ================================================================ queries
  async queryList(projectId: string): Promise<Row[]> {
    return this.adb.all("SELECT * FROM queries WHERE project_id=? ORDER BY created DESC", [projectId]);
  }

  // ================================================================ sources
  async sourceList(projectId: string, minRelevance?: number): Promise<Row[]> {
    this.guard(); return this.sync!.sourceList(projectId, minRelevance);
  }
  async sourceSearch(projectId: string, q: string): Promise<Row[]> {
    this.guard(); return this.sync!.sourceSearch(projectId, q);
  }
  async sourceGet(id: string): Promise<Row | null> { this.guard(); return this.sync!.sourceGet(id); }

  // ================================================================ evidence
  async evidenceList(projectId: string): Promise<Row[]> { this.guard(); return this.sync!.evidenceList(projectId); }

  // ================================================================ claims
  async claimList(projectId: string): Promise<Row[]> { this.guard(); return this.sync!.claimList(projectId); }

  // ================================================================ artifacts
  async artifactList(projectId: string): Promise<Row[]> { this.guard(); return this.sync!.artifactList(projectId); }
  async artifactGet(id: string): Promise<Row | null> { this.guard(); return this.sync!.artifactGet(id); }

  // ================================================================ skills
  async skillList(): Promise<Row[]> { this.guard(); return this.sync!.skillList(); }
  async skillGet(name: string): Promise<Row | null> { this.guard(); return this.sync!.skillGet(name); }
  async skillMatch(q: string, limit?: number): Promise<Row[]> { this.guard(); return this.sync!.skillMatch(q, limit); }

  // ================================================================ events
  async tail(limit?: number): Promise<Row[]> { this.guard(); return this.sync!.tail(limit); }

  // ================================================================ writes used by command handlers
  /** #78: command handlers call this on the async facade. It stays a delegate to the
   *  sync Store write (transactional writes live in writes.ts; this is the query status flip). */
  async queryDone(id: string): Promise<void> {
    this.guard(); return this.sync!.queryDone(id);
  }

  // ================================================================ stats
  async stats(): Promise<Record<string, number>> {
    const t = async (name: string) => ((await this.adb.get(`SELECT COUNT(*) AS c FROM ${name}`))?.c ?? 0) as number;
    return {
      skills: await t("skills"),
      skill_refs: await t("skill_refs"),
      projects: await t("projects"),
      queries: await t("queries"),
      sources: await t("sources"),
      query_sources: await t("query_sources"),
      evidence: await t("evidence"),
      claims: await t("claims"),
      claim_evidence: await t("claim_evidence"),
      kb_notes: await t("kb_notes"),
      kb_links: await t("kb_links"),
      relations: await t("relations"),
      artifacts: await t("artifacts"),
      jobs: await t("jobs"),
      runs: await t("runs"),
      events: await t("events"),
      node_edges: await t("node_edges"),
      node_conditions: await t("node_conditions"),
    };
  }

  // ================================================================ raw async
  async query(sql: string, params: unknown[] = []): Promise<Row[]> { return this.adb.all(sql, params); }
  async queryOne(sql: string, params: unknown[] = []): Promise<Row | null> { return this.adb.get(sql, params); }
}
