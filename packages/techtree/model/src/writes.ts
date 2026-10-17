/**
 * Transactional TypeORM write service — tree/node domain (migration batch 3,
 * the final write surface; see docs/conventions.md §五).
 *
 * Ports the TreeStore write semantics verbatim into single transactions:
 *   validations (enums, self-loop, cycle guard via closure) → writes →
 *   closure rebuild → derived index refresh. Cycle detection still throws
 *   at build time, never at runtime. TreeStore historically logs NO events
 *   — parity kept (documented in conventions.md).
 *
 * Read paths (can/ready/path/ancestors/validate) stay on TreeStore.
 */
import { DataSource, EntityManager } from "typeorm";
import { EDGE_MODES, EDGE_RELS, COND_KINDS } from "../../../core/database/src/db";
import { ngram, nowIso, shortId } from "../../../core/text/src/text";

async function markDirty(mgr: EntityManager, treeId: string): Promise<void> {
  await mgr.query(`INSERT INTO node_index(tree_id,built_at,dirty) VALUES(?,?,1) ON CONFLICT(tree_id) DO UPDATE SET dirty=1`, [
    treeId,
    nowIso(),
  ]);
}

/** R10.1 (0.30): tree-domain audit trail — overturns the 0.12 "no events"
 *  exception. Same shape as the research-domain logEvent (raw SQL here since
 *  treeWrites predates the entity snapshots); object payloads carry the run id. */
async function logEvent(
  mgr: EntityManager,
  kind: string,
  entityId: string,
  payload: Record<string, any>,
  level: "info" | "warn" | "error" = "info"
): Promise<void> {
  const run = process.env.YGL_RUN_ID || "";
  const body = run ? JSON.stringify({ ...payload, run }) : JSON.stringify(payload ?? {});
  await mgr.query(
    `INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,?)`,
    [shortId([kind, entityId], 12), nowIso(), "cli", kind, "node", entityId, body, level]
  );
  // 0.76: cross-domain event bus — notify real-time consumers (SSE/plugins)
  try {
    const { emitEvent } = require("../../../core/text/src/eventbus");
    emitEvent({ kind, entity: "node", entityId, payload: String(body), ts: new Date().toISOString() });
  } catch { /* eventbus optional — never block the write path */ }

}

async function reaches(mgr: EntityManager, treeId: string, fromId: string, toId: string): Promise<boolean> {
  const rows = (await mgr.query(
    `SELECT 1 AS hit FROM node_closure WHERE tree_id=? AND ancestor=? AND descendant=? AND depth>0`,
    [treeId, fromId, toId]
  )) as any[];
  return rows.length > 0;
}

/** BFS closure rebuild — same algorithm as TreeStore.rebuildClosure. */
export async function rebuildClosure(mgr: EntityManager, treeId: string): Promise<number> {
  await mgr.query(`DELETE FROM node_closure WHERE tree_id=?`, [treeId]);
  const nodes = (await mgr.query(`SELECT id FROM nodes WHERE tree_id=?`, [treeId])) as any[];
  const edges = (await mgr.query(
    `SELECT parent_id, child_id FROM node_edges WHERE tree_id=? AND rel IN ('prereq','unlock')`,
    [treeId]
  )) as any[];
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const arr = adj.get(e.child_id) || [];
    arr.push(e.parent_id);
    adj.set(e.child_id, arr);
  }
  let count = 0;
  for (const start of nodes) {
    await mgr.query(`INSERT INTO node_closure(tree_id,ancestor,descendant,depth) VALUES(?,?,?,0)`, [treeId, start.id, start.id]);
    count++;
    const seen = new Set<string>([start.id]);
    let frontier = [start.id];
    let depth = 0;
    while (frontier.length) {
      depth++;
      const next: string[] = [];
      for (const cur of frontier) {
        for (const p of adj.get(cur) || []) {
          if (seen.has(p)) continue;
          seen.add(p);
          await mgr.query(`INSERT INTO node_closure(tree_id,ancestor,descendant,depth) VALUES(?,?,?,?)`, [
            treeId,
            p,
            start.id,
            depth,
          ]);
          count++;
          next.push(p);
        }
      }
      frontier = next;
    }
  }
  return count;
}

/** Kahn topological index — same algorithm as TreeStore.buildIndex; throws
 *  on required-edge cycles so bad data fails at build time. */
export async function buildIndex(
  mgr: EntityManager,
  treeId: string
): Promise<{ topo: string[]; tiers: Record<string, string[]>; inDegree: Record<string, number> }> {
  const nodes = (await mgr.query(`SELECT id,key,tier FROM nodes WHERE tree_id=?`, [treeId])) as any[];
  const requiredParents = new Map<string, string[]>();
  for (const n of nodes) requiredParents.set(n.id, []);
  const edges = (await mgr.query(
    `SELECT parent_id,child_id FROM node_edges WHERE tree_id=? AND rel IN ('prereq','unlock') AND required=1`,
    [treeId]
  )) as any[];
  for (const e of edges) {
    const arr = requiredParents.get(e.child_id);
    if (arr) arr.push(e.parent_id);
  }

  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n.id, (requiredParents.get(n.id) || []).length);
  const children = new Map<string, string[]>();
  for (const [child, ps] of requiredParents)
    for (const p of ps) {
      const arr = children.get(p) || [];
      arr.push(child);
      children.set(p, arr);
    }
  const byKey = new Map(nodes.map((n) => [n.id, n.key]));
  const q: string[] = [];
  for (const [id, d] of indeg) if (d === 0) q.push(id);
  q.sort((a, b) => (byKey.get(a) || "").localeCompare(byKey.get(b) || ""));
  const topo: string[] = [];
  while (q.length) {
    const cur = q.shift()!;
    topo.push(cur);
    for (const ch of children.get(cur) || []) {
      const d = (indeg.get(ch) || 0) - 1;
      indeg.set(ch, d);
      if (d === 0) q.push(ch);
    }
  }
  if (topo.length !== nodes.length) {
    const stuck = nodes.filter((n) => !topo.includes(n.id)).map((n) => n.key);
    throw new Error(`cycle detected among: ${stuck.join(", ")}`);
  }

  const tierOf = new Map<string, number>(nodes.map((n) => [n.id, Number(n.tier) || 0]));
  for (const id of topo) {
    for (const p of requiredParents.get(id) || []) {
      const pt = tierOf.get(p) || 0;
      if ((tierOf.get(id) || 0) <= pt) tierOf.set(id, pt + 1);
    }
  }
  const tiers: Record<string, string[]> = {};
  for (const n of nodes) {
    const t = String(tierOf.get(n.id) ?? 0);
    (tiers[t] = tiers[t] || []).push(n.key);
  }
  const inDegree: Record<string, number> = {};
  for (const n of nodes) inDegree[n.key] = (requiredParents.get(n.id) || []).length;
  for (const n of nodes)
    await mgr.query(`UPDATE nodes SET tier=? WHERE id=? AND tier<>?`, [tierOf.get(n.id) ?? 0, n.id, tierOf.get(n.id) ?? 0]);
  await mgr.query(
    `INSERT INTO node_index(tree_id,topo_order,tiers,in_degree,built_at,dirty) VALUES(?,?,?,?,?,0)
     ON CONFLICT(tree_id) DO UPDATE SET topo_order=excluded.topo_order, tiers=excluded.tiers,
       in_degree=excluded.in_degree, built_at=excluded.built_at, dirty=0`,
    [treeId, JSON.stringify(topo), JSON.stringify(tiers), JSON.stringify(inDegree), nowIso()]
  );
  return { topo, tiers, inDegree };
}

// ================================================================ trees & nodes

export async function treeCreate(ds: DataSource, name: string, projectId = "", note = ""): Promise<Record<string, any>> {
  return ds.transaction(async (mgr) => {
    // Idempotency (frozen contract): an existing tree name is selected, not a
    // UNIQUE-constraint crash — `tree new <same>` is how a caller switches.
    const existing = (await mgr.query(`SELECT * FROM trees WHERE name=?`, [name])) as any[];
    if (existing.length) return { ...existing[0], duplicate: true };
    const id = shortId(["tree", name], 10);
    await mgr.query(`INSERT INTO trees(id,project_id,name,note,created) VALUES(?,?,?,?,?)`, [
      id,
      projectId || null,
      name,
      note,
      nowIso(),
    ]);
    await markDirty(mgr, id);
    const rows = (await mgr.query(`SELECT * FROM trees WHERE id=?`, [id])) as any[];
    return rows[0];
  });
}

export async function nodeAdd(
  ds: DataSource,
  treeId: string,
  o: { key: string; name?: string; kind?: string; tier?: number; cost?: number; cost_unit?: string; payload?: string; tags?: string }
): Promise<{ row: Record<string, any>; created: boolean }> {
  return ds.transaction(async (mgr) => {
    const ex = (await mgr.query(`SELECT * FROM nodes WHERE tree_id=? AND key=?`, [treeId, o.key])) as any[];
    if (ex.length) return { row: ex[0], created: false };
    const id = shortId(["node", treeId, o.key], 10);
    const name = o.name || o.key;
    await mgr.query(
      `INSERT INTO nodes(id,tree_id,key,name,kind,tier,cost,cost_unit,payload,tags,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [id, treeId, o.key, name, o.kind || "tech", o.tier ?? 0, o.cost ?? 0, o.cost_unit || "", o.payload || "", o.tags || "", nowIso()]
    );
    await mgr.query(`INSERT INTO nodes_fts(id,key,name,tags,ngram) VALUES(?,?,?,?,?)`, [
      id,
      o.key,
      name,
      o.tags || "",
      ngram(`${o.key} ${name} ${o.tags || ""}`),
    ]);
    await markDirty(mgr, treeId);
    await logEvent(mgr, "node.add", id, { tree: treeId, key: o.key, name, kind: o.kind || "tech", tier: o.tier ?? 0 });
    const rows = (await mgr.query(`SELECT * FROM nodes WHERE id=?`, [id])) as any[];
    return { row: rows[0], created: true };
  });
}

export async function nodeDel(ds: DataSource, treeId: string, keyOrId: string): Promise<void> {
  return ds.transaction(async (mgr) => {
    const rows = (await mgr.query(`SELECT id FROM nodes WHERE tree_id=? AND (key=? OR id=?)`, [treeId, keyOrId, keyOrId])) as any[];
    if (!rows.length) throw new Error(`node not found: ${keyOrId}`);
    await mgr.query(`DELETE FROM nodes_fts WHERE id=?`, [rows[0].id]);
    await mgr.query(`DELETE FROM nodes WHERE id=?`, [rows[0].id]); // FK cascades edges/closure/conds/state
    await markDirty(mgr, treeId);
    await logEvent(mgr, "node.delete", rows[0].id, { tree: treeId, key: keyOrId }, "warn");
  });
}

// ================================================================ edges

export async function link(
  ds: DataSource,
  treeId: string,
  parentKey: string,
  childKey: string,
  o: {
    rel?: string;
    mode?: string;
    required?: boolean;
    min_level?: number;
    weight?: number;
    note?: string;
  } = {}
): Promise<Record<string, any>> {
  return ds.transaction(async (mgr) => {
    const p = (await mgr.query(`SELECT id,key FROM nodes WHERE tree_id=? AND (key=? OR id=?)`, [treeId, parentKey, parentKey])) as any[];
    if (!p.length) throw new Error(`parent not found: ${parentKey}`);
    const c = (await mgr.query(`SELECT id,key FROM nodes WHERE tree_id=? AND (key=? OR id=?)`, [treeId, childKey, childKey])) as any[];
    if (!c.length) throw new Error(`child not found: ${childKey}`);
    const rel = o.rel || "prereq";
    if (!(EDGE_RELS as readonly string[]).includes(rel)) throw new Error(`rel must be one of ${EDGE_RELS.join("|")}`);
    const mode = o.mode || "AND";
    if (!(EDGE_MODES as readonly string[]).includes(mode)) throw new Error(`mode must be one of ${EDGE_MODES.join("|")}`);

    // Cycle guard: gating relations must keep a DAG.
    if (rel === "prereq" || rel === "unlock") {
      if (p[0].id === c[0].id) throw new Error("self-loop rejected");
      if (await reaches(mgr, treeId, c[0].id, p[0].id))
        throw new Error(`cycle rejected: ${childKey} already reaches ${parentKey}`);
    }

    // Idempotency (frozen contract): re-linking the same (parent,child,rel)
    // updates in place and reports duplicate:true — it must NOT look like a
    // fresh insert. The upsert keeps the ORIGINAL row id, so the return must
    // re-read by the natural key; selecting by a freshly derived id returns
    // nothing and crashed the caller (regression fixed 0.42).
    const before = (await mgr.query(
      `SELECT id FROM node_edges WHERE parent_id=? AND child_id=? AND rel=?`,
      [p[0].id, c[0].id, rel]
    )) as any[];
    const duplicate = before.length > 0;
    const id = duplicate ? before[0].id : shortId(["edge", p[0].id, c[0].id, rel], 12);
    await mgr.query(
      `INSERT INTO node_edges(id,tree_id,parent_id,child_id,rel,mode,required,min_level,weight,note,created)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(parent_id,child_id,rel) DO UPDATE SET
         mode=excluded.mode, required=excluded.required, min_level=excluded.min_level,
         weight=excluded.weight, note=excluded.note`,
      [id, treeId, p[0].id, c[0].id, rel, mode, o.required === false ? 0 : 1, o.min_level ?? 1, o.weight ?? 1, o.note || "", nowIso()]
    );
    await rebuildClosure(mgr, treeId);
    await logEvent(mgr, "node.link", id, { tree: treeId, parent: parentKey, child: childKey, rel, mode, required: o.required !== false, duplicate });
    const rows = (await mgr.query(
      `SELECT * FROM node_edges WHERE parent_id=? AND child_id=? AND rel=?`,
      [p[0].id, c[0].id, rel]
    )) as any[];
    if (!rows.length) throw new Error(`edge vanished after upsert: ${parentKey} → ${childKey} [${rel}]`);
    return duplicate ? { ...rows[0], duplicate: true } : rows[0];
  });
}

export async function unlink(ds: DataSource, treeId: string, parentKey: string, childKey: string, rel = "prereq"): Promise<void> {
  return ds.transaction(async (mgr) => {
    const p = (await mgr.query(`SELECT id FROM nodes WHERE tree_id=? AND (key=? OR id=?)`, [treeId, parentKey, parentKey])) as any[];
    const c = (await mgr.query(`SELECT id FROM nodes WHERE tree_id=? AND (key=? OR id=?)`, [treeId, childKey, childKey])) as any[];
    if (!p.length || !c.length) throw new Error("node not found");
    await mgr.query(`DELETE FROM node_edges WHERE parent_id=? AND child_id=? AND rel=?`, [p[0].id, c[0].id, rel]);
    await rebuildClosure(mgr, treeId);
    await logEvent(mgr, "node.unlink", `${p[0].id}->${c[0].id}`, { tree: treeId, parent: parentKey, child: childKey, rel });
  });
}

// ================================================================ conditions & state

export async function condAdd(
  ds: DataSource,
  treeId: string,
  keyOrId: string,
  o: {
    name: string;
    kind?: string;
    expr?: string;
    op?: string;
    value?: string;
    required?: boolean;
    effect?: string;
    weight?: number;
    note?: string;
  }
): Promise<Record<string, any>> {
  return ds.transaction(async (mgr) => {
    const n = (await mgr.query(`SELECT id FROM nodes WHERE tree_id=? AND (key=? OR id=?)`, [treeId, keyOrId, keyOrId])) as any[];
    if (!n.length) throw new Error(`node not found: ${keyOrId}`);
    const kind = o.kind || "flag";
    if (!(COND_KINDS as readonly string[]).includes(kind)) throw new Error(`kind must be one of ${COND_KINDS.join("|")}`);
    const id = shortId(["cond", n[0].id, o.name], 12);
    await mgr.query(
      `INSERT INTO node_conditions(id,node_id,name,kind,expr,op,value,required,effect,weight,note)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [id, n[0].id, o.name, kind, o.expr || o.name, o.op || ">=", o.value || "", o.required === false ? 0 : 1, o.effect || "gate", o.weight ?? 1, o.note || ""]
    );
    await markDirty(mgr, treeId);
    await logEvent(mgr, "node.cond", id, { tree: treeId, node: keyOrId, name: o.name, kind, op: o.op || ">=", required: o.required !== false });
    const rows = (await mgr.query(`SELECT * FROM node_conditions WHERE id=?`, [id])) as any[];
    return rows[0];
  });
}

/** 0.81: `node cond rm <key> --name <n>` — remove one condition by natural
 * key. Throws "node not found" / "condition not found: <name> (node X has:
 * ...)" (named, per frozen contract ④). Mirrors condAdd: transactional +
 * event (node.cond-rm) + markDirty. */
export async function condRemove(
  ds: DataSource,
  treeId: string,
  keyOrId: string,
  name: string
): Promise<Record<string, any>> {
  return ds.transaction(async (mgr) => {
    const n = (await mgr.query(`SELECT id FROM nodes WHERE tree_id=? AND (key=? OR id=?)`, [treeId, keyOrId, keyOrId])) as any[];
    if (!n.length) throw new Error(`node not found: ${keyOrId}`);
    const existing = (await mgr.query(`SELECT * FROM node_conditions WHERE node_id=? AND name=?`, [n[0].id, name])) as any[];
    if (!existing.length) {
      const all = (await mgr.query(`SELECT name FROM node_conditions WHERE node_id=?`, [n[0].id])) as any[];
      const have = all.map((r: any) => r.name).join(", ") || "(none)";
      throw new Error(`condition not found: ${name} (node ${keyOrId} has: ${have})`);
    }
    const row = existing[0];
    await mgr.query(`DELETE FROM node_conditions WHERE id=?`, [row.id]);
    await markDirty(mgr, treeId);
    await logEvent(mgr, "node.cond-rm", row.id, { tree: treeId, node: keyOrId, name, kind: row.kind, op: row.op, required: !!row.required, effect: row.effect });
    return { ...row, removed: true };
  });
}

export async function stateSet(
  ds: DataSource,
  treeId: string,
  keyOrId: string,
  status: string,
  context = "default",
  level = 0
): Promise<void> {
  return ds.transaction(async (mgr) => {
    const n = (await mgr.query(`SELECT id FROM nodes WHERE tree_id=? AND (key=? OR id=?)`, [treeId, keyOrId, keyOrId])) as any[];
    if (!n.length) throw new Error(`node not found: ${keyOrId}`);
    await mgr.query(
      `INSERT INTO node_state(tree_id,context,node_id,status,level,progress,updated) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(tree_id,context,node_id) DO UPDATE SET status=excluded.status, level=excluded.level, updated=excluded.updated`,
      [treeId, context, n[0].id, status, level, status === "unlocked" ? 1 : 0, nowIso()]
    );
    // R10.1: unlock/lock are the timeline anchors for R11's time axis
    await logEvent(mgr, status === "unlocked" ? "node.unlock" : "node.lock", n[0].id, {
      tree: treeId, node: keyOrId, status, context,
    });
  });
}

// ================================================================ index & import

export async function rebuildIndex(ds: DataSource, treeId: string): Promise<{ nodes: number; closureRows: number }> {
  return ds.transaction(async (mgr) => {
    const closureRows = await rebuildClosure(mgr, treeId);
    const built = await buildIndex(mgr, treeId);
    return { nodes: built.topo.length, closureRows };
  });
}

/** Cycle among gating edges (required or optional) — defense-in-depth for
 *  imports; link() blocks these at write time. */
function gatingCycle(nodes: string[], edges: Array<{ parent: string; child: string; rel: string }>): string | null {
  const par = new Map<string, string[]>();
  for (const e of edges) {
    if (e.rel !== "prereq" && e.rel !== "unlock") continue;
    const arr = par.get(e.child) || [];
    arr.push(e.parent);
    par.set(e.child, arr);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(nodes.map((n) => [n, WHITE]));
  const path: string[] = [];
  const visit = (id: string): string | null => {
    color.set(id, GRAY);
    path.push(id);
    for (const p of par.get(id) || []) {
      const c = color.get(p) ?? WHITE;
      if (c === GRAY) {
        const i = path.indexOf(p);
        return [...path.slice(i), p].join(" -> ");
      }
      if (c === WHITE) {
        const hit = visit(p);
        if (hit) return hit;
      }
    }
    path.pop();
    color.set(id, BLACK);
    return null;
  };
  for (const n of nodes) {
    if ((color.get(n) ?? WHITE) === WHITE) {
      const hit = visit(n);
      if (hit) return hit;
    }
  }
  return null;
}

export async function importTree(
  ds: DataSource,
  spec: any,
  opts: { name?: string; merge?: boolean } = {}
): Promise<{ tree: Record<string, any>; nodes: number; edges: number; conditions: number }> {
  const errs: string[] = [];
  const name = opts.name || spec?.tree?.name;
  if (!name || typeof name !== "string") throw new Error("import: missing tree name");
  const nodes: any[] = Array.isArray(spec?.nodes) ? spec.nodes : [];
  const edges: any[] = Array.isArray(spec?.edges) ? spec.edges : [];
  const conds: any[] = Array.isArray(spec?.conditions) ? spec.conditions : [];
  if (!nodes.length) throw new Error("import: no nodes");

  const keys = new Set<string>();
  for (const n of nodes) {
    if (!n.key || typeof n.key !== "string") errs.push(`node without key: ${JSON.stringify(n).slice(0, 60)}`);
    else if (keys.has(n.key)) errs.push(`duplicate node key: ${n.key}`);
    else keys.add(n.key);
  }
  for (const e of edges) {
    if (!keys.has(e.parent) || !keys.has(e.child)) errs.push(`edge references unknown node: ${e.parent} -> ${e.child}`);
    if (e.parent === e.child) errs.push(`self-loop: ${e.parent}`);
    if (!(EDGE_RELS as readonly string[]).includes(e.rel)) errs.push(`bad rel '${e.rel}': ${e.parent} -> ${e.child}`);
    if (!(EDGE_MODES as readonly string[]).includes(e.mode)) errs.push(`bad mode '${e.mode}': ${e.parent} -> ${e.child}`);
  }
  for (const c of conds) {
    if (!keys.has(c.node)) errs.push(`condition references unknown node: ${c.node}`);
    if (!(COND_KINDS as readonly string[]).includes(c.kind)) errs.push(`bad condition kind '${c.kind}': ${c.node} · ${c.name}`);
    // op=eval: value is question wording and may legitimately be empty
    // (falls back to the condition name) — R8.7
    const evalOp = String(c.op || "") === "eval";
    if (c.required && c.kind !== "flag" && !evalOp && (c.value === undefined || c.value === "")) errs.push(`required condition without value: ${c.node} · ${c.name}`);
  }
  if (errs.length) throw new Error(`import rejected — ${errs.length} issue(s):\n  ${errs.slice(0, 10).join("\n  ")}`);

  const cyc = gatingCycle([...keys], edges.map((e) => ({ parent: String(e.parent), child: String(e.child), rel: String(e.rel) })));
  if (cyc) throw new Error(`import rejected — cycle among gating edges: ${cyc}`);

  const existing = (await ds.query(`SELECT * FROM trees WHERE name=? OR id=?`, [name, name])) as any[];
  if (existing.length && !opts.merge) throw new Error(`tree already exists: ${name} (use --merge to upsert into it)`);

  return ds.transaction(async (mgr) => {
    let tid: string;
    if (existing.length) tid = existing[0].id;
    else {
      tid = shortId(["tree", name], 10);
      await mgr.query(`INSERT INTO trees(id,project_id,name,note,created) VALUES(?,?,?,?,?)`, [
        tid,
        null,
        name,
        String(spec.tree?.note || ""),
        nowIso(),
      ]);
    }
    const nodeId = new Map<string, string>();
    for (const n of nodes) {
      const ex = (await mgr.query(`SELECT id FROM nodes WHERE tree_id=? AND key=?`, [tid, String(n.key)])) as any[];
      if (ex.length) {
        nodeId.set(String(n.key), ex[0].id);
        continue;
      }
      const id = shortId(["node", tid, String(n.key)], 10);
      nodeId.set(String(n.key), id);
      const nm = n.name === undefined ? String(n.key) : String(n.name);
      await mgr.query(
        `INSERT INTO nodes(id,tree_id,key,name,kind,tier,cost,cost_unit,payload,tags,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, tid, String(n.key), nm, n.kind === undefined ? "tech" : String(n.kind),
          n.tier === undefined ? 0 : Number(n.tier), n.cost === undefined ? 0 : Number(n.cost),
          n.cost_unit === undefined ? "" : String(n.cost_unit),
          n.payload === undefined || n.payload === null ? "" : typeof n.payload === "object" ? JSON.stringify(n.payload) : String(n.payload),
          n.tags === undefined ? "" : String(n.tags), nowIso(),
        ]
      );
      await mgr.query(`INSERT INTO nodes_fts(id,key,name,tags,ngram) VALUES(?,?,?,?,?)`, [
        id, String(n.key), nm, n.tags === undefined ? "" : String(n.tags),
        ngram(`${n.key} ${nm} ${n.tags || ""}`),
      ]);
    }
    for (const e of edges) {
      const pid = nodeId.get(String(e.parent))!;
      const cid = nodeId.get(String(e.child))!;
      await mgr.query(
        `INSERT INTO node_edges(id,tree_id,parent_id,child_id,rel,mode,required,min_level,weight,note,created)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(parent_id,child_id,rel) DO UPDATE SET
           mode=excluded.mode, required=excluded.required, min_level=excluded.min_level,
           weight=excluded.weight, note=excluded.note`,
        [
          shortId(["edge", tid, pid, cid, String(e.rel)], 12), tid, pid, cid,
          String(e.rel), String(e.mode || "AND"), e.required === false ? 0 : 1,
          Number(e.min_level ?? 1), Number(e.weight ?? 1), String(e.note || ""), nowIso(),
        ]
      );
    }
    for (const c of conds) {
      const nid = nodeId.get(String(c.node))!;
      await mgr.query(`DELETE FROM node_conditions WHERE node_id=? AND name=?`, [nid, String(c.name)]);
      await mgr.query(
        `INSERT INTO node_conditions(id,node_id,name,kind,expr,op,value,required,effect,weight,note)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [
          shortId(["cond", tid, nid, String(c.name)], 10), nid, String(c.name),
          String(c.kind || "flag"), String(c.expr || ""), String(c.op || ">="), String(c.value ?? ""),
          c.required === false ? 0 : 1, String(c.effect || "gate"), Number(c.weight ?? 1), String(c.note || ""),
        ]
      );
    }
    await rebuildClosure(mgr, tid);
    await buildIndex(mgr, tid);
    const rows = (await mgr.query(`SELECT * FROM trees WHERE id=?`, [tid])) as any[];
    return { tree: rows[0], nodes: nodes.length, edges: edges.length, conditions: conds.length };
  });
}
