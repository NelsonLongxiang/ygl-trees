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
    const [treeName, key] = ref.includes("/") ? [ref.slice(0, ref.indexOf("/")), ref.slice(ref.indexOf("/") + 1)] : [null, ref];
    const cur = treeName || db.metaGet("current_tree") || "";
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
        if (ctx.json) {
          console.log(JSON.stringify({ id: r.row.id, src: `${r.row.src_type}:${r.row.src_id}`, dst: `${r.row.dst_type}:${r.row.dst_id}`, rel: r.row.rel, duplicate: r.duplicate }));
          return 0;
        }
        if (r.duplicate) out(ctx, paint(C.yellow, `  ⚠ duplicate: ${a} ${rel} ${b} (already linked)`, ctx.color));
        else ok(ctx, `linked: ${a} ${paint(C.dim, `—${rel}→`, ctx.color)} ${b}`);
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

  bad(ctx, "usage: rel [add|rm|list] ...  (see ygl-trees help)");
  return 2;
}
