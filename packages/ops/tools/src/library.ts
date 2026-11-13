/**
 * library: 面向市场的只读经验库出口（#275）。
 *
 * 四类材料（claim/note/skill/check）投影为统一行形，游标分页 + --since，
 * 契约版本 ygl-library/1。只读：不写 events、不 bump hits/reuse。
 * 唯一调用方 = 市场经验库页面（本机 CLI --json / 后续 MCP HTTP）。
 */
import type { Env } from "../../../core/database/src/types";
import { readListIndex } from "./verify-list-index";

export const LIBRARY_CONTRACT = "ygl-library/1";

export type LibraryKind = "claim" | "note" | "skill" | "check";
export const LIBRARY_KINDS: LibraryKind[] = ["claim", "note", "skill", "check"];

export interface LibraryRow {
  kind: LibraryKind;
  id: string;
  title: string;
  summary: string;
  status: string;
  created: string;
  updated: string;
  project?: string;
  scope?: string;
  [key: string]: unknown; // kind-specific fields, absent when unknown — never ""
}

export interface LibraryPage { contract: string; items: LibraryRow[]; total: number; next_cursor: string | null }
export interface LibraryShow { contract: string; kind: LibraryKind; id: string; body?: string; [key: string]: unknown }

export class LibraryUsageError extends Error {}

const CURSOR_SCOPE_MAX = 512;

/** Strict ISO, same acceptance as verify prepare --as-of (#171). */
export function parseSince(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) throw new LibraryUsageError("since must be a strict ISO-8601 datetime (e.g. 2026-11-13T00:00:00Z)");
  return new Date(t).toISOString();
}

function pagination(limitRaw: string | undefined, cursor: string | undefined, scopeKey: string) {
  const raw = limitRaw ?? "200";
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > 500) throw new LibraryUsageError("limit must be an integer from 1 to 500");
  let after: [string, string] | undefined;
  if (cursor !== undefined) {
    if (cursor.length > 4096) throw new LibraryUsageError("invalid cursor for this list");
    let k: any;
    try { k = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch {}
    if (!Array.isArray(k) || k.length !== 3 || k[0] !== scopeKey || typeof k[1] !== "string" || typeof k[2] !== "string")
      throw new LibraryUsageError("invalid cursor for this list");
    after = [k[1], k[2]];
  }
  return { limit: Number(raw), after };
}

function pageEnvelope(rows: LibraryRow[], total: number, limit: number, scopeKey: string): LibraryPage {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    contract: LIBRARY_CONTRACT,
    items,
    total,
    next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([scopeKey, last.updated, last.id])).toString("base64url") : null,
  };
}

/** First paragraph after an optional leading YAML frontmatter block, cut to 200 chars. */
export function firstParagraph(body: string, cut = 200): string {
  let text = body || "";
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end > 0) {
      const after = text.slice(end + 4);
      const nl = after.indexOf("\n");
      // only strip when the --- line is a lone delimiter line (frontmatter shape)
      const between = text.slice(3, end);
      if (!between.includes("\n---") && /^\r?\n/.test(after) === false || nl >= 0) text = after.replace(/^\r?\n/, "");
    }
  }
  const para = text.split(/\r?\n\r?\n/, 1)[0].replace(/\s+/g, " ").trim();
  return para.length > cut ? para.slice(0, cut) : para;
}

/** note scope: #276 lands the column; until then scope is absent (never ""). */
function noteScope(_row: any): string | undefined { return undefined; }

function claimRows(db: any, since: string | null, projectFilter?: string): LibraryRow[] {
  const clauses: string[] = []; const params: string[] = [];
  if (since) { clauses.push("c.updated >= ?"); params.push(since); }
  if (projectFilter) { clauses.push("p.name = ?"); params.push(projectFilter); }
  const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
  return (db.all(
    "SELECT c.id,c.text,c.status,c.confidence,c.channel,c.created,c.updated,p.name AS project FROM claims c LEFT JOIN projects p ON p.id=c.project_id" + where + " ORDER BY c.updated DESC, c.id DESC",
    params) as any[]).map((r) => {
    const row: LibraryRow = {
      kind: "claim", id: r.id, title: r.text,
      summary: r.channel ? `channel:${r.channel}` : "",
      status: r.status === "unverified" ? "open" : r.status,
      created: r.created, updated: r.updated,
    };
    if (r.project) row.project = r.project; // absent when unknown, never ""
    row.confidence = r.confidence;
    return row;
  });
}

function noteRows(db: any, since: string | null): LibraryRow[] {
  const clauses: string[] = []; const params: string[] = [];
  if (since) { clauses.push("updated >= ?"); params.push(since); }
  const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
  return (db.all("SELECT id,title,body,tags,confidence,source_url,created,updated FROM kb_notes" + where + " ORDER BY updated DESC, id DESC", params) as any[]).map((r) => {
    const row: LibraryRow = {
      kind: "note", id: r.id, title: r.title,
      summary: firstParagraph(r.body),
      status: "open",
      created: r.created, updated: r.updated,
    };
    if (r.tags) row.tags = r.tags;
    row.confidence = r.confidence;
    if (r.source_url) row.source_url = r.source_url;
    const scope = noteScope(r); if (scope) row.scope = scope;
    return row;
  });
}

function skillRows(db: any, since: string | null): LibraryRow[] {
  // bundled 技能在表内（origin=builtin:*，db init 预置）；只暴露 promoted（origin=kb:<noteId>）。
  const clauses: string[] = ["origin LIKE 'kb:%'"]; const params: string[] = [];
  if (since) { clauses.push("updated >= ?"); params.push(since); }
  const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
  return (db.all("SELECT id,name,description,tags,origin,enabled,hits,created,updated FROM skills" + where + " ORDER BY updated DESC, id DESC", params) as any[]).map((r) => {
    const m = /^kb:(.+)$/.exec(r.origin || "");
    const row: LibraryRow = {
      kind: "skill", id: r.id, title: r.name,
      summary: r.description || "",
      status: r.enabled ? "enabled" : "disabled",
      created: r.created, updated: r.updated,
      from_note: m ? m[1] : null,
    };
    if (r.tags) row.tags = r.tags;
    return row;
  });
}

function checkRows(indexDb: any, since: string | null): LibraryRow[] {
  const clauses: string[] = []; const params: string[] = [];
  if (since) { clauses.push("finished >= ?"); params.push(since); }
  const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
  const reports = (indexDb.all("SELECT run_id,overall,summary_json,finished FROM reports" + where + " ORDER BY finished DESC, run_id DESC", params) as any[]).map((r) => ({
    kind: "check" as const, id: r.run_id, title: `run ${r.run_id}`,
    summary: (() => { try { const s = JSON.parse(r.summary_json || "{}"); return `pass ${s.pass ?? 0} · fail ${s.fail ?? 0} · error ${s.error ?? 0}`; } catch { return ""; } })(),
    status: r.overall, created: r.finished, updated: r.finished,
  }));
  const archives = (indexDb.all("SELECT archive_id,filename,created FROM archives" + (since ? " WHERE created >= ?" : "") + " ORDER BY created DESC, archive_id DESC", since ? [since] : []) as any[]).map((r) => ({
    kind: "check" as const, id: r.archive_id, title: r.filename || `archive ${r.archive_id}`,
    summary: "", status: "archived", created: r.created, updated: r.created,
  }));
  return [...reports, ...archives].sort((a, b) => (a.updated === b.updated ? a.id.localeCompare(b.id) : a.updated < b.updated ? 1 : -1));
}

export async function libraryList(env: Env, o: {
  kind: LibraryKind; limit?: string; cursor?: string; since?: string; scope?: string; project?: string;
}): Promise<LibraryPage> {
  const since = parseSince(o.since);
  const scopeKey = [o.kind, o.since ?? "", o.scope ?? "", o.project ?? ""].join("|");
  const { limit, after } = pagination(o.limit, o.cursor, scopeKey);
  let rows: LibraryRow[];
  let total: number;
  const count = (r: LibraryRow[]) => r.length; // in-memory counts are fine for workspace scale
  if (o.kind === "check") {
    // check 走 verify 列表索引（与 verify-list 同一事实源，不新建索引文件）
    return readListIndex(env.home, (db) => {
      const all = checkRows(db, since);
      const filtered = after ? all.filter((r) => r.updated < after[0] || (r.updated === after[0] && r.id < after[1])) : all;
      total = count(all);
      return pageEnvelope(filtered, total, limit, scopeKey);
    });
  }
  rows = env.db.all("SELECT 1"); // touch
  const db = env.db as any;
  const all =
    o.kind === "claim" ? claimRows(db, since, o.project) :
    o.kind === "note" ? noteRows(db, since) :
    skillRows(db, since);
  const filtered = after ? all.filter((r) => r.updated < after[0] || (r.updated === after[0] && r.id < after[1])) : all;
  total = all.length;
  return pageEnvelope(filtered, total, limit, scopeKey);
}

export async function libraryShow(env: Env, kind: LibraryKind, id: string): Promise<LibraryShow> {
  const fail = (msg: string): never => { throw Object.assign(new Error(msg), { rc: 1 }); };
  if (kind === "claim") {
    const r = env.db.get("SELECT c.*,p.name AS project FROM claims c LEFT JOIN projects p ON p.id=c.project_id WHERE c.id=? OR c.text=?", [id, id]) as any;
    if (!r) fail(`claim not found: ${id}`);
    const evidence = (env.db.all(
      "SELECT e.quote,e.note,ce.stance,e.created,e.source_id FROM claim_evidence ce JOIN evidence e ON e.id=ce.evidence_id WHERE ce.claim_id=? ORDER BY e.created",
      [r.id]) as any[]).map((e) => ({
      quote: e.quote, note: e.note, stance: e.stance, created: e.created,
      source: (() => { const s = env.db.get("SELECT title,url FROM sources WHERE id=?", [e.source_id]) as any; return s ? { title: s.title, url: s.url } : undefined; })(),
    }));
    const out: LibraryShow = { contract: LIBRARY_CONTRACT, kind, id: r.id, title: r.text, status: r.status, created: r.created, updated: r.updated, confidence: r.confidence, evidence };
    if (r.project) out.project = r.project;
    return out;
  }
  if (kind === "note") {
    const r = env.db.get("SELECT * FROM kb_notes WHERE id=? OR title=?", [id, id]) as any;
    if (!r) fail(`note not found: ${id}`);
    const out: LibraryShow = { contract: LIBRARY_CONTRACT, kind, id: r.id, title: r.title, summary: firstParagraph(r.body), status: "open", created: r.created, updated: r.updated, body: r.body };
    if (r.tags) out.tags = r.tags;
    out.confidence = r.confidence;
    if (r.source_url) out.source_url = r.source_url;
    return out;
  }
  if (kind === "skill") {
    const r = env.db.get("SELECT * FROM skills WHERE id=? OR name=?", [id, id]) as any;
    if (!r) fail(`skill not found: ${id}`);
    const m = /^kb:(.+)$/.exec(r.origin || "");
    const out: LibraryShow = { contract: LIBRARY_CONTRACT, kind, id: r.id, title: r.name, status: r.enabled ? "enabled" : "disabled", created: r.created, updated: r.updated, body: r.body, from_note: m ? m[1] : null };
    if (r.tags) out.tags = r.tags;
    return out;
  }
  // check
  return readListIndex(env.home, (db) => {
    const rep = db.get("SELECT row_json FROM reports WHERE run_id=?", [id]) as any;
    if (rep) {
      const r = JSON.parse(rep.row_json || "{}");
      return { contract: LIBRARY_CONTRACT, kind, id, title: `run ${id}`, status: r.overall ?? "?", created: r.started ?? "", updated: r.finished ?? "", body: rep.row_json } as LibraryShow;
    }
    const arc = db.get("SELECT * FROM archives WHERE archive_id=?", [id]) as any;
    if (arc) return { contract: LIBRARY_CONTRACT, kind, id, title: arc.filename ?? id, status: "archived", created: arc.created, updated: arc.created, body: "" } as LibraryShow;
    throw Object.assign(new Error(`check not found: ${id}`), { rc: 1 });
  });
}