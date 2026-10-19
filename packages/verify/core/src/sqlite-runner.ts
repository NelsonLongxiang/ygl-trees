/**
 * SQLite QueryRunner（node:sqlite）——M13-1 参考实现的数据面。
 *
 * 纪律：只读打开（readOnly 打开文件），拒绝多语句（单语句契约），
 * 源表行数与 schema 指纹供 scope witness 使用（评审 B2）。
 */
import { createHash } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";

import { openDatabaseSync } from "./sqlite-bindings";

import { extractTables, type QueryRunner, type Row } from "./engine";

export interface SqliteRunnerOptions {
  /** 打开后立即执行的只读设置（如 PRAGMA query_only） */
  queryOnly?: boolean;
}

export class SqliteRunner implements QueryRunner {
  private readonly db: DatabaseSync;
  private tableCache = new Map<string, number>();

  constructor(path: string, opts: SqliteRunnerOptions = {}) {
    this.db = openDatabaseSync(path, { readOnly: true });
    if (opts.queryOnly !== false) {
      try {
        this.db.exec("PRAGMA query_only = ON");
      } catch {
        /* older sqlite: ignore */
      }
    }
  }

  close(): void {
    this.db.close();
  }

  query(sql: string): Row[] {
    const trimmed = sql.trim();
    if (!/^(select|with)\b/i.test(trimmed)) {
      throw new Error(`only SELECT/WITH allowed (read-only contract): ${trimmed.slice(0, 40)}`);
    }
    if (/;\s*\S/.test(trimmed)) {
      throw new Error("multi-statement SQL rejected (single statement contract)");
    }
    const stmt = this.db.prepare(trimmed.replace(/;\s*$/, ""));
    const rows = stmt.all() as Row[];
    return rows;
  }

  tableRows(table: string): number {
    const cached = this.tableCache.get(table);
    if (cached !== undefined) return cached;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`invalid table name: ${table}`);
    const stmt = this.db.prepare(`SELECT count(*) AS n FROM "${table}"`);
    const row = stmt.get() as { n: number } | undefined;
    const n = Number(row?.n ?? 0);
    this.tableCache.set(table, n);
    return n;
  }

  sourceTables(sql: string): string[] {
    return extractTables(sql);
  }

  /** schema 指纹：所有用户表（名 + 列定义）的规范化哈希——prepare 冻结值需与 run 比对。 */
  schemaFingerprint(): string {
    const rows = this.db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;
    const norm = rows.map((r) => `${r.name}:${(r.sql ?? "").replace(/\s+/g, " ").trim()}`).join("|");
    return `sha256:${createHash("sha256").update(norm).digest("hex")}`;
  }
}
