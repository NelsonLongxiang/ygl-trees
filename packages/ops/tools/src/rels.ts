/**
 * Relation fabric — spec R9 (0.29.0).
 *
 * The `relations` table (type-agnostic, schema-v2 era) finally goes live for
 * ALL entity types: node / claim / evidence / source / query / kb / artifact /
 * skill. Reference syntax `<type>:<ref>`; node ids stored as node.id, skills
 * by name; every other type by row id.
 *
 * @module @ygl/ops-tools/rels
 */
import { Env } from "../../../core/database/src/types";
import { ok, bad, out, head, table, paint, C } from "../../../core/text/src/fmt";
import { nowIso, shortId } from "../../../core/text/src/text";
import { getOrm } from "../../../core/database/src/orm";
import { resolveTree } from "../../../core/database/src/selection";

export const REL_TYPES = ["node", "claim", "evidence", "source", "query", "kb", "artifact", "task", "skill"] as const;

/** Resolve one `<type>:<ref>` against the database → { type, id, display }.
 *  Throws RelError(code) on unknown type / missing row. */
export class RelError extends Error {
  constructor(public code: 1 | 2, message: string) {
    super(message);
  }
}

const DISPLAY: Record<string, (db: any, ref: string) => { id: string; display: string }> = {
  node: (db, ref) => {
    // node:<tree>/<key> explicit, or node:<key> resolved in the current tree
    // (R16: resolved selection — session-aware, not the raw global pointer)
    const [treeName, key] = ref.includes("/") ? [ref.slice(0, ref.indexOf("/")), ref.slice(ref.indexOf("/") + 1)] : [null, ref];
    const cur = treeName || resolveTree(db).name || "";
    if (!cur) {
      // 0.81: bare node:<key> with NO current tree used to die as a generic
      // "node not found" — name the real cause (parallel session cleared the
      // selection) and both ways out.
      throw new RelError(1, `no current tree — qualify as node:<tree>/${key} or run 'ygl-trees tree use <name>' first`);
    }
    const rows = db.all("SELECT n.id, n.key, n.name FROM nodes n JOIN trees t ON t.id=n.tree_id WHERE (t.name=? OR t.id=?) AND (n.key=? OR n.id=?)", [cur, cur, key, key]);
    if (!rows.length) throw new RelError(1, `node not found: ${ref}${treeName ? "" : ` (searched current tree '${cur}' — qualify as node:<tree>/${key} for another tree)`}`);
    return { id: String(rows[0].id), display: String(rows[0].name || rows[0].key) };
  },
  claim: (db, ref) => {
    const r = db.get("SELECT id, text FROM claims WHERE id=? LIMIT 1", [ref]);
    if (!r) throw new RelError(1, `claim not found: ${ref}`);
    return { id: String(r.id), display: String(r.text).slice(0, 60) };
  },
  evidence: (db, ref) => {
    const r = db.get("SELECT id, quote FROM evidence WHERE id=? LIMIT 1", [ref]);
    if (!r) throw new RelError(1, `evidence not found: ${ref}`);
    return { id: String(r.id), display: String(r.quote).slice(0, 60) };
  },
  source: (db, ref) => {
    const r = db.get("SELECT id, title FROM sources WHERE id=? LIMIT 1", [ref]);
    if (!r) throw new RelError(1, `source not found: ${ref}`);
    return { id: String(r.id), display: String(r.title) };
  },
  query: (db, ref) => {
    const r = db.get("SELECT id, text FROM queries WHERE id=? LIMIT 1", [ref]);
    if (!r) throw new RelError(1, `query not found: ${ref}`);
    return { id: String(r.id), display: String(r.text).slice(0, 60) };
  },
  kb: (db, ref) => {
    const r = db.get("SELECT id, title FROM kb_notes WHERE id=? OR title=? LIMIT 1", [ref, ref]);
    if (!r) throw new RelError(1, `kb note not found: ${ref}`);
    return { id: String(r.id), display: String(r.title) };
  },
  artifact: (db, ref) => {
    const r = db.get("SELECT id, title FROM artifacts WHERE id=? OR title=? LIMIT 1", [ref, ref]);
    if (!r) throw new RelError(1, `artifact not found: ${ref}`);
    return { id: String(r.id), display: String(r.title) };
  },
  task: (db, ref) => {
    // tasks are artifacts kind='task' (0.81: task:<id|title> so `task add
    // --node` can link without spelling artifact:)
    const r = db.get("SELECT id, title FROM artifacts WHERE kind='task' AND (id=? OR title=?) LIMIT 1", [ref, ref]);
    if (!r) throw new RelError(1, `task not found: ${ref}`);
    return { id: String(r.id), display: String(r.title) };
  },
  skill: (db, ref) => {
    const r = db.get("SELECT name, description FROM skills WHERE name=? LIMIT 1", [ref]);
    if (!r) throw new RelError(1, `skill not found: ${ref}`);
    return { id: String(r.name), display: String(r.name) };
  },
};

export function resolveRef(env: Env, ref: string): { type: string; id: string; display: string } {
  const i = ref.indexOf(":");
  if (i < 1) throw new RelError(2, `bad reference '${ref}' — want <type>:<ref> where type ∈ ${REL_TYPES.join("|")}`);
  const type = ref.slice(0, i);
  const ident = ref.slice(i + 1);
  const fn = DISPLAY[type];
  if (!fn) throw new RelError(2, `unknown reference type '${type}' — want ${REL_TYPES.join("|")}`);
  const r = fn(env.db, ident);
  return { type, id: r.id, display: r.display };
}

/** Reverse lookup: type+id → display (for the webui related section). */
export function resolveId(env: Env, type: string, id: string): string {
  const fn = DISPLAY[type];
  if (!fn) return id;
  try {
    return fn(env.db, id).display;
  } catch {
    return id; // dangling relation: show the raw id
  }
}

// ── transactional write service ──

export async function relAdd(env: Env, srcRef: string, dstRef: string, rel = "related"): Promise<{ row: any; duplicate: boolean }> {
  const src = resolveRef(env, srcRef);
  const dst = resolveRef(env, dstRef);
  const ds = await getOrm(env.db.path);
  return ds.transaction(async (mgr: any) => {
    const ex = (await mgr.query(
      `SELECT id FROM relations WHERE src_type=? AND src_id=? AND dst_type=? AND dst_id=? AND rel=?`,
      [src.type, src.id, dst.type, dst.id, rel]
    )) as any[];
    if (ex.length) {
      const rows = (await mgr.query(`SELECT * FROM relations WHERE id=?`, [ex[0].id])) as any[];
      return { row: rows[0], duplicate: true };
    }
    const id = shortId(["rel", src.id, dst.id, rel], 10);
    await mgr.query(
      `INSERT INTO relations(id,src_type,src_id,dst_type,dst_id,rel,weight,created) VALUES(?,?,?,?,?,?,1,?)`,
      [id, src.type, src.id, dst.type, dst.id, rel, nowIso()]
    );
    await mgr.query(`INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload) VALUES(?,?,?,?,?,?,?)`, [
      shortId(["ev", "rel.add", id], 12), nowIso(), "cli", "rel.add", "relation", id,
      JSON.stringify({ src: `${src.type}:${src.id}`, dst: `${dst.type}:${dst.id}`, rel }),
    ]);
    const rows = (await mgr.query(`SELECT * FROM relations WHERE id=?`, [id])) as any[];
    return { row: rows[0], duplicate: false };
  });
}

export async function relRm(env: Env, srcRef: string, dstRef: string, rel = "related"): Promise<void> {
  const src = resolveRef(env, srcRef);
  const dst = resolveRef(env, dstRef);
  const ds = await getOrm(env.db.path);
  await ds.transaction(async (mgr: any) => {
    const ex = (await mgr.query(
      `SELECT id FROM relations WHERE src_type=? AND src_id=? AND dst_type=? AND dst_id=? AND rel=?`,
      [src.type, src.id, dst.type, dst.id, rel]
    )) as any[];
    if (!ex.length) throw new RelError(1, `relation not found: ${srcRef} → ${dstRef} (${rel})`);
    await mgr.query(
      `DELETE FROM relations WHERE src_type=? AND src_id=? AND dst_type=? AND dst_id=? AND rel=?`,
      [src.type, src.id, dst.type, dst.id, rel]
    );
  });
}

/** Endpoint existence probes for the relation fabric (K3 0.106.0: `relations`
 *  has no FK cascade, so deleting a node/evidence/claim can leave a relation
 *  pointing at nothing). Unknown types are treated as alive — a future entity
 *  type must not be reported dangling just because this table is stale. */
const EXISTS_SQL: Record<string, string> = {
  node: "SELECT 1 AS hit FROM nodes WHERE id=?",
  claim: "SELECT 1 AS hit FROM claims WHERE id=?",
  evidence: "SELECT 1 AS hit FROM evidence WHERE id=?",
  source: "SELECT 1 AS hit FROM sources WHERE id=?",
  query: "SELECT 1 AS hit FROM queries WHERE id=?",
  kb: "SELECT 1 AS hit FROM kb_notes WHERE id=?",
  artifact: "SELECT 1 AS hit FROM artifacts WHERE id=?",
  task: "SELECT 1 AS hit FROM artifacts WHERE kind='task' AND id=?",
  skill: "SELECT 1 AS hit FROM skills WHERE name=?",
};

export function relationEndExists(db: any, type: string, id: string): boolean {
  const sql = EXISTS_SQL[type];
  if (!sql) return true;
  return !!db.get(sql, [id]);
}

/** F4 (0.110.x): stored project name for a relation end — the link-time fact,
 *  not dynamic visibility. Returns null for project-less types (kb/skill) and
 *  unset projects, which must never produce a cross-project hint. */
export function projectNameOf(db: any, type: string, id: string): string | null {
  const SQL: Record<string, string> = {
    node: "SELECT p.name FROM nodes n JOIN trees t ON t.id=n.tree_id JOIN projects p ON p.id=t.project_id WHERE n.id=?",
    claim: "SELECT p.name FROM claims x JOIN projects p ON p.id=x.project_id WHERE x.id=?",
    evidence: "SELECT p.name FROM evidence x JOIN projects p ON p.id=x.project_id WHERE x.id=?",
    source: "SELECT p.name FROM sources x JOIN projects p ON p.id=x.project_id WHERE x.id=?",
    query: "SELECT p.name FROM queries x JOIN projects p ON p.id=x.project_id WHERE x.id=?",
    artifact: "SELECT p.name FROM artifacts x JOIN projects p ON p.id=x.project_id WHERE x.id=?",
    task: "SELECT p.name FROM artifacts x JOIN projects p ON p.id=x.project_id WHERE x.id=? AND x.kind='task'",
  };
  const sql = SQL[type];
  if (!sql) return null;
  const row = db.get(sql, [id]) as any;
  return row?.name ? String(row.name) : null;
}

/** Relations whose src or dst row no longer exists (detection; `rel prune`
 *  is the explicit cleanup — deletion paths must not cascade silently). */
export function orphanRelations(env: Env): any[] {
  const rows = env.db.all("SELECT id, src_type, src_id, dst_type, dst_id, rel, created FROM relations ORDER BY created") as any[];
  return rows.filter(
    (r) => !relationEndExists(env.db, r.src_type, r.src_id) || !relationEndExists(env.db, r.dst_type, r.dst_id)
  );
}

// ── CLI ──

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx } = env;

  if (action === "add") {
    const [a, b] = rest;
    if (!a || !b) {
      bad(ctx, 'usage: rel add <type>:<ref> <type>:<ref> [--rel <type>]');
      return 2;
    }
    const rel = String(args.flags.rel || "related");
    return (async () => {
      try {
        const r = await relAdd(env, a, b, rel);
        // F4: cross-project hint (stored project is the criterion; either end
        // project-less → no hint). The link itself always succeeds.
        const srcP = projectNameOf(env.db, r.row.src_type, r.row.src_id);
        const dstP = projectNameOf(env.db, r.row.dst_type, r.row.dst_id);
        const crossProject = srcP && dstP && srcP !== dstP ? { src: srcP, dst: dstP } : null;
        if (ctx.json) {
          console.log(JSON.stringify({ id: r.row.id, src: `${r.row.src_type}:${r.row.src_id}`, dst: `${r.row.dst_type}:${r.row.dst_id}`, rel: r.row.rel, duplicate: r.duplicate, ...(crossProject ? { cross_project: crossProject } : {}) }));
          return 0;
        }
        if (r.duplicate) out(ctx, paint(C.yellow, `  ⚠ duplicate: ${a} ${rel} ${b} (already linked)`, ctx.color));
        else ok(ctx, `linked: ${a} ${paint(C.dim, `—${rel}→`, ctx.color)} ${b}`);
        if (crossProject) {
          out(ctx, paint(C.yellow, `  跨项目：${a} 属 '${crossProject.src}'，${b} 属 '${crossProject.dst}'（实体 project 字段是判定口径）`, ctx.color));
        }
        return 0;
      } catch (e: any) {
        if (e instanceof RelError) {
          bad(ctx, e.message);
          return e.code;
        }
        throw e;
      }
    })();
  }

  if (action === "rm") {
    const [a, b] = rest;
    if (!a || !b) {
      bad(ctx, 'usage: rel rm <type>:<ref> <type>:<ref> [--rel <type>]');
      return 2;
    }
    const rel = String(args.flags.rel || "related");
    return (async () => {
      try {
        await relRm(env, a, b, rel);
        if (ctx.json) console.log(JSON.stringify({ removed: `${a} -${rel}-> ${b}` }));
        else ok(ctx, `unlinked: ${a} (${rel}) ${b}`);
        return 0;
      } catch (e: any) {
        if (e instanceof RelError) {
          bad(ctx, e.message);
          return e.code;
        }
        throw e;
      }
    })();
  }

  if (action === "list" || action === "") {
    const rows = (() => {
      const params: any[] = [];
      let where = "1=1";
      const srcF = String(args.flags.src || "");
      const dstF = String(args.flags.dst || "");
      const relF = String(args.flags.rel || "");
      if (srcF) {
        const s = resolveRef(env, srcF); // may throw RelError(1)
        where += " AND src_type=? AND src_id=?";
        params.push(s.type, s.id);
      }
      if (dstF) {
        const d = resolveRef(env, dstF);
        where += " AND dst_type=? AND dst_id=?";
        params.push(d.type, d.id);
      }
      if (relF) {
        where += " AND rel=?";
        params.push(relF);
      }
      return env.db.all(`SELECT * FROM relations WHERE ${where} ORDER BY rowid DESC LIMIT 200`, params);
    })();
    const outRows = rows.map((r: any) => ({
      src: `${r.src_type}:${r.src_id}`,
      dst: `${r.dst_type}:${r.dst_id}`,
      rel: r.rel,
      src_display: resolveId(env, r.src_type, r.src_id),
      dst_display: resolveId(env, r.dst_type, r.dst_id),
    }));
    if (ctx.json) {
      console.log(JSON.stringify(outRows, null, 2));
      return 0;
    }
    head(ctx, `Relations (${outRows.length})`);
    table(ctx, outRows, ["src", "rel", "dst"], ["src_display", "rel", "dst_display"]);
    return 0;
  }

  // K3 0.106.0: explicit cleanup for relations whose endpoints are gone.
  // Detection lives in doctor (`relation_orphans`); deletion paths deliberately
  // do not cascade — a node delete must not quietly erase "who was related to
  // it", or the user cannot tell what their delete actually removed.
  if (action === "prune") {
    const dry = !!args.flags["dry-run"] || args.flags.dry === true;
    return (async () => {
      const dangling = orphanRelations(env);
      if (!dangling.length) {
        if (ctx.json) console.log(JSON.stringify({ pruned: 0, dry_run: dry, rows: [] }, null, 2));
        else ok(ctx, "no orphan relations");
        return 0;
      }
      if (dry) {
        if (ctx.json) console.log(JSON.stringify({ pruned: 0, dry_run: true, rows: dangling }, null, 2));
        else {
          head(ctx, `Would prune ${dangling.length} orphan relation(s)`);
          table(
            ctx,
            dangling.map((r: any) => ({ src: `${r.src_type}:${r.src_id}`, rel: r.rel, dst: `${r.dst_type}:${r.dst_id}` })),
            ["src", "rel", "dst"],
            ["src", "rel", "dst"]
          );
        }
        return 0;
      }
      const ds = await getOrm(env.db.path);
      await ds.transaction(async (mgr: any) => {
        for (const r of dangling) await mgr.query("DELETE FROM relations WHERE id=?", [r.id]);
        await mgr.query(
          "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,?)",
          [shortId(["rel.prune"], 12), nowIso(), "cli", "rel.prune", "relation", "", JSON.stringify({ pruned: dangling.length }), "info"]
        );
      });
      if (ctx.json) console.log(JSON.stringify({ pruned: dangling.length, dry_run: false, rows: dangling }, null, 2));
      else {
        ok(ctx, `pruned ${dangling.length} orphan relation(s)`);
        table(
          ctx,
          dangling.map((r: any) => ({ src: `${r.src_type}:${r.src_id}`, rel: r.rel, dst: `${r.dst_type}:${r.dst_id}` })),
          ["src", "rel", "dst"],
          ["src", "rel", "dst"]
        );
      }
      return 0;
    })();
  }

  bad(ctx, "usage: rel [add|rm|list|prune] ...  (see ygl-trees help)");
  return 2;
}
