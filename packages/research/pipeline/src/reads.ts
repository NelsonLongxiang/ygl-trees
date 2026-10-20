/**
 * Store: the only place that writes to the database.
 * Keeps FTS shadow tables in sync so search always matches reality.
 */
import { DB } from "../../../core/database/src/db";
import { clip, contentHash, ngram, nowIso, parseFrontmatter, sha1, shortId, splitTags } from "../../../core/text/src/text";

export type Row = Record<string, any>;

export class Store {
  constructor(readonly db: DB) {}

  // ================================================================ events
  log(kind: string, entity = "", entityId = "", payload: any = "", actor = "cli"): void {
    this.db.run(
      "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload) VALUES(?,?,?,?,?,?,?)",
      [shortId([kind, entity], 12), nowIso(), actor, kind, entity, entityId, str(payload)]
    );
  }

  tail(limit = 20): Row[] {
    return this.db.all("SELECT ts,actor,kind,entity,entity_id,payload FROM events ORDER BY rowid DESC LIMIT ?", [
      limit,
    ]);
  }

  // ================================================================ projects
  projectByName(name: string): Row | null {
    return this.db.get("SELECT * FROM projects WHERE name=?", [name]);
  }

  projectResolve(name?: string): Row {
    const key = name || this.db.metaGet("current_project");
    if (!key) throw new Error("no project selected; run: ygl-trees project new <name>");
    const p = this.projectByName(key);
    if (!p) throw new Error(`project not found: ${key}`);
    return p;
  }

  projectList(): Row[] {
    return this.db.all(
      `SELECT p.name, p.status,
              (SELECT COUNT(*) FROM sources s WHERE s.project_id=p.id)  AS sources,
              (SELECT COUNT(*) FROM claims  c WHERE c.project_id=p.id)  AS claims,
              (SELECT COUNT(*) FROM artifacts a WHERE a.project_id=p.id) AS artifacts,
              p.updated
         FROM projects p ORDER BY p.updated DESC`
    );
  }

  // ================================================================ queries
  queryDone(id: string): void {
    this.db.run("UPDATE queries SET status='done' WHERE id=?", [id]);
  }

  // ================================================================ sources
  sourceList(projectId: string, minRelevance = -1): Row[] {
    // 0.95: tags joined into the projection — graduation-protocol.md consumes
    // "sources with tags=sop"; a projection that hides tags makes the
    // documented SOP pull impossible from the read surface.
    return this.db.all(
      "SELECT id,title,url,engine,relevance,confidence,tags,retrieved_at FROM sources WHERE project_id=? AND relevance>=? ORDER BY relevance DESC, retrieved_at DESC",
      [projectId, minRelevance]
    );
  }

  sourceSearch(projectId: string, q: string): Row[] {
    return this.fts({
      table: "sources_fts",
      join: "sources s ON s.id=f.id",
      idCol: "id",
      cols: ["s.id", "s.title", "s.url", "s.relevance", "s.confidence", "s.tags"],
      where: "s.project_id=?",
      params: [projectId],
      q,
      limit: 50,
      boostExpr: "s.title", // title hits outrank same-hit rows (same as kb/skill)
      fallback: () =>
        this.db.all(
          "SELECT id,title,url,relevance,confidence FROM sources WHERE project_id=? AND (title LIKE ? OR abstract LIKE ?) LIMIT 50",
          [projectId, `%${q}%`, `%${q}%`]
        ),
    });
  }

  sourceGet(id: string): Row | null {
    return this.db.get("SELECT * FROM sources WHERE id=?", [id]);
  }

  sourceDel(id: string): void {
    this.db.run("DELETE FROM sources_fts WHERE id=?", [id]);
    this.db.run("DELETE FROM sources WHERE id=?", [id]);
  }

  evidenceList(projectId: string): Row[] {
    return this.db.all(
      `SELECT e.id, s.title AS source, e.locator, e.quote,
              (SELECT COUNT(*) FROM claim_evidence c WHERE c.evidence_id=e.id) AS used_by
         FROM evidence e JOIN sources s ON s.id=e.source_id
        WHERE e.project_id=? ORDER BY e.created`,
      [projectId]
    );
  }

  // ================================================================ claims
  claimList(projectId: string): Row[] {
    return this.db.all(
      `SELECT c.id, c.text, c.status, c.confidence,
              (SELECT COUNT(*) FROM claim_evidence e WHERE e.claim_id=c.id AND e.stance='supports') AS sup,
              (SELECT COUNT(*) FROM claim_evidence e WHERE e.claim_id=c.id AND e.stance='refutes')  AS ref
         FROM claims c WHERE c.project_id=? ORDER BY c.created`,
      [projectId]
    );
  }

  // ================================================================ artifacts
  artifactList(projectId: string): Row[] {
    return this.db.all(
      "SELECT id,kind,title,version,format,created,LENGTH(content) AS size FROM artifacts WHERE project_id=? ORDER BY created",
      [projectId]
    );
  }

  artifactGet(id: string): Row | null {
    return this.db.get("SELECT * FROM artifacts WHERE id=?", [id]);
  }

  // ================================================================ skills
  skillList(): Row[] {
    return this.db.all(
      "SELECT name,description,version,enabled,hits,tags,updated FROM skills ORDER BY hits DESC, updated DESC"
    );
  }

  skillGet(name: string): Row | null {
    return this.db.get("SELECT * FROM skills WHERE name=? OR id=?", [name, name]);
  }

  /** L1 match: full-text search over skills, used by agents to pick a skill. */
  skillMatch(q: string, limit = 5): Row[] {
    const rows = this.fts({
      table: "skills_fts",
      join: "skills s ON s.id=f.id",
      idCol: "id",
      cols: ["s.id", "s.name", "s.description", "s.version"],
      where: "s.enabled=1",
      params: [],
      boostExpr: "s.name", // name hits outrank same-hit rows (see fts doc)
      q,
      limit,
      fallback: () =>
        this.db.all(
          "SELECT id,name,description FROM skills WHERE enabled=1 AND (name LIKE ? OR description LIKE ?) LIMIT ?",
          [`%${q}%`, `%${q}%`, limit]
        ),
    });
    // single-statement hits bump (per-row UPDATEs = N implicit txns = N VFS
    // fsyncs — same write-amp class kbSearch had before 0.23.0)
    if (rows.length) {
      const ids: string[] = rows.map((r) => r.id);
      this.db.run(`UPDATE skills SET hits=hits+1 WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    }
    return rows;
  }

  skillEnabled(name: string, on: boolean): boolean {
    return (
      this.db.run("UPDATE skills SET enabled=?, updated=? WHERE name=?", [on ? 1 : 0, nowIso(), name]).changes > 0
    );
  }

  skillRefs(skillId: string): Row[] {
    return this.db.all("SELECT id,path,LENGTH(content) AS size FROM skill_refs WHERE skill_id=? ORDER BY path", [
      skillId,
    ]);
  }

  kbSearch(q: string, limit = 20): Row[] {
    const rows = this.fts({
      table: "kb_fts",
      join: "kb_notes k ON k.id=f.id",
      idCol: "id",
      cols: ["k.id", "k.title", "k.tags", "k.confidence", "k.reuse", "k.origin"],
      where: "",
      params: [],
      q,
      limit,
      boostExpr: "k.title", // title substring hits outrank same-hit rows (see fts doc)
      fallback: () =>
        this.db.all("SELECT id,title,tags,confidence FROM kb_notes WHERE title LIKE ? LIMIT ?", [`%${q}%`, limit]),
    });
    // single-statement reuse bump: N per-row UPDATEs would mean N implicit
    // transactions (N VFS fsyncs) per search — benchmarked 20x slower (0.23.0)
    if (rows.length) {
      const ids: string[] = rows.map((r) => r.id);
      this.db.run(
        `UPDATE kb_notes SET reuse=reuse+1 WHERE id IN (${ids.map(() => "?").join(",")})`,
        ids
      );
    }
    return rows;
  }

  kbList(): Row[] {
    return this.db.all(
      "SELECT id,title,tags,confidence,reuse,updated FROM kb_notes ORDER BY reuse DESC, updated DESC"
    );
  }

  kbGet(id: string): Row | null {
    return this.db.get("SELECT * FROM kb_notes WHERE id=? OR title=?", [id, id]);
  }

  kbLink(fromId: string, toId: string, rel = "related"): void {
    this.db.run(
      "INSERT INTO kb_links(from_id,to_id,rel) VALUES(?,?,?) ON CONFLICT(from_id,to_id,rel) DO NOTHING",
      [fromId, toId, rel]
    );
  }

  kbLinks(id: string): Row[] {
    return this.db.all(
      `SELECT l.rel, CASE WHEN l.to_id=? THEN k2.title ELSE k1.title END AS other
         FROM kb_links l
         JOIN kb_notes k1 ON k1.id=l.from_id
         JOIN kb_notes k2 ON k2.id=l.to_id
        WHERE l.from_id=? OR l.to_id=?`,
      [id, id, id]
    );
  }

  /**
   * Full-text search helper shared by sources / skills / kb.
   *
   * CJK text is tokenized into character bigrams, so a sentence like
   * "我要建科技树" becomes 我要/要建/建科/科技/技树. Handing all of them to
   * FTS5 as one MATCH expression makes it an AND — one missing bigram and the
   * result is empty. Instead we match token by token, count how many distinct
   * tokens each row hits, and rank by (hits desc, bm25 asc). Rows matching any
   * single token still show up, so recall survives noisy phrasing while rows
   * matching more tokens float to the top.
   *
   * `boostExpr` (e.g. "k.title"): rows whose boosted column contains a
   * token as a SUBSTRING outrank same-hit rows (hits desc, boost desc,
   * bm25 asc). Substring LIKE instead of an FTS5 column filter because
   * unicode61 indexes whole CJK title runs as single tokens — `title:监督`
   * never matches (real-data finding); LIKE bypasses the tokenizer and
   * works for CJK and latin alike.
   */
  private fts(o: {
    table: string;
    join: string;
    cols: string[];
    idCol: string;
    where?: string;
    params?: any[];
    q: string;
    limit: number;
    boostExpr?: string;
    fallback: () => Row[];
  }): Row[] {
    const tokens = Array.from(new Set(ngram(o.q).split(/\s+/).filter(Boolean)));
    if (!tokens.length) return o.fallback();

    const cond = [o.where, `${o.table} MATCH ?`].filter(Boolean).join(" AND ");
    const agg = new Map<string, { row: Row; hits: number; score: number; boost: number }>();
    try {
      const st = this.db.db.prepare(
        `SELECT ${o.cols.join(",")}, bm25(${o.table}) AS score
           FROM ${o.table} f JOIN ${o.join}
          WHERE ${cond} ORDER BY score LIMIT ?`
      );
      try {
        for (const t of tokens) {
          const phrase = `"${t.replace(/"/g, "")}"`;
          const rows = st.all([...(o.params || []), phrase, o.limit]) as Row[];
          for (const r of rows) {
            const id = String(r[o.idCol]);
            const prev = agg.get(id);
            if (prev) {
              prev.hits += 1;
              prev.score += r.score;
            } else agg.set(id, { row: r, hits: 1, score: r.score, boost: 0 });
          }
        }
        // boost: LIKE-scan restricted to the MATCH candidate set — identical
        // counts (only candidates ever receive boost), no full-table scan.
        if (o.boostExpr && agg.size) {
          const ids = Array.from(agg.keys());
          const stBoost = this.db.db.prepare(
            `SELECT f.id AS __id
               FROM ${o.table} f JOIN ${o.join}
              WHERE ${[
                o.where,
                `lower(${o.boostExpr}) LIKE ?`,
                `f.id IN (${ids.map(() => "?").join(",")})`,
              ]
                .filter(Boolean)
                .join(" AND ")}`
          );
          try {
            for (const t of tokens) {
              const hits = stBoost.all([
                ...(o.params || []),
                `%${t.toLowerCase()}%`,
                ...ids,
              ]) as Row[];
              for (const h of hits) {
                const prev = agg.get(String(h.__id));
                if (prev) prev.boost += 1;
              }
            }
          } finally {
            stBoost.finalize();
          }
        }
      } finally {
        st.finalize();
      }
    } catch {
      return o.fallback();
    }

    if (!agg.size) return o.fallback();
    return [...agg.values()]
      .sort((a, b) => b.hits - a.hits || b.boost - a.boost || a.score - b.score)
      .slice(0, o.limit)
      .map((a) => ({ ...a.row, score: -a.hits, bm25: a.score, matched: a.hits, title_matched: a.boost }));
  }

  // ================================================================ relations
  relate(srcType: string, srcId: string, dstType: string, dstId: string, rel = "related", weight = 1): void {
    this.db.run(
      `INSERT INTO relations(id,src_type,src_id,dst_type,dst_id,rel,weight) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(src_type,src_id,dst_type,dst_id,rel) DO UPDATE SET weight=excluded.weight`,
      [shortId([srcType, srcId, dstType, dstId, rel], 12), srcType, srcId, dstType, dstId, rel, weight]
    );
  }

  neighbours(type: string, id: string): Row[] {
    return this.db.all(
      `SELECT rel, dst_type AS other_type, dst_id AS other_id FROM relations WHERE src_type=? AND src_id=?
       UNION ALL
       SELECT rel, src_type AS other_type, src_id AS other_id FROM relations WHERE dst_type=? AND dst_id=?`,
      [type, id, type, id]
    );
  }

  // ================================================================ jobs
  /** Idempotent by title; force appends a numeric suffix (nightly-2, -3…). */
  jobList(): Row[] {
    return this.db.all(
      "SELECT id,title,every_minutes AS every,at,enabled,runs,last_run,status FROM jobs ORDER BY created"
    );
  }

  jobDue(): Row[] {
    const rows = this.db.all("SELECT * FROM jobs WHERE enabled=1");
    const now = Date.now();
    return rows.filter((j: Row) => {
      if (!j.last_run) return true;
      if (j.every_minutes > 0) {
        const last = Date.parse(j.last_run.replace(" ", "T"));
        return Number.isFinite(last) && now - last >= j.every_minutes * 60_000;
      }
      if (j.at) {
        const t = Date.parse(j.at.replace(" ", "T"));
        return Number.isFinite(t) && t <= now && !j.last_run;
      }
      return false;
    });
  }

  /** Runs left dangling by a killed process: close them out and report. */
  jobReapStuck(maxAgeMinutes = 30): number {
    // GitHub issue #6 ①: `started` is written by jobStart() as nowIso() — UTC
    // ISO-8601 with 'T' and 'Z'. The old cutoff was a space-separated LOCAL
    // timestamp, so the string compare `started < cut` was always false on the
    // same day (' ' 0x20 < 'T' 0x54) and off by the tz offset across days: the
    // reaper silently stopped reaping anything after the 0.87.1 timestamp
    // format change. Same clock, same format — never compare formatted times.
    const cut = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
    const r = this.db.run(
      `UPDATE runs SET finished=?, rc=126, output=COALESCE(NULLIF(output,''),'') || '(reaped: process was killed mid-run)'
        WHERE finished='' AND started < ?`,
      [nowIso(), cut]
    );
    return r.changes;
  }

  jobStart(jobId: string): string {
    const id = shortId(["run", jobId], 12);
    this.db.run("INSERT INTO runs(id,job_id,started) VALUES(?,?,?)", [id, jobId, nowIso()]);
    return id;
  }

  jobFinish(runId: string, rc: number, output: string): void {
    // 0.83.1: the UPDATE params were missing runId (3 values for 4
    // placeholders → WHERE id=NULL → silent no-op). Run history (rc/output/
    // finished) never persisted — only the jobs-row side updated. Caught
    // while verifying the 0.83 patrol job's captured output.
    this.db.run("UPDATE runs SET finished=?, rc=?, output=? WHERE id=?", [nowIso(), rc, output.slice(0, 8000), runId]);
    this.db.run("UPDATE jobs SET runs=runs+1, last_run=?, status=? WHERE id=(SELECT job_id FROM runs WHERE id=?)", [
      nowIso(),
      rc === 0 ? "ok" : "failed",
      runId,
    ]);
  }

  runsList(limit = 10): Row[] {
    return this.db.all(
      "SELECT r.id,j.title,r.started,r.rc,substr(r.output,1,120) AS output FROM runs r JOIN jobs j ON j.id=r.job_id ORDER BY r.started DESC LIMIT ?",
      [limit]
    );
  }

  // ================================================================ stats
  stats(): Record<string, number> {
    const t = (name: string) => this.db.get<{ c: number }>(`SELECT COUNT(*) c FROM ${name}`)?.c ?? 0;
    return {
      skills: t("skills"),
      skill_refs: t("skill_refs"),
      projects: t("projects"),
      queries: t("queries"),
      sources: t("sources"),
      query_sources: t("query_sources"),
      evidence: t("evidence"),
      claims: t("claims"),
      claim_evidence: t("claim_evidence"),
      artifacts: t("artifacts"),
      kb_notes: t("kb_notes"),
      kb_links: t("kb_links"),
      relations: t("relations"),
      jobs: t("jobs"),
      runs: t("runs"),
      events: t("events"),
      trees: t("trees"),
      nodes: t("nodes"),
      node_edges: t("node_edges"),
      node_conditions: t("node_conditions"),
    };
  }
}

function str(v: any): string {
  return typeof v === "string" ? v : JSON.stringify(v ?? "");
}

/**
 * Derive an L1 description (what + when) from a note body, for kb promote.
 * Exported: the kb promote command composes it with the TypeORM skillUpsert.
 */
export function deriveL1(body: string, title: string): string {
  const lines = body
    .split("\n")
    .map((l) => l.replace(/\*\*/g, "").trim())
    .filter(Boolean)
    .filter((l) => !/^#{1,6}\s/.test(l))
    .filter((l) => !/^_generated/i.test(l) && !/^generated/i.test(l));
  const listLine = lines.slice(0, 20).find((l) => /^[-*]\s+|^\d+[.)]\s+/.test(l));
  const pick = (listLine || lines[0] || title)
    .replace(/^[-*]\s+|^\d+[.)]\s+/, "")
    .replace(/^[✓✗⚠?*☐☑]\s*/, "")
    .replace(/\s*\[\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${clip(pick, 200)}（提炼自《${clip(title, 60)}》）`;
}
