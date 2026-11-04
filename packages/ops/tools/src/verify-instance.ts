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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Env } from "../../../core/database/src/types";
import { getOrm } from "../../../core/database/src/orm";
import { bad, head, out, paint, C, table } from "../../../core/text/src/fmt";
import * as writes from "../../../research/pipeline/src/writes";
import { jcsCanonical } from "./jcs";

export const USAGE_INSTANCE = "usage: verify instance create|list|show|retire|import-latest (see ygl-trees verify --help)";

/** Pack names follow verifier-pack-plan §4.1: the `ygl-v-` prefix is a hard rule (scoped form allowed). */
const PACK_RE = /^(@[a-z0-9][a-z0-9-]*\/)?ygl-v-[a-z0-9][a-z0-9-]*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TARGET_RE = /^[a-z][a-z0-9-]{0,31}:\S+$/;
const PARAM_KEY_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const SCHEDULE_RE = /^(manual|on-push|every:[1-9]\d{0,5}m)$/;
const STATES = ["draft", "active", "retired"];
const SHOW_RUNS = 20;
/** Flags `verify instance` accepts (verify-cmds ACTION_FLAGS reads this list — one source). */
export const INSTANCE_FLAGS = ["pack", "target", "rev", "param", "owner", "schedule", "draft", "state", "reason", "scope"];

/** #213 G2: unscoped `ygl-v-<name>` is reserved for the global packs (verifier-pack-plan §4). The list lives only
 *  here, so adding a global pack is a reviewed ygl-trees change; every other pack is `@<project>/ygl-v-<name>`. */
export const GLOBAL_PACKS = ["ygl-v-core-aggregate", "ygl-v-pr-gate", "ygl-v-release-audit"];
const SCOPE_RE = /^@([a-z0-9][a-z0-9-]*)\//;

/** Repository name of a git target (`git:owner/repo` or `git:repo`), lowercase; "" for any other kind. */
function gitRepoName(target: string): string {
  const m = /^git:(?:.*\/)?([^/]+?)(?:\.git)?\/?$/.exec(target);
  return m ? m[1].toLowerCase() : "";
}

/** #213: an instance's tier — `global` for the reserved packs, otherwise its project: the pack's @scope, or for a
 *  legacy-repo instance the target repository. Derived on read, never stored, so it cannot drift from the name. */
export function scopeOf(kind: string, pack: string, target: string): string {
  if (kind === "legacy-repo") return gitRepoName(target) || "unscoped";
  const m = SCOPE_RE.exec(pack);
  return m ? m[1] : GLOBAL_PACKS.includes(pack) ? "global" : "unscoped";
}

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
  // #213 tiers: unscoped names belong to the global packs; a project pack verifies only its own project.
  const scope = SCOPE_RE.exec(pack)?.[1];
  if (!scope && !GLOBAL_PACKS.includes(pack)) return `--pack ${pack}: unscoped ygl-v-* names are reserved for the global packs (${GLOBAL_PACKS.join(", ")}); a project pack is @<project>/ygl-v-<name>`;
  const repo = gitRepoName(target);
  if (scope && repo && scope !== repo) return `--pack scope @${scope} does not match the target repository ${repo}: a project pack verifies only its own project (use @${repo}/…)`;
  return { pack, version, binding: { target, rev, params }, owner, schedule, state };
}

// ---------------------------------------------------------------- #207 S1: legacy-repo bridge

const VERDICTS = ["PASS", "FAIL", "NEEDS-MATERIAL", "ERROR"];

const GITHUB_RE = /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i;
const isAbs = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);

/** Legacy verifier repos name their target as a local path, owner/repo or a GitHub URL; the bridge maps them
 *  onto the `<kind>:<ref>` target form. A GitHub URL wins — target.repo_url first, then the origin of a local
 *  checkout (`originOf`) — so copies of one verifier on different machines (different checkout paths, same
 *  upstream) land on the same instance. A path only stays a path when no upstream is known. */
export function legacyTarget(target: { repo?: unknown; repo_url?: unknown }, base = "", originOf: (dir: string) => string = () => ""): string {
  const url = typeof target.repo_url === "string" ? target.repo_url.trim() : "";
  let repo = typeof target.repo === "string" ? target.repo.trim() : "";
  if (/^\.\.?([\\/]|$)/.test(repo) && isAbs(base)) repo = resolve(base, repo);
  for (const v of [url, repo]) {
    const m = GITHUB_RE.exec(v);
    if (m) return `git:${m[1]}`;
  }
  if (/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repo)) return `git:${repo}`;
  if (isAbs(repo)) {
    const m = GITHUB_RE.exec(originOf(repo));
    return m ? `git:${m[1]}` : `path:${repo.replace(/\\/g, "/")}`;
  }
  return `ref:${repo}`;
}

/** origin URL of a local git checkout, read from .git/config (no git spawn); "" when there is none. */
export function checkoutOrigin(dir: string): string {
  try {
    const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(readFileSync(join(dir, ".git", "config"), "utf8"));
    return m ? m[1] : "";
  } catch { return ""; }
}

export interface LegacyLatest {
  verifier: string;
  binding: InstanceBinding;
  run: { id: string; verdict: string; judged_at: string; target_sha: string };
  archive: string;
  result_file: string;
  repo: string;
}

/** Validate one `ygl-verifier-latest/1` document and normalize it. Returns every problem by name, or the
 *  fields the registry keeps. Relative paths resolve against the document's own `repo` (the verifier repo),
 *  else against `dir` (where the latest.json sits). */
export function parseLatest(doc: any, dir = "", originOf: (dir: string) => string = () => ""): string[] | LegacyLatest {
  const problems: string[] = [];
  const str = (v: unknown) => typeof v === "string" && v.trim() !== "";
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return ["document is not a JSON object"];
  if (doc.contract !== "ygl-verifier-latest/1") problems.push(`contract must be "ygl-verifier-latest/1" (got ${JSON.stringify(doc.contract ?? null)})`);
  if (!str(doc.verifier)) problems.push("verifier missing");
  const t = doc.target;
  if (!t || typeof t !== "object") problems.push("target missing");
  else {
    if (!str(t.repo) && !str(t.repo_url)) problems.push("target.repo missing");
    if (!str(t.rev)) problems.push("target.rev missing");
    if (!str(t.sha)) problems.push("target.sha missing");
  }
  if (!VERDICTS.includes(doc.overall)) problems.push(`overall must be one of ${VERDICTS.join("|")} (got ${JSON.stringify(doc.overall ?? null)})`);
  if (!(typeof doc.root_run_id === "string" && /^run_[0-9a-f]{8,}$/.test(doc.root_run_id))) problems.push("root_run_id missing or not run_<hex>");
  if (!(str(doc.judged_at) && !Number.isNaN(Date.parse(doc.judged_at)))) problems.push("judged_at missing or not an ISO timestamp");
  if (problems.length) return problems;
  const repo = str(doc.repo) ? doc.repo.trim() : "";
  const base = isAbs(repo) ? repo : dir;
  const at = (v: unknown) => (str(v) ? (isAbs(v as string) || !base ? (v as string) : resolve(base, v as string)) : "");
  return {
    verifier: doc.verifier.trim(),
    binding: { target: legacyTarget(t, base, originOf), rev: t.rev.trim(), params: {} },
    run: { id: doc.root_run_id, verdict: doc.overall, judged_at: new Date(doc.judged_at).toISOString(), target_sha: t.sha.trim() },
    archive: at(doc.archive),
    result_file: at(doc.result_file),
    repo,
  };
}

const fileSha = (p: string): string => (p && existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "");

/** Which instance flags each subcommand reads; any other instance flag is a usage error, not silently ignored. */
const SUB_FLAGS: Record<string, string[]> = {
  create: ["pack", "target", "rev", "param", "owner", "schedule", "draft"],
  list: ["owner", "state", "pack", "scope"],
  show: [],
  retire: ["reason"],
  "import-latest": ["owner"],
};

/** I/O-free usage check (#175 ordering): bin runs it before the workspace DB gate and open. */
export function instancePreflight(rest: string[], flags: Record<string, any>): string | null {
  const sub = rest[0];
  const allowed = Object.hasOwn(SUB_FLAGS, sub) ? SUB_FLAGS[sub] : null;
  const stray = allowed ? Object.keys(flags).filter((k) => INSTANCE_FLAGS.includes(k) && !allowed.includes(k)) : [];
  if (stray.length) return `${stray.map((k) => `--${k}`).join(" ")} ${stray.length > 1 ? "do" : "does"} not apply to verify instance ${sub} — ${USAGE_INSTANCE}`;
  if (sub === "create") { const p = parseCreate(flags); return typeof p === "string" ? p : null; }
  if (sub === "list") {
    for (const k of ["owner", "state", "pack", "scope"]) {
      const v = flags[k];
      if (v === undefined) continue;
      if (typeof v !== "string" || !v.trim()) return `--${k} needs a value`;
      if (k === "state" && !STATES.includes(v)) return `--state must be one of ${STATES.join("|")}, got: ${v}`;
    }
    return null;
  }
  if (sub === "show") return rest[1] ? null : USAGE_INSTANCE;
  if (sub === "retire") return rest[1] && flag(flags.reason) ? null : `verify instance retire needs <id> and --reason — ${USAGE_INSTANCE}`;
  if (sub === "import-latest") return rest[1] && flag(flags.owner) ? null : `verify instance import-latest needs <latest.json> and --owner — ${USAGE_INSTANCE}`;
  return USAGE_INSTANCE;
}

/** Row as the CLI shows it: binding parsed back to an object, last-run fields from verifier_runs. */
function present(row: any): Record<string, any> {
  let binding: any = row.binding;
  try { binding = JSON.parse(row.binding); } catch { /* keep the stored text */ }
  return {
    id: row.id, identity_sha256: row.identity_sha256, kind: row.kind, scope: scopeOf(row.kind, row.pack, binding?.target ?? ""),
    pack: row.pack, pack_version: row.pack_version,
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
    const scope = args.flags?.scope === undefined ? null : String(args.flags.scope).trim();
    const rows = env.store.db.all(`${SELECT_INSTANCE}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY i.created, i.id`, params)
      .map(present).filter((r: Record<string, any>) => scope === null || r.scope === scope);
    if (ctx.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
    head(ctx, `Verifier instances (${rows.length})`);
    table(ctx, rows.map((r: Record<string, any>) => ({ ...r, target: r.binding?.target ?? "", pack_ref: `${r.pack}@${r.pack_version}`, last: r.last_verdict ?? "—" })),
      ["id", "scope", "pack", "target", "owner", "state", "last"], ["id", "scope", "pack_ref", "target", "owner", "state", "last"]);
    return 0;
  }

  if (sub === "show") {
    const id = rest[1];
    const row = env.store.db.get(`${SELECT_INSTANCE} WHERE i.id=?`, [id]);
    if (!row) { bad(ctx, `verifier instance not found: ${id}`); return 1; }
    // Newest SHOW_RUNS runs (plan D3 keeps K = 20 per instance), so readers never need the DB file.
    const runs = env.store.db.all(`SELECT id, verdict, judged_at, target_sha, payload_sha256, archive_sha256, executor, engine_version, created
      FROM verifier_runs WHERE instance_id=? ORDER BY judged_at DESC, id DESC LIMIT ${SHOW_RUNS}`, [id]);
    const shown = { ...present(row), runs };
    if (ctx.json) { console.log(JSON.stringify(shown, null, 2)); return 0; }
    for (const [k, v] of Object.entries(present(row))) out(ctx, `  ${k.padEnd(16)} ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "—")}`);
    out(ctx, `  ${"runs".padEnd(16)} ${runs.length ? "" : "—"}`);
    for (const r of runs as Array<Record<string, any>>) out(ctx, `    ${r.judged_at}  ${String(r.verdict).padEnd(14)} ${r.id}  ${String(r.target_sha).slice(0, 12)}${r.archive_sha256 ? "" : "  (no archive)"}`);
    return 0;
  }

  if (sub === "import-latest") {
    const file = rest[1];
    let doc: any;
    try { doc = JSON.parse(readFileSync(file, "utf8")); } catch (e: any) { bad(ctx, `cannot read ${file}: ${e?.code === "ENOENT" ? "no such file" : e?.message || e}`); return 1; }
    const p = parseLatest(doc, dirname(resolve(file)), checkoutOrigin);
    if (Array.isArray(p)) { bad(ctx, `${file} does not satisfy ygl-verifier-latest/1: ${p.join("; ")}`); return 1; }
    // #213 P3: a legacy-repo instance is project-level, so its target must resolve to a GitHub project.
    if (!p.binding.target.startsWith("git:")) { bad(ctx, `${file}: target ${p.binding.target} has no GitHub upstream, so it cannot be attributed to a project — set target.repo_url, or an origin remote on the checkout (#213 P3)`); return 1; }
    const ids = instanceIdentity(p.verifier, "legacy", p.binding);
    const archiveSha = fileSha(p.archive);
    return getOrm(env.db.path)
      .then((ds) => writes.verifierRunRecord(ds,
        { ...ids, kind: "legacy-repo", pack: p.verifier, pack_version: "legacy", binding: jcsCanonical(p.binding), owner: flag(args.flags.owner), schedule: "", state: "active" },
        { ...p.run, payload_sha256: fileSha(p.result_file), archive_sha256: archiveSha, executor: `legacy-repo:${p.repo || p.verifier}`, engine_version: "" }))
      .then((r): number => {
        const inst = present(env.store.db.get(`${SELECT_INSTANCE} WHERE i.id=?`, [r.instance.id]) ?? r.instance);
        const payload = { instance: inst, instance_created: r.instance_created, run: r.run, archive_ok: archiveSha !== "", ...(r.run_dup ? { duplicate: true } : {}) };
        if (ctx.json) console.log(JSON.stringify(payload, null, 2));
        else if (r.run_dup) out(ctx, paint(C.yellow, `  ⚠ duplicate: run ${r.run.id} already recorded for ${inst.id}`, ctx.color));
        else out(ctx, `  ✓ ${r.instance_created ? "registered" : "updated"} ${inst.id} (${p.verifier}) ← ${r.run.id} ${r.run.verdict}${archiveSha ? "" : "  [archive not found: archive_ok=false]"}`);
        return 0;
      })
      .catch(fail);
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
