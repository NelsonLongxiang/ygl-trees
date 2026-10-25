/**
 * B4 调度面原语 — job tick 单执行锁（双后端）。
 *
 * 背景（PG 方案 §5 B4）：`job tick` 是「扫到期 job → 执行 → 写 runs」。两台机器
 * 同时 tick 会重复执行同一个 job（SQLite 侧靠文件写锁串行化单机多进程，但跨机器
 * 无锁面）。PG 侧用 `pg_try_advisory_lock`（会话级、非阻塞）实现「同一时刻只有
 * 一个 ticker 在跑」；SQLite 侧维持既有文件锁语义（单机多进程已串行）。
 *
 * 本模块只给**原语**（tryLock/release/holder），接线在 job-cmds 的 tick 入口；
 * 锁名固定 `ygl:job-tick`（跨库同一语义）。
 *
 * @module @ygl/core/database/advisory-lock
 */

export interface AdvisoryLock {
  /** true = 拿到锁（可以跑 tick）；false = 别人在跑（本进程跳过）。 */
  tryAcquire(name: string): Promise<boolean>;
  /** 释放（幂等；未持有时无副作用）。 */
  release(name: string): Promise<void>;
  /** 当前持有者描述（诊断用；未知返回 null）。 */
  holder(name: string): Promise<string | null>;
}

/** PG 实现：`pg_try_advisory_lock(hashtext(name))`（会话级锁）。 */
export class PgAdvisoryLock implements AdvisoryLock {
  constructor(private readonly query: (sql: string, params: unknown[]) => Promise<Array<Record<string, any>>>) {}

  async tryAcquire(name: string): Promise<boolean> {
    const rows = await this.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [name]);
    return rows[0]?.ok === true;
  }

  async release(name: string): Promise<void> {
    await this.query("SELECT pg_advisory_unlock(hashtext($1))", [name]);
  }

  async holder(name: string): Promise<string | null> {
    // pg_locks 无会话身份名——返回持有者 pid 供诊断
    const rows = await this.query(
      `SELECT l.pid::text AS pid FROM pg_locks l
        WHERE l.locktype='advisory' AND l.objid = hashtext($1)::oid AND l.granted LIMIT 1`,
      [name],
    );
    return rows[0]?.pid ?? null;
  }
}

/** SQLite 实现：单机语义已由文件写锁串行化——tryAcquire 恒 true（无跨机面）。 */
export class SqliteAdvisoryLock implements AdvisoryLock {
  async tryAcquire(): Promise<boolean> { return true; }
  async release(): Promise<void> { /* no-op：无跨机锁面 */ }
  async holder(): Promise<string | null> { return null; }
}

export const JOB_TICK_LOCK = "ygl:job-tick";
