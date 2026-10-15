/**
 * One-way full mirror of the SQLite library into PostgreSQL — L1 of
 * docs/pg-compat.md. SQLite stays the single source of truth; the mirror
 * exists so SQL tools / teams can query the data with PG.
 *
 * Design points:
 *  - mirror DDL is derived from PRAGMA table_info at runtime, so schema
 *    evolution on the SQLite side flows through automatically (PK only —
 *    FK/UNIQUE constraints live in the source of truth, the mirror is
 *    analytics-oriented)
 *  - the 5 searchable base tables get their ngram column recomputed with
 *    the SAME tokenizer as the FTS5 writes, plus a tsvector generated
 *    column + GIN index (PG >= 12) — CJK recall works with the 'simple'
 *    dictionary, no zhparser needed
 *  - full refresh: DELETE child-first, INSERT parent-first, both in FK
 *    declaration order derived from the source schema
 */
import type { DB } from "./db";
import { ngram } from "./text";

/** Mirror targets, FK-dependency-safe order (same list as `db export`). */
export const MIRROR_TABLES = [
  "meta", "skills", "skill_refs", "projects", "queries", "sources", "evidence",
  "claims", "claim_evidence", "artifacts", "kb_notes", "kb_links",
  "trees", "nodes", "node_edges", "node_closure", "node_conditions", "node_state", "node_index",
  "relations", "jobs", "runs", "events",
];

/** Base tables whose FTS ngram we recompute — input functions MUST mirror
 *  the FTS inserts in store.ts / tree.ts exactly, or recall diverges. */
const NGRAM_INPUT: Record<string, (r: any) => string> = {
  skills: (r) => `${r.name} ${r.description} ${r.tags} ${r.body}`,
  sources: (r) => `${r.title} ${r.abstract} ${r.content} ${r.tags || ""}`,
  evidence: (r) => String(r.quote),
  kb_notes: (r) => `${r.title} ${r.tags || ""} ${r.body}`,
  nodes: (r) => `${r.key} ${r.name} ${r.tags}`,
};

function pgType(sqliteType: string): string {
  const t = String(sqliteType || "").toUpperCase();
  if (t.includes("INT")) return "integer";
  if (t.includes("REAL") || t.includes("DOUB") || t.includes("FLOA")) return "double precision";
  return "text";
}

export interface SyncResult {
  tables: Array<{ table: string; rows: number }>;
  server_version: string;
  fulltext: "tsvector+GIN" | "ngram-only(pg<12)";
}

export async function syncToPg(db: DB, url: string, only?: string[]): Promise<SyncResult> {
  let pg: any;
  try {
    pg = require("pg");
  } catch {
    throw new Error("pg driver not installed — run: pnpm add pg (optional dependency)");
  }
  for (const t of only || []) {
    if (!MIRROR_TABLES.includes(t)) throw new Error(`unknown table: ${t} (see db export table list)`);
  }
  const tables = only?.length ? MIRROR_TABLES.filter((t) => only.includes(t)) : MIRROR_TABLES;

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const verNum = Number((await client.query("SHOW server_version_num")).rows[0].server_version_num);
    const ver = (await client.query("SELECT version()")).rows[0].version;
    const fulltext: SyncResult["fulltext"] = verNum >= 120000 ? "tsvector+GIN" : "ngram-only(pg<12)";

    // ---- ensure mirror schema (CREATE IF NOT EXISTS; follows source columns)
    for (const t of tables) {
      const cols = db.all(`PRAGMA table_info(${t})`) as any[];
      if (!cols.length) throw new Error(`source table missing: ${t}`);
      const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      const defs = cols.map((c) => {
        const dflt = c.dflt_value === null || c.dflt_value === undefined ? "" : ` DEFAULT ${c.dflt_value}`;
        const nn = c.notnull || c.pk ? " NOT NULL" : "";
        return `"${c.name}" ${pgType(c.type)}${dflt}${nn}`;
      });
      if (NGRAM_INPUT[t]) defs.push(`"ngram" text NOT NULL DEFAULT ''`);
      const pk = pkCols.length ? `, PRIMARY KEY (${pkCols.map((c) => `"${c}"`).join(",")})` : "";
      await client.query(`CREATE TABLE IF NOT EXISTS "${t}" (${defs.join(", ")}${pk})`);
      if (NGRAM_INPUT[t] && verNum >= 120000) {
        await client.query(
          `ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "ngram_tsv" tsvector
             GENERATED ALWAYS AS (to_tsvector('simple', coalesce("ngram", ''))) STORED`
        );
        await client.query(`CREATE INDEX IF NOT EXISTS "${t}_tsv" ON "${t}" USING GIN ("ngram_tsv")`);
      }
    }

    // ---- full refresh: delete child-first, insert parent-first
    for (const t of [...tables].reverse()) await client.query(`DELETE FROM "${t}"`);
    const result: Array<{ table: string; rows: number }> = [];
    for (const t of tables) {
      const rows = db.all(`SELECT * FROM ${t}`);
      if (rows.length) {
        const baseCols = Object.keys(rows[0]);
        const cols = NGRAM_INPUT[t] ? [...baseCols, "ngram"] : baseCols;
        const CHUNK = 500;
        for (let i = 0; i < rows.length; i += CHUNK) {
          const part = rows.slice(i, i + CHUNK);
          const params: any[] = [];
          const tuples = part.map((r: any) => {
            const vals = baseCols.map((c) => {
              const v = r[c];
              return v === undefined ? null : v;
            });
            if (NGRAM_INPUT[t]) vals.push(ngram(NGRAM_INPUT[t](r)));
            params.push(...vals);
            return `(${vals.map((_, j) => `$${params.length - vals.length + j + 1}`).join(",")})`;
          });
          await client.query(
            `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES ${tuples.join(",")}`,
            params
          );
        }
      }
      result.push({ table: t, rows: rows.length });
    }
    return { tables: result, server_version: ver, fulltext };
  } finally {
    await client.end();
  }
}
