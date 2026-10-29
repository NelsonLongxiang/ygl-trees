/** PG workspace identity. Credentials never enter binding records or diagnostics. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DataSource } from "typeorm";

export function pgTargetHash(raw: string): string {
  const u = new URL(raw);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error("invalid PostgreSQL URL");
  // libpq query parameters can override the authority's actual destination.
  for (const k of u.searchParams.keys()) {
    if (/^(host|hostaddr|port|dbname|database|service|servicefile|options)$/i.test(k)) {
      throw new Error("PG target overrides in URL query parameters are not supported; use the URL authority");
    }
  }
  const identity = [u.hostname.toLowerCase(), u.port || "5432", decodeURIComponent(u.pathname.slice(1))];
  if (!identity[2]) throw new Error("PG URL must name a database");
  return "sha256:" + createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function checkPgWorkspace(home: string, url: string, sqliteFile?: string): void {
  const path = join(home, "pg-binding.json");
  if (url) pgTargetHash(url); // Reject destination overrides before any connection or binding write.
  if (existsSync(path)) {
    const b = JSON.parse(readFileSync(path, "utf8"));
    if (!url || b.mode !== "pg" || b.url_hash !== pgTargetHash(url)) {
      throw new Error("workspace PG binding conflicts with YGL_DB_URL; select the bound PG target (no SQLite fallback)");
    }
  }
  if (url && sqliteFile && existsSync(sqliteFile)) {
    throw new Error("conflicting targets: YGL_DB_URL (PG) vs existing SQLite workspace; use a separate YGL_HOME");
  }
}

/** Explicitly attach to an already migrated PG schema; never synchronize/auto-create tables. */
export async function bindPgWorkspace(ds: DataSource, home: string, url: string, version: string): Promise<void> {
  const hash = pgTargetHash(url);
  const path = join(home, "pg-binding.json");
  const binding = { mode: "pg", url_hash: hash, bound_at: new Date().toISOString(), engine_version: version };
  await ds.transaction(async (mgr) => {
    const columns = await mgr.query("SELECT is_generated FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='kb_notes' AND column_name='ngram_tsv'");
    if (columns[0]?.is_generated !== "ALWAYS") throw new Error("PG business schema requires generated kb_notes.ngram_tsv (run the explicit migration)");
    await mgr.query("INSERT INTO meta(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING", ["backend_binding", JSON.stringify(binding)]);
    const rows = await mgr.query("SELECT value FROM meta WHERE key=$1", ["backend_binding"]);
    const stored = JSON.parse(rows[0]?.value || "null");
    if (stored?.mode !== "pg" || stored.url_hash !== hash) throw new Error("PG database backend_binding conflicts with YGL_DB_URL");
  });
  mkdirSync(home, { recursive: true });
  // Publish an entire record atomically: concurrent CLI readers never observe a partial JSON write.
  const temp = path + "." + process.pid + "." + Math.random().toString(36).slice(2);
  writeFileSync(temp, JSON.stringify(binding, null, 2) + String.fromCharCode(10), { flag: "wx" });
  try { linkSync(temp, path); }
  catch (e: any) { if (e.code !== "EEXIST") throw e; }
  finally { unlinkSync(temp); }
  checkPgWorkspace(home, url);
}

/** Only identifier metadata may enter this error; driver SQL and values stay masked. */
export class PgCapabilityError extends Error {}

export async function requirePgColumns(db: { query(sql: string, params?: any[]): Promise<any> }, requirements: Record<string, string[]>): Promise<void> {
  const rows = await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1)", [Object.keys(requirements)]);
  const found = new Set(rows.map((r: any) => r.table_name + "." + r.column_name));
  const missing = Object.entries(requirements).flatMap(([table, cols]) => cols.filter(c => !found.has(table + "." + c)).map(c => table + "." + c));
  if (missing.length) throw new PgCapabilityError("PG schema missing required columns: " + missing.join(", ") + "; no changes made. Use a compatible explicitly migrated target; do not overwrite an existing database with --fresh.");
}

export function pgFailure(): string {
  // Driver messages/SQL/parameters may contain raw URLs or credentials: do not echo them.
  return "PG operation failed (connection/schema/transaction); check the configured target and migrated schema; no SQLite fallback";
}
