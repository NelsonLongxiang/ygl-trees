/** Require an application-supplied ORM instance only on paths which actually use it. */
import type { OrmAccess } from "./scoped-orm";

export function requireOrm(env: { readonly orm?: OrmAccess }): OrmAccess {
  const orm = env?.orm;
  if (!orm || typeof orm.getOrm !== "function" || typeof orm.getPgOrm !== "function") throw new Error("ORM instance is required: env.orm");
  return orm;
}


/** Preserve explicit target selection while keeping repeated command access domain-free. */
export function sqliteOrm(env: { orm?: OrmAccess; db: { path: string } }) { return requireOrm(env).getOrm(env.db.path); }
export function pgOrm(env: { orm?: OrmAccess; pgUrl?: string }) {
  if (!env.pgUrl) return Promise.reject(new Error("PostgreSQL target is required"));
  return requireOrm(env).getPgOrm(env.pgUrl);
}
export function workspaceOrm(env: { orm?: OrmAccess; db: any; pgUrl?: string }) { return env.pgUrl ? pgOrm(env) : sqliteOrm(env); }
