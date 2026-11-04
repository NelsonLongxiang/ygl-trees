/**
 * AsyncTreeStore — B1 first-batch async read facade (PG plan).
 *
 * Wraps the sync TreeStore read methods with async signatures, backed by
 * the AsyncDb interface. SQLite is zero-cost (Promise.resolve wrap); PG
 * (B2/B3) implements the same AsyncDb without touching call sites.
 *
 * Write paths stay on TreeStore/writes.ts (transactional services) —
 * conventions §五 boundary unchanged.
 *
 * @module @ygl/techtree-model/async-store
 */
import { DB } from "../../../core/database/src/db";
import { AsyncDb, SqliteAsyncDb, getAsyncDb, assertSyncDelegationAllowed } from "../../../core/database/src/asyncdb";
import { TreeStore, Row } from "./reads";
import { recordSelectionVia, sessionId, type Selection } from "../../../core/database/src/selection";

/**
 * #176 W1-T3: copy one tree's rows into an in-memory SQLite workspace so the synchronous TreeStore judgement
 * (canUnlock / ready / pathTo / ancestors / descendants) runs unchanged on PG data — one implementation, no
 * dialect drift in the gate logic. Rows are read in creation order (`created, id`), the same rule as
 * pg-compat-drift #10. Only the columns the SQLite schema knows are copied (PG search columns are dropped).
 * Events are copied only for kinds that `op=telemetry` conditions of this tree count.
 */
export async function materializeTree(adb: AsyncDb, treeId: string): Promise<DB> {
  const mem = new DB(":memory:");
  mem.run("PRAGMA foreign_keys=OFF");
  const colsOf = (table: string): string[] => (mem.all(`PRAGMA table_info(${table})`) as Row[]).map((c) => String(c.name));
  const copy = async (table: string, where: string, params: unknown[], order = ""): Promise<void> => {
    const cols = colsOf(table);
    const rows = await adb.all(`SELECT ${cols.map((c) => `"${c}"`).join(",")} FROM ${table} WHERE ${where}${order}`, params);
    if (!rows.length) return;
    const st = mem.db.prepare(`INSERT INTO ${table}(${cols.map((c) => `"${c}"`).join(",")}) VALUES(${cols.map(() => "?").join(",")})`);
    for (const r of rows) st.run(cols.map((c) => (r as Row)[c] ?? null));
  };
  try {
    await copy("trees", "id=?", [treeId]);
    await copy("nodes", "tree_id=?", [treeId], " ORDER BY created, id");
    await copy("node_edges", "tree_id=?", [treeId], " ORDER BY created, id");
    await copy("node_closure", "tree_id=?", [treeId]);
    await copy("node_conditions", "node_id IN (SELECT id FROM nodes WHERE tree_id=?)", [treeId], " ORDER BY created, id");
    await copy("node_state", "tree_id=?", [treeId]);
    await copy("node_index", "tree_id=?", [treeId]);
    const kinds = new Set<string>();
    for (const c of mem.all("SELECT value FROM node_conditions WHERE op='telemetry'") as Row[]) {
      const m = /^([A-Za-z0-9_.\/-]+)/.exec(String(c.value).trim());
      if (m) kinds.add(m[1]);
    }
    if (kinds.size) await copy("events", `kind IN (${[...kinds].map(() => "?").join(",")})`, [...kinds], " ORDER BY ts, id");
  } catch (e) {
    mem.close(); // a failed copy must not leak the in-memory handle
    throw e;
  }
  return mem;
}

export class AsyncTreeStore {
  private readonly sync: TreeStore;
  private readonly adb: AsyncDb;

  constructor(db: DB) {
    this.sync = new TreeStore(db);
    this.adb = getAsyncDb(db);
  }

  /** Release the PG connection (no-op on SQLite). The CLI process cannot exit while it is open. */
  async close(): Promise<void> {
    if (this.adb.dialect === "pg") await (this.adb as import("../../../core/database/src/asyncdb").PgAsyncDb).close();
  }

  /** #176 W1-T1: PG business mode (YGL_DB_URL) — the PG branches below return the SQLite row shapes. */
  get pg(): boolean {
    return this.adb.dialect === "pg";
  }

  /** #77③: every delegated method calls this first — PG mode has no sync face. */
  private guard(): void {
    assertSyncDelegationAllowed(this.adb, "AsyncTreeStore");
  }

  // ================================================================ trees

  async treeByName(name: string): Promise<Row | null> {
    if (this.pg) return this.adb.get("SELECT * FROM trees WHERE name=? OR id=?", [name, name]);
    this.guard(); return this.sync.treeByName(name);
  }

  async treeResolve(name?: string): Promise<Row> {
    if (!this.pg) { this.guard(); return this.sync.treeResolve(name); }
    const key = name || (await this.treeSelection()).name;
    if (!key) throw new Error("no tree selected; run: ygl-trees tree new <name>");
    const t = await this.treeByName(key);
    if (!t) throw new Error(`tree not found: ${key}`);
    return t;
  }

  /** PG twin of selection.resolveTree: flag > env > session chain > global > only > none. */
  private async pgTreeSelection(explicit?: string): Promise<Selection> {
    if (explicit) return { name: explicit, id: "", source: "flag" };
    if (process.env.YGL_TREE) return { name: process.env.YGL_TREE, id: "", source: "env" };
    const parts = sessionId().split("/").filter(Boolean);
    const chain = parts.length ? parts.map((_, i) => `current_tree@${parts.slice(0, parts.length - i).join("/")}`) : ["current_tree@default"];
    for (const key of chain) {
      const v = await this.metaGet(key);
      if (v) return { name: v, id: "", source: "session" };
    }
    const g = await this.metaGet("current_tree");
    if (g) return { name: g, id: "", source: "global" };
    const rows = await this.adb.all("SELECT name FROM trees LIMIT 2");
    return rows.length === 1 ? { name: rows[0].name, id: "", source: "only" } : { name: "", id: "", source: "none" };
  }

  /** PG twin of selection.resolveProject for the tree-use mismatch hint: flag > env > session chain. */
  async pgProjectSelection(flag?: string): Promise<{ id: string; name: string; source: string }> {
    let name = flag || process.env.YGL_PROJECT || "";
    let source = flag ? "flag" : name ? "env" : "none";
    if (!name) {
      const parts = sessionId().split("/").filter(Boolean);
      const chain = parts.length ? parts.map((_, i) => `current_project@${parts.slice(0, parts.length - i).join("/")}`) : ["current_project@default"];
      for (const key of chain) { const v = await this.metaGet(key); if (v) { name = v; source = "session"; break; } }
    }
    const row = name ? await this.projectByName(name) : null;
    return { id: row ? String(row.id) : "", name, source };
  }

  async metaGet(key: string): Promise<string> {
    const r = await this.adb.get("SELECT value FROM meta WHERE key=?", [key]);
    return r ? String(r.value) : "";
  }

  async metaSet(key: string, value: string): Promise<void> {
    if (!this.pg) { this.guard(); (this.sync.db as any).metaSet(key, value); return; }
    await this.adb.all("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]);
  }

  async treeCount(): Promise<number> {
    const r = await this.adb.get(this.pg ? "SELECT COUNT(*)::int AS n FROM trees" : "SELECT COUNT(*) AS n FROM trees");
    return Number(r?.n ?? 0);
  }

  async projectByName(name: string): Promise<Row | null> {
    return this.adb.get("SELECT id, name FROM projects WHERE name=?", [name]);
  }

  async projectNameById(id: string): Promise<string | null> {
    const r = await this.adb.get("SELECT name FROM projects WHERE id=?", [id]);
    return r ? String(r.name) : null;
  }

  async treeStats(treeId: string): Promise<{ nodes: number; edges: number; unlocked: number }> {
    const c = this.pg ? "::int" : "";
    const r = await this.adb.get(
      `SELECT (SELECT COUNT(*)${c} FROM nodes n WHERE n.tree_id=?) AS nodes,
              (SELECT COUNT(*)${c} FROM node_edges e WHERE e.tree_id=?) AS edges,
              (SELECT COUNT(*)${c} FROM node_state s WHERE s.tree_id=? AND s.status='unlocked') AS unlocked`,
      [treeId, treeId, treeId]);
    return { nodes: Number(r?.nodes ?? 0), edges: Number(r?.edges ?? 0), unlocked: Number(r?.unlocked ?? 0) };
  }

  /** Selection change telemetry (tree.use / project.use), same row shape on both dialects. */
  async logSelection(kind: "tree.use" | "project.use", name: string): Promise<{ ts: string; payload: string }> {
    const ts = new Date().toISOString();
    const payload = JSON.stringify({ name, session: process.env.YGL_SESSION || "cli" });
    await this.adb.all(
      "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,?)",
      [`ev${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ts, process.env.YGL_SESSION || "cli", kind, kind === "tree.use" ? "tree" : "project", name, payload, "info"]);
    return { ts, payload };
  }

  async trees(): Promise<Row[]> {
    return this.adb.all("SELECT * FROM trees ORDER BY created");
  }

  // ================================================================ nodes

  async nodesOfTree(treeId: string): Promise<Row[]> {
    return this.adb.all("SELECT * FROM nodes WHERE tree_id=? ORDER BY created", [treeId]);
  }

  async nodeByKey(treeId: string, key: string): Promise<Row | null> {
    return this.adb.get("SELECT * FROM nodes WHERE tree_id=? AND key=?", [treeId, key]);
  }

  async edgesOf(treeId: string): Promise<Row[]> {
    return this.adb.all("SELECT * FROM node_edges WHERE tree_id=? ORDER BY created", [treeId]);
  }

  async conditionsOf(treeId: string, nodeKey?: string): Promise<Row[]> {
    if (nodeKey) {
      return this.adb.all(
        "SELECT c.* FROM node_conditions c JOIN nodes n ON n.id=c.node_id WHERE n.tree_id=? AND n.key=? ORDER BY c.created",
        [treeId, nodeKey]);
    }
    return this.adb.all(
      "SELECT c.* FROM node_conditions c JOIN nodes n ON n.id=c.node_id WHERE n.tree_id=? ORDER BY c.created",
      [treeId]);
  }

  // ================================================================ reads (delegate)

  async treeList(): Promise<Row[]> {
    if (this.pg) {
      return this.adb.all(
        `SELECT t.name, t.note,
                (SELECT COUNT(*)::int FROM nodes n WHERE n.tree_id=t.id) AS nodes,
                (SELECT COUNT(*)::int FROM node_edges e WHERE e.tree_id=t.id) AS edges,
                (SELECT dirty FROM node_index i WHERE i.tree_id=t.id) AS dirty,
                t.created
           FROM trees t ORDER BY t.created DESC`);
    }
    this.guard(); return this.sync.treeList();
  }
  async treeSelection(name?: string): Promise<{ name: string | null; source: string }> {
    if (this.pg) return recordSelectionVia(await this.pgTreeSelection(name));
    this.guard(); return this.sync.treeSelection(name);
  }
  async nodeGet(treeId: string, keyOrId: string): Promise<Row | null> {
    if (this.pg) {
      const r = await this.adb.get("SELECT * FROM nodes WHERE tree_id=? AND (key=? OR id=?)", [treeId, keyOrId, keyOrId]);
      if (!r) return null;
      const { ngram: _n, ngram_tsv: _t, ...rest } = r as any;
      return rest;
    }
    this.guard(); return this.sync.nodeGet(treeId, keyOrId);
  }
  async nodeInOtherTrees(keyOrId: string, excludeTreeId: string): Promise<{ tree: string; key: string }[]> {
    if (this.pg) {
      return this.adb.all(
        `SELECT t.name AS tree, n.key FROM nodes n JOIN trees t ON t.id=n.tree_id
          WHERE n.tree_id<>? AND (n.key=? OR n.id=?) LIMIT 5`,
        [excludeTreeId, keyOrId, keyOrId]) as any;
    }
    this.guard(); return this.sync.nodeInOtherTrees(keyOrId, excludeTreeId);
  }
  async nodeStateOf(treeId: string, keyOrId: string, context = "default"): Promise<{ state: string; unlocked_at: string | null }> {
    if (this.pg) {
      const r = await this.adb.get(
        `SELECT st.status AS state, CASE WHEN st.status='unlocked' THEN st.updated ELSE NULL END AS unlocked_at
           FROM nodes n LEFT JOIN node_state st ON st.node_id=n.id AND st.context=?
          WHERE n.tree_id=? AND (n.key=? OR n.id=?)`,
        [context, treeId, keyOrId, keyOrId]) as any;
      return { state: r?.state || "locked", unlocked_at: r?.unlocked_at || null };
    }
    this.guard(); return this.sync.nodeStateOf(treeId, keyOrId, context);
  }
  async parents(treeId: string, keyOrId: string): Promise<Row[]> {
    if (this.pg) {
      const n = await this.nodeGet(treeId, keyOrId);
      if (!n) return [];
      return this.adb.all(
        `SELECT p.key, p.name, e.rel, e.mode, e.required, e.min_level, e.weight, e.note
           FROM node_edges e JOIN nodes p ON p.id=e.parent_id
          WHERE e.child_id=? ORDER BY e.required DESC, p.key COLLATE "C"`,
        [n.id]);
    }
    this.guard(); return this.sync.parents(treeId, keyOrId);
  }
  async children(treeId: string, keyOrId: string): Promise<Row[]> {
    if (this.pg) {
      const n = await this.nodeGet(treeId, keyOrId);
      if (!n) return [];
      return this.adb.all(
        `SELECT c.key, c.name, e.rel, e.mode, e.required, e.min_level, e.weight
           FROM node_edges e JOIN nodes c ON c.id=e.child_id
          WHERE e.parent_id=? ORDER BY e.required DESC, c.key COLLATE "C"`,
        [n.id]);
    }
    this.guard(); return this.sync.children(treeId, keyOrId);
  }
  async ancestors(treeId: string, keyOrId: string, depth?: number): Promise<Row[]> {
    if (this.pg) return this.onTreeCopy(treeId, (t) => t.ancestors(treeId, keyOrId, depth));
    this.guard(); return this.sync.ancestors(treeId, keyOrId, depth);
  }
  async descendants(treeId: string, keyOrId: string): Promise<Row[]> {
    if (this.pg) return this.onTreeCopy(treeId, (t) => t.descendants(treeId, keyOrId));
    this.guard(); return this.sync.descendants(treeId, keyOrId);
  }
  async condList(treeId: string, keyOrId: string): Promise<Row[]> {
    if (this.pg) {
      const n = await this.nodeGet(treeId, keyOrId);
      if (!n) return [];
      return this.adb.all(
        `SELECT id,name,kind,expr,op,value,required,effect,weight FROM node_conditions WHERE node_id=? ORDER BY required DESC, name COLLATE "C"`,
        [n.id]);
    }
    this.guard(); return this.sync.condList(treeId, keyOrId);
  }
  async evalContext(treeId: string, keyOrId: string, stateBag: Record<string, any>, context?: string): Promise<Row> { this.guard(); return this.sync.evalContext(treeId, keyOrId, stateBag, context); }
  async evalCandidates(treeId: string, context?: string, state?: Record<string, any>): Promise<Row[]> { this.guard(); return this.sync.evalCandidates(treeId, context, state); }
  async nodeSearch(treeId: string, q: string, limit?: number): Promise<Row[]> { this.guard(); return this.sync.nodeSearch(treeId, q, limit); }
  async pathTo(treeId: string, targetKey: string, context?: string): Promise<{ order: string[]; total_cost: number }> {
    if (this.pg) return this.onTreeCopy(treeId, (t) => t.pathTo(treeId, targetKey, context));
    this.guard(); return this.sync.pathTo(treeId, targetKey, context);
  }
  async validate(treeId: string): Promise<string[]> { this.guard(); return this.sync.validate(treeId); }

  /** PG: run a synchronous TreeStore read against an in-memory copy of one tree (see materializeTree). */
  private async onTreeCopy<T>(treeId: string, fn: (t: TreeStore) => T): Promise<T> {
    const mem = await materializeTree(this.adb, treeId);
    try { return fn(new TreeStore(mem)); } finally { mem.close(); }
  }

  async nodeList(treeId: string, context = "default"): Promise<Row[]> {
    if (this.pg) {
      // COLLATE "C" = SQLite's BINARY order for keys; counts cast so JSON carries numbers, not bigint strings.
      return this.adb.all(
        `SELECT n.key, n.name, n.kind, n.tier, n.cost, n.tags,
                (SELECT COUNT(*)::int FROM node_edges e WHERE e.child_id=n.id AND e.required=1) AS req_parents,
                (SELECT COUNT(*)::int FROM node_edges e WHERE e.parent_id=n.id) AS children,
                COALESCE(st.status,'locked') AS state,
                CASE WHEN st.status='unlocked' THEN st.updated ELSE NULL END AS unlocked_at
           FROM nodes n
           LEFT JOIN node_state st ON st.node_id=n.id AND st.context=?
          WHERE n.tree_id=? ORDER BY n.tier, n.key COLLATE "C"`,
        [context, treeId]);
    }
    this.guard(); return this.sync.nodeList(treeId, context);
  }

  async canUnlock(treeId: string, keyOrId: string, context?: string, state?: Record<string, any>): Promise<unknown> {
    if (this.pg) return this.onTreeCopy(treeId, (t) => t.canUnlock(treeId, keyOrId, context, state));
    this.guard(); return this.sync.canUnlock(treeId, keyOrId, context, state);
  }

  async ready(treeId: string, context?: string, state?: Record<string, any>): Promise<Row[]> {
    if (this.pg) return this.onTreeCopy(treeId, (t) => t.ready(treeId, context, state));
    this.guard(); return this.sync.ready(treeId, context, state);
  }

  async exportTree(treeId: string): Promise<unknown> {
    this.guard(); return this.sync.exportTree(treeId);
  }

  // ================================================================ raw async (for new code)

  /** Direct async query — for B1+ new code paths that should not add sync reads. */
  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    return this.adb.all(sql, params);
  }

  /** Direct async single-row — same contract as DB.get. */
  async queryOne(sql: string, params: unknown[] = []): Promise<Row | null> {
    return this.adb.get(sql, params);
  }
}
