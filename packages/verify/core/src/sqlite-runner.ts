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

/**
 * 单语句判定（#162）：只把引号、标识符与注释之外的分号当语句分隔符。
 * 返回去掉末尾分隔符后的语句；顶层分号之后若还有非空白内容则返回 null。
 * 未闭合的引号/注释原样交给 SQLite，由 prepare 报错。Rust 端 sqlite.rs 同算法。
 */
export function singleStatement(sql: string): string | null {
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) i += 2; // doubled quote = escaped quote
          else break;
        } else i++;
      }
      i++;
    } else if (c === "[") {
      const end = sql.indexOf("]", i + 1);
      i = end < 0 ? n : end + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? n : end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === ";") {
      return /\S/.test(sql.slice(i + 1)) ? null : sql.slice(0, i).trimEnd();
    } else i++;
  }
  return sql;
}

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
    const clean = singleStatement(trimmed);
    if (clean === null) {
      throw new Error("multi-statement SQL rejected (single statement contract)");
    }
    const stmt = this.db.prepare(clean);
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
