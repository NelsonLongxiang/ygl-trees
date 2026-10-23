/**
 * Selection resolution policy (spec R16) — pure, layer-free.
 *
 * Resolution priority (project and tree alike):
 *   explicit flag > env (YGL_PROJECT / YGL_TREE) > session key
 *   (`current_project@<sid>` / `current_tree@<sid>`, walking the session chain
 *   `<sid>` → ancestors for worker sessions) > global key.
 *
 * The global key is display/migration fallback ONLY: it never authorizes
 * project-scoped commands when the workspace has more than one project
 * (fail-closed, R16.3 — enforced by the caller via `source`).
 *
 * A single-project workspace self-selects (`source: "only"`), because
 * there is nothing to be ambiguous about.
 */
import { DB } from "./db";

export type SelectionSource = "flag" | "env" | "session" | "global" | "only" | "none";

export interface Selection {
  /** resolved name; "" when source === "none" */
  name: string;
  /** projects.id when found; "" when the name is set but no row matches (caller reports rc=1) */
  id: string;
  source: SelectionSource;
}

/** sid — the session identity keys are namespaced under (R16.1).
 *  The no-session fallback is `"default"` here, while `eventActor()` falls back
 *  to `"cli"`: same concept, two names for historical reasons (selection keys
 *  predate the events actor). Keep them distinct — `"default"` means "shared
 *  bucket, no isolation", `"cli"` means "a human/agent shell did this". */
export function sessionId(): string {
  return process.env.YGL_SESSION || process.env.DSH_SESSION_ID || "default";
}

export function projectSessionKey(): string {
  return `current_project@${sessionId()}`;
}

export function treeSessionKey(): string {
  return `current_tree@${sessionId()}`;
}

/** K3 选择观测（0.114.22）：write-time warning for a selection that can be
 *  flipped by another session-less process.
 *
 *  Criteria (K3 ruling, no actor comparison):
 *   - shared bucket := source "global" OR (source "session" AND sid "default");
 *   - the SAME dimension's `project.use` / `tree.use` event is within 90 s.
 *  A warning means "your target may move under you", not a refusal. */
export function selectionChangeWarning(
  db: DB,
  dimension: "project" | "tree",
  source: SelectionSource,
  windowMs = 90_000,
): string | undefined {
  const shared = source === "global" || (source === "session" && sessionId() === "default");
  if (!shared) return undefined;
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = db.get(
    "SELECT ts FROM events WHERE kind=? AND ts>=? ORDER BY ts DESC LIMIT 1",
    [`${dimension}.use`, since],
  ) as { ts?: string } | undefined;
  if (!row?.ts) return undefined;
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(String(row.ts))) / 1000));
  const flag = dimension === "project" ? "-p/--project" : "-t/--tree";
  return (
    `selection is the shared "${sessionId()}" bucket and ${dimension}.use changed ${secs}s ago ` +
    `(within 90s) — parallel session-less agents share this pointer; pass ${flag} explicitly or set YGL_SESSION`
  );
}

export function projectCount(db: DB): number {
  const r = db.get("SELECT COUNT(*) AS n FROM projects");
  return Number(r?.n ?? 0);
}

function byName(db: DB, name: string): string {
  const r = db.get("SELECT id FROM projects WHERE name=?", [name]);
  return r?.id ?? "";
}

/** Last resolution outcome in this process (K3 0.106.0): audit rows record
 *  which layer authorized a write, so a later reader can tell a bare command
 *  riding a session key from one riding the global migration pointer. Written
 *  by resolveProject/resolveTree; absent when a write ran without any selection
 *  resolution (library callers, tests).
 *
 *  Boundary (K3 review): this is PROCESS-global, which is exact for the CLI
 *  (one command per process) but would mislabel concurrent requests if a
 *  long-lived host (webui serve / verify HTTP) ever performs selection-bearing
 *  writes from interleaved requests. Tree writes are CLI-only today; if the
 *  HTTP face ever grows them, `via` must move into request scope. */
export function recordSelectionVia(sel: Selection): Selection {
  process.env.YGL_SELECTION_VIA = sel.source;
  return sel;
}

/** The layer the current process resolved through, if any. */
export function currentSelectionVia(): SelectionSource | "" {
  const v = process.env.YGL_SELECTION_VIA;
  return (v as SelectionSource) || "";
}

/** Actor identity for audit rows: the session id when the caller has one, so
 *  two concurrent sessions are distinguishable in `events` (K3 0.106.0). */
export function eventActor(): string {
  return process.env.YGL_SESSION || process.env.DSH_SESSION_ID || "cli";
}

/**
 * Resolve the effective project for this invocation.
 * `explicit` is the --project/-p flag value when present (source "flag").
 */
export function resolveProject(db: DB, explicit?: string): Selection {
  return recordSelectionVia(resolveProjectRaw(db, explicit));
}

/** Session keys to try, exact first then ancestors. YGL_SESSION may be a
 *  chain: the job runner writes `<parent>/<job-id>` and nested workers append
 *  further segments (see workerSessionId). A child that never selected a
 *  project must inherit the nearest ancestor's — otherwise every bare-command
 *  job in a multi-project workspace died "ambiguous project" (GitHub #7). */
function sessionChain(prefix: "current_project" | "current_tree"): string[] {
  const parts = sessionId().split("/").filter(Boolean);
  const keys: string[] = [];
  for (let i = parts.length; i > 0; i--) keys.push(`${prefix}@${parts.slice(0, i).join("/")}`);
  if (!keys.length) keys.push(`${prefix}@default`);
  return keys;
}

function sessionSelection(db: DB, prefix: "current_project" | "current_tree"): string {
  for (const key of sessionChain(prefix)) {
    const name = db.metaGet(key);
    if (name) return name;
  }
  return "";
}

function resolveProjectRaw(db: DB, explicit?: string): Selection {
  if (explicit) return { name: explicit, id: byName(db, explicit), source: "flag" };
  const envName = process.env.YGL_PROJECT;
  if (envName) return { name: envName, id: byName(db, envName), source: "env" };
  const sessionName = sessionSelection(db, "current_project");
  if (sessionName) return { name: sessionName, id: byName(db, sessionName), source: "session" };
  const globalName = db.metaGet("current_project");
  if (globalName) return { name: globalName, id: byName(db, globalName), source: "global" };
  if (projectCount(db) === 1) {
    const r = db.get("SELECT id, name FROM projects LIMIT 1");
    return { name: r?.name ?? "", id: r?.id ?? "", source: "only" };
  }
  return { name: "", id: "", source: "none" };
}

/** Resolve the effective tree. Tree-scoped commands stay lenient (R16.4). */
export function resolveTree(db: DB, explicit?: string): Selection {
  return recordSelectionVia(resolveTreeRaw(db, explicit));
}

function resolveTreeRaw(db: DB, explicit?: string): Selection {
  if (explicit) return { name: explicit, id: "", source: "flag" };
  const envName = process.env.YGL_TREE;
  if (envName) return { name: envName, id: "", source: "env" };
  const sessionName = sessionSelection(db, "current_tree");
  if (sessionName) return { name: sessionName, id: "", source: "session" };
  const globalName = db.metaGet("current_tree");
  if (globalName) return { name: globalName, id: "", source: "global" };
  const r = db.get("SELECT COUNT(*) AS n FROM trees");
  if (Number(r?.n ?? 0) === 1) {
    const t = db.get("SELECT name FROM trees LIMIT 1");
    return { name: t?.name ?? "", id: "", source: "only" };
  }
  return { name: "", id: "", source: "none" };
}

/** True when the strict gate (R16.3) must refuse to run: many projects,
 *  and the only thing pointing at one is a global key (or nothing). */
export function ambiguousProject(db: DB, sel: Selection): boolean {
  return (sel.source === "global" || sel.source === "none") && projectCount(db) > 1;
}

/** First 8 project names for the ambiguous-error payload (R16.3). */
/** #47: id-addressed verbs resolve inside one project. Ids are workspace
 *  unique, so when the row exists in another project the refusal can always
 *  name the owner (one rule for research / produce / task surface). */
export type IdTable = "claims" | "evidence" | "sources" | "artifacts" | "tasks" | "queries";
export function ownerProjectName(db: DB, table: IdTable, id: string): string | null {
  if (!id) return null;
  const r = db.get(`SELECT p.name AS name FROM ${table} t JOIN projects p ON p.id=t.project_id WHERE t.id=?`, [id]) as any;
  return r?.name ?? null;
}

export function idNotFound(db: DB, table: IdTable, id: string, label: string): string {
  const owner = ownerProjectName(db, table, id);
  return owner ? `${label} not found: ${id}  (it belongs to project '${owner}' — use -p ${owner})` : `${label} not found: ${id}`;
}

export function projectSample(db: DB, limit = 8): string[] {
  return (db.all("SELECT name FROM projects ORDER BY updated DESC LIMIT ?", [limit]) || []).map(
    (r: any) => r.name
  );
}
