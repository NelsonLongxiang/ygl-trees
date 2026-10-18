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
import { Claim, Evidence, Query, QuerySource, Source } from "./entities";
import { Event } from "../../../core/database/src/entities";
import { contentHash, ngram, nowIso, sha1, shortId } from "../../../core/text/src/text";
import { ormDialect } from "../../../core/database/src/orm";
// 0.91a (Cordis review direct-032bf3b4): static import — the old
// `require()`-in-try/catch form silently dies under ESM hosts (vitest),
// the exact disease M7-3 fixed in database/plugin.ts. The bus is core→core
// with zero dependency cycle, so a static import costs nothing at load.
import { emitEvent, YglEvent } from "../../../core/text/src/eventbus";

/** 0.91a: run a write transaction with post-commit event flush.
 *
 * The events-table INSERT stays INSIDE the transaction (the audit row must
// roll back with the write), but the cross-domain bus emission moves to
// AFTER ds.transaction resolves — TypeORM only resolves on commit, so
// subscribers can never observe an event whose row is not durable. A
 * rollback (fn throws → transaction rejects) discards the pending bag:
 * zero ghost events by construction (acceptance ① of the batch). */
export async function runTx<T>(ds: DataSource, fn: (mgr: EntityManager) => Promise<T>): Promise<T> {
  const pending: YglEvent[] = [];
  const result = await ds.transaction(async (mgr) => {
    (mgr as any).__yglPendingEvents = pending;
    return fn(mgr);
  });
  // 0.91a review (direct-55b4ca85): never block the write path — a throwing
  // subscriber must not surface out of a COMMITTED transaction (the write is
  // durable; only the notification is lost, same contract as the old
  // require-in-catch form).
  try {
    for (const ev of pending) emitEvent(ev);
  } catch { /* bus subscribers are best-effort — write already committed */ }
  return result;
}

/** 0.89 (PG-A ②): FTS5 shadow tables are SQLite-only virtual tables — the PG
 * mirror carries full-text as a tsvector column recomputed at sync time. Gate
 * every shadow write so the same transaction body runs on both dialects (the
 * B-segment dual-write would otherwise crash on missing _fts relations). */
async function ftsShadow(mgr: EntityManager, sql: string, params: unknown[]): Promise<void> {
  if (ormDialect(mgr) !== "sqlite") return;
  await mgr.query(sql, params as any[]);
}

export interface WriteResult {
  row: Record<string, any>;
  dup: boolean;
}

async function logEvent(mgr: EntityManager, kind: string, entity: string, entityId: string, payload: any, level: "info" | "warn" | "error" = "info"): Promise<void> {
  // R10.3: object payloads carry the run id so `agent log --run` can
  // reconstruct one CLI invocation; R10.2 severity is pre-mapped here.
  let obj = typeof payload === "string" ? payload : payload ?? "";
  const run = process.env.YGL_RUN_ID || "";
  if (run && typeof obj === "object") obj = { ...obj, run };
  const p = typeof obj === "string" ? obj : JSON.stringify(obj);
  await mgr.insert(Event, {
    id: shortId([kind, entity], 12),
    ts: nowIso(),
    actor: "cli",
    kind,
    entity,
    entityId,
    payload: p,
    level,
  });
  // 0.91a: snapshot the payload at log time (callers may mutate objects
  // after the call) and stash it on the transaction-scoped pending bag —
  // runTx flushes to the bus after commit. Outside runTx (no pending bag)
  // emit immediately: a bare INSERT in autocommit mode is already durable.
  const snap: YglEvent = { kind, entity, entityId, payload: String(payload), ts: new Date().toISOString() };
  const pending: YglEvent[] | undefined = (mgr as any).__yglPendingEvents;
  if (pending) pending.push(snap);
  else emitEvent(snap);
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
  return runTx(ds, async (mgr) => {
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
  return runTx(ds, async (mgr) => {
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
    // v9: creation timestamp (distinct from retrievedAt which is fetch time)
    s.created = nowIso();
    await mgr.save(s);
    await ftsShadow(mgr, `INSERT INTO sources_fts(id,title,abstract,content,ngram) VALUES(?,?,?,?,?)`, [
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
  return runTx(ds, async (mgr) => {
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
    await ftsShadow(mgr, `INSERT INTO evidence_fts(id,quote,ngram) VALUES(?,?,?)`, [e.id, quote, ngram(quote)]);
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
  force = false,
  channel = ""
): Promise<WriteResult> {
  const hash = contentHash(text, force);
  return runTx(ds, async (mgr) => {
    const ex = await mgr.findOne(Claim, { where: { projectId, contentHash: hash } });
    if (ex) return { row: mapClaim(ex), dup: true };
    const c = new Claim();
    c.id = shortId(["cl", projectId, text], 10);
    c.projectId = projectId;
    c.text = text;
    c.status = "unverified";
    c.confidence = confidence;
    // always assign: TypeORM binds explicit NULL for unset entity props,
    // bypassing the SQL DEFAULT and tripping claims.channel NOT NULL.
    c.channel = channel || "";
    c.contentHash = hash;
    c.created = nowIso(); (c as any).updated = nowIso();
    await mgr.save(c);
    await logEvent(mgr, "claim.add", "claim", c.id, text.slice(0, 60));
    return { row: mapClaim(c), dup: false };
  });
}

function mapClaim(c: Claim): Record<string, any> {
  return {
    id: c.id, project_id: c.projectId, text: c.text, status: c.status,
    confidence: c.confidence, content_hash: c.contentHash, created: c.created,
    channel: c.channel || "",
  };
}

export async function claimLink(
  ds: DataSource,
  claimId: string,
  evidenceId: string,
  stance: "supports" | "refutes" = "supports"
): Promise<{ status: string; auto_promote: boolean }> {
  return runTx(ds, async (mgr) => {
    // Resolve both ends before writing: a bad/foreign id must surface as a
    // named not-found, not as a raw FOREIGN KEY constraint failure.
    const c = (await mgr.query(`SELECT id, text FROM claims WHERE id=?`, [claimId])) as any[];
    if (!c.length) throw new Error(`claim not found: ${claimId}`);
    const e = (await mgr.query(`SELECT id FROM evidence WHERE id=?`, [evidenceId])) as any[];
    if (!e.length) throw new Error(`evidence not found: ${evidenceId}`);
    await mgr.query(
      `INSERT INTO claim_evidence(claim_id,evidence_id,stance) VALUES(?,?,?)
       ON CONFLICT(claim_id,evidence_id) DO UPDATE SET stance=excluded.stance`,
      [claimId, evidenceId, stance]
    );
    // 0.82.1 (user report ③): prediction claims (`[预测·…]` prefix) must NOT
    // auto-promote on link — predict audit treats supported/refuted as
    // human-arbitrated (terminal), so a mere evidence link would kick the
    // prediction out of the tracking table before its deadline. Evidence
    // linking is evidence gathering; arbitration stays an explicit
    // `claim resolve` (frozen contract, same discipline as predict audit).
    const text = String(c[0]?.text ?? "");
    if (text.startsWith("[预测·")) {
      const cur = (await mgr.query(`SELECT status FROM claims WHERE id=?`, [claimId])) as any[];
      const status = String(cur?.[0]?.status ?? "unverified");
      await logEvent(mgr, "claim.link", "claim", claimId, `${stance} ${evidenceId} (prediction: auto-promote skipped)`);
      return { status, auto_promote: false };
    }
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
    return { status, auto_promote: true };
  });
}

/** 0.82.1 (user report ③): reset an auto-promoted / wrongly arbitrated claim
 * back to unverified — the repair channel for link side effects on
 * predictions (and for any claim arbitrated too early). Idempotent: already
 * unverified → duplicate:true, no event spam. */
export async function claimUnresolve(ds: DataSource, claimId: string): Promise<{ status: string; duplicate: boolean }> {
  return runTx(ds, async (mgr) => {
    const c = (await mgr.query(`SELECT id, status FROM claims WHERE id=?`, [claimId])) as any[];
    if (!c.length) throw new Error(`claim not found: ${claimId}`);
    if (String(c[0]?.status) === "unverified") return { status: "unverified", duplicate: true };
    await mgr.update(Claim, { id: claimId }, { status: "unverified", updated: nowIso() } as any);
    await logEvent(mgr, "claim.unresolve", "claim", claimId, `${c[0]?.status} → unverified`);
    return { status: "unverified", duplicate: false };
  });
}

export async function claimResolve(ds: DataSource, claimId: string, status: string, note = ""): Promise<void> {
  return runTx(ds, async (mgr) => {
    // v9: update the timestamp when the claim is resolved
    await mgr.update(Claim, { id: claimId }, { status, updated: nowIso() } as any);
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
  return runTx(ds, async (mgr) => {
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
  return runTx(ds, async (mgr) => {
    const ex = (await mgr.query(`SELECT * FROM kb_notes WHERE content_hash=?`, [hash])) as any[];
    if (ex.length) return { row: ex[0], dup: true };
    const id = shortId(["kb", o.title], 10);
    const now = nowIso();
    await mgr.query(
      `INSERT INTO kb_notes(id,title,body,source_url,origin,tags,confidence,reuse,content_hash,created,updated)
       VALUES(?,?,?,?,?,?,?,0,?,?,?)`,
      [id, o.title, o.body, o.source_url || "", o.origin || "", o.tags || "", o.confidence || "B", hash, now, now]
    );
    await ftsShadow(mgr, `INSERT INTO kb_fts(id,title,tags,ngram) VALUES(?,?,?,?)`, [
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

/**
 * Bulk kb import — ONE transaction for the whole batch. Per-note commits
 * (WAL fsync each) measured ~20ms/note on the real-data trial (2189 notes
 * = 44s); in-transaction row work is memory-bound until the single COMMIT.
 */
export interface KbImportItem {
  title: string;
  body: string;
  tags?: string;
  source_url?: string;
  origin?: string;
  confidence?: string;
}

export async function kbImportBulk(ds: DataSource, items: KbImportItem[]): Promise<{ added: number; dups: number }> {
  return runTx(ds, async (mgr) => {
    let added = 0;
    let dups = 0;
    for (const o of items) {
      const hash = contentHash(`${o.title}\n${o.body}`, false);
      const ex = (await mgr.query(`SELECT id FROM kb_notes WHERE content_hash=?`, [hash])) as any[];
      if (ex.length) {
        dups++;
        continue;
      }
      const id = shortId(["kb", o.title], 10);
      const now = nowIso();
      await mgr.query(
        `INSERT INTO kb_notes(id,title,body,source_url,origin,tags,confidence,reuse,content_hash,created,updated)
         VALUES(?,?,?,?,?,?,?,0,?,?,?)`,
        [id, o.title, o.body, o.source_url || "", o.origin || "", o.tags || "", o.confidence || "B", hash, now, now]
      );
      await ftsShadow(mgr, `INSERT INTO kb_fts(id,title,tags,ngram) VALUES(?,?,?,?)`, [
        id, o.title, o.tags || "", ngram(`${o.title} ${o.tags || ""} ${o.body}`),
      ]);
      await logEvent(mgr, "kb.add", "kb_note", id, o.title);
      added++;
    }
    return { added, dups };
  });
}

// ================================================================ jobs

export async function jobAdd(
  ds: DataSource,
  o: { title: string; command: string; every?: number; at?: string; force?: boolean }
): Promise<WriteResult> {
  return runTx(ds, async (mgr) => {
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
  format = "markdown",
  meta = ""
): Promise<{ row: Record<string, any>; version: number }> {
  return runTx(ds, async (mgr) => {
    // version numbering inside the transaction — no duplicate versions under concurrency
    const max = (await mgr.query(
      `SELECT COALESCE(MAX(version),0) AS m FROM artifacts WHERE project_id=? AND kind=? AND title=?`,
      [projectId, kind, title]
    )) as any[];
    const ver = Number(max?.[0]?.m ?? 0) + 1;
    const id = shortId(["art", projectId, kind, title, String(ver)], 10);
    const created = nowIso();
    await mgr.query(
      `INSERT INTO artifacts(id,project_id,kind,title,format,content,version,created,meta) VALUES(?,?,?,?,?,?,?,?,?)`,
      [id, projectId, kind, title, format, content, ver, created, meta]
    );
    await logEvent(mgr, "artifact.add", "artifact", id, `${kind}:${title} v${ver}`);
    return {
      row: { id, project_id: projectId, kind, title, format, content, version: ver, created, meta },
      version: ver,
    };
  });
}

// ================================================================ engineering artifacts (spec R12, 0.32)

const TASK_STATUSES = ["todo", "doing", "done"] as const;

/** Create a task artifact (kind=task, status machine in the meta envelope). */
export async function taskAdd(ds: DataSource, projectId: string, title: string, note = ""): Promise<Record<string, any>> {
  const r = await artifactAdd(ds, projectId, "task", title, note, "markdown", JSON.stringify({ status: "todo" }));
  return r.row;
}

/** Move a task along its state machine (todo|doing|done); logs task.status. */
export async function taskSetStatus(ds: DataSource, taskId: string, status: string): Promise<Record<string, any>> {
  if (!(TASK_STATUSES as readonly string[]).includes(status)) throw new Error(`status must be one of ${TASK_STATUSES.join("|")}`);
  return runTx(ds, async (mgr) => {
    const rows = (await mgr.query(`SELECT * FROM artifacts WHERE id=? AND kind='task'`, [taskId])) as any[];
    if (!rows.length) throw new Error(`task not found: ${taskId}`);
    let meta: any = {};
    try { meta = rows[0].meta ? JSON.parse(rows[0].meta) : {}; } catch { /* malformed → reset */ }
    const from = meta.status || "todo";
    await mgr.query(`UPDATE artifacts SET meta=?, updated=? WHERE id=?`, [JSON.stringify({ ...meta, status }), nowIso(), taskId]);
    await logEvent(mgr, "task.status", "task", taskId, `${from} → ${status}`, status === "done" ? "info" : "info");
    return { id: taskId, title: rows[0].title, from, to: status };
  });
}

// ================================================================ skills (batch 2)

export async function skillUpsert(
  ds: DataSource,
  o: { name: string; description?: string; body?: string; tags?: string; version?: string; origin?: string }
): Promise<Record<string, any>> {
  return runTx(ds, async (mgr) => {
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
    await ftsShadow(mgr, `DELETE FROM skills_fts WHERE id=?`, [s.id]);
    await ftsShadow(mgr, `INSERT INTO skills_fts(id,name,description,tags,ngram) VALUES(?,?,?,?,?)`, [
      s.id, s.name, s.description, s.tags, ngram(`${s.name} ${s.description} ${s.tags} ${s.body}`),
    ]);
    await logEvent(mgr, "skill.upsert", "skill", s.id, s.name);
    return s;
  });
}

export async function skillDel(ds: DataSource, name: string): Promise<void> {
  return runTx(ds, async (mgr) => {
    const rows = (await mgr.query(`SELECT id FROM skills WHERE name=?`, [name])) as any[];
    if (!rows.length) throw new Error(`skill not found: ${name}`);
    await ftsShadow(mgr, `DELETE FROM skills_fts WHERE id=?`, [rows[0].id]);
    await mgr.query(`DELETE FROM skills WHERE id=?`, [rows[0].id]);
  });
}

export async function skillEnabled(ds: DataSource, name: string, on: boolean): Promise<boolean> {
  return runTx(ds, async (mgr) => {
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
  return runTx(ds, async (mgr) => {
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

/** R16.2: `project new` selects via the SESSION key only — the global
 *  pointer is demoted to migration fallback and must not be re-pointed
 *  implicitly (parallel sessions used to steal each other's selection). */
export async function projectCreate(ds: DataSource, name: string, question = ""): Promise<Record<string, any>> {
  return runTx(ds, async (mgr) => {
    // Idempotency (frozen contract): re-creating a project selects it instead
    // of failing on the UNIQUE name — "new" is also the switch verb.
    const sessionKey = `current_project@${process.env.YGL_SESSION || process.env.DSH_SESSION_ID || "default"}`;
    const existing = (await mgr.query(`SELECT * FROM projects WHERE name=?`, [name])) as any[];
    if (existing.length) {
      await mgr.query(
        `INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        [sessionKey, name]
      );
      return { ...existing[0], duplicate: true };
    }
    const now = nowIso();
    const id = shortId(["proj", name], 10);
    await mgr.query(
      `INSERT INTO projects(id,name,question,status,created,updated) VALUES(?,?,?,'active',?,?)`,
      [id, name, question, now, now]
    );
    // selecting the new project is part of the create — same transaction
    await mgr.query(
      `INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [sessionKey, name]
    );
    await logEvent(mgr, "project.create", "project", id, name);
    const rows = (await mgr.query(`SELECT * FROM projects WHERE id=?`, [id])) as any[];
    return rows[0];
  });
}
