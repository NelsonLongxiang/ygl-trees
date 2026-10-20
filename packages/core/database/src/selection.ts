/**
 * Selection resolution policy (spec R16) — pure, layer-free.
 *
 * Resolution priority (project and tree alike):
 *   explicit flag > env (YGL_PROJECT / YGL_TREE) > session key
 *   (`current_project@<sid>` / `current_tree@<sid>`) > global key.
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

/** sid — the session identity keys are namespaced under (R16.1). */
export function sessionId(): string {
  return process.env.YGL_SESSION || process.env.DSH_SESSION_ID || "default";
}

export function projectSessionKey(): string {
  return `current_project@${sessionId()}`;
}

export function treeSessionKey(): string {
  return `current_tree@${sessionId()}`;
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
 *  resolution (library callers, tests). */
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

function resolveProjectRaw(db: DB, explicit?: string): Selection {
  if (explicit) return { name: explicit, id: byName(db, explicit), source: "flag" };
  const envName = process.env.YGL_PROJECT;
  if (envName) return { name: envName, id: byName(db, envName), source: "env" };
  const sessionName = db.metaGet(projectSessionKey());
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
  const sessionName = db.metaGet(treeSessionKey());
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
export function projectSample(db: DB, limit = 8): string[] {
  return (db.all("SELECT name FROM projects ORDER BY updated DESC LIMIT ?", [limit]) || []).map(
    (r: any) => r.name
  );
}
