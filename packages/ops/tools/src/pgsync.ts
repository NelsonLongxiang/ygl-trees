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
import type { DB } from "../../../core/database/src/db";
import { ngram } from "../../../core/text/src/text";
import { exportableRows } from "./config";

/** Mirror targets, FK-dependency-safe order (same list as `db export`). */
export const MIRROR_TABLES = [
  "meta", "config", "skills", "skill_refs", "projects", "queries", "sources", "query_sources", "evidence",
  "claims", "claim_evidence", "artifacts", "kb_notes", "kb_links",
  "trees", "nodes", "node_edges", "node_closure", "node_conditions", "node_state", "node_index",
  "relations", "jobs", "runs", "events", "schema_migrations", "patrol_checks", "patrol_findings",
  "verifier_instances", "verifier_runs",
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

/** Copy one table (batched, 500/insert) into an open PG client. */
async function copyTable(client: any, db: DB, t: string, keepSecretConfig = false): Promise<number> {
  const rows = exportableRows(db, t, keepSecretConfig);
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
  return rows.length;
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
        // Punctuation normalization BEFORE tsvector: slash/dot/colon-joined
        // latin runs (docker/mongo, bin/bash, hosts) parse as compound
        // tokens (url/host) in PG and would NOT match their parts — SQLite
        // unicode61 splits on any non-alphanumeric. Normalize both sides
        // to space-separated parts (found via real-data trial: docker
        // token 27 vs 24 rows). DROP first so existing mirrors self-heal
        // (full refresh rewrites every row anyway).
        await client.query(`ALTER TABLE "${t}" DROP COLUMN IF EXISTS "ngram_tsv"`);
        await client.query(
          `ALTER TABLE "${t}" ADD COLUMN "ngram_tsv" tsvector
             GENERATED ALWAYS AS (to_tsvector('simple', regexp_replace(coalesce("ngram",''), '[/\\._:,&+()]+', ' ', 'g'))) STORED`
        );
        await client.query(`CREATE INDEX IF NOT EXISTS "${t}_tsv" ON "${t}" USING GIN ("ngram_tsv")`);
      }
    }

    // ---- full refresh: delete child-first, insert parent-first
    for (const t of [...tables].reverse()) await client.query(`DELETE FROM "${t}"`);
    const result: Array<{ table: string; rows: number }> = [];
    for (const t of tables) {
      result.push({ table: t, rows: await copyTable(client, db, t) });
    }
    // PG-A③: record the mirrored schema generation in the dual-end ledger
    const uv = (db.get("PRAGMA user_version") as { user_version?: number })?.user_version ?? 0;
    await client.query(
      `INSERT INTO schema_migrations(backend,version,applied_at,note) VALUES('postgres',$1,$2,$3)
       ON CONFLICT (backend,version) DO UPDATE SET applied_at=excluded.applied_at, note=excluded.note`,
      [uv, new Date().toISOString(), `mirror sync of sqlite v${uv}`]
    );
    return { tables: result, server_version: ver, fulltext };
  } finally {
    await client.end();
  }
}

// ================================================================ migration (L1.5)
// One-time full-fidelity graduation: unlike sync (refreshable PK-only
// mirror), migrate creates the complete schema — FKs, UNIQUE constraints,
// plain indexes — so the target is a standalone, self-describing PG
// database other tools can own. ygl-trees itself NEVER writes to it again
// (no dual-backend writes by design; see docs/pg-compat.md).

const MIGRATE_DDL = `
CREATE SEQUENCE IF NOT EXISTS events_seq;  -- v10/PG-A④: backing sequence for events.seq (PG-native writes)
CREATE TABLE meta (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE config (
  key text PRIMARY KEY, value text NOT NULL DEFAULT '',
  note text DEFAULT '', updated text NOT NULL);
CREATE TABLE skills (
  id text PRIMARY KEY, name text NOT NULL UNIQUE, version text DEFAULT '0.1.0',
  description text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
  tags text DEFAULT '', origin text DEFAULT '',
  enabled integer NOT NULL DEFAULT 1, hits integer NOT NULL DEFAULT 0,
  created text NOT NULL, updated text NOT NULL);
CREATE TABLE skill_refs (
  id text PRIMARY KEY, skill_id text NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  path text NOT NULL, content text NOT NULL DEFAULT '', UNIQUE (skill_id, path));
CREATE TABLE projects (
  id text PRIMARY KEY, name text NOT NULL UNIQUE, question text NOT NULL DEFAULT '',
  inclusion text DEFAULT '', exclusion text DEFAULT '', status text NOT NULL DEFAULT 'active',
  created text NOT NULL, updated text NOT NULL);
CREATE TABLE queries (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text text NOT NULL, engine text DEFAULT '', status text NOT NULL DEFAULT 'pending',
  note text DEFAULT '', content_hash text NOT NULL DEFAULT '', created text NOT NULL,
  UNIQUE (project_id, content_hash));
CREATE TABLE sources (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url text DEFAULT '', title text NOT NULL DEFAULT '', url_hash text NOT NULL,
  content_hash text NOT NULL DEFAULT '', abstract text DEFAULT '', content text DEFAULT '',
  engine text DEFAULT '', relevance integer NOT NULL DEFAULT 0, confidence text NOT NULL DEFAULT 'B',
  tags text DEFAULT '', retrieved_at text NOT NULL,
  created text NOT NULL DEFAULT '',            -- v9
  UNIQUE (project_id, url_hash));
CREATE TABLE query_sources (
  query_id text NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  note text DEFAULT '', created text NOT NULL, PRIMARY KEY (query_id, source_id));
CREATE TABLE evidence (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  quote text NOT NULL, note text DEFAULT '', locator text DEFAULT '',
  content_hash text NOT NULL DEFAULT '', created text NOT NULL,
  UNIQUE (source_id, content_hash));
CREATE TABLE claims (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text text NOT NULL, status text NOT NULL DEFAULT 'unverified', confidence text NOT NULL DEFAULT 'B',
  content_hash text NOT NULL DEFAULT '', created text NOT NULL,
  updated text NOT NULL DEFAULT '',                -- v9
  channel text NOT NULL DEFAULT '',                -- v11 prediction ledger channel
  UNIQUE (project_id, content_hash));
CREATE TABLE claim_evidence (
  claim_id text NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  evidence_id text NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  stance text NOT NULL DEFAULT 'supports', PRIMARY KEY (claim_id, evidence_id));
CREATE TABLE artifacts (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'section', title text NOT NULL DEFAULT '',
  format text NOT NULL DEFAULT 'markdown', content text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1, created text NOT NULL,
  updated text NOT NULL DEFAULT '',                  -- v9
  meta text NOT NULL DEFAULT '');
CREATE TABLE kb_notes (
  id text PRIMARY KEY, title text NOT NULL, body text NOT NULL DEFAULT '',
  source_url text DEFAULT '', origin text DEFAULT '', tags text DEFAULT '',
  confidence text NOT NULL DEFAULT 'B', reuse integer NOT NULL DEFAULT 0,
  content_hash text NOT NULL DEFAULT '', created text NOT NULL, updated text NOT NULL,
  UNIQUE (content_hash));
CREATE TABLE kb_links (
  from_id text NOT NULL REFERENCES kb_notes(id) ON DELETE CASCADE,
  to_id text NOT NULL REFERENCES kb_notes(id) ON DELETE CASCADE,
  rel text NOT NULL DEFAULT 'related', PRIMARY KEY (from_id, to_id, rel));
CREATE TABLE trees (
  id text PRIMARY KEY, project_id text REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL UNIQUE, note text DEFAULT '', created text NOT NULL);
CREATE TABLE nodes (
  id text PRIMARY KEY, tree_id text NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  key text NOT NULL, name text NOT NULL, kind text NOT NULL DEFAULT 'tech',
  tier integer NOT NULL DEFAULT 0, cost double precision NOT NULL DEFAULT 0,
  cost_unit text DEFAULT '', payload text DEFAULT '', tags text DEFAULT '',
  created text NOT NULL, UNIQUE (tree_id, key));
CREATE TABLE node_edges (
  id text PRIMARY KEY, tree_id text NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  parent_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  child_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  rel text NOT NULL DEFAULT 'prereq', mode text NOT NULL DEFAULT 'AND',
  required integer NOT NULL DEFAULT 1, min_level integer NOT NULL DEFAULT 1,
  weight double precision NOT NULL DEFAULT 1, note text DEFAULT '',
  created text NOT NULL DEFAULT '',                 -- v9
  UNIQUE (parent_id, child_id, rel));
CREATE TABLE node_closure (
  tree_id text NOT NULL, ancestor text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  descendant text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  depth integer NOT NULL, PRIMARY KEY (ancestor, descendant));
CREATE TABLE node_conditions (
  id text PRIMARY KEY, node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name text NOT NULL, kind text NOT NULL DEFAULT 'flag', expr text NOT NULL DEFAULT '',
  op text NOT NULL DEFAULT '>=', value text NOT NULL DEFAULT '',
  required integer NOT NULL DEFAULT 1, effect text NOT NULL DEFAULT 'gate',
  weight double precision NOT NULL DEFAULT 1, note text DEFAULT '',
  created text NOT NULL DEFAULT '');                -- v9
CREATE TABLE node_state (
  tree_id text NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  context text NOT NULL DEFAULT 'default', node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'locked', level integer NOT NULL DEFAULT 0,
  progress double precision NOT NULL DEFAULT 0, updated text NOT NULL,
  PRIMARY KEY (tree_id, context, node_id));
CREATE TABLE node_index (
  tree_id text PRIMARY KEY REFERENCES trees(id) ON DELETE CASCADE,
  topo_order text NOT NULL DEFAULT '', tiers text NOT NULL DEFAULT '',
  in_degree text NOT NULL DEFAULT '', built_at text NOT NULL, dirty integer NOT NULL DEFAULT 1);
CREATE TABLE relations (
  id text PRIMARY KEY, src_type text NOT NULL, src_id text NOT NULL,
  dst_type text NOT NULL, dst_id text NOT NULL, rel text NOT NULL DEFAULT 'related',
  weight double precision NOT NULL DEFAULT 1,
  created text NOT NULL DEFAULT '',                 -- v9
  UNIQUE (src_type, src_id, dst_type, dst_id, rel));
CREATE TABLE jobs (
  id text PRIMARY KEY, title text NOT NULL, command text NOT NULL,
  every_minutes integer DEFAULT 0, at text DEFAULT '', enabled integer NOT NULL DEFAULT 1,
  runs integer NOT NULL DEFAULT 0, last_run text DEFAULT '',
  status text NOT NULL DEFAULT 'pending', created text NOT NULL,
  project_id text NOT NULL DEFAULT '', owner text NOT NULL DEFAULT '');
CREATE TABLE runs (
  id text PRIMARY KEY, job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  started text NOT NULL, finished text DEFAULT '', rc integer, output text DEFAULT '');
CREATE TABLE events (
  id text PRIMARY KEY, ts text NOT NULL, actor text NOT NULL DEFAULT 'cli', kind text NOT NULL,
  entity text DEFAULT '', entity_id text DEFAULT '', payload text DEFAULT '',
  level text NOT NULL DEFAULT 'info',
  seq bigint DEFAULT nextval('events_seq'));  -- v10/PG-A④: monotonic order for PG-native writes (nullable: mirrored rows carry NULL)
CREATE TABLE schema_migrations (   -- v10/PG-A③: applied-schema ledger, both backends
  backend text NOT NULL, version integer NOT NULL, applied_at text NOT NULL,
  note text NOT NULL DEFAULT '', PRIMARY KEY (backend, version));
CREATE TABLE patrol_checks (       -- v12/0.93-T2: boundary assertions
  id text PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '',
  sql text NOT NULL, severity text NOT NULL DEFAULT 'S2',
  enabled integer NOT NULL DEFAULT 1, created text NOT NULL, updated text NOT NULL, UNIQUE(name));
CREATE TABLE patrol_findings (     -- v12/0.93-T2: disposition queue
  id text PRIMARY KEY,
  check_id text NOT NULL REFERENCES patrol_checks(id) ON DELETE CASCADE,
  row_key text NOT NULL, detail text NOT NULL DEFAULT '', severity text NOT NULL DEFAULT 'S2',
  status text NOT NULL DEFAULT 'open', first_seen text NOT NULL, last_seen text NOT NULL,
  resolved text, note text NOT NULL DEFAULT '', UNIQUE(check_id, row_key));
CREATE TABLE verifier_instances (  -- v13/#206
  id text PRIMARY KEY, identity_sha256 text NOT NULL, kind text NOT NULL DEFAULT 'pack',
  pack text NOT NULL, pack_version text NOT NULL, binding text NOT NULL, owner text NOT NULL,
  schedule text NOT NULL DEFAULT '', state text NOT NULL DEFAULT 'active', note text NOT NULL DEFAULT '',
  created text NOT NULL, updated text NOT NULL, UNIQUE(identity_sha256));
CREATE TABLE verifier_runs (       -- v13/#206
  id text PRIMARY KEY,
  instance_id text NOT NULL REFERENCES verifier_instances(id) ON DELETE CASCADE,
  verdict text NOT NULL, judged_at text NOT NULL, target_sha text NOT NULL DEFAULT '',
  payload_sha256 text NOT NULL DEFAULT '', archive_sha256 text NOT NULL DEFAULT '',
  executor text NOT NULL DEFAULT '', engine_version text NOT NULL DEFAULT '', created text NOT NULL);
`;

const MIGRATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_sources_project  ON sources(project_id);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project_id);
CREATE INDEX IF NOT EXISTS idx_claims_project   ON claims(project_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_proj   ON artifacts(project_id);
CREATE INDEX IF NOT EXISTS idx_events_ts        ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_kind_entity ON events(kind, entity_id, ts);  -- #176 W5a: parity with SCHEMA_SQL (found by the structural gate)
CREATE INDEX IF NOT EXISTS idx_jobs_enabled     ON jobs(enabled);
CREATE INDEX IF NOT EXISTS idx_patrol_status    ON patrol_findings(status);
CREATE INDEX IF NOT EXISTS idx_nodes_tree       ON nodes(tree_id);
CREATE INDEX IF NOT EXISTS idx_nodes_tier       ON nodes(tree_id, tier);
CREATE INDEX IF NOT EXISTS idx_edge_child       ON node_edges(child_id);
CREATE INDEX IF NOT EXISTS idx_edge_parent      ON node_edges(parent_id);
CREATE INDEX IF NOT EXISTS idx_edge_req         ON node_edges(child_id, required);
CREATE INDEX IF NOT EXISTS idx_closure_desc     ON node_closure(descendant);
CREATE INDEX IF NOT EXISTS idx_closure_anc      ON node_closure(ancestor);
CREATE INDEX IF NOT EXISTS idx_cond_node        ON node_conditions(node_id);
CREATE INDEX IF NOT EXISTS idx_cond_req         ON node_conditions(node_id, required);
CREATE INDEX IF NOT EXISTS idx_state_ctx        ON node_state(tree_id, context);
CREATE INDEX IF NOT EXISTS idx_state_status     ON node_state(tree_id, context, status);
CREATE INDEX IF NOT EXISTS idx_verifier_instances_owner ON verifier_instances(owner, state);  -- v13/#206
CREATE INDEX IF NOT EXISTS idx_verifier_runs_instance ON verifier_runs(instance_id, judged_at);  -- v13/#206
`;

export interface MigrateResult {
  tables: Array<{ table: string; rows: number }>;
  server_version: string;
  constraints: { fk: number; unique: number };
  fulltext: "tsvector+GIN" | "ngram-only(pg<12)";
}

/**
 * One-time migration of the whole library into a standalone PG database.
 * Atomic (single transaction: DDL + data + verification), refuses a non-
 * empty target unless `fresh` drops the existing tables first. After
 * migration the CLI keeps working on SQLite only — no dual writes.
 */
export async function migrateToPg(db: DB, url: string, fresh = false): Promise<MigrateResult> {
  let pg: any;
  try {
    pg = require("pg");
  } catch {
    throw new Error("pg driver not installed — run: pnpm add pg (optional dependency)");
  }

  // ⑤ cold-user report: a REAL value in an INTEGER column passes SQLite's
  // weak typing but explodes in PG with no table/column/row context. Pre-flight
  // type check: scan INTEGER columns for non-integer values, name the offender.
  const typeErrors = preflightTypeCheck(db);
  if (typeErrors.length) {
    const lines = typeErrors.slice(0, 5).map((e) => `  ${e.table}.${e.column} rowid=${e.rowid}: value "${e.value}" is not a valid INTEGER`);
    throw new Error(
      `pre-flight type check failed (${typeErrors.length} issue(s)) — fix these before migrating:\n${lines.join("\n")}${typeErrors.length > 5 ? `\n  ...and ${typeErrors.length - 5} more` : ""}\n  hint: ygl-trees db sql "UPDATE <table> SET <column>=<int> WHERE rowid=<rowid>"`
    );
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const verNum = Number((await client.query("SHOW server_version_num")).rows[0].server_version_num);
    const ver = (await client.query("SELECT version()")).rows[0].version;
    const fulltext: MigrateResult["fulltext"] = verNum >= 120000 ? "tsvector+GIN" : "ngram-only(pg<12)";

    // guard: refuse a target that already holds our tables with data
    if (!fresh) {
      for (const t of MIRROR_TABLES) {
        const exists = await client.query(
          `SELECT 1 AS hit FROM information_schema.tables WHERE table_name=$1`, [t]
        );
        if (exists.rowCount) {
          const n = (await client.query(`SELECT count(*)::int n FROM "${t}"`)).rows[0].n;
          if (n > 0)
            throw new Error(
              `target already contains data (table ${t}, ${n} rows) — migration is one-time; ` +
                `use --fresh to drop and recreate, or 'db sync pg' for a refreshable mirror`
            );
        }
      }
    } else {
      for (const t of [...MIRROR_TABLES].reverse())
        await client.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    }

    await client.query("BEGIN");
    try {
      await client.query(MIGRATE_DDL);
      await client.query(MIGRATE_INDEXES);
      for (const t of Object.keys(NGRAM_INPUT)) {
        await client.query(`ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS ngram text NOT NULL DEFAULT ''`);
        if (verNum >= 120000) {
          await client.query(
            `ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS ngram_tsv tsvector
               GENERATED ALWAYS AS (to_tsvector('simple', regexp_replace(coalesce(ngram,''), '[/\\._:,&+()]+', ' ', 'g'))) STORED`
          );
          await client.query(`CREATE INDEX IF NOT EXISTS "${t}_tsv" ON "${t}" USING GIN (ngram_tsv)`);
        }
      }

      // drift guard: hand-written DDL must match the live SQLite columns
      for (const t of MIRROR_TABLES) {
        const src = (db.all(`PRAGMA table_info(${t})`) as any[]).map((c) => c.name).sort();
        const dst = (
          await client.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [t]
          )
        ).rows.map((r: any) => r.column_name);
        const want = new Set(src);
        if (Object.keys(NGRAM_INPUT).includes(t)) {
          want.add("ngram");
          if (verNum >= 120000) want.add("ngram_tsv");
        }
        const got = new Set(dst);
        const missing = [...want].filter((c) => !got.has(c));
        if (missing.length || got.size !== want.size)
          throw new Error(
            `schema drift on ${t}: migrate DDL out of date (want [${[...want]}]; got [${dst}]) — update MIGRATE_DDL`
          );
      }

      const result: Array<{ table: string; rows: number }> = [];
      for (const t of MIRROR_TABLES) {
        const rows = await copyTable(client, db, t, true);
        // verify per-table count inside the same transaction
        const n = (await client.query(`SELECT count(*)::int n FROM "${t}"`)).rows[0].n;
        if (n !== rows) throw new Error(`count mismatch on ${t}: copied ${rows}, found ${n}`);
        result.push({ table: t, rows });
      }
      // PG-A③: record the migrated schema generation (replaces the copied
      // 'sqlite' seed row set with the PG-side graduation record)
      const uvM = (db.get("PRAGMA user_version") as { user_version?: number })?.user_version ?? 0;
      await client.query(
        `INSERT INTO schema_migrations(backend,version,applied_at,note) VALUES('postgres',$1,$2,$3)
         ON CONFLICT (backend,version) DO UPDATE SET applied_at=excluded.applied_at, note=excluded.note`,
        [uvM, new Date().toISOString(), `one-time full-fidelity graduation from sqlite v${uvM}`]
      );
      await client.query("COMMIT");

      const fk = (
        await client.query(
          `SELECT count(*)::int n FROM information_schema.table_constraints WHERE constraint_type='FOREIGN KEY'`
        )
      ).rows[0].n;
      const unique = (
        await client.query(
          `SELECT count(*)::int n FROM information_schema.table_constraints WHERE constraint_type='UNIQUE'`
        )
      ).rows[0].n;
      return { tables: result, server_version: ver, constraints: { fk, unique }, fulltext };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  } finally {
    await client.end();
  }
}

/** Pre-flight: scan INTEGER columns for non-integer values (SQLite weak
 *  typing allows REAL into INTEGER; PG rejects at migration time with no
 *  context). Returns actionable errors with table.column+rowid. */
function preflightTypeCheck(db: DB): Array<{ table: string; column: string; rowid: number; value: string }> {
  const issues: Array<{ table: string; column: string; rowid: number; value: string }> = [];
  const tables = db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_fts%' AND name NOT LIKE '%_config%' AND name NOT LIKE '%_content%' AND name NOT LIKE '%_data%' AND name NOT LIKE '%_docsize%' AND name NOT LIKE '%_idx%' AND name != 'meta'"
  ) as any[];
  for (const t of tables) {
    const cols = db.all(`PRAGMA table_info(${t.name})`) as any[];
    for (const c of cols) {
      if (c.type !== "INTEGER") continue;
      // SQLite typeof() returns 'integer', 'real', 'text', 'blob', 'null'
      const bad = db.all(
        `SELECT rowid, ${c.name} AS v FROM ${t.name} WHERE typeof(${c.name}) NOT IN ('integer','null') LIMIT 5`
      ) as any[];
      for (const row of bad) {
        issues.push({ table: t.name, column: c.name, rowid: row.rowid, value: String(row.v) });
      }
    }
  }
  return issues;
}

// ================================================================ upgrade track (#176 W5b)
// A migrated PG database stays the workspace's write backend, so it must follow schema changes.
// SQLite upgrades itself on open (PRAGMA user_version); PG gets an explicit `db upgrade`:
//  - version steps: one PG_UPGRADES entry per SCHEMA_VERSION above the baseline, applied in order;
//  - index convergence: MIGRATE_INDEXES is all CREATE INDEX IF NOT EXISTS, re-run every time, so an
//    index added to MIGRATE_INDEXES (W5a: idx_events_kind_entity) also reaches already-migrated targets.
// Everything runs in one transaction under an advisory lock and lands in schema_migrations.

/** PG business mode shipped at v12: every migrated PG database starts there. Older ones are re-migrated. */
export const PG_BASELINE_VERSION = 12;

export interface PgUpgradeStep { version: number; note: string; sql: string }

/** Ordered PG steps for SCHEMA_VERSION > PG_BASELINE_VERSION. A SCHEMA_VERSION bump must add its step here (pg-upgrade.spec enforces it). */
export const PG_UPGRADES: PgUpgradeStep[] = [
  // v13 (#206): verifier registry — additive tables; their indexes converge through MIGRATE_INDEXES.
  { version: 13, note: "v13: verifier_instances/verifier_runs (verifier registry, #206)", sql: migrateTableDdl(["verifier_instances", "verifier_runs"]) },
  // v14 (#258): jobs attribution — project_id/owner with the empty-string legacy default.
  { version: 14, note: "v14: jobs.project_id/owner (job attribution, #258)", sql: `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS project_id text NOT NULL DEFAULT ''; ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT '';` },
];

/** CREATE TABLE IF NOT EXISTS statements for the named tables, taken from MIGRATE_DDL — the one PG DDL text, so an
 *  upgrade step can never drift from what a fresh migrate creates. Throws when a name is missing. */
export function migrateTableDdl(tables: string[]): string {
  const stmts = MIGRATE_DDL.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean);
  return tables.map((t) => {
    const hit = stmts.find((x) => new RegExp(`^CREATE TABLE ${t} \\(`).test(x));
    if (!hit) throw new Error(`migrateTableDdl: ${t} not found in MIGRATE_DDL`);
    return hit.replace(/^CREATE TABLE /, "CREATE TABLE IF NOT EXISTS ") + ";";
  }).join("\n");
}

/** Index names declared in MIGRATE_INDEXES, in order. */
export function migrateIndexNames(): string[] {
  return [...MIGRATE_INDEXES.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]);
}

export interface PgQuery { query(sql: string, params?: any[]): Promise<{ rows: any[] }> }

/** Highest PG ledger version, or null when the target has no ygl-trees schema_migrations table. */
export async function pgSchemaVersion(client: PgQuery): Promise<number | null> {
  const t = await client.query("SELECT 1 AS hit FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='schema_migrations'");
  if (!t.rows.length) return null;
  const r = await client.query("SELECT MAX(version) AS version FROM schema_migrations WHERE backend IN ('pg','postgres')");
  const v = r.rows[0]?.version;
  return v === null || v === undefined ? null : Number(v);
}

export async function missingPgIndexes(client: PgQuery): Promise<string[]> {
  const r = await client.query("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema()");
  const have = new Set(r.rows.map((x: any) => String(x.indexname)));
  return migrateIndexNames().filter((n) => !have.has(n));
}

export class PgUpgradeError extends Error {}

export interface PgUpgradeResult { from: number; to: number; steps: number[]; indexes_created: string[]; duplicate: boolean }

/** Applies the upgrade track inside the caller's connection. Throws PgUpgradeError (identifier-only messages) on refusal. */
export async function upgradePgSchema(client: PgQuery, target: number, steps: PgUpgradeStep[] = PG_UPGRADES): Promise<PgUpgradeResult> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ygl-trees:pg-schema-upgrade'))");
    const from = await pgSchemaVersion(client);
    if (from === null) throw new PgUpgradeError("target has no ygl-trees schema_migrations ledger; create it with db migrate pg from a SQLite workspace");
    if (from > target) throw new PgUpgradeError(`PG schema v${from} is newer than this engine (v${target}); upgrade ygl-trees instead`);
    if (from < PG_BASELINE_VERSION) throw new PgUpgradeError(`PG schema v${from} predates the PG upgrade baseline v${PG_BASELINE_VERSION}; re-migrate into a new database with db migrate pg`);
    const pending = steps.filter((s) => s.version > from && s.version <= target).sort((a, b) => a.version - b.version);
    for (let v = from + 1; v <= target; v++) {
      if (!pending.some((s) => s.version === v)) throw new PgUpgradeError(`no PG upgrade step for v${v}; this engine cannot upgrade PG from v${from} to v${target}`);
    }
    const before = await missingPgIndexes(client);
    for (const s of pending) {
      await client.query(s.sql);
      await client.query(
        `INSERT INTO schema_migrations(backend,version,applied_at,note) VALUES('postgres',$1,$2,$3)
         ON CONFLICT (backend,version) DO NOTHING`,
        [s.version, new Date().toISOString(), `pg upgrade: ${s.note}`]
      );
    }
    await client.query(MIGRATE_INDEXES);
    const after = await missingPgIndexes(client);
    if (after.length) throw new PgUpgradeError(`indexes still missing after upgrade: ${after.join(", ")}`);
    await client.query("COMMIT");
    const created = before.filter((n) => !after.includes(n));
    return { from, to: target, steps: pending.map((s) => s.version), indexes_created: created, duplicate: pending.length === 0 && created.length === 0 };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}
