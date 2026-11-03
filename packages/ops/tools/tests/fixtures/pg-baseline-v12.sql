-- #176 W5b: frozen PG baseline v12 = MIGRATE_DDL + MIGRATE_INDEXES exactly as shipped in ygl-trees 0.119.0 (tag v0.119.0).
-- Never edit: the real-PG replay (b8-pg-upgrade.spec.ts) builds the oldest supported PG database from this file.
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
  status text NOT NULL DEFAULT 'pending', created text NOT NULL);
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
CREATE INDEX IF NOT EXISTS idx_sources_project  ON sources(project_id);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project_id);
CREATE INDEX IF NOT EXISTS idx_claims_project   ON claims(project_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_proj   ON artifacts(project_id);
CREATE INDEX IF NOT EXISTS idx_events_ts        ON events(ts);
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
-- Post-DDL steps of migrateToPg as shipped in 0.119.0: ngram + generated tsvector + GIN on the five searchable tables, then the ledger row.
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS ngram text NOT NULL DEFAULT '';
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS ngram_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', regexp_replace(coalesce(ngram,''), '[/\._:,&+()]+', ' ', 'g'))) STORED;
CREATE INDEX IF NOT EXISTS "skills_tsv" ON "skills" USING GIN (ngram_tsv);
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS ngram text NOT NULL DEFAULT '';
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS ngram_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', regexp_replace(coalesce(ngram,''), '[/\._:,&+()]+', ' ', 'g'))) STORED;
CREATE INDEX IF NOT EXISTS "sources_tsv" ON "sources" USING GIN (ngram_tsv);
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS ngram text NOT NULL DEFAULT '';
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS ngram_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', regexp_replace(coalesce(ngram,''), '[/\._:,&+()]+', ' ', 'g'))) STORED;
CREATE INDEX IF NOT EXISTS "evidence_tsv" ON "evidence" USING GIN (ngram_tsv);
ALTER TABLE "kb_notes" ADD COLUMN IF NOT EXISTS ngram text NOT NULL DEFAULT '';
ALTER TABLE "kb_notes" ADD COLUMN IF NOT EXISTS ngram_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', regexp_replace(coalesce(ngram,''), '[/\._:,&+()]+', ' ', 'g'))) STORED;
CREATE INDEX IF NOT EXISTS "kb_notes_tsv" ON "kb_notes" USING GIN (ngram_tsv);
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS ngram text NOT NULL DEFAULT '';
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS ngram_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', regexp_replace(coalesce(ngram,''), '[/\._:,&+()]+', ' ', 'g'))) STORED;
CREATE INDEX IF NOT EXISTS "nodes_tsv" ON "nodes" USING GIN (ngram_tsv);
INSERT INTO schema_migrations(backend,version,applied_at,note) VALUES('postgres',12,'2026-11-03T00:00:00.000Z','frozen v12 baseline (0.119.0)');
