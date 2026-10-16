/**
 * TreeStore — the tech-tree node model.
 *
 * Guarantees:
 *   • parent/child structure lives in `node_edges` (adjacency list = truth)
 *   • every node can carry typed associations (prereq/unlock/excludes/enables)
 *   • every gate is either required (blocking) or optional (bonus/discount)
 *   • `node_closure` + `node_index` keep ancestor/descendant and reachability
 *     queries cheap instead of recursing per frame
 */
import { DB, EDGE_RELS, EDGE_MODES, COND_KINDS } from "../../../core/database/src/db";
import { nowIso, shortId } from "../../../core/text/src/text";
import { parseEvalSpec } from "../../eval/src/eval";

export type Row = Record<string, any>;
export type EdgeRel = (typeof EDGE_RELS)[number];
export type EdgeMode = (typeof EDGE_MODES)[number];
export type CondKind = (typeof COND_KINDS)[number];

export class TreeStore {
  constructor(readonly db: DB) {}

  // ================================================================ trees
  treeByName(name: string): Row | null {
    return this.db.get("SELECT * FROM trees WHERE name=? OR id=?", [name, name]);
  }

  treeResolve(name?: string): Row {
    const key = name || this.db.metaGet("current_tree");
    if (!key) throw new Error("no tree selected; run: ygl-trees tree new <name>");
    const t = this.treeByName(key);
    if (!t) throw new Error(`tree not found: ${key}`);
    return t;
  }

  treeList(): Row[] {
    return this.db.all(
      `SELECT t.name, t.note,
              (SELECT COUNT(*) FROM nodes n WHERE n.tree_id=t.id) AS nodes,
              (SELECT COUNT(*) FROM node_edges e WHERE e.tree_id=t.id) AS edges,
              (SELECT dirty FROM node_index i WHERE i.tree_id=t.id) AS dirty,
              t.created
         FROM trees t ORDER BY t.created DESC`
    );
  }

  // ================================================================ nodes
  nodeGet(treeId: string, keyOrId: string): Row | null {
    return this.db.get("SELECT * FROM nodes WHERE tree_id=? AND (key=? OR id=?)", [treeId, keyOrId, keyOrId]);
  }

  /** Runtime state for one node (default context). Separate from nodeGet on
   *  purpose: nodeGet feeds WRITE paths, and a context join there could return
   *  one row per context — silently wrong for link/unlink/rm. */
  nodeStateOf(treeId: string, keyOrId: string, context = "default"): { state: string; unlocked_at: string | null } {
    const r = this.db.get(
      `SELECT st.status AS state, st.updated AS unlocked_at
         FROM nodes n LEFT JOIN node_state st ON st.node_id=n.id AND st.context=?
        WHERE n.tree_id=? AND (n.key=? OR n.id=?)`,
      [context, treeId, keyOrId, keyOrId]
    ) as any;
    return { state: r?.state || "locked", unlocked_at: r?.unlocked_at || null };
  }

  nodeList(treeId: string, context = "default"): Row[] {
    // Runtime state rides along: the lifecycle discipline ("unlock the moment a
    // capability lands") is only auditable if the CLI can SEE the unlock state.
    return this.db.all(
      `SELECT n.key, n.name, n.kind, n.tier, n.cost, n.tags,
              (SELECT COUNT(*) FROM node_edges e WHERE e.child_id=n.id AND e.required=1) AS req_parents,
              (SELECT COUNT(*) FROM node_edges e WHERE e.parent_id=n.id) AS children,
              COALESCE(st.status,'locked') AS state,
              st.updated AS unlocked_at
         FROM nodes n
         LEFT JOIN node_state st ON st.node_id=n.id AND st.context=?
        WHERE n.tree_id=? ORDER BY n.tier, n.key`,
      [context, treeId]
    );
  }

  // ================================================================ edges (父子 + 关联)
  /**
   * Link parent -> child.
   * rel: prereq (child needs parent) | unlock (parent reveals child)
   *      excludes (parent blocks child) | enables (soft association)
   * required: 1 = blocking gate, 0 = optional (bonus / discount / hint)
   */
  link(treeId: string, parentKey: string, childKey: string, o: {
    rel?: EdgeRel;
    mode?: EdgeMode;
    required?: boolean;
    min_level?: number;
    weight?: number;
    note?: string;
  } = {}): { row: Row; cycle: boolean } {
    const p = this.nodeGet(treeId, parentKey);
    const c = this.nodeGet(treeId, childKey);
    if (!p) throw new Error(`parent not found: ${parentKey}`);
    if (!c) throw new Error(`child not found: ${childKey}`);
    const rel = o.rel || "prereq";
    if (!EDGE_RELS.includes(rel)) throw new Error(`rel must be one of ${EDGE_RELS.join("|")}`);
    const mode = o.mode || "AND";
    if (!EDGE_MODES.includes(mode)) throw new Error(`mode must be one of ${EDGE_MODES.join("|")}`);

    // Cycle guard: for gating relations the graph must stay a DAG.
    if (rel === "prereq" || rel === "unlock") {
      if (p.id === c.id) throw new Error("self-loop rejected");
      if (this.reaches(treeId, c.id, p.id)) throw new Error(`cycle rejected: ${childKey} already reaches ${parentKey}`);
    }

    const id = shortId(["edge", p.id, c.id, rel], 12);
    this.db.run(
      `INSERT INTO node_edges(id,tree_id,parent_id,child_id,rel,mode,required,min_level,weight,note)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(parent_id,child_id,rel) DO UPDATE SET
         mode=excluded.mode, required=excluded.required, min_level=excluded.min_level,
         weight=excluded.weight, note=excluded.note`,
      [id, treeId, p.id, c.id, rel, mode, o.required === false ? 0 : 1, o.min_level ?? 1, o.weight ?? 1, o.note || ""]
    );
    this.rebuildClosure(treeId);
    return { row: this.db.get("SELECT * FROM node_edges WHERE id=?", [id])!, cycle: false };
  }

  /** Direct parents of a node, with their rel/mode/required flags. */
  parents(treeId: string, keyOrId: string): Row[] {
    const n = this.nodeGet(treeId, keyOrId);
    if (!n) return [];
    return this.db.all(
      `SELECT p.key, p.name, e.rel, e.mode, e.required, e.min_level, e.weight, e.note
         FROM node_edges e JOIN nodes p ON p.id=e.parent_id
        WHERE e.child_id=? ORDER BY e.required DESC, p.key`,
      [n.id]
    );
  }

  /** Direct children of a node. */
  children(treeId: string, keyOrId: string): Row[] {
    const n = this.nodeGet(treeId, keyOrId);
    if (!n) return [];
    return this.db.all(
      `SELECT c.key, c.name, e.rel, e.mode, e.required, e.min_level, e.weight
         FROM node_edges e JOIN nodes c ON c.id=e.child_id
        WHERE e.parent_id=? ORDER BY e.required DESC, c.key`,
      [n.id]
    );
  }

  /** All ancestors via the closure index (depth 1 = direct parent). */
  ancestors(treeId: string, keyOrId: string, depth = -1): Row[] {
    const n = this.nodeGet(treeId, keyOrId);
    if (!n) return [];
    const extra = depth > 0 ? " AND c.depth<=?" : "";
    const params: any[] = [n.id, treeId];
    if (depth > 0) params.push(depth);
    return this.db.all(
      `SELECT a.key, a.name, c.depth
         FROM node_closure c JOIN nodes a ON a.id=c.ancestor
        WHERE c.descendant=? AND c.depth>0 AND c.tree_id=?${extra}
        ORDER BY c.depth, a.key`,
      params
    );
  }

  /** All descendants (what this node eventually gates). */
  descendants(treeId: string, keyOrId: string): Row[] {
    const n = this.nodeGet(treeId, keyOrId);
    if (!n) return [];
    return this.db.all(
      `SELECT d.key, d.name, c.depth
         FROM node_closure c JOIN nodes d ON d.id=c.descendant
        WHERE c.ancestor=? AND c.depth>0 AND c.tree_id=?
        ORDER BY c.depth, d.key`,
      [n.id, treeId]
    );
  }

  /** Reachability test using the closure index — O(1) lookup, no recursion. */
  reaches(treeId: string, fromId: string, toId: string): boolean {
    const r = this.db.get(
      "SELECT 1 AS hit FROM node_closure WHERE tree_id=? AND ancestor=? AND descendant=? AND depth>0",
      [treeId, fromId, toId]
    );
    return !!r;
  }

  // ================================================================ conditions (必检 / 可选)
  condList(treeId: string, keyOrId: string): Row[] {
    const n = this.nodeGet(treeId, keyOrId);
    if (!n) return [];
    return this.db.all(
      "SELECT id,name,kind,expr,op,value,required,effect,weight FROM node_conditions WHERE node_id=? ORDER BY required DESC, name",
      [n.id]
    );
  }

  condDel(condId: string): void {
    this.db.run("DELETE FROM node_conditions WHERE id=?", [condId]);
  }

  // ================================================================ index
  private markDirty(treeId: string): void {
    this.db.run(
      "INSERT INTO node_index(tree_id,built_at,dirty) VALUES(?,?,1) ON CONFLICT(tree_id) DO UPDATE SET dirty=1",
      [treeId, nowIso()]
    );
  }

  /** Rebuild the transitive closure (BFS from every node). */
  rebuildClosure(treeId: string): number {
    let count = 0;
    this.db.tx(() => {
      this.db.run("DELETE FROM node_closure WHERE tree_id=?", [treeId]);
      const nodes = this.db.all("SELECT id FROM nodes WHERE tree_id=?", [treeId]);
      const ids = nodes.map((n: Row) => n.id as string);
      // Only gating relations contribute to ancestry.
      const adj = new Map<string, string[]>();
      const edges = this.db.all(
        "SELECT parent_id,child_id FROM node_edges WHERE tree_id=? AND rel IN ('prereq','unlock')",
        [treeId]
      );
      for (const e of edges) {
        const arr = adj.get(e.child_id) || [];
        arr.push(e.parent_id);
        adj.set(e.child_id, arr);
      }
      const ins = this.db.db.prepare(
        "INSERT INTO node_closure(tree_id,ancestor,descendant,depth) VALUES(?,?,?,?)"
      );
      try {
        for (const start of ids) {
          ins.run([treeId, start, start, 0]);
          count++;
          const seen = new Set<string>([start]);
          let frontier = [start];
          let depth = 0;
          while (frontier.length) {
            depth++;
            const next: string[] = [];
            for (const cur of frontier) {
              for (const p of adj.get(cur) || []) {
                if (seen.has(p)) continue;
                seen.add(p);
                ins.run([treeId, p, start, depth]);
                count++;
                next.push(p);
              }
            }
            frontier = next;
          }
        }
      } finally {
        ins.finalize();
      }
      this.markDirty(treeId);
    });
    return count;
  }

  /**
   * Build the derived index: topological order, tier buckets, in-degrees.
   * Throws on a cycle so bad data fails at build time, not at runtime.
   */
  buildIndex(treeId: string): { topo: string[]; tiers: Record<string, string[]>; inDegree: Record<string, number> } {
    const nodes = this.db.all("SELECT id,key,tier FROM nodes WHERE tree_id=?", [treeId]);
    const byKey = new Map<string, string>(nodes.map((n: Row) => [n.key as string, n.id as string]));
    const requiredParents = new Map<string, string[]>();
    for (const n of nodes) requiredParents.set(n.id, []);
    const edges = this.db.all(
      "SELECT parent_id,child_id FROM node_edges WHERE tree_id=? AND rel IN ('prereq','unlock') AND required=1",
      [treeId]
    );
    for (const e of edges) {
      const arr = requiredParents.get(e.child_id);
      if (arr) arr.push(e.parent_id);
    }

    // Kahn's algorithm.
    const indeg = new Map<string, number>();
    for (const n of nodes) indeg.set(n.id, (requiredParents.get(n.id) || []).length);
    const children = new Map<string, string[]>();
    for (const [child, ps] of requiredParents) {
      for (const p of ps) {
        const arr = children.get(p) || [];
        arr.push(child);
        children.set(p, arr);
      }
    }
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
      const stuck = nodes.filter((n: Row) => !topo.includes(n.id)).map((n: Row) => n.key);
      throw new Error(`cycle detected among: ${stuck.join(", ")}`);
    }

    // Tier buckets: respect declared tier, but never place a child above its parent.
    const tierOf = new Map<string, number>(nodes.map((n: Row) => [n.id, Number(n.tier) || 0]));
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
    for (const n of nodes) {
      inDegree[n.key] = (requiredParents.get(n.id) || []).length;
    }
    for (const n of nodes) {
      this.db.run("UPDATE nodes SET tier=? WHERE id=? AND tier<>?", [tierOf.get(n.id) ?? 0, n.id, tierOf.get(n.id) ?? 0]);
    }

    this.db.run(
      `INSERT INTO node_index(tree_id,topo_order,tiers,in_degree,built_at,dirty)
       VALUES(?,?,?,?,?,0)
       ON CONFLICT(tree_id) DO UPDATE SET topo_order=excluded.topo_order, tiers=excluded.tiers,
         in_degree=excluded.in_degree, built_at=excluded.built_at, dirty=0`,
      [treeId, JSON.stringify(topo), JSON.stringify(tiers), JSON.stringify(inDegree), nowIso()]
    );
    return { topo, tiers, inDegree };
  }

  indexStatus(treeId: string): Row {
    return this.db.get("SELECT dirty, built_at, LENGTH(topo_order) AS topo_len FROM node_index WHERE tree_id=?", [
      treeId,
    ]) || { dirty: 1, built_at: "", topo_len: 0 };
  }

  // ================================================================ runtime state
  unlockedSet(treeId: string, context = "default"): Set<string> {
    const rows = this.db.all(
      "SELECT node_id FROM node_state WHERE tree_id=? AND context=? AND status='unlocked'",
      [treeId, context]
    );
    return new Set(rows.map((r: Row) => r.node_id as string));
  }

  /**
   * Can this node be researched right now?
   *
   * Required gates must all pass; optional ones are skipped but reported,
   * so the caller can still surface "you could get a discount if…".
   */
  canUnlock(treeId: string, keyOrId: string, context = "default", state: Record<string, any> = {}): {
    key: string;
    ok: boolean;
    missing_required: string[];
    missing_optional: string[];
    blocked_by: string[];
    cost_multiplier: number;
    /** R8: present only under `node can --eval` (decision-model outcomes) */
    pending?: string[];
    evaluated?: any[];
  } {
    const n = this.nodeGet(treeId, keyOrId);
    if (!n) throw new Error(`node not found: ${keyOrId}`);
    const unlocked = this.unlockedSet(treeId, context);
    const parents = this.db.all(
      `SELECT p.key, p.id, e.rel, e.mode, e.required, e.min_level
         FROM node_edges e JOIN nodes p ON p.id=e.parent_id
        WHERE e.child_id=?`,
      [n.id]
    );
    const missingRequired: string[] = [];
    const missingOptional: string[] = [];
    const blocked: string[] = [];
    let costMul = 1;

    // group by mode so OR / XOR / NOT get their own semantics
    const byMode = (m: string) => parents.filter((p: Row) => p.mode === m && p.rel !== "excludes");
    for (const p of parents) {
      if (p.rel === "excludes" && unlocked.has(p.id)) blocked.push(p.key);
    }
    for (const p of byMode("AND")) {
      const have = unlocked.has(p.id);
      if (!have) (p.required ? missingRequired : missingOptional).push(`${p.key} (AND)`);
    }
    const ors = byMode("OR");
    if (ors.length) {
      const any = ors.some((p: Row) => unlocked.has(p.id));
      if (!any) {
        const names = ors.map((p: Row) => p.key).join(" | ");
        (ors.some((p: Row) => p.required) ? missingRequired : missingOptional).push(`任一: ${names}`);
      }
    }
    const xors = byMode("XOR");
    if (xors.length) {
      const hit = xors.filter((p: Row) => unlocked.has(p.id));
      if (hit.length !== 1) {
        const names = xors.map((p: Row) => p.key).join(" ^ ");
        (xors.some((p: Row) => p.required) ? missingRequired : missingOptional).push(`恰好其一: ${names}`);
      }
    }
    for (const p of byMode("NOT")) {
      if (unlocked.has(p.id)) blocked.push(`${p.key} (NOT)`);
    }

    // conditions: required gates block, optional ones only modify cost
    const conds = this.db.all("SELECT * FROM node_conditions WHERE node_id=?", [n.id]);
    for (const c of conds) {
      const pass = evalCond(c, state);
      // eval-family values may carry a question envelope — display the
      // wording, not the JSON (0.26.0)
      const shown = /^eval(-choice|-score)?$/.test(String(c.op))
        ? parseEvalSpec(c.value).q
        : c.value;
      if (!pass && c.required) missingRequired.push(`${c.name} ${c.op} ${shown}`.trim());
      if (!pass && !c.required) missingOptional.push(`${c.name} (可选)`);
      // GPT-6.1 SOL fix: cost_mul applies the DISCOUNT when the optional
      // condition PASSES (README: "满足条件则成本打折"). The original `!pass`
      // inverted the semantics — an unsatisfied condition granted the discount.
      if (pass && !c.required && c.effect === "cost_mul") costMul *= Number(c.weight) || 1;
    }

    const ok = missingRequired.length === 0 && blocked.length === 0;
    return {
      key: n.key,
      ok,
      missing_required: missingRequired,
      missing_optional: missingOptional,
      blocked_by: blocked,
      cost_multiplier: costMul,
    };
  }

  /**
   * R8.2 decision-model context package: node metadata + direct parents
   * (node_edges) + ancestor chain (node_closure) + the node's condition set
   * + unlocked set + the caller's state bag. The eval API demands a context
   * package — bare state fell into the gray band 6/8 in the material's
   * routing test, so we ship everything the tree knows about this node.
   */
  evalContext(treeId: string, keyOrId: string, stateBag: Record<string, any>, context = "default"): Row {
    const n = this.nodeGet(treeId, keyOrId);
    if (!n) throw new Error(`node not found: ${keyOrId}`);
    const idToKey = new Map<string, string>(
      this.db.all("SELECT id,key FROM nodes WHERE tree_id=?", [treeId]).map((r: Row) => [r.id as string, r.key as string])
    );
    const parents = this.parents(treeId, keyOrId).map((p) => ({ key: p.key, rel: p.rel, required: !!p.required }));
    const ancestors = this.ancestors(treeId, keyOrId).map((a) => ({ key: a.key, depth: a.depth }));
    const conditions = this.condList(treeId, keyOrId).map((c) => ({
      name: c.name, kind: c.kind, op: c.op, value: c.value, required: !!c.required, effect: c.effect,
    }));
    const unlocked = [...this.unlockedSet(treeId, context)].map((id) => idToKey.get(id) || id);
    return {
      node: { key: n.key, name: n.name, kind: n.kind, tier: n.tier, cost: n.cost },
      parents,
      ancestors,
      conditions,
      unlocked,
      state: stateBag,
    };
  }

  /** Every node whose required gates are currently satisfied. */
  ready(treeId: string, context = "default", state: Record<string, any> = {}): Row[] {
    const idx = this.db.get("SELECT topo_order,dirty FROM node_index WHERE tree_id=?", [treeId]);
    const nodes = this.db.all("SELECT id,key,name,tier,cost FROM nodes WHERE tree_id=?", [treeId]);
    // Process in topological order so a single pass is enough.
    let ordered = nodes;
    if (idx && !idx.dirty && idx.topo_order) {
      const pos = new Map<string, number>(JSON.parse(idx.topo_order).map((id: string, i: number) => [id, i]));
      ordered = [...nodes].sort((a: Row, b: Row) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
    }
    const unlocked = this.unlockedSet(treeId, context);
    const out: Row[] = [];
    for (const n of ordered) {
      if (unlocked.has(n.id)) continue;          // already done, not "ready"
      const r = this.canUnlock(treeId, n.key, context, state);
      if (r.ok) out.push({ key: n.key, name: n.name, tier: n.tier, cost: Number(n.cost) * r.cost_multiplier });
    }
    return out;
  }

  /**
   * Nodes blocked ONLY by op=eval conditions (nothing else missing, not
   * excluded, parents satisfied) — the candidate set for `node ready
   * --eval`: one decision-model request per node can flip them to ready.
   * Returns {key, name, tier, cost, conds: [{name, question}]}.
   */
  evalCandidates(treeId: string, context = "default", state: Record<string, any> = {}): Row[] {
    const nodes = this.db.all("SELECT id,key,name,tier,cost FROM nodes WHERE tree_id=?", [treeId]);
    const unlocked = this.unlockedSet(treeId, context);
    const out: Row[] = [];
    for (const n of nodes) {
      if (unlocked.has(n.id)) continue;
      const r = this.canUnlock(treeId, n.key, context, state);
      if (r.ok || r.blocked_by.length) continue;
      const evalConds = this.condList(treeId, n.key).filter((c: Row) => /^eval(-choice|-score)?$/.test(String(c.op)));
      if (!evalConds.length) continue;
      // every remaining missing_required entry must belong to an eval cond
      const onlyEval = r.missing_required.every((m: string) =>
        evalConds.some((c: Row) => m.startsWith(String(c.name)))
      );
      if (!onlyEval) continue;
      out.push({
        key: n.key,
        name: n.name,
        tier: n.tier,
        cost: Number(n.cost),
        // 0.27: mixed question types — op + parsed envelope per condition
        conds: evalConds.map((c: Row) => {
          const spec = parseEvalSpec(c.value);
          return {
            name: String(c.name),
            op: String(c.op),
            question: spec.q || String(c.name),
            options: spec.options,
            answer: spec.answer,
            levels: spec.levels,
            min: spec.min,
          };
        }),
      });
    }
    return out;
  }

  /**
   * Unlock order to a target: every prerequisite precedes its dependent.
   *
   * Walks `node_edges` (prereq|unlock, required or optional) directly — the
   * source of truth — instead of the global topo index, which only orders
   * required edges and can place the target before its optional ancestors.
   * Post-order DFS guarantees ancestors-first; `seen` guards against cycles.
   */
  pathTo(treeId: string, targetKey: string, context = "default"): { order: string[]; total_cost: number } {
    const target = this.nodeGet(treeId, targetKey);
    if (!target) throw new Error(`node not found: ${targetKey}`);
    const unlocked = this.unlockedSet(treeId, context);

    const parents = new Map<string, { id: string; key: string; cost: number }[]>();
    const edges = this.db.all(
      `SELECT e.child_id, p.id AS parent_id, p.key AS parent_key, p.cost AS parent_cost
         FROM node_edges e JOIN nodes p ON p.id = e.parent_id
        WHERE e.tree_id=? AND e.rel IN ('prereq','unlock')
        ORDER BY p.key`,
      [treeId]
    );
    for (const e of edges) {
      const arr = parents.get(e.child_id) || [];
      arr.push({ id: e.parent_id, key: e.parent_key, cost: Number(e.parent_cost || 0) });
      parents.set(e.child_id, arr);
    }

    // A node is emitted only after all of its ancestors. Unlocked ancestors
    // are skipped (nothing left to pay) but still walked through, so deeper
    // locked ancestors remain in the path.
    const seen = new Set<string>();
    const order: { key: string; cost: number }[] = [];
    const visit = (id: string, key: string, cost: number): void => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const p of parents.get(id) || []) visit(p.id, p.key, p.cost);
      if (!unlocked.has(id)) order.push({ key, cost });
    };
    visit(target.id, target.key, Number(target.cost || 0));
    // The destination is always shown, even if already unlocked.
    if (unlocked.has(target.id)) order.push({ key: target.key, cost: Number(target.cost || 0) });

    return {
      order: order.map((o) => o.key),
      total_cost: order.reduce((s, o) => s + o.cost, 0),
    };
  }

  /** Full-text search over nodes. Title/key substring hits outrank same-hit
   *  rows (same ranking semantics as kb/skill/source search). */
  nodeSearch(treeId: string, q: string, limit = 20): Row[] {
    const tokens: string[] = Array.from(
      new Set(String(require("../../../core/text/src/text").ngram(q) || "").split(/\s+/).filter(Boolean))
    );
    if (!tokens.length) return [];
    const agg = new Map<string, { row: Row; hits: number; score: number; boost: number }>();
    const st = this.db.db.prepare(
      `SELECT n.id,n.key,n.name,n.tier, bm25(nodes_fts) AS score
         FROM nodes_fts f JOIN nodes n ON n.id=f.id
        WHERE nodes_fts MATCH ? AND n.tree_id=? ORDER BY score LIMIT ?`
    );
    // Title/key boost: nodes whose key or name contains the token rank higher
    const stBoost = this.db.db.prepare(
      `SELECT f.id AS __id FROM nodes_fts f
        JOIN nodes n ON n.id=f.id
       WHERE n.tree_id=? AND (lower(n.key) LIKE ? OR lower(n.name) LIKE ?) LIMIT ?`
    );
    try {
      for (const t of tokens) {
        for (const r of st.all([`"${t.replace(/"/g, "")}"`, treeId, limit]) as Row[]) {
          const prev = agg.get(r.id);
          if (prev) {
            prev.hits++;
            prev.score += r.score;
          } else agg.set(r.id, { row: r, hits: 1, score: r.score, boost: 0 });
        }
        const like = `%${t.toLowerCase()}%`;
        for (const h of stBoost.all([treeId, like, like, limit]) as Row[]) {
          const prev = agg.get(String(h.__id));
          if (prev) prev.boost += 1;
        }
      }
    } finally {
      st.finalize();
      stBoost.finalize();
    }
    return [...agg.values()]
      .sort((a, b) => b.hits - a.hits || b.boost - a.boost || a.score - b.score)
      .slice(0, limit)
      .map((a) => ({ key: a.row.key, name: a.row.name, tier: a.row.tier, matched: a.hits, title_matched: a.boost }));
  }

  /** Sanity checks: cycles, orphan gating edges, unknown refs. */
  validate(treeId: string): string[] {
    const issues: string[] = [];
    try {
      this.buildIndex(treeId);
    } catch (e: any) {
      issues.push(`cycle: ${e.message}`);
    }
    // Cycle over ALL gating edges (incl. optional ones): link() blocks these
    // at write time, so this only fires for data written via `db sql`.
    const nodeKeys = this.db.all("SELECT key FROM nodes WHERE tree_id=?", [treeId]).map((n: Row) => String(n.key));
    const gateEdges = this.db.all(
      `SELECT p.key AS parent, c.key AS child, e.rel
         FROM node_edges e
         JOIN nodes p ON p.id = e.parent_id
         JOIN nodes c ON c.id = e.child_id
        WHERE e.tree_id = ? AND e.rel IN ('prereq','unlock')`,
      [treeId]
    );
    const cyc = this.gatingCycle(
      nodeKeys,
      gateEdges.map((e: Row) => ({ parent: String(e.parent), child: String(e.child), rel: String(e.rel) }))
    );
    if (cyc) issues.push(`cycle(gating edges): ${cyc}`);
    const orphanEdges = this.db.all(
      `SELECT e.id FROM node_edges e
        WHERE e.tree_id=? AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.id=e.parent_id)
           OR e.tree_id=? AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.id=e.child_id)`,
      [treeId, treeId]
    );
    if (orphanEdges.length) issues.push(`${orphanEdges.length} edge(s) referencing missing nodes`);
    const selfLoops = this.db.all("SELECT id FROM node_edges WHERE tree_id=? AND parent_id=child_id", [treeId]);
    if (selfLoops.length) issues.push(`${selfLoops.length} self-loop(s)`);
    const st = this.indexStatus(treeId);
    if (st.dirty) issues.push("index is dirty; run: ygl-trees node index");
    const noCondValue = this.db.all(
      "SELECT id,name FROM node_conditions c WHERE c.node_id IN (SELECT id FROM nodes WHERE tree_id=?) AND c.required=1 AND c.value='' AND c.kind<>'flag' AND c.op NOT IN ('eval','eval-choice','eval-score')",
      [treeId]
    );
    if (noCondValue.length) issues.push(`${noCondValue.length} required condition(s) without a threshold`);
    return issues;
  }

  // ================================================================ export
  /** Dump the tree as portable JSON (adjacency + conditions + tiers). */
  exportTree(treeId: string): any {
    const tree = this.db.get("SELECT * FROM trees WHERE id=?", [treeId]);
    const nodes = this.db.all("SELECT key,name,kind,tier,cost,cost_unit,payload,tags FROM nodes WHERE tree_id=? ORDER BY tier,key", [treeId]);
    const byId2Key = new Map<string, string>();
    for (const n of this.db.all("SELECT id,key FROM nodes WHERE tree_id=?", [treeId])) byId2Key.set(n.id, n.key);
    const edges = this.db.all("SELECT parent_id,child_id,rel,mode,required,min_level,weight,note FROM node_edges WHERE tree_id=?", [treeId]);
    const nodeIdByKey = new Map<string, string>();
    for (const n of this.db.all("SELECT id,key FROM nodes WHERE tree_id=?", [treeId])) nodeIdByKey.set(n.key, n.id);
    const conds = this.db.all(
      "SELECT c.*, n.key AS node_key FROM node_conditions c JOIN nodes n ON n.id=c.node_id WHERE n.tree_id=?",
      [treeId]
    );
    const idx = this.db.get("SELECT topo_order,tiers,in_degree,built_at,dirty FROM node_index WHERE tree_id=?", [treeId]);
    return {
      tree: { name: tree?.name, note: tree?.note },
      nodes: nodes.map((n: Row) => ({ ...n, payload: safeJson(n.payload) })),
      edges: edges.map((e: Row) => ({
        parent: byId2Key.get(e.parent_id),
        child: byId2Key.get(e.child_id),
        rel: e.rel,
        mode: e.mode,
        required: !!e.required,
        min_level: e.min_level,
        weight: e.weight,
        note: e.note,
      })),
      conditions: conds.map((c: Row) => ({
        node: c.node_key,
        name: c.name,
        kind: c.kind,
        expr: c.expr,
        op: c.op,
        value: c.value,
        required: !!c.required,
        effect: c.effect,
        weight: c.weight,
      })),
      index: idx
        ? {
            dirty: !!idx.dirty,
            built_at: idx.built_at,
            topo_order: idx.topo_order ? JSON.parse(idx.topo_order).map((id: string) => byId2Key.get(id) || id) : [],
            tiers: idx.tiers ? JSON.parse(idx.tiers) : {},
            in_degree: idx.in_degree ? JSON.parse(idx.in_degree) : {},
          }
        : null,
    };
  }

  /** Find a cycle among gating edges (prereq|unlock, required or optional).
   *  Returns the cycle path (a -> b -> a) or null. Used by validate() and
   *  importTree() — link() blocks these at write time, this is the
   *  defense-in-depth for data written via `db sql`. */
  gatingCycle(nodes: string[], edges: Array<{ parent: string; child: string; rel: string }>): string | null {
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
}

/** Evaluate a condition against a runtime state bag. */
function evalCond(c: Row, state: Record<string, any>): boolean {
  const raw = state[c.expr] ?? state[c.name];
  if (raw === undefined) return false;
  const op = c.op || ">=";
  if (op === "has") return !!raw;
  const target = Number(c.value);
  const actual = Number(raw);
  if (!Number.isNaN(target) && !Number.isNaN(actual)) {
    switch (op) {
      case ">=": return actual >= target;
      case "<=": return actual <= target;
      case "==": return actual === target;
      case "!=": return actual !== target;
      case ">": return actual > target;
      case "<": return actual < target;
    }
  }
  switch (op) {
    case "==": return String(raw) === String(c.value);
    case "!=": return String(raw) !== String(c.value);
  }
  return !!raw;
}

function safeJson(s: string): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
