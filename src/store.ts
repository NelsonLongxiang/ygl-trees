/**
 * Store: the only place that writes to the database.
 * Keeps FTS shadow tables in sync so search always matches reality.
 */
import { DB } from "./db";
import { clip, ngram, nowIso, parseFrontmatter, sha1, shortId, splitTags } from "./text";

export type Row = Record<string, any>;

/** Content hash for idempotent writes; --force salts it so a duplicate row
 *  is explicitly distinct (queryable via `db dups`). */
function contentHash(content: string, force: boolean): string {
  return sha1(content) + (force ? `#f${Date.now()}${Math.random()}` : "");
}

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
    return this.db.all("SELECT ts,actor,kind,entity,entity_id,payload FROM events ORDER BY ts DESC, rowid DESC LIMIT ?", [
      limit,
    ]);
  }

  // ================================================================ projects
  projectCreate(name: string, question = ""): Row {
    const id = shortId(["proj", name], 10);
    this.db.run(
      "INSERT INTO projects(id,name,question,status,created,updated) VALUES(?,?,?,'active',?,?)",
      [id, name, question, nowIso(), nowIso()]
    );
    this.db.metaSet("current_project", name);
    this.log("project.create", "project", id, name);
    return this.projectByName(name)!;
  }

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
  /** Idempotent by (project, sha1(text)); force salts the hash. */
  queryAdd(projectId: string, text: string, engine = "", force = false): { row: Row; dup: boolean } {
    const hash = contentHash(text, force);
    const ex = this.db.get("SELECT * FROM queries WHERE project_id=? AND content_hash=?", [projectId, hash]);
    if (ex) return { row: ex, dup: true };
    const id = shortId(["q", projectId, text], 10);
    this.db.run(
      "INSERT INTO queries(id,project_id,text,engine,status,content_hash,created) VALUES(?,?,?,?,'pending',?,?)",
      [id, projectId, text, engine, hash, nowIso()]
    );
    this.log("query.add", "query", id, text);
    return { row: this.db.get("SELECT * FROM queries WHERE id=?", [id])!, dup: false };
  }

  queryList(projectId: string): Row[] {
    return this.db.all(
      `SELECT q.id, q.text, q.engine, q.status, q.created,
              (SELECT COUNT(*) FROM query_sources s WHERE s.query_id=q.id) AS sources
         FROM queries q WHERE q.project_id=? ORDER BY q.created`,
      [projectId]
    );
  }

  /** Attach a source to the query that recalled it (id or exact text). */
  queryAttach(projectId: string, queryIdOrText: string, sourceId: string, note = ""): { query: Row; source: Row; dup: boolean } {
    const q = this.db.get("SELECT * FROM queries WHERE (id=? OR text=?) AND project_id=?", [
      queryIdOrText,
      queryIdOrText,
      projectId,
    ]);
    if (!q) throw new Error(`query not found: ${queryIdOrText}`);
    const s = this.db.get("SELECT * FROM sources WHERE id=? AND project_id=?", [sourceId, projectId]);
    if (!s) throw new Error(`source not found in this project: ${sourceId}`);
    const ex = this.db.get("SELECT 1 AS hit FROM query_sources WHERE query_id=? AND source_id=?", [q.id, s.id]);
    if (!ex) {
      this.db.run("INSERT INTO query_sources(query_id,source_id,note,created) VALUES(?,?,?,?)", [
        q.id,
        s.id,
        note,
        nowIso(),
      ]);
      this.log("query.attach", "query", q.id, s.id);
    }
    return { query: q, source: s, dup: !!ex };
  }

  queryDone(id: string): void {
    this.db.run("UPDATE queries SET status='done' WHERE id=?", [id]);
  }

  // ================================================================ sources
  /** Dedupe by (project, url_hash); returns {row, created}. */
  sourceAdd(projectId: string, o: Partial<Row>): { row: Row; created: boolean; dup: boolean } {
    const url = o.url || "";
    const urlHash = sha1(url || o.title || "");
    const existing = this.db.get("SELECT * FROM sources WHERE project_id=? AND url_hash=?", [projectId, urlHash]);
    if (existing) return { row: existing, created: false, dup: true };

    const id = shortId(["src", projectId, urlHash], 10);
    const title = o.title || url || "untitled";
    const abstract_ = o.abstract || "";
    const content = o.content || "";
    this.db.run(
      `INSERT INTO sources(id,project_id,url,title,url_hash,content_hash,abstract,content,
                           engine,relevance,confidence,tags,retrieved_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        projectId,
        url,
        title,
        urlHash,
        sha1(content || abstract_),
        abstract_,
        content,
        o.engine || "",
        o.relevance ?? 0,
        o.confidence || "B",
        o.tags || "",
        o.retrieved_at || nowIso(),
      ]
    );
    this.db.run("INSERT INTO sources_fts(id,title,abstract,content,ngram) VALUES(?,?,?,?,?)", [
      id,
      title,
      abstract_,
      content,
      ngram(`${title} ${abstract_} ${content} ${o.tags || ""}`),
    ]);
    this.log("source.add", "source", id, title);
    return { row: this.db.get("SELECT * FROM sources WHERE id=?", [id])!, created: true, dup: false };
  }

  sourceList(projectId: string, minRelevance = -1): Row[] {
    return this.db.all(
      "SELECT id,title,url,engine,relevance,confidence,retrieved_at FROM sources WHERE project_id=? AND relevance>=? ORDER BY relevance DESC, retrieved_at DESC",
      [projectId, minRelevance]
    );
  }

  sourceSearch(projectId: string, q: string): Row[] {
    return this.fts({
      table: "sources_fts",
      join: "sources s ON s.id=f.id",
      idCol: "id",
      cols: ["s.id", "s.title", "s.url", "s.relevance", "s.confidence"],
      where: "s.project_id=?",
      params: [projectId],
      q,
      limit: 50,
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

  // ================================================================ evidence
  /** Idempotent by (source, sha1(quote)); force salts the hash. */
  evidenceAdd(projectId: string, sourceId: string, quote: string, note = "", locator = "", force = false): { row: Row; dup: boolean } {
    const hash = contentHash(quote, force);
    const ex = this.db.get("SELECT * FROM evidence WHERE source_id=? AND content_hash=?", [sourceId, hash]);
    if (ex) return { row: ex, dup: true };
    const id = shortId(["ev", sourceId, quote], 10);
    this.db.run(
      "INSERT INTO evidence(id,project_id,source_id,quote,note,locator,content_hash,created) VALUES(?,?,?,?,?,?,?,?)",
      [id, projectId, sourceId, quote, note, locator, hash, nowIso()]
    );
    this.db.run("INSERT INTO evidence_fts(id,quote,ngram) VALUES(?,?,?)", [id, quote, ngram(quote)]);
    this.log("evidence.add", "evidence", id, quote.slice(0, 60));
    return { row: this.db.get("SELECT * FROM evidence WHERE id=?", [id])!, dup: false };
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
  /** Idempotent by (project, sha1(text)); force salts the hash. */
  claimAdd(projectId: string, text: string, confidence = "B", force = false): { row: Row; dup: boolean } {
    const hash = contentHash(text, force);
    const ex = this.db.get("SELECT * FROM claims WHERE project_id=? AND content_hash=?", [projectId, hash]);
    if (ex) return { row: ex, dup: true };
    const id = shortId(["cl", projectId, text], 10);
    this.db.run(
      "INSERT INTO claims(id,project_id,text,status,confidence,content_hash,created) VALUES(?,?,?,'unverified',?,?,?)",
      [id, projectId, text, confidence, hash, nowIso()]
    );
    this.log("claim.add", "claim", id, text.slice(0, 60));
    return { row: this.db.get("SELECT * FROM claims WHERE id=?", [id])!, dup: false };
  }

  claimLink(claimId: string, evidenceId: string, stance: "supports" | "refutes" = "supports"): void {
    this.db.run(
      "INSERT INTO claim_evidence(claim_id,evidence_id,stance) VALUES(?,?,?) ON CONFLICT(claim_id,evidence_id) DO UPDATE SET stance=excluded.stance",
      [claimId, evidenceId, stance]
    );
    const sup = this.db.get<{ c: number }>(
      "SELECT COUNT(*) c FROM claim_evidence WHERE claim_id=? AND stance='supports'",
      [claimId]
    )!.c;
    const ref = this.db.get<{ c: number }>(
      "SELECT COUNT(*) c FROM claim_evidence WHERE claim_id=? AND stance='refutes'",
      [claimId]
    )!.c;
    const status = sup && ref ? "contested" : sup ? "supported" : ref ? "refuted" : "unverified";
    this.db.run("UPDATE claims SET status=? WHERE id=?", [status, claimId]);
    this.log("claim.link", "claim", claimId, `${stance} ${evidenceId}`);
  }

  claimList(projectId: string): Row[] {
    return this.db.all(
      `SELECT c.id, c.text, c.status, c.confidence,
              (SELECT COUNT(*) FROM claim_evidence e WHERE e.claim_id=c.id AND e.stance='supports') AS sup,
              (SELECT COUNT(*) FROM claim_evidence e WHERE e.claim_id=c.id AND e.stance='refutes')  AS ref
         FROM claims c WHERE c.project_id=? ORDER BY c.created`,
      [projectId]
    );
  }

  /** Manual arbitration for contested claims; a later evidence link
   *  re-derives the status automatically. Audited via events. */
  claimResolve(claimId: string, status: string, note = ""): void {
    this.db.run("UPDATE claims SET status=? WHERE id=?", [status, claimId]);
    this.log("claim.resolve", "claim", claimId, `${status}${note ? " | " + note : ""}`);
  }

  // ================================================================ artifacts
  artifactAdd(projectId: string, kind: string, title: string, content: string, format = "markdown"): Row {
    const ver =
      (this.db.get<{ m: number }>(
        "SELECT COALESCE(MAX(version),0) m FROM artifacts WHERE project_id=? AND kind=? AND title=?",
        [projectId, kind, title]
      )?.m ?? 0) + 1;
    const id = shortId(["art", projectId, kind, title, String(ver)], 10);
    this.db.run(
      "INSERT INTO artifacts(id,project_id,kind,title,format,content,version,created) VALUES(?,?,?,?,?,?,?,?)",
      [id, projectId, kind, title, format, content, ver, nowIso()]
    );
    this.log("artifact.add", "artifact", id, `${kind}:${title} v${ver}`);
    return this.db.get("SELECT * FROM artifacts WHERE id=?", [id])!;
  }

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
  skillUpsert(o: {
    name: string;
    description?: string;
    body?: string;
    tags?: string;
    version?: string;
    origin?: string;
  }): Row {
    const now = nowIso();
    this.db.run(
      `INSERT INTO skills(id,name,version,description,body,tags,origin,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET
         version=excluded.version, description=excluded.description,
         body=excluded.body, tags=excluded.tags, origin=excluded.origin, updated=excluded.updated`,
      [
        shortId(["skill", o.name], 10),
        o.name,
        o.version || "0.1.0",
        o.description || "",
        o.body || "",
        o.tags || "",
        o.origin || "",
        now,
        now,
      ]
    );
    const row = this.db.get("SELECT * FROM skills WHERE name=?", [o.name])!;
    this.db.run("DELETE FROM skills_fts WHERE id=?", [row.id]);
    this.db.run("INSERT INTO skills_fts(id,name,description,tags,ngram) VALUES(?,?,?,?,?)", [
      row.id,
      row.name,
      row.description,
      row.tags,
      ngram(`${row.name} ${row.description} ${row.tags} ${row.body}`),
    ]);
    this.log("skill.upsert", "skill", row.id, row.name);
    return row;
  }

  /** Import a SKILL.md file (frontmatter = L1 meta, body = L2 instructions). */
  skillImport(file: string): Row {
    const raw = require("node:fs").readFileSync(file, "utf8") as string;
    const { meta, body } = parseFrontmatter(raw);
    return this.skillUpsert({
      name: meta.name || require("node:path").basename(file, ".md"),
      description: meta.description || "",
      body,
      tags: (meta.tags || "").toString(),
      version: meta.version || "0.1.0",
      origin: file,
    });
  }

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
      q,
      limit,
      fallback: () =>
        this.db.all(
          "SELECT id,name,description FROM skills WHERE enabled=1 AND (name LIKE ? OR description LIKE ?) LIMIT ?",
          [`%${q}%`, `%${q}%`, limit]
        ),
    });
    for (const r of rows) this.db.run("UPDATE skills SET hits=hits+1 WHERE id=?", [r.id]);
    return rows;
  }

  skillEnabled(name: string, on: boolean): boolean {
    return (
      this.db.run("UPDATE skills SET enabled=?, updated=? WHERE name=?", [on ? 1 : 0, nowIso(), name]).changes > 0
    );
  }

  skillDel(name: string): void {
    const r = this.skillGet(name);
    if (!r) throw new Error(`skill not found: ${name}`);
    this.db.run("DELETE FROM skills_fts WHERE id=?", [r.id]);
    this.db.run("DELETE FROM skills WHERE id=?", [r.id]);
  }

  skillRefs(skillId: string): Row[] {
    return this.db.all("SELECT id,path,LENGTH(content) AS size FROM skill_refs WHERE skill_id=? ORDER BY path", [
      skillId,
    ]);
  }

  skillRefAdd(skillId: string, refPath: string, content: string): Row {
    const id = shortId(["ref", skillId, refPath], 10);
    this.db.run(
      "INSERT INTO skill_refs(id,skill_id,path,content) VALUES(?,?,?,?) ON CONFLICT(skill_id,path) DO UPDATE SET content=excluded.content",
      [id, skillId, refPath, content]
    );
    return this.db.get("SELECT * FROM skill_refs WHERE skill_id=? AND path=?", [skillId, refPath])!;
  }

  // ================================================================ knowledge base
  /** Idempotent by sha1(title+body); force salts the hash. */
  kbAdd(o: {
    title: string;
    body: string;
    tags?: string;
    source_url?: string;
    origin?: string;
    confidence?: string;
    force?: boolean;
  }): { row: Row; dup: boolean } {
    const hash = contentHash(`${o.title}\n${o.body}`, !!o.force);
    const ex = this.db.get("SELECT * FROM kb_notes WHERE content_hash=?", [hash]);
    if (ex) return { row: ex, dup: true };
    const id = shortId(["kb", o.title], 10);
    const now = nowIso();
    this.db.run(
      "INSERT INTO kb_notes(id,title,body,source_url,origin,tags,confidence,content_hash,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [id, o.title, o.body, o.source_url || "", o.origin || "", o.tags || "", o.confidence || "B", hash, now, now]
    );
    this.db.run("INSERT INTO kb_fts(id,title,tags,ngram) VALUES(?,?,?,?)", [
      id,
      o.title,
      o.tags || "",
      ngram(`${o.title} ${o.tags || ""} ${o.body}`),
    ]);
    this.log("kb.add", "kb_note", id, o.title);
    return { row: this.db.get("SELECT * FROM kb_notes WHERE id=?", [id])!, dup: false };
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
      fallback: () =>
        this.db.all("SELECT id,title,tags,confidence FROM kb_notes WHERE title LIKE ? LIMIT ?", [`%${q}%`, limit]),
    });
    for (const r of rows) this.db.run("UPDATE kb_notes SET reuse=reuse+1 WHERE id=?", [r.id]);
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
    fallback: () => Row[];
  }): Row[] {
    const tokens = Array.from(new Set(ngram(o.q).split(/\s+/).filter(Boolean)));
    if (!tokens.length) return o.fallback();

    const cond = [o.where, `${o.table} MATCH ?`].filter(Boolean).join(" AND ");
    const agg = new Map<string, { row: Row; hits: number; score: number }>();
    try {
      const st = this.db.db.prepare(
        `SELECT ${o.cols.join(",")}, bm25(${o.table}) AS score
           FROM ${o.table} f JOIN ${o.join}
          WHERE ${cond} ORDER BY score LIMIT ?`
      );
      try {
        for (const t of tokens) {
          const rows = st.all([...(o.params || []), `"${t.replace(/"/g, "")}"`, o.limit]) as Row[];
          for (const r of rows) {
            const id = String(r[o.idCol]);
            const prev = agg.get(id);
            if (prev) {
              prev.hits += 1;
              prev.score += r.score;
            } else agg.set(id, { row: r, hits: 1, score: r.score });
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
      .sort((a, b) => b.hits - a.hits || a.score - b.score)
      .slice(0, o.limit)
      .map((a) => ({ ...a.row, score: -a.hits, bm25: a.score, matched: a.hits }));
  }

  /** Knowledge reuse: turn a note (or artifact) into a reusable skill. */
  kbPromote(idOrTitle: string, skillName?: string): Row {
    const note = this.kbGet(idOrTitle);
    if (!note) throw new Error(`kb note not found: ${idOrTitle}`);
    const name = skillName || note.title;
    return this.skillUpsert({
      name,
      description: deriveL1(note.body || "", note.title),
      body: note.body,
      tags: note.tags,
      origin: `kb:${note.id}`,
    });
  }

  /** Import a finished artifact into the knowledge base for long-term reuse. */
  kbIngestArtifact(artifactId: string, force = false): { row: Row; dup: boolean } {
    const a = this.artifactGet(artifactId);
    if (!a) throw new Error(`artifact not found: ${artifactId}`);
    return this.kbAdd({
      title: a.title,
      body: a.content,
      tags: a.kind,
      origin: `artifact:${a.id}`,
      confidence: "B",
      force,
    });
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
  jobAdd(o: { title: string; command: string; every?: number; at?: string; force?: boolean }): { row: Row; dup: boolean } {
    if (!o.force) {
      const ex = this.db.get("SELECT * FROM jobs WHERE title=?", [o.title]);
      if (ex) return { row: ex, dup: true };
    }
    let title = o.title;
    if (o.force) {
      let i = 2;
      while (this.db.get("SELECT 1 FROM jobs WHERE title=?", [title])) title = `${o.title}-${i++}`;
    }
    const id = shortId(["job", title], 10);
    this.db.run(
      "INSERT INTO jobs(id,title,command,every_minutes,at,enabled,status,created) VALUES(?,?,?,?,?,1,'pending',?)",
      [id, title, o.command, o.every ?? 0, o.at || "", nowIso()]
    );
    this.log("job.add", "job", id, title);
    return { row: this.db.get("SELECT * FROM jobs WHERE id=?", [id])!, dup: false };
  }

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
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000);
    const p = (n: number) => String(n).padStart(2, "0");
    const cut = `${cutoff.getFullYear()}-${p(cutoff.getMonth() + 1)}-${p(cutoff.getDate())} ${p(cutoff.getHours())}:${p(cutoff.getMinutes())}:${p(cutoff.getSeconds())}`;
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
    this.db.run("UPDATE runs SET finished=?, rc=?, output=? WHERE id=?", [nowIso(), rc, output.slice(0, 8000)]);
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
      evidence: t("evidence"),
      claims: t("claims"),
      artifacts: t("artifacts"),
      kb_notes: t("kb_notes"),
      kb_links: t("kb_links"),
      relations: t("relations"),
      jobs: t("jobs"),
      runs: t("runs"),
      events: t("events"),
    };
  }
}

function str(v: any): string {
  return typeof v === "string" ? v : JSON.stringify(v ?? "");
}

/**
 * Derive an L1 description (what + when) from a note body, for kb promote.
 * Preference order: the first list item near the top, else the first
 * meaningful line (skipping headings and boilerplate like the generated
 * stamp); a provenance tail keeps the source greppable for agent matching.
 */
function deriveL1(body: string, title: string): string {
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
