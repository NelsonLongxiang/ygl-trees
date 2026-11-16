/** Explicit ORM adapters and dialect inspection. Entity composition belongs to the application. */
import type { DataSource } from "typeorm";
import type { ScopedOrm } from "./scoped-orm";
export { createScopedOrm } from "./scoped-orm";
export type { ScopedOrm, OrmAccess, OrmTarget } from "./scoped-orm";

function requireOwner(owner?: ScopedOrm): ScopedOrm {
  if (!owner || typeof owner.getOrm !== "function" || typeof owner.getPgOrm !== "function" || typeof owner.close !== "function") throw new Error("ORM instance is required; pass an explicit owner");
  return owner;
}
export async function getOrm(file: string, owner?: ScopedOrm): Promise<DataSource> { return requireOwner(owner).getOrm(file); }
export async function getPgOrm(url: string, owner?: ScopedOrm): Promise<DataSource> { return requireOwner(owner).getPgOrm(url); }
export async function closeOrm(owner?: ScopedOrm): Promise<void> { await requireOwner(owner).close(); }

/** Dialect of the connection a manager belongs to (FTS5 gating). */
export function ormDialect(dsOrMgr: any): "sqlite" | "postgres" | "other" {
  const options = dsOrMgr?.connection?.options ?? dsOrMgr?.options;
  const type = String(options?.type ?? "");
  if (type === "better-sqlite3" || type === "sqlite") return "sqlite";
  if (type === "postgres") return "postgres";
  return "other";
}
