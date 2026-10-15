/**
 * Transactional TypeORM write service — the write path for the research /
 * kb / job domains (docs/conventions.md §五 ruling).
 *
 * Every write wraps THE WHOLE side-effect trio in one ds.transaction:
 *   idempotency (content_hash / url_hash pre-check) + base-row insert +
 *   FTS5 shadow insert (raw SQL — virtual tables are not entities) +
 *   events audit row. The Store era performed these as separate statements;
 *   an FTS failure used to orphan the base row — the transaction closes
 *  that hole.
 *
 * Return shapes are EXPLICIT snake_case plain objects, byte-compatible with
 * the raw-SQL era (the frozen output contract): callers feed them straight
 * into writeResult()/ack(). Event kind strings match Store.log exactly so
 * `agent log` history stays homogeneous.
 */
import { DataSource, EntityManager } from "typeorm";
import { Claim, Evidence, Query, QuerySource, Source } from "./entities/research";
import { Event } from "./entities/core";
import { contentHash, ngram, nowIso, sha1, shortId } from "./text";

export interface WriteResult {
  row: Record<string, any>;
  dup: boolean;
}

async function logEvent(mgr: EntityManager, kind: string, entity: string, entityId: string, payload: any): Promise<void> {
  const p = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  await mgr.insert(Event, {
    id: shortId([kind, entity], 12),
    ts: nowIso(),
    actor: "cli",
    kind,
    entity,
    entityId,
    payload: p,
  });
}

// ================================================================ queries

export async function queryAdd(
  ds: DataSource,
  projectId: string,
  text: string,
  engine = "",
  force = false
): Promise<WriteResult> {
  const hash = contentHash(text, force);
  return ds.transaction(async (mgr) => {
    const ex = await mgr.findOne(Query, { where: { projectId, contentHash: hash } });
    if (ex) return { row: mapQuery(ex), dup: true };
    const q = new Query();
    q.id = shortId(["q", projectId, text], 10);
    q.projectId = projectId;
    q.text = text;
    q.engine = engine;
    q.status = "pending";
    q.note = "";
    q.contentHash = hash;
    q.created = nowIso();
    await mgr.save(q);
    await logEvent(mgr, "query.add", "query", q.id, text);
    return { row: mapQuery(q), dup: false };
  });
}

function mapQuery(q: Query): Record<string, any> {
  return {
    id: q.id, project_id: q.projectId, text: q.text, engine: q.engine,
    status: q.status, note: q.note, content_hash: q.contentHash, created: q.created,
  };
}

// ================================================================ sources

export async function sourceAdd(
  ds: DataSource,
  projectId: string,
  o: {
    title: string; url: string; abstract?: string; content?: string; engine?: string;
    relevance?: number; confidence?: string; tags?: string;
  }
): Promise<WriteResult & { created: boolean }> {
  const url = o.url || "";
  const urlHash = sha1(url || o.title || "");
  return ds.transaction(async (mgr) => {
    const ex = await mgr.findOne(Source, { where: { projectId, urlHash } });
    if (ex) return { row: mapSource(ex), created: false, dup: true };
    const title = o.title || url || "untitled";
    const abstract_ = o.abstract || "";
    const content = o.content || "";
    const s = new Source();
    s.id = shortId(["src", projectId, urlHash], 10);
    s.projectId = projectId;
    s.url = url;
    s.title = title;
    s.urlHash = urlHash;
    s.contentHash = sha1(content || abstract_);
    s.abstract = abstract_;
    s.content = content;
    s.engine = o.engine || "";
    s.relevance = o.relevance ?? 0;
    s.confidence = o.confidence || "B";
    s.tags = o.tags || "";
    s.retrievedAt = nowIso();
    await mgr.save(s);
    await mgr.query(`INSERT INTO sources_fts(id,title,abstract,content,ngram) VALUES(?,?,?,?,?)`, [
      s.id, title, abstract_, content, ngram(`${title} ${abstract_} ${content} ${o.tags || ""}`),
    ]);
    await logEvent(mgr, "source.add", "source", s.id, title);
    return { row: mapSource(s), created: true, dup: false };
  });
}

function mapSource(s: Source): Record<string, any> {
  return {
    id: s.id, project_id: s.projectId, url: s.url, title: s.title, url_hash: s.urlHash,
    content_hash: s.contentHash, abstract: s.abstract, content: s.content, engine: s.engine,
    relevance: s.relevance, confidence: s.confidence, tags: s.tags, retrieved_at: s.retrievedAt,
  };
}

// ================================================================ evidence

export async function evidenceAdd(
  ds: DataSource,
  projectId: string,
  sourceId: string,
  quote: string,
  note = "",
  locator = "",
  force = false
): Promise<WriteResult> {
  const hash = contentHash(quote, force);
  return ds.transaction(async (mgr) => {
    const src = await mgr.findOne(Source, { where: { id: sourceId, projectId } });
    if (!src) throw new Error(`source not found: ${sourceId}`);
    const ex = await mgr.findOne(Evidence, { where: { sourceId, contentHash: hash } });
    if (ex) return { row: mapEvidence(ex), dup: true };
    const e = new Evidence();
    e.id = shortId(["ev", sourceId, quote], 10);
    e.projectId = projectId;
    e.sourceId = sourceId;
    e.quote = quote;
    e.note = note;
    e.locator = locator;
    e.contentHash = hash;
    e.created = nowIso();
    await mgr.save(e);
    await mgr.query(`INSERT INTO evidence_fts(id,quote,ngram) VALUES(?,?,?)`, [e.id, quote, ngram(quote)]);
    await logEvent(mgr, "evidence.add", "evidence", e.id, quote.slice(0, 60));
    return { row: mapEvidence(e), dup: false };
  });
}

function mapEvidence(e: Evidence): Record<string, any> {
  return {
    id: e.id, project_id: e.projectId, source_id: e.sourceId, quote: e.quote,
    note: e.note, locator: e.locator, content_hash: e.contentHash, created: e.created,
  };
}

// ================================================================ claims

export async function claimAdd(
  ds: DataSource,
  projectId: string,
  text: string,
  confidence = "B",
  force = false
): Promise<WriteResult> {
  const hash = contentHash(text, force);
  return ds.transaction(async (mgr) => {
    const ex = await mgr.findOne(Claim, { where: { projectId, contentHash: hash } });
    if (ex) return { row: mapClaim(ex), dup: true };
    const c = new Claim();
    c.id = shortId(["cl", projectId, text], 10);
    c.projectId = projectId;
    c.text = text;
    c.status = "unverified";
    c.confidence = confidence;
    c.contentHash = hash;
    c.created = nowIso();
    await mgr.save(c);
    await logEvent(mgr, "claim.add", "claim", c.id, text.slice(0, 60));
    return { row: mapClaim(c), dup: false };
  });
}

function mapClaim(c: Claim): Record<string, any> {
  return {
    id: c.id, project_id: c.projectId, text: c.text, status: c.status,
    confidence: c.confidence, content_hash: c.contentHash, created: c.created,
  };
}

export async function claimLink(
  ds: DataSource,
  claimId: string,
  evidenceId: string,
  stance: "supports" | "refutes" = "supports"
): Promise<{ status: string }> {
  return ds.transaction(async (mgr) => {
    await mgr.query(
      `INSERT INTO claim_evidence(claim_id,evidence_id,stance) VALUES(?,?,?)
       ON CONFLICT(claim_id,evidence_id) DO UPDATE SET stance=excluded.stance`,
      [claimId, evidenceId, stance]
    );
    const sup = (await mgr.query(
      `SELECT COUNT(*) AS c FROM claim_evidence WHERE claim_id=? AND stance='supports'`, [claimId]
    )) as any[];
    const ref = (await mgr.query(
      `SELECT COUNT(*) AS c FROM claim_evidence WHERE claim_id=? AND stance='refutes'`, [claimId]
    )) as any[];
    const s = Number(sup?.[0]?.c ?? 0);
    const r = Number(ref?.[0]?.c ?? 0);
    const status = s && r ? "contested" : s ? "supported" : r ? "refuted" : "unverified";
    await mgr.update(Claim, { id: claimId }, { status });
    await logEvent(mgr, "claim.link", "claim", claimId, `${stance} ${evidenceId}`);
    return { status };
  });
}

export async function claimResolve(ds: DataSource, claimId: string, status: string, note = ""): Promise<void> {
  return ds.transaction(async (mgr) => {
    await mgr.update(Claim, { id: claimId }, { status });
    await logEvent(mgr, "claim.resolve", "claim", claimId, `${status}${note ? " | " + note : ""}`);
  });
}

// ================================================================ query ↔ source

export async function queryAttach(
  ds: DataSource,
  projectId: string,
  queryIdOrText: string,
  sourceId: string,
  note = ""
): Promise<{ dup: boolean; queryText: string; sourceTitle: string; sourceId: string }> {
  return ds.transaction(async (mgr) => {
    const q = await mgr.findOne(Query, { where: [{ id: queryIdOrText, projectId }, { text: queryIdOrText, projectId }] });
    if (!q) throw new Error(`query not found: ${queryIdOrText}`);
    const s = await mgr.findOne(Source, { where: { id: sourceId, projectId } });
    if (!s) throw new Error(`source not found in this project: ${sourceId}`);
    const ex = await mgr.findOne(QuerySource, { where: { queryId: q.id, sourceId: s.id } });
    if (!ex) {
      const qs = new QuerySource();
      qs.queryId = q.id;
      qs.sourceId = s.id;
      qs.note = note;
      qs.created = nowIso();
      await mgr.save(qs);
      await logEvent(mgr, "query.attach", "query", q.id, s.id);
    }
    return { dup: !!ex, queryText: q.text, sourceTitle: s.title, sourceId: s.id };
  });
}

// ================================================================ kb

export async function kbAdd(
  ds: DataSource,
  o: { title: string; body: string; tags?: string; source_url?: string; origin?: string; confidence?: string; force?: boolean }
): Promise<WriteResult> {
  const hash = contentHash(`${o.title}\n${o.body}`, !!o.force);
  return ds.transaction(async (mgr) => {
    const ex = (await mgr.query(`SELECT * FROM kb_notes WHERE content_hash=?`, [hash])) as any[];
    if (ex.length) return { row: ex[0], dup: true };
    const id = shortId(["kb", o.title], 10);
    const now = nowIso();
    await mgr.query(
      `INSERT INTO kb_notes(id,title,body,source_url,origin,tags,confidence,reuse,content_hash,created,updated)
       VALUES(?,?,?,?,?,?,?,0,?,?,?)`,
      [id, o.title, o.body, o.source_url || "", o.origin || "", o.tags || "", o.confidence || "B", hash, now, now]
    );
    await mgr.query(`INSERT INTO kb_fts(id,title,tags,ngram) VALUES(?,?,?,?)`, [
      id, o.title, o.tags || "", ngram(`${o.title} ${o.tags || ""} ${o.body}`),
    ]);
    await logEvent(mgr, "kb.add", "kb_note", id, o.title);
    return {
      row: {
        id, title: o.title, body: o.body, source_url: o.source_url || "", origin: o.origin || "",
        tags: o.tags || "", confidence: o.confidence || "B", reuse: 0, content_hash: hash, created: now, updated: now,
      },
      dup: false,
    };
  });
}

export async function kbIngestArtifact(ds: DataSource, artifactId: string, force = false): Promise<WriteResult> {
  const a = (await ds.query(`SELECT * FROM artifacts WHERE id=?`, [artifactId])) as any[];
  if (!a.length) throw new Error(`artifact not found: ${artifactId}`);
  return kbAdd(ds, {
    title: a[0].title,
    body: a[0].content,
    tags: a[0].kind,
    origin: `artifact:${a[0].id}`,
    confidence: "B",
    force,
  });
}

// ================================================================ jobs

export async function jobAdd(
  ds: DataSource,
  o: { title: string; command: string; every?: number; at?: string; force?: boolean }
): Promise<WriteResult> {
  return ds.transaction(async (mgr) => {
    const ex = (await mgr.query(`SELECT * FROM jobs WHERE title=?`, [o.title])) as any[];
    if (ex.length && !o.force) return { row: ex[0], dup: true };
    let title = o.title;
    if (o.force) {
      let i = 2;
      // eslint-disable-next-line no-constant-condition
      while ((((await mgr.query(`SELECT 1 AS hit FROM jobs WHERE title=?`, [title])) as any[]).length)) title = `${o.title}-${i++}`;
    }
    const id = shortId(["job", title], 10);
    const created = nowIso();
    await mgr.query(
      `INSERT INTO jobs(id,title,command,every_minutes,at,enabled,runs,last_run,status,created)
       VALUES(?,?,?,?,?,1,0,'','pending',?)`,
      [id, title, o.command, o.every ?? 0, o.at || "", created]
    );
    await logEvent(mgr, "job.add", "job", id, title);
    return {
      row: {
        id, title, command: o.command, every_minutes: o.every ?? 0, at: o.at || "",
        enabled: 1, runs: 0, last_run: "", status: "pending", created,
      },
      dup: false,
    };
  });
}

// ================================================================ artifacts (versioned appends, batch 2)

export async function artifactAdd(
  ds: DataSource,
  projectId: string,
  kind: string,
  title: string,
  content: string,
  format = "markdown"
): Promise<{ row: Record<string, any>; version: number }> {
  return ds.transaction(async (mgr) => {
    // version numbering inside the transaction — no duplicate versions under concurrency
    const max = (await mgr.query(
      `SELECT COALESCE(MAX(version),0) AS m FROM artifacts WHERE project_id=? AND kind=? AND title=?`,
      [projectId, kind, title]
    )) as any[];
    const ver = Number(max?.[0]?.m ?? 0) + 1;
    const id = shortId(["art", projectId, kind, title, String(ver)], 10);
    const created = nowIso();
    await mgr.query(
      `INSERT INTO artifacts(id,project_id,kind,title,format,content,version,created) VALUES(?,?,?,?,?,?,?,?)`,
      [id, projectId, kind, title, format, content, ver, created]
    );
    await logEvent(mgr, "artifact.add", "artifact", id, `${kind}:${title} v${ver}`);
    return {
      row: { id, project_id: projectId, kind, title, format, content, version: ver, created },
      version: ver,
    };
  });
}

// ================================================================ skills (batch 2)

export async function skillUpsert(
  ds: DataSource,
  o: { name: string; description?: string; body?: string; tags?: string; version?: string; origin?: string }
): Promise<Record<string, any>> {
  return ds.transaction(async (mgr) => {
    const now = nowIso();
    await mgr.query(
      `INSERT INTO skills(id,name,version,description,body,tags,origin,created,updated)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET
         version=excluded.version, description=excluded.description, body=excluded.body,
         tags=excluded.tags, origin=excluded.origin, updated=excluded.updated`,
      [shortId(["skill", o.name], 10), o.name, o.version || "0.1.0", o.description || "", o.body || "", o.tags || "", o.origin || "", now, now]
    );
    const rows = (await mgr.query(`SELECT * FROM skills WHERE name=?`, [o.name])) as any[];
    const s = rows[0];
    // FTS shadow refresh in the SAME transaction (delete+reinsert, Store-era discipline)
    await mgr.query(`DELETE FROM skills_fts WHERE id=?`, [s.id]);
    await mgr.query(`INSERT INTO skills_fts(id,name,description,tags,ngram) VALUES(?,?,?,?,?)`, [
      s.id, s.name, s.description, s.tags, ngram(`${s.name} ${s.description} ${s.tags} ${s.body}`),
    ]);
    await logEvent(mgr, "skill.upsert", "skill", s.id, s.name);
    return s;
  });
}

export async function skillDel(ds: DataSource, name: string): Promise<void> {
  return ds.transaction(async (mgr) => {
    const rows = (await mgr.query(`SELECT id FROM skills WHERE name=?`, [name])) as any[];
    if (!rows.length) throw new Error(`skill not found: ${name}`);
    await mgr.query(`DELETE FROM skills_fts WHERE id=?`, [rows[0].id]);
    await mgr.query(`DELETE FROM skills WHERE id=?`, [rows[0].id]);
  });
}

export async function skillEnabled(ds: DataSource, name: string, on: boolean): Promise<boolean> {
  return ds.transaction(async (mgr) => {
    const rows = (await mgr.query(`SELECT id FROM skills WHERE name=?`, [name])) as any[];
    if (!rows.length) return false;
    await mgr.query(`UPDATE skills SET enabled=?, updated=? WHERE id=?`, [on ? 1 : 0, nowIso(), rows[0].id]);
    return true;
  });
}

export async function skillRefAdd(
  ds: DataSource,
  skillName: string,
  refPath: string,
  content: string
): Promise<Record<string, any>> {
  return ds.transaction(async (mgr) => {
    const s = (await mgr.query(`SELECT id FROM skills WHERE name=?`, [skillName])) as any[];
    if (!s.length) throw new Error(`skill not found: ${skillName}`);
    const id = shortId(["ref", s[0].id, refPath], 10);
    await mgr.query(
      `INSERT INTO skill_refs(id,skill_id,path,content) VALUES(?,?,?,?)
       ON CONFLICT(skill_id,path) DO UPDATE SET content=excluded.content`,
      [id, s[0].id, refPath, content]
    );
    const rows = (await mgr.query(`SELECT * FROM skill_refs WHERE skill_id=? AND path=?`, [s[0].id, refPath])) as any[];
    return rows[0];
  });
}

// ================================================================ projects (batch 2)

export async function projectCreate(ds: DataSource, name: string, question = ""): Promise<Record<string, any>> {
  return ds.transaction(async (mgr) => {
    const now = nowIso();
    const id = shortId(["proj", name], 10);
    await mgr.query(
      `INSERT INTO projects(id,name,question,status,created,updated) VALUES(?,?,?,'active',?,?)`,
      [id, name, question, now, now]
    );
    // selecting the new project is part of the create — same transaction
    await mgr.query(
      `INSERT INTO meta(key,value) VALUES('current_project',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [name]
    );
    await logEvent(mgr, "project.create", "project", id, name);
    const rows = (await mgr.query(`SELECT * FROM projects WHERE id=?`, [id])) as any[];
    return rows[0];
  });
}
