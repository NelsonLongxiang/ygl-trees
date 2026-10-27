/**
 * AsyncDB — the async data-access layer for B1 read-path migration (PG plan).
 *
 * B1 goal: every read path works against an async interface so PG can slot in
 * later without touching call sites again. The SQLite implementation wraps
 * the existing sync `DB` in zero-cost `Promise.resolve()` — no behavioral
 * change, byte-identical output (golden reconciliation).
 *
 * The PG implementation (B2/B3) will implement the same interface with the
 * `pg` client. Write paths stay on the transactional services (conventions §五)
 * and are NOT converted here.
 *
 * @module @ygl/core/database/asyncdb
 */
import type { DB } from "./db";

export interface AsyncDb {
  /** #77③: dialect marker — sync delegation is only valid on "sqlite". */
  readonly dialect: "sqlite" | "pg";
  /** Single-row read; null when no match (same contract as DB.get). */
  get(sql: string, params?: unknown[]): Promise<Record<string, any> | null>;
  /** Multi-row read; empty array when no match (same contract as DB.all). */
  all(sql: string, params?: unknown[]): Promise<Record<string, any>[]>;
}

/** SQLite adapter: wraps the sync DB in Promises (zero overhead — the
 *  underlying call is still synchronous, microtask hop only). */
export class SqliteAsyncDb implements AsyncDb {
  readonly dialect = "sqlite" as const;
  constructor(private readonly db: DB) {}

  async get(sql: string, params: unknown[] = []): Promise<Record<string, any> | null> {
    return this.db.get(sql, params);
  }

  async all(sql: string, params: unknown[] = []): Promise<Record<string, any>[]> {
    return this.db.all(sql, params);
  }
}

/** PG 实现（B6）：`pg` 客户端直连；`?` 占位符在发送前转 `$n`（facade 层统一用 ?）。 */
export class PgAsyncDb implements AsyncDb {
  readonly dialect = "pg" as const;
  private client: any = null;
  private connecting: Promise<void> | null = null;

  /** clientFactory 可注入（测试）；默认 require("pg")。 */
  constructor(private readonly url: string, private readonly clientFactory?: (url: string) => any) {}

  private async ready(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (this.clientFactory) {
        this.client = this.clientFactory(this.url);
      } else {
        const pgMod = require("pg") as any;
        this.client = new pgMod.Client({ connectionString: this.url });
      }
      await this.client.connect();
    })();
    return this.connecting;
  }

  /** `?` → `$1..$n`（facade 查询不含字符串字面量里的 ?）。 */
  private pgSql(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => "$" + ++i);
  }

  async get(sql: string, params: unknown[] = []): Promise<Record<string, any> | null> {
    await this.ready();
    const r = await this.client.query(this.pgSql(sql), params);
    return r.rows[0] ?? null;
  }

  async all(sql: string, params: unknown[] = []): Promise<Record<string, any>[]> {
    await this.ready();
    const r = await this.client.query(this.pgSql(sql), params);
    return r.rows;
  }

  async close(): Promise<void> {
    if (this.client) { try { await this.client.end(); } catch { /* */ } this.client = null; this.connecting = null; }
  }
}

/** #93-②：PG URL 脱敏——单点助手，所有打印面共用。
 *  剥 userinfo（user:pass@）和查询串里的凭证参数（password/user/sslpassword/
 *  sslkey/sslcert/passfile，大小写不敏感）。凭证不得进 stdout/错误文本/事件/归档（plan §3.5）。 */
export function redactPgUrl(url: string): string {
  let u = String(url || "").replace(/\/\/[^@\/]*@/i, "//");
  u = u.replace(/([?&])(user|password|passfile|sslpassword|sslkey|sslcert)=([^&]*)/gi, (_m, q, k) => q + k + "=***");
  return u;
}

/** Factory: create the async adapter for the current workspace DB.
 *  B6：YGL_DB_URL 为 postgres:// 时返回 PgAsyncDb（PG 直连面），否则 SQLite。 */
export function getAsyncDb(db: DB | null, url?: string): AsyncDb {
  const target = url ?? process.env.YGL_DB_URL ?? "";
  if (/^postgres(ql)?:\/\//i.test(target)) return new PgAsyncDb(target);
  if (!db) throw new Error("getAsyncDb: sqlite backend requires a DB instance (or pass YGL_DB_URL for PG)");
  return new SqliteAsyncDb(db);
}

/** #77③: sync delegation is only sound on a synchronous backend (SQLite).
 *  A PG-backed facade has no sync face — calling the legacy sync Store against
 *  it would either lie (fail late, deep in a query) or block the event loop
 *  waiting on a socket. Fail closed at the boundary with a named error. */
export function assertSyncDelegationAllowed(adb: AsyncDb, where: string): void {
  if (adb.dialect !== "sqlite") {
    throw new Error(
      `${where}: sync delegation requires the sqlite dialect; this facade is ${adb.dialect}. ` +
      `Call the async method instead — the sync Store path cannot reach a PG backend (B4).`,
    );
  }
}
