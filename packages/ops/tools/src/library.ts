/**
 * library: 面向市场的只读经验库出口（#275）。
 *
 * 四类材料（claim/note/skill/check）投影为统一行形，游标分页 + --since，
 * 契约版本 ygl-library/1。只读：不写 events、不 bump hits/reuse。
 * 唯一调用方 = 市场经验库页面（本机 CLI --json / 后续 MCP HTTP）。
 */
import type { Env } from "../../../core/database/src/types";
import { readListIndex, prepareListIndex } from "./verify-list-index";
import { strictIsoTimestamp, AsOfError } from "./as-of";

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
  if (raw === undefined || raw === "") return null;
  // #278 review③：verify prepare --as-of 同款严格 ISO（Date.parse 会吞 "Nov 13 2026" 等松散形）
  try { return strictIsoTimestamp(raw, "since"); }
  catch (e) { if (e instanceof AsOfError) throw new LibraryUsageError(e.message); throw e; }
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
  // review⑨ plain rule: a leading --- line stripped only when a closing --- line exists
  let text = body || "";
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[0].trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close > 0) text = lines.slice(close + 1).join("\n");
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
      // review②：channel 属 never-exposed——summary 用首条 evidence note（无则空串）
      summary: (() => { const e0 = db.get("SELECT e.note FROM claim_evidence ce JOIN evidence e ON e.id=ce.evidence_id WHERE ce.claim_id=? ORDER BY e.created LIMIT 1", [r.id]) as any; return (e0?.note && String(e0.note).trim()) || ""; })(),
      status: r.status === "unverified" ? "open" : r.status,
      created: r.created, updated: r.updated,
    };
    if (r.project) row.project = r.project; // absent when unknown, never ""
    const conf = typeof r.confidence === "string" && r.confidence.trim() ? r.confidence : undefined; if (conf) row.confidence = conf; // review⑦：空则缺席
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
    if (typeof r.confidence === "string" && r.confidence.trim()) row.confidence = r.confidence; // review⑦
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
  return (db.all("SELECT id,name,version,description,tags,origin,enabled,hits,created,updated FROM skills" + where + " ORDER BY updated DESC, id DESC", params) as any[]).map((r) => {
    const m = /^kb:(.+)$/.exec(r.origin || "");
    const row: LibraryRow = {
      kind: "skill", id: r.id, title: r.name,
      summary: r.description || "",
      status: r.enabled ? "enabled" : "disabled",
      created: r.created, updated: r.updated,
      from_note: m ? m[1] : null,
    };
    if (r.version) row.version = r.version; // review⑥
    if (r.tags) row.tags = r.tags;
    return row;
  });
}

/** check 行 = verify run 行（一 run 一行；#278 review①）。句柄是 better-sqlite3：prepare().all(...)。
 *  reports(run_id,spec_id,finished,overall,row_json)；archived 计数来自 archives 表。 */
function checkRows(indexDb: any, since: string | null, specTitles: Record<string, string>): LibraryRow[] {
  const clauses: string[] = []; const params: string[] = [];
  if (since) { clauses.push("r.finished >= ?"); params.push(since); }
  const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
  const sql = "SELECT r.row_json,(SELECT COUNT(*) FROM archives a WHERE a.run_id=r.run_id) n_arch,(SELECT a2.row_json FROM archives a2 WHERE a2.run_id=r.run_id ORDER BY a2.created DESC LIMIT 1) first_archive FROM reports r" + where + " ORDER BY r.finished DESC, r.run_id DESC";
  return (indexDb.prepare(sql).all(...params) as any[]).map((r: any) => {
    let j: any = {}; try { j = JSON.parse(r.row_json || "{}"); } catch {}
    let arc: any = null; try { arc = r.first_archive ? JSON.parse(r.first_archive) : null; } catch {}
    const s = j.summary || {};
    // #278 review-B：binary_sha256 是 reportSummary 顶层字段；archive_sha256 属归档行；archived 布尔；signature 取报告 footer 身份
    const row: LibraryRow = {
      kind: "check", id: j.run_id || "",
      title: specTitles[j.spec_id] || j.spec_id || `run ${j.run_id || ""}`, // title = spec title
      summary: `pass ${s.pass ?? 0} · fail ${s.fail ?? 0} · error ${s.error ?? 0}`,
      status: j.overall || "?",
      created: j.started || "", updated: j.finished || "",
      spec_id: j.spec_id || "",
      finished: j.finished || "",
      archived: Number(r.n_arch || 0) > 0,
    };
    if (arc?.archive_sha256) row.archive_sha256 = arc.archive_sha256;
    row.signature = j.signature ? "signed" : (j.mode === "sealed" ? "legacy" : "none");
    return row;
  });
}

/** 从 $YGL_HOME/verify/<spec>/spec.json 建 spec_id→title 映射（#278 review-B：title=spec title）。 */
async function specTitleMap(home: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const root = join(home, "verify");
    for (const d of await readdir(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try {
        const j = JSON.parse(await readFile(join(root, d.name, "spec.json"), "utf8"));
        if (j?.spec_id && j?.title) out[String(j.spec_id)] = String(j.title);
      } catch { /* 无 spec.json 的目录跳过 */ }
    }
  } catch { /* verify 根不存在 */ }
  return out;
}

/** CLI 面必须自备索引（review①）：未备则先调和再读。 */
async function ensureIndex(env: Env): Promise<void> {
  try { readListIndex(env.home, () => undefined); } catch {
    await prepareListIndex(env.home);
    readListIndex(env.home, () => undefined);
  }
}

export async function libraryList(env: Env, o: {
  kind: LibraryKind; limit?: string; cursor?: string; since?: string; scope?: string; project?: string;
}): Promise<LibraryPage> {
  // #278 review④：#276 落地前 --scope 必须 rc 2——静默忽略等于访问泄漏
  if (o.scope !== undefined && o.scope !== "") throw new LibraryUsageError("scope filter needs #276 (the kb/skill scope column is not shipped yet)");
  const since = parseSince(o.since);
  const scopeKey = [o.kind, o.since ?? "", o.scope ?? "", o.project ?? ""].join("|");
  const { limit, after } = pagination(o.limit, o.cursor, scopeKey);
  let total: number;
  const count = (r: LibraryRow[]) => r.length; // in-memory counts are fine for workspace scale
  if (o.kind === "check") {
    // check 走 verify 列表索引（与 verify-list 同一事实源，不新建索引文件）。CLI 面必须自备索引（review①）。
    await ensureIndex(env);
    const specTitles = await specTitleMap(env.home);
    return readListIndex(env.home, (db) => {
      const all = checkRows(db, since, specTitles);
      const filtered = after ? all.filter((r) => r.updated < after[0] || (r.updated === after[0] && r.id < after[1])) : all;
      total = count(all);
      return pageEnvelope(filtered, total, limit, scopeKey);
    });
  }
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
    // review⑧：show = {...row, body}——补 summary 与 body；confidence 空则缺席（review⑦）
    const firstEv = evidence[0];
    const out: LibraryShow = { contract: LIBRARY_CONTRACT, kind, id: r.id, title: r.text, summary: (firstEv?.note || "").trim(), status: r.status, created: r.created, updated: r.updated, evidence };
    if (typeof r.confidence === "string" && r.confidence.trim()) out.confidence = r.confidence;
    if (r.project) out.project = r.project;
    out.body = r.text;
    return out;
  }
  if (kind === "note") {
    const r = env.db.get("SELECT * FROM kb_notes WHERE id=? OR title=?", [id, id]) as any;
    if (!r) fail(`note not found: ${id}`);
    const out: LibraryShow = { contract: LIBRARY_CONTRACT, kind, id: r.id, title: r.title, summary: firstParagraph(r.body), status: "open", created: r.created, updated: r.updated, body: r.body };
    if (r.tags) out.tags = r.tags;
    if (typeof r.confidence === "string" && r.confidence.trim()) out.confidence = r.confidence;
    if (r.source_url) out.source_url = r.source_url;
    return out;
  }
  if (kind === "skill") {
    // review⑤：show 与 list 同规则——只认 promoted（origin LIKE kb:%）；bundled/未知 rc 1
    const r = env.db.get("SELECT * FROM skills WHERE (id=? OR name=?) AND origin LIKE 'kb:%'", [id, id]) as any;
    if (!r) fail(`skill not found: ${id}`);
    const m = /^kb:(.+)$/.exec(r.origin || "");
    const out: LibraryShow = { contract: LIBRARY_CONTRACT, kind, id: r.id, title: r.name, status: r.enabled ? "enabled" : "disabled", created: r.created, updated: r.updated, body: r.body, from_note: m ? m[1] : null };
    if (r.tags) out.tags = r.tags;
    return out;
  }
  // check show：run 行（一 run 一行）；body=row_json 去掉本地路径（review①：data_source.source 不出口）
  await ensureIndex(env);
  return readListIndex(env.home, (db) => {
    const rep = db.prepare("SELECT row_json FROM reports WHERE run_id=?").get(id) as any;
    if (rep) {
      let j: any = {}; try { j = JSON.parse(rep.row_json || "{}"); } catch {}
      if (j?.data_source && typeof j.data_source === "object") delete j.data_source.source; // 本地路径
      const s = j.summary || {};
      return {
        contract: LIBRARY_CONTRACT, kind, id,
        title: j.spec_id ? `verify ${j.spec_id}` : `run ${id}`,
        summary: `pass ${s.pass ?? 0} · fail ${s.fail ?? 0} · error ${s.error ?? 0}`,
        status: j.overall ?? "?", created: j.started ?? "", updated: j.finished ?? "",
        spec_id: j.spec_id || "", finished: j.finished || "",
        body: JSON.stringify(j),
      } as LibraryShow;
    }
    throw Object.assign(new Error(`check not found: ${id}`), { rc: 1 });
  });
}