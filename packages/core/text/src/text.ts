/** Text helpers: mixed CN/EN tokenization, ids, hashing, time. */

const CJK = "\\u4e00-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff";
const CJK_RE = new RegExp(`[${CJK}]`, "u");
const CJK_RUN_RE = new RegExp(`[${CJK}]+|[^\\s${CJK}]+`, "gu");
const CJK_ONLY_RE = new RegExp(`^[${CJK}]+$`, "u");

export function nowIso(): string {
  // 0.87.1: TRUE ISO-8601 UTC. The original implementation returned a
  // local-time "YYYY-MM-DD HH:MM:SS" string while sibling writers used
  // new Date().toISOString() — text-comparing the two formats ranks every
  // ISO row after every space-format row regardless of real time, which
  // silently corrupted ORDER BY ts windows (agent log, event tails).
  return new Date().toISOString();
}

export function stampId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
}

export function slug(text: string, limit = 40): string {
  const s = (text || "")
    .trim()
    .toLowerCase()
    .replace(new RegExp(`[^\\w${CJK}]+`, "gu"), "-")
    .replace(/^-+|-+$/g, "");
  if (s.length <= limit) return s || "item";
  return s.slice(0, limit).replace(/-+$/, "") || "item";
}

/**
 * Tokenize mixed Chinese/English text for SQLite FTS5.
 *
 * FTS5's default unicode61 tokenizer treats a whole CJK sentence as one token,
 * which makes Chinese search degrade to exact match. We expand CJK runs into
 * character bigrams and keep latin words intact.
 */
export function ngram(text: string): string {
  const src = (text || "").normalize("NFKC").toLowerCase();
  const out: string[] = [];
  const segs = src.match(CJK_RUN_RE) || [];
  for (const seg of segs) {
    if (CJK_ONLY_RE.test(seg)) {
      if (seg.length === 1) out.push(seg);
      else for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
    } else {
      const w = seg.replace(/^[^\w]+|[^\w]+$/gu, "");
      if (w) out.push(w);
    }
  }
  return out.join(" ");
}

export function sha1(text: string): string {
  const crypto = require("node:crypto") as typeof import("crypto");
  return crypto.createHash("sha1").update(text || "").digest("hex");
}

/** Content hash for idempotent writes (single source: store writes and the
 *  TypeORM write service must produce identical hashes); --force salts it
 *  so a duplicate row is explicitly distinct (queryable via `db dups`). */
export function contentHash(content: string, force: boolean): string {
  return sha1(content) + (force ? `#f${Date.now()}${Math.random()}` : "");
}

export function shortId(parts: string[], n = 8): string {
  return sha1(parts.join("|") + Date.now() + Math.random()).slice(0, n);
}

/** Truncate for table display, collapsing newlines. */
export function clip(text: string, n = 40): string {
  const one = (text || "").replace(/\s+/g, " ").trim();
  return one.length <= n ? one : one.slice(0, Math.max(1, n - 1)) + "…";
}

/**
 * Minimal SKILL.md frontmatter parser: supports `key: value`, quoted scalars,
 * folded blocks (`>-` / `>`) and inline `a,b` lists.
 */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  let key: string | null = null;
  let folded: string[] | null = null;
  const flush = () => {
    if (key && folded) meta[key] = folded.join(" ").replace(/\s+/g, " ").trim();
    key = null;
    folded = null;
  };
  for (const line of lines) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv && !/^\s/.test(line)) {
      flush();
      key = kv[1];
      const v = kv[2].trim();
      if (v === ">-" || v === ">" || v === "|" || v === "|-") folded = [];
      else {
        meta[key] = v.replace(/^["']|["']$/g, "");
        key = null;
      }
      continue;
    }
    if (key && folded) folded.push(line.trim());
  }
  flush();
  return { meta, body: text.slice(m[0].length) };
}

export function splitTags(v: string): string[] {
  return (v || "")
    .split(/[,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
