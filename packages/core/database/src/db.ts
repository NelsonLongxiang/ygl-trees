/**
 * Database: single source of truth for ygl-trees.
 *
 * Everything — skills, research state, evidence, drafts, knowledge notes and
 * schedules — lives in one SQLite file. No sidecar JSON, no git-as-database.
 */
import { Database } from "node-sqlite3-wasm";
import * as fs from "node:fs";
import * as path from "node:path";
import { sha1, nowIso } from "../../text/src/text";

export const SCHEMA_VERSION = 10;

/** Shared ORM-opened signal: orm.ts flips this when a DataSource settles.
 * plugin.ts stop() reads it WITHOUT importing orm (which pulls typeorm) so
 * shutdown stays cheap for runs that never touched the ORM. 0.87. */
export const ormState = { opened: false };

export const SCHEMA_SQL = `
-- ---------------------------------------------------------------- meta
-- runtime state the tool writes itself (current selections, bookkeeping);
-- user-tunable settings live in config
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------- config (v6)
-- user-tunable settings; registry (defaults/types/notes) in src/config.ts.
-- Reads fall back to defaults — an empty table is a valid state.
CREATE TABLE IF NOT EXISTS config (
  key     TEXT PRIMARY KEY,
  value   TEXT NOT NULL DEFAULT '',
  note    TEXT DEFAULT '',
  updated TEXT NOT NULL
);

-- ---------------------------------------------------------------- skills (L1/L2/L3)
CREATE TABLE IF NOT EXISTS skills (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  version     TEXT DEFAULT '0.1.0',
  description TEXT NOT NULL DEFAULT '',   -- L1: what + when, always in context
  body        TEXT NOT NULL DEFAULT '',   -- L2: instructions, loaded on activation
  tags        TEXT DEFAULT '',
  origin      TEXT DEFAULT '',            -- where it came from (path/repo)
  enabled     INTEGER NOT NULL DEFAULT 1,
  hits        INTEGER NOT NULL DEFAULT 0, -- how often an agent matched it
  created     TEXT NOT NULL,
  updated     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_refs (          -- L3: loaded on demand
  id       TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  path     TEXT NOT NULL,
  content  TEXT NOT NULL DEFAULT ''
);
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  id UNINDEXED, name, description, tags, ngram, tokenize='unicode61'
);

-- ---------------------------------------------------------------- projects
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  question   TEXT NOT NULL DEFAULT '',
  inclusion  TEXT DEFAULT '',
  exclusion  TEXT DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'active',
  created    TEXT NOT NULL,
  updated    TEXT NOT NULL
);

-- ---------------------------------------------------------------- research: queries
CREATE TABLE IF NOT EXISTS queries (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  engine       TEXT DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending|done
  note         TEXT DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',         -- sha1(text): idempotent writes
  created      TEXT NOT NULL
);

-- ---------------------------------------------------------------- research: sources
-- query <-> source association: which search query recalled which source
-- (schema v4; pure additive, no migration needed beyond CREATE IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS query_sources (
  query_id  TEXT NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  note      TEXT DEFAULT '',
  created   TEXT NOT NULL,
  PRIMARY KEY (query_id, source_id)
);

CREATE TABLE IF NOT EXISTS sources (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url          TEXT DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',
  url_hash     TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  abstract     TEXT DEFAULT '',
  content      TEXT DEFAULT '',
  engine       TEXT DEFAULT '',
  relevance    INTEGER NOT NULL DEFAULT 0,   -- 0..5 screening score
  confidence   TEXT NOT NULL DEFAULT 'B',    -- A|B|C source trust grade
  tags         TEXT DEFAULT '',
  created      TEXT NOT NULL DEFAULT '',
  retrieved_at TEXT NOT NULL,
  UNIQUE(project_id, url_hash)
);
CREATE VIRTUAL TABLE IF NOT EXISTS sources_fts USING fts5(
  id UNINDEXED, title, abstract, content, ngram, tokenize='unicode61'
);

-- ---------------------------------------------------------------- research: evidence
CREATE TABLE IF NOT EXISTS evidence (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  quote        TEXT NOT NULL,
  note         TEXT DEFAULT '',
  locator      TEXT DEFAULT '',   -- page / section / offset
  content_hash TEXT NOT NULL DEFAULT '',  -- sha1(quote): idempotent writes
  created      TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
  id UNINDEXED, quote, ngram, tokenize='unicode61'
);

-- ---------------------------------------------------------------- research: claims
CREATE TABLE IF NOT EXISTS claims (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'unverified', -- unverified|supported|refuted|contested
  confidence   TEXT NOT NULL DEFAULT 'B',
  content_hash TEXT NOT NULL DEFAULT '',           -- sha1(text): idempotent writes
  created      TEXT NOT NULL,
  updated      TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS claim_evidence (
  claim_id    TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  stance      TEXT NOT NULL DEFAULT 'supports',  -- supports|refutes
  PRIMARY KEY (claim_id, evidence_id)
);

-- ---------------------------------------------------------------- production
CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'section',  -- outline|section|report|note|spec|design|task
  title      TEXT NOT NULL DEFAULT '',
  format     TEXT NOT NULL DEFAULT 'markdown',
  content    TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL DEFAULT 1,
  created    TEXT NOT NULL,
  updated    TEXT NOT NULL DEFAULT '',
  meta       TEXT NOT NULL DEFAULT ''          -- v8 JSON envelope: task {"status"}, design {"design_type"}
);

-- ---------------------------------------------------------------- knowledge base
CREATE TABLE IF NOT EXISTS kb_notes (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  source_url    TEXT DEFAULT '',
  origin        TEXT DEFAULT '',       -- 'artifact:<id>' | 'note' | 'skill:<id>'
  tags          TEXT DEFAULT '',
  confidence    TEXT NOT NULL DEFAULT 'B',
  reuse         INTEGER NOT NULL DEFAULT 0,
  content_hash  TEXT NOT NULL DEFAULT '',  -- sha1(title+body): idempotent writes
  created       TEXT NOT NULL,
  updated       TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
  id UNINDEXED, title, tags, ngram, tokenize='unicode61'
);
CREATE TABLE IF NOT EXISTS kb_links (
  from_id TEXT NOT NULL REFERENCES kb_notes(id) ON DELETE CASCADE,
  to_id   TEXT NOT NULL REFERENCES kb_notes(id) ON DELETE CASCADE,
  rel     TEXT NOT NULL DEFAULT 'related',
  PRIMARY KEY (from_id, to_id, rel)
);

-- ================================================================ TECH TREE MODEL
-- A node model covering four things:
--   1. parent/child structure      -> node_edges (adjacency, source of truth)
--   2. associations per node       -> node_edges.rel + relations (multi-kind)
--   3. required vs optional gates  -> node_edges.required + node_conditions
--   4. indexes for fast queries    -> node_closure (transitive), node_fts, idx_*
CREATE TABLE IF NOT EXISTS trees (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL UNIQUE,
  note       TEXT DEFAULT '',
  created    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id         TEXT PRIMARY KEY,
  tree_id    TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,                  -- stable id used in save files
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'tech',   -- tech|skill|upgrade|building|era
  tier       INTEGER NOT NULL DEFAULT 0,     -- era / depth band for layout
  cost       REAL NOT NULL DEFAULT 0,
  cost_unit  TEXT DEFAULT '',
  payload    TEXT DEFAULT '',                -- JSON: effects, unlocks, metadata
  tags       TEXT DEFAULT '',
  created    TEXT NOT NULL,
  UNIQUE(tree_id, key)
);
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  id UNINDEXED, key, name, tags, ngram, tokenize='unicode61'
);
CREATE INDEX IF NOT EXISTS idx_nodes_tree ON nodes(tree_id);
CREATE INDEX IF NOT EXISTS idx_nodes_tier ON nodes(tree_id, tier);

-- Adjacency list: the faithful source of truth for the DAG.
--   rel       parent->child semantics: prereq | unlock | excludes | enables
--   mode      how multiple parents combine: AND | OR | XOR | NOT
--   required  1 = must pass (gating)  0 = optional (bonus / discount only)
CREATE TABLE IF NOT EXISTS node_edges (
  id         TEXT PRIMARY KEY,
  tree_id    TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  parent_id  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  child_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  rel        TEXT NOT NULL DEFAULT 'prereq',
  mode       TEXT NOT NULL DEFAULT 'AND',
  required   INTEGER NOT NULL DEFAULT 1,
  min_level  INTEGER NOT NULL DEFAULT 1,
  weight     REAL NOT NULL DEFAULT 1,
  note       TEXT DEFAULT '',
  created    TEXT NOT NULL DEFAULT '',
  UNIQUE(parent_id, child_id, rel)
);
CREATE INDEX IF NOT EXISTS idx_edge_child  ON node_edges(child_id);
CREATE INDEX IF NOT EXISTS idx_edge_parent ON node_edges(parent_id);
CREATE INDEX IF NOT EXISTS idx_edge_req    ON node_edges(child_id, required);

-- Closure table: transitive index for ancestor/descendant queries.
-- depth 0 = self row, 1 = direct parent, n = n-th ancestor.
CREATE TABLE IF NOT EXISTS node_closure (
  tree_id    TEXT NOT NULL,
  ancestor   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  descendant TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  depth      INTEGER NOT NULL,
  PRIMARY KEY (ancestor, descendant)
);
CREATE INDEX IF NOT EXISTS idx_closure_desc ON node_closure(descendant);
CREATE INDEX IF NOT EXISTS idx_closure_anc  ON node_closure(ancestor);

-- Non-structural gates: conditions that are not other nodes.
-- required=1 blocks unlock; required=0 only modifies cost / grants bonus.
CREATE TABLE IF NOT EXISTS node_conditions (
  id       TEXT PRIMARY KEY,
  node_id  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  kind     TEXT NOT NULL DEFAULT 'flag',   -- flag|resource|level|quest|time|expr
  expr     TEXT NOT NULL DEFAULT '',       -- evaluated against a runtime state
  op       TEXT NOT NULL DEFAULT '>=',     -- >= | == | <= | != | has
  value    TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 1,
  effect   TEXT NOT NULL DEFAULT 'gate',   -- gate | cost_mul | bonus
  weight   REAL NOT NULL DEFAULT 1,
  note     TEXT DEFAULT '',
  created  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cond_node ON node_conditions(node_id);
CREATE INDEX IF NOT EXISTS idx_cond_req  ON node_conditions(node_id, required);
-- (node_conditions.created is added by upgrade8to9 for existing DBs; new DBs get it from upgrade8to9 too since SCHEMA_SQL doesn't declare it inline)

-- Runtime state per context (save slot / player / run).
CREATE TABLE IF NOT EXISTS node_state (
  tree_id  TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  context  TEXT NOT NULL DEFAULT 'default',
  node_id  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  status   TEXT NOT NULL DEFAULT 'locked',  -- locked|available|unlocked
  level    INTEGER NOT NULL DEFAULT 0,
  progress REAL NOT NULL DEFAULT 0,
  updated  TEXT NOT NULL,
  PRIMARY KEY (tree_id, context, node_id)
);
CREATE INDEX IF NOT EXISTS idx_state_ctx    ON node_state(tree_id, context);
CREATE INDEX IF NOT EXISTS idx_state_status ON node_state(tree_id, context, status);

-- Denormalized index on nodes, refreshed by the 'node index' command.
-- topo_order lets "can I research this" skip recursive traversal.
CREATE TABLE IF NOT EXISTS node_index (
  tree_id     TEXT PRIMARY KEY REFERENCES trees(id) ON DELETE CASCADE,
  topo_order  TEXT NOT NULL DEFAULT '',   -- JSON array of node ids
  tiers       TEXT NOT NULL DEFAULT '',   -- JSON: tier -> [node ids]
  in_degree   TEXT NOT NULL DEFAULT '',   -- JSON: node id -> required parent count
  built_at    TEXT NOT NULL,
  dirty       INTEGER NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------- generic graph
CREATE TABLE IF NOT EXISTS relations (
  id       TEXT PRIMARY KEY,
  src_type TEXT NOT NULL, src_id TEXT NOT NULL,
  dst_type TEXT NOT NULL, dst_id TEXT NOT NULL,
  rel      TEXT NOT NULL DEFAULT 'related',
  weight   REAL NOT NULL DEFAULT 1,
  created  TEXT NOT NULL DEFAULT '',
  UNIQUE(src_type, src_id, dst_type, dst_id, rel)
);

-- ---------------------------------------------------------------- scheduling
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  command       TEXT NOT NULL,
  every_minutes INTEGER DEFAULT 0,
  at            TEXT DEFAULT '',     -- one-shot ISO datetime
  enabled       INTEGER NOT NULL DEFAULT 1,
  runs          INTEGER NOT NULL DEFAULT 0,
  last_run      TEXT DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending',
  created       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id       TEXT PRIMARY KEY,
  job_id   TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  started  TEXT NOT NULL,
  finished TEXT DEFAULT '',
  rc       INTEGER,
  output   TEXT DEFAULT ''
);

-- ---------------------------------------------------------------- audit log
CREATE TABLE IF NOT EXISTS events (
  id        TEXT PRIMARY KEY,
  ts        TEXT NOT NULL,
  actor     TEXT NOT NULL DEFAULT 'cli',
  kind      TEXT NOT NULL,
  entity    TEXT DEFAULT '',
  entity_id TEXT DEFAULT '',
  payload   TEXT DEFAULT '',
  level     TEXT NOT NULL DEFAULT 'info',  -- v7 telemetry severity: info|warn|error
  seq       INTEGER                        -- v10/PG-A④: PG-side BIGSERIAL ordering; SQLite NULL (rowid is the native order since 0.87.1)
);

-- ---------------------------------------------------------------- schema ledger
-- v10/PG-A③: applied-schema bookkeeping on BOTH backends — the SQLite side
-- records each applied user_version; the PG side records the mirrored schema
-- generation. Dual-write (B segment) consults this to gate format changes.
CREATE TABLE IF NOT EXISTS schema_migrations (
  backend    TEXT NOT NULL,               -- 'sqlite' | 'postgres'
  version    INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (backend, version)
);

CREATE INDEX IF NOT EXISTS idx_sources_project  ON sources(project_id);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project_id);
CREATE INDEX IF NOT EXISTS idx_claims_project   ON claims(project_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_proj   ON artifacts(project_id);
CREATE INDEX IF NOT EXISTS idx_events_ts        ON events(ts);
CREATE INDEX IF NOT EXISTS idx_jobs_enabled     ON jobs(enabled);

-- idempotent-write uniqueness (schema v3; named indexes serve both fresh
-- installs and v2 upgrades — keep CREATE TABLEs free of inline UNIQUE)
CREATE UNIQUE INDEX IF NOT EXISTS uq_queries_content  ON queries(project_id, content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_content ON evidence(source_id, content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claims_content   ON claims(project_id, content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_content       ON kb_notes(content_hash);

-- v5: skill refs add upserts ON CONFLICT(skill_id, path) — the unique index
-- it depends on was missing since v1 (the command errored on first use)
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_refs ON skill_refs(skill_id, path);
`;

export class DB {
  readonly db: Database;
  readonly path: string;
  /** True when THIS instance acquired the .ygllock (0.79.1) — lock-less
   *  instances (serve, db unlock) never release a foreign lock. */
  ownsLock = false;

  constructor(file: string, opts?: { lock?: boolean }) {
    this.path = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const useLock = opts?.lock === true; // opt-in: only the CLI entry point locks
    // P0-2 (real-user incident): single-writer mutex. node-sqlite3-wasm has no
    // concurrent-write protection; two CLI processes writing simultaneously
    // corrupted the DB ("malformed"). App-level dir lock with pid file +
    // stale steal + friendly error.
    //
    // NAME COLLISION (0.65.0 P0): node-sqlite3-wasm's Node VFS implements
    // sqlite's own file-lock protocol with exactly `${file}.lock` (mkdir on
    // lock, EEXIST → SQLITE_BUSY, rmdir on unlock). An app lock using that
    // name made every locked open fail BUSY on itself. Ours is `.ygllock` —
    // the wasm protocol dir stays untouched.
    const legacyLockDir = `${file}.lock`;
    if (fs.existsSync(path.join(legacyLockDir, "pid"))) {
      // orphaned 0.65.0 app-layer lock (wasm protocol dirs are empty — a pid
      // file marks it as ours) would block wasm forever; remove it.
      try { fs.rmSync(legacyLockDir, { recursive: true, force: true }); } catch { /* */ }
    }
    const lockDir = `${file}.ygllock`;
    if (useLock && fs.existsSync(lockDir)) {
      let holder = "unknown";
      try { holder = fs.readFileSync(path.join(lockDir, "pid"), "utf8").trim(); } catch { /* */ }
      // Same-process re-entry backstop (0.65.0 self-deadlock lesson).
      const mine = holder === String(process.pid);
      // PID liveness (P1 cold-user report): the 15-minute mtime window was a
      // blunt proxy — on Windows the exit-time rmSync can silently fail (EBUSY
      // from an un-released handle), leaving an orphaned lock whose mtime is
      // recent. A dead holder means the lock is garbage regardless of mtime;
      // a live holder means it is real regardless of mtime.
      //   signal 0 = pure existence check (does NOT kill the process)
      //   EPERM   = exists but permission-denied (Windows ACL) — still alive
      //   ESRCH   = no such process — dead, steal the lock
      let holderAlive: boolean;
      if (mine) holderAlive = false; // our own stale entry — always steal
      else {
        try {
          process.kill(Number(holder), 0);
          holderAlive = true;
        } catch (e: any) {
          holderAlive = e.code === "EPERM"; // EPERM = alive (Windows), ESRCH = dead
        }
      }
      if (!holderAlive) {
        // Orphaned lock (holder crashed / exit cleanup failed) — steal now.
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* */ }
      } else {
        // 0.79.1 (R297 user report): the old hint guessed "serve? webui
        // dashboard" — but serve never takes the write lock, so the guess
        // sent users to kill the wrong process. The lock dir now carries a
        // `cmd` file (written at acquisition) naming the real holder.
        let holderCmd = "";
        try { holderCmd = fs.readFileSync(path.join(lockDir, "cmd"), "utf8").trim(); } catch { /* */ }
        throw new Error(
          `database is locked by another process (pid: ${holder}).\n` +
          (holderCmd
            ? `  holder command: ${holderCmd}\n`
            : `  the holder is almost certainly a parallel CLI session (serve never takes the write lock);\n`) +
          `  read commands still work. The lock self-heals once pid ${holder} exits —\n` +
          `  simply retry after it finishes.\n` +
          `  to clear manually:  ygl-trees db unlock   (checks pid liveness, refuses live holders)\n` +
          `  last resort:         rmdir "${lockDir}"`
        );
      }
    }
    // acquire the lock (best-effort; crash cleanup via stale detection above)
    let acquired = false;
    if (useLock) try {
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid));
      acquired = true;
      // 0.79.1: self-reported holder identity — the collision error and
      // `db unlock` read this back instead of guessing who holds the lock.
      try {
        const cmd = [process.argv0, ...process.argv.slice(1)].join(" ").slice(0, 240);
        fs.writeFileSync(path.join(lockDir, "cmd"), cmd);
      } catch { /* identity is best-effort */ }
      // P1 cold-user report (Windows): `process.on("exit")` rmSync can silently
      // fail when the SQLite handle hasn't been released yet (EBUSY on the dir).
      // Two mitigations:
      //   1. beforeExit fires earlier (while the event loop is still alive)
      //   2. PID liveness check (above) makes any residual lock self-healing —
      //      the NEXT process sees a dead PID and clears it immediately.
      const cleanup = () => {
        for (let i = 0; i < 3; i++) { // retry: Windows may need a tick
          try { fs.rmSync(lockDir, { recursive: true, force: true }); return; } catch { /* */ }
        }
      };
      process.on("beforeExit", cleanup);
      process.on("exit", cleanup);
    } catch { /* lock creation failure is non-fatal (read-only scenarios) */ }
    // 0.79.1: ownership flag — lock-less instances (serve, db unlock) must
    // never release a FOREIGN lock on close/exit (latent since serve existed,
    // made acute by lock-free `db unlock`).
    this.ownsLock = acquired;
    this.db = new Database(file);
    this.db.exec("PRAGMA journal_mode=WAL");
    // WAL + NORMAL (sqlite.org recommended pairing): commits skip the per-tx
    // fsync (~14ms on Windows) and sync at WAL checkpoints instead. A power
    // loss may roll back the last transactions; the database cannot corrupt.
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.migrate();
  }

  /** Release the write lock (called by close() and process exit).
   *  Ownership-guarded since 0.79.1: a lock-less instance (serve, db unlock)
   *  shares the workspace with a foreign holder — its close() must not nuke
   *  that holder's lock. */
  private releaseLock(): void {
    if (!this.ownsLock) return;
    try {
      const lockDir = `${this.path}.ygllock`;
      if (fs.existsSync(lockDir)) fs.rmSync(lockDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }

  /** Static: force-release a lock (for cleanup hooks). */
  static releaseLockFor(file: string): void {
    try {
      const lockDir = `${file}.ygllock`;
      if (fs.existsSync(lockDir)) fs.rmSync(lockDir, { recursive: true, force: true });
    } catch { /* */ }
  }

  /** Static: read the holder pid of a lock file ("" when absent/unreadable). */
  static lockHolder(file: string): string {
    try {
      return fs.readFileSync(path.join(`${file}.ygllock`, "pid"), "utf8").trim();
    } catch {
      return "";
    }
  }

  /** Static: read the holder's self-reported command line ("" when absent). */
  static lockHolderCmd(file: string): string {
    try {
      return fs.readFileSync(path.join(`${file}.ygllock`, "cmd"), "utf8").trim();
    } catch {
      return "";
    }
  }

  private migrate(): void {
    let row: { user_version: number } | null;
    try {
      row = this.get<{ user_version: number }>("PRAGMA user_version");
    } catch (e: any) {
      if (String(e.message).includes("malformed") || String(e.message).includes("not a database")) {
        throw new Error(
          `database corrupted: ${this.path}
` +
          `  ${e.message}
` +
          `  
` +
          `  自愈路径（库可随时从源文件重建）：
` +
          `  1. 备份损坏库：  cp "${this.path}" "${this.path}.corrupt.bak"
` +
          `  2. 重置：        ygl-trees db reset
` +
          `  3. 重新导入：    ygl-trees db init && ygl-trees kb import <源目录>
` +
          `     （kb 笔记全部有源 .md 文件在盘上，库只是索引）`
        );
      }
      throw e;
    }
    const v = row?.user_version ?? 0;
    if (v < SCHEMA_VERSION) {
      // A replayed dump has user_version=0 but tables already exist — the
      // version number alone cannot be trusted to mean "fresh install".
      const tablesPreExist = !!this.get(
        "SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='claims'"
      );
      // ALTER + backfill BEFORE SCHEMA_SQL creates its unique indexes
      // (they would fail on empty-hash duplicates).
      if (v > 0 || tablesPreExist) this.upgrade2to3();
      if ((v > 0 && v < 7) || (v === 0 && tablesPreExist)) this.upgrade6to7();
      if ((v > 0 && v < 8) || (v === 0 && tablesPreExist)) this.upgrade7to8();
      if ((v > 0 && v < 9) || (v === 0 && tablesPreExist)) this.upgrade8to9();
      if ((v > 0 && v < 10) || (v === 0 && tablesPreExist)) this.upgrade9to10();
      this.db.exec(SCHEMA_SQL);
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      // PG-A③: seed the ledger every open (INSERT OR IGNORE — one row per
      // applied version; replay-safe)
      this.db.run(
        `INSERT OR IGNORE INTO schema_migrations(backend,version,applied_at,note) VALUES('sqlite',?,?,?)`,
        [SCHEMA_VERSION, nowIso(), 'v10: events.seq + schema_migrations ledger (PG-A foundation)']
      );
    }
  }

  /** v9 -> v10 (PG-A foundation, 单5): events gains a nullable seq column
   * (PG-side BIGSERIAL; SQLite keeps rowid as native order) and the
   * schema_migrations ledger table lands on both backends. */
  private upgrade9to10(): void {
    const hasSeq = this.get("SELECT 1 FROM pragma_table_info('events') WHERE name='seq'");
    if (!hasSeq) this.db.exec(`ALTER TABLE events ADD COLUMN seq INTEGER`);
  }

  /** v7 -> v8: engineering artifact envelope (spec R12) — task status machine
   *  and design_type ride in a JSON meta column on artifacts. */
  private upgrade7to8(): void {
    const hasTable = this.get("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='artifacts'");
    if (!hasTable) return;
    const has = this.get("SELECT 1 FROM pragma_table_info('artifacts') WHERE name='meta'");
    if (!has) this.db.exec(`ALTER TABLE artifacts ADD COLUMN meta TEXT NOT NULL DEFAULT ''`);
  }

  /** v8 -> v9 (0.58): time is a critical dimension — six tables gain
   *  created/updated columns, backfilled from events when possible. */
  private upgrade8to9(): void {
    const now = new Date().toISOString();
    const addCol = (table: string, col: string) => {
      const has = this.get(`SELECT 1 FROM pragma_table_info('${table}') WHERE name='${col}'`);
      if (!has) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    };
    addCol("sources", "created");
    addCol("claims", "updated");
    addCol("artifacts", "updated");
    addCol("node_edges", "created");
    addCol("node_conditions", "created");
    addCol("relations", "created");
    // Backfill from events where traceable; fall back to created/current time
    try {
      this.db.exec(`UPDATE sources SET created=COALESCE((SELECT MIN(e.ts) FROM events e WHERE e.kind='source.add' AND e.entity_id=sources.id),'${now}') WHERE created='' OR created IS NULL`);
      this.db.exec(`UPDATE claims SET updated=COALESCE((SELECT MAX(e.ts) FROM events e WHERE e.kind='claim.resolve' AND e.entity_id=claims.id),created) WHERE updated='' OR updated IS NULL`);
      this.db.exec(`UPDATE artifacts SET updated=COALESCE((SELECT MAX(e.ts) FROM events e WHERE e.kind LIKE 'artifact%' AND e.entity_id=artifacts.id),created) WHERE updated='' OR updated IS NULL`);
      this.db.exec(`UPDATE node_edges SET created='${now}' WHERE created='' OR created IS NULL`);
      this.db.exec(`UPDATE node_conditions SET created='${now}' WHERE created='' OR created IS NULL`);
      this.db.exec(`UPDATE relations SET created='${now}' WHERE created='' OR created IS NULL`);
    } catch { /* best-effort backfill */ }
  }

  /** v6 -> v7: telemetry severity on events (spec R10.2). Existing rows are
   *  info by definition — the audit ledger has only ever carried outcomes. */
  private upgrade6to7(): void {
    const hasTable = this.get("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='events'");
    if (!hasTable) return; // SCHEMA_SQL below creates it fresh (with level)
    const has = this.get("SELECT 1 FROM pragma_table_info('events') WHERE name='level'");
    if (!has) this.db.exec(`ALTER TABLE events ADD COLUMN level TEXT NOT NULL DEFAULT 'info'`);
  }

  /**
   * v2 -> v3: add content_hash to claims / evidence / queries / kb_notes and
   * backfill it with sha1 of the content (MUST match runtime contentHash —
   * plain sha1 of the content, no scope prefix; the unique index columns
   * carry the scoping). Pre-existing duplicate rows get a salted hash
   * ("#dup<n>") instead of being merged — no silent data changes; leftovers
   * remain visible via `db dups`.
   */
  private upgrade2to3(): void {
    for (const t of ["claims", "evidence", "queries", "kb_notes"]) {
      const has = this.get(`SELECT 1 FROM pragma_table_info('${t}') WHERE name='content_hash'`);
      if (!has) this.db.exec(`ALTER TABLE ${t} ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''`);
    }
    const specs = [
      { t: "claims", scope: "project_id", pick: (r: any) => String(r.text) },
      { t: "queries", scope: "project_id", pick: (r: any) => String(r.text) },
      { t: "evidence", scope: "source_id", pick: (r: any) => String(r.quote) },
      { t: "kb_notes", scope: "", pick: (r: any) => `${r.title}\n${r.body}` },
    ];
    for (const s of specs) {
      const rows = this.all(`SELECT rowid AS __rid, * FROM ${s.t} WHERE content_hash=''`);
      // group by (scope, content) to detect duplicates, but hash the bare
      // content so the value matches what runtime writes produce
      const seen = new Map<string, number>();
      for (const r of rows) {
        const content = s.pick(r);
        const group = (s.scope ? `${r[s.scope]}|` : "") + content;
        const n = (seen.get(group) || 0) + 1;
        seen.set(group, n);
        const h = n > 1 ? `${sha1(content)}#dup${n}` : sha1(content);
        this.run(`UPDATE ${s.t} SET content_hash=? WHERE rowid=?`, [h, r.__rid]);
      }
    }
  }

  // -- low level -------------------------------------------------------
  all<T = any>(sql: string, params: any[] = []): T[] {
    const st = this.db.prepare(sql);
    try {
      return st.all(params) as T[];
    } finally {
      st.finalize();
    }
  }

  get<T = any>(sql: string, params: any[] = []): T | null {
    const st = this.db.prepare(sql);
    try {
      return (st.get(params) as T) ?? null;
    } finally {
      st.finalize();
    }
  }

  run(sql: string, params: any[] = []): { changes: number; lastInsertRowid: number } {
    const st = this.db.prepare(sql);
    try {
      const r = st.run(params);
      return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
    } finally {
      st.finalize();
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  txDepth = 0;
  /** Re-entrant: a tx opened inside another tx joins it (no nested BEGIN),
   *  so a helper with its own tx stays composable inside a larger unit. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.txDepth++;
    this.exec("BEGIN");
    try {
      const r = fn();
      this.exec("COMMIT");
      return r;
    } catch (e) {
      this.exec("ROLLBACK");
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  // -- meta ------------------------------------------------------------
  metaGet(key: string, fallback = ""): string {
    const r = this.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [key]);
    return r ? r.value : fallback;
  }

  metaSet(key: string, value: string): void {
    this.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [
      key,
      value,
    ]);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
    this.releaseLock();
  }
}

// ================================================================ tree model
/** Supported parent->child relation kinds. */
export const EDGE_RELS = ["prereq", "unlock", "excludes", "enables"] as const;
/** How multiple parents of one child combine. */
export const EDGE_MODES = ["AND", "OR", "XOR", "NOT"] as const;
/** Condition kinds for non-structural gates. */
export const COND_KINDS = ["flag", "resource", "level", "quest", "time", "expr"] as const;

/** PID liveness probe (shared by lock acquisition, `db unlock`, and doctor).
 *  signal 0 = pure existence check (does NOT kill the process)
 *  EPERM    = exists but permission-denied (Windows ACL) — still alive
 *  ESRCH    = no such process — dead. NaN (garbage pid file) counts as dead. */
export function pidAlive(pidStr: string | number): boolean {
  const pid = Number(pidStr);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM"; // EPERM = alive (Windows), ESRCH = dead
  }
}

/** Resolve the active database file. */
export function dbPath(home: string): string {
  return path.join(home, "ygl-trees.db");
}
