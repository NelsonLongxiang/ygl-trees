/**
 * #206 (verifier scale S0): `verify instance` — the registry entry point.
 *
 * An instance is a binding — pack@version × target × params — kept as a row, not a git repository
 * (docs/reviews/verifier-scale-plan.md §2–§3). Its identity is content-addressed:
 *   identity_sha256 = sha256(JCS({pack, version, target, rev, params}))   id = "vi_" + first 24 hex
 * so creating the same binding twice is a duplicate, whatever order the params came in. Owner and
 * schedule are mutable attributes outside the identity.
 *
 * Every usage check runs before any store or DB access (#175 ordering); writes go through the
 * transactional services in research/pipeline/src/writes.ts.
 */
import { createHash } from "node:crypto";
import type { Env } from "../../../core/database/src/types";
import { getOrm } from "../../../core/database/src/orm";
import { bad, head, out, paint, C, table } from "../../../core/text/src/fmt";
import * as writes from "../../../research/pipeline/src/writes";
import { jcsCanonical } from "./jcs";

export const USAGE_INSTANCE = "usage: verify instance create|list|show|retire (see ygl-trees verify --help)";

/** Pack names follow verifier-pack-plan §4.1: the `ygl-v-` prefix is a hard rule (scoped form allowed). */
const PACK_RE = /^(@[a-z0-9][a-z0-9-]*\/)?ygl-v-[a-z0-9][a-z0-9-]*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TARGET_RE = /^[a-z][a-z0-9-]{0,31}:\S+$/;
const PARAM_KEY_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const SCHEDULE_RE = /^(manual|on-push|every:[1-9]\d{0,5}m)$/;
const STATES = ["draft", "active", "retired"];
/** Flags `verify instance` accepts (verify-cmds ACTION_FLAGS reads this list — one source). */
export const INSTANCE_FLAGS = ["pack", "target", "rev", "param", "owner", "schedule", "draft", "state", "reason"];

export interface InstanceBinding {
  target: string;
  rev: string;
  params: Record<string, string>;
}

/** Content-addressed identity of pack@version + binding (exported for tests and the S1 bridge). */
export function instanceIdentity(pack: string, version: string, binding: InstanceBinding): { id: string; identity_sha256: string } {
  const sha = createHash("sha256")
    .update(jcsCanonical({ pack, version, target: binding.target, rev: binding.rev, params: binding.params }), "utf8")
    .digest("hex");
  return { id: "vi_" + sha.slice(0, 24), identity_sha256: sha };
}

const list = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const flag = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Parse and validate `create` flags. Returns a usage-error message, or the validated fields. */
export function parseCreate(flags: Record<string, any>): string | {
  pack: string; version: string; binding: InstanceBinding; owner: string; schedule: string; state: string;
} {
  const packRef = flag(flags.pack), target = flag(flags.target), owner = flag(flags.owner);
  if (!packRef || !target || !owner) return `--pack, --target and --owner are required — ${USAGE_INSTANCE}`;
  const at = packRef.lastIndexOf("@");
  if (at <= 0) return `--pack must be <name>@<version>, got: ${packRef}`;
  const pack = packRef.slice(0, at), version = packRef.slice(at + 1);
  if (!PACK_RE.test(pack)) return `--pack name must start with ygl-v- (scoped: @scope/ygl-v-…), lowercase [a-z0-9-] — got: ${pack}`;
  if (!SEMVER_RE.test(version)) return `--pack version must be MAJOR.MINOR.PATCH, got: ${version}`;
  if (!TARGET_RE.test(target)) return `--target must be <kind>:<ref> (kind lowercase, e.g. git:owner/repo), got: ${target}`;
  if (flags.rev === true) return "--rev needs a value";
  const rev = flag(flags.rev);
  // A Map, not an object literal: keys such as `constructor` are legal and must not hit Object.prototype.
  const seen = new Map<string, string>();
  for (const raw of list(flags.param)) {
    const eq = raw.indexOf("=");
    if (eq <= 0) return `--param must be k=v, got: ${raw}`;
    const k = raw.slice(0, eq), v = raw.slice(eq + 1);
    if (!PARAM_KEY_RE.test(k)) return `--param key must match [a-z][a-z0-9_.-]*, got: ${k}`;
    if (seen.has(k) && seen.get(k) !== v) return `--param ${k} given twice with different values`;
    seen.set(k, v);
  }
  const params: Record<string, string> = Object.fromEntries(seen);
  if (flags.schedule === true) return "--schedule needs a value";
  const schedule = flag(flags.schedule);
  if (schedule && !SCHEDULE_RE.test(schedule)) return `--schedule must be manual | on-push | every:<N>m, got: ${schedule}`;
  const state = flags.draft === true || flags.draft === "true" ? "draft" : "active";
  return { pack, version, binding: { target, rev, params }, owner, schedule, state };
}

/** Which instance flags each subcommand reads; any other instance flag is a usage error, not silently ignored. */
const SUB_FLAGS: Record<string, string[]> = {
  create: ["pack", "target", "rev", "param", "owner", "schedule", "draft"],
  list: ["owner", "state", "pack"],
  show: [],
  retire: ["reason"],
};

/** I/O-free usage check (#175 ordering): bin runs it before the workspace DB gate and open. */
export function instancePreflight(rest: string[], flags: Record<string, any>): string | null {
  const sub = rest[0];
  const allowed = Object.hasOwn(SUB_FLAGS, sub) ? SUB_FLAGS[sub] : null;
  const stray = allowed ? Object.keys(flags).filter((k) => INSTANCE_FLAGS.includes(k) && !allowed.includes(k)) : [];
  if (stray.length) return `${stray.map((k) => `--${k}`).join(" ")} ${stray.length > 1 ? "do" : "does"} not apply to verify instance ${sub} — ${USAGE_INSTANCE}`;
  if (sub === "create") { const p = parseCreate(flags); return typeof p === "string" ? p : null; }
  if (sub === "list") {
    for (const k of ["owner", "state", "pack"]) {
      const v = flags[k];
      if (v === undefined) continue;
      if (typeof v !== "string" || !v.trim()) return `--${k} needs a value`;
      if (k === "state" && !STATES.includes(v)) return `--state must be one of ${STATES.join("|")}, got: ${v}`;
    }
    return null;
  }
  if (sub === "show") return rest[1] ? null : USAGE_INSTANCE;
  if (sub === "retire") return rest[1] && flag(flags.reason) ? null : `verify instance retire needs <id> and --reason — ${USAGE_INSTANCE}`;
  return USAGE_INSTANCE;
}

/** Row as the CLI shows it: binding parsed back to an object, last-run fields from verifier_runs. */
function present(row: any): Record<string, any> {
  let binding: any = row.binding;
  try { binding = JSON.parse(row.binding); } catch { /* keep the stored text */ }
  return {
    id: row.id, identity_sha256: row.identity_sha256, kind: row.kind, pack: row.pack, pack_version: row.pack_version,
    binding, owner: row.owner, schedule: row.schedule, state: row.state, note: row.note, created: row.created, updated: row.updated,
    last_run_id: row.last_run_id ?? null, last_verdict: row.last_verdict ?? null, last_judged_at: row.last_judged_at ?? null,
  };
}

const LAST_RUN = (col: string) =>
  `(SELECT r.${col} FROM verifier_runs r WHERE r.instance_id=i.id ORDER BY r.judged_at DESC, r.id DESC LIMIT 1)`;
const SELECT_INSTANCE = `SELECT i.*, ${LAST_RUN("id")} AS last_run_id, ${LAST_RUN("verdict")} AS last_verdict, ${LAST_RUN("judged_at")} AS last_judged_at FROM verifier_instances i`;

export function runInstance(env: Env, rest: string[], args: any): number | Promise<number> {
  const { ctx } = env;
  const sub = rest[0];
  const fail = (e: any): number => { bad(ctx, e?.message || String(e)); return 1; };
  const usage = instancePreflight(rest, args.flags ?? {});
  if (usage) { bad(ctx, usage); return 2; }

  if (sub === "create") {
    const p = parseCreate(args.flags ?? {}) as Exclude<ReturnType<typeof parseCreate>, string>;
    const ids = instanceIdentity(p.pack, p.version, p.binding);
    return getOrm(env.db.path)
      .then((ds) => writes.verifierInstanceCreate(ds, {
        ...ids, kind: "pack", pack: p.pack, pack_version: p.version, binding: jcsCanonical(p.binding),
        owner: p.owner, schedule: p.schedule, state: p.state,
      }))
      .then((r): number => {
        const row = present(env.store.db.get(`${SELECT_INSTANCE} WHERE i.id=?`, [r.row.id]) ?? r.row);
        if (ctx.json) console.log(JSON.stringify(r.dup ? { ...row, duplicate: true, updated: r.updated } : row, null, 2));
        else if (r.dup) out(ctx, paint(C.yellow, `  ⚠ duplicate: ${row.id} already registered (${row.pack}@${row.pack_version})${r.updated.length ? ` — updated: ${r.updated.join(", ")}` : ""}`, ctx.color));
        else out(ctx, `  ✓ verifier instance registered: ${row.id}  ${row.pack}@${row.pack_version} → ${p.binding.target}  [${row.state}]`);
        return 0;
      })
      .catch(fail);
  }

  if (sub === "list") {
    const where: string[] = [], params: string[] = [];
    for (const [k, col] of [["owner", "i.owner"], ["state", "i.state"], ["pack", "i.pack"]] as const) {
      const v = args.flags?.[k];
      if (v === undefined) continue;
      where.push(`${col}=?`); params.push(String(v).trim());
    }
    const rows = env.store.db.all(`${SELECT_INSTANCE}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY i.created, i.id`, params).map(present);
    if (ctx.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
    head(ctx, `Verifier instances (${rows.length})`);
    table(ctx, rows.map((r: Record<string, any>) => ({ ...r, target: r.binding?.target ?? "", pack_ref: `${r.pack}@${r.pack_version}`, last: r.last_verdict ?? "—" })),
      ["id", "pack", "target", "owner", "state", "last"], ["id", "pack_ref", "target", "owner", "state", "last"]);
    return 0;
  }

  if (sub === "show") {
    const id = rest[1];
    const row = env.store.db.get(`${SELECT_INSTANCE} WHERE i.id=?`, [id]);
    if (!row) { bad(ctx, `verifier instance not found: ${id}`); return 1; }
    const shown = present(row);
    if (ctx.json) console.log(JSON.stringify(shown, null, 2));
    else for (const [k, v] of Object.entries(shown)) out(ctx, `  ${k.padEnd(16)} ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "—")}`);
    return 0;
  }

  if (sub === "retire") {
    const id = rest[1];
    const reason = flag(args.flags?.reason);
    return getOrm(env.db.path)
      .then((ds) => writes.verifierInstanceRetire(ds, id, reason))
      .then((r): number => {
        const row = present(env.store.db.get(`${SELECT_INSTANCE} WHERE i.id=?`, [id]) ?? r.row);
        if (ctx.json) console.log(JSON.stringify(r.dup ? { ...row, duplicate: true } : row, null, 2));
        else out(ctx, r.dup ? paint(C.yellow, `  ⚠ duplicate: ${id} was already retired`, ctx.color) : `  ✓ verifier instance retired: ${id}  (${reason})`);
        return 0;
      })
      .catch((e: any): number => (/not found/.test(String(e?.message)) ? (bad(ctx, e.message), 1) : fail(e)));
  }

  return 2; // unreachable: instancePreflight rejects unknown subcommands
}
