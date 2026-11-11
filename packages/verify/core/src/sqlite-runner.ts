/**
 * SQLite QueryRunner（node:sqlite）——M13-1 参考实现的数据面。
 *
 * 纪律：只读打开（readOnly 打开文件），拒绝多语句（单语句契约），
 * 源表行数与 schema 指纹供 scope witness 使用（评审 B2）。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { DatabaseSync } from "node:sqlite";

import { openDatabaseSync } from "./sqlite-bindings";

import { COLLECT_ERROR_TABLES } from "./contract";
import { extractTables, parsePragmaSource, type QueryRunner, type Row } from "./engine";

/**
 * 单语句判定（#162）：只把引号、标识符与注释之外的分号当语句分隔符。
 * 返回去掉末尾分隔符后的语句；顶层分号之后若还有非空白内容则返回 null。
 * 未闭合的引号/注释原样交给 SQLite，由 prepare 报错。Rust 端 sqlite.rs 同算法。
 */
/** SQL 空白：只认 ASCII 0x09–0x0D 与空格（与 Rust is_sql_ws 同集）；不用 JS \s 或 Unicode White_Space，两端才能逐字同判（#162 增补）。 */
const SQL_WS = /[\t\n\v\f\r ]/;
export function trimSqlWs(s: string): string {
  let a = 0, b = s.length;
  while (a < b && SQL_WS.test(s[a])) a++;
  while (b > a && SQL_WS.test(s[b - 1])) b--;
  return s.slice(a, b);
}

/**
 * 开头是非 ASCII 空白时返回其码位（如 "U+00A0"），否则 null——只用于给出准确报错（#162 P4），不改变拒收结论。
 * 字符集显式列出（U+0085/00A0/1680/2000–200A/2028/2029/202F/205F/3000/FEFF），与 Rust leading_non_ascii_ws 同集。
 */
const NON_ASCII_WS = /^[\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/;
export function leadingNonAsciiWs(s: string): string | null {
  if (!NON_ASCII_WS.test(s)) return null;
  return `U+${s.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
}

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
      return trimSqlWs(sql.slice(i + 1)) !== "" ? null : trimSqlWs(sql.slice(0, i));
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
  private isolated = false;
  /** 1.3: the snapshot file's sha256 when isolate() ran — `untouched()` proves it unchanged at the end of the run. */
  private isolatedSha: string | null = null;

  constructor(private readonly path: string, opts: SqliteRunnerOptions = {}) {
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

  /**
   * 1.3 (#80, rulings ② ③): derived tables and spec views run in memory only. The snapshot stays opened read-only
   * (SQLITE_OPEN_READONLY, so its file cannot change); temp storage is forced to memory and checked, each view is
   * created as a TEMP VIEW, then `query_only` locks the connection again before the first checker. A view name that
   * equals any object in the snapshot is refused (a temp view would shadow it). Rust sqlite.rs `isolate` is the same.
   */
  isolate(views: Array<{ name: string; sql: string }>): void {
    if (this.isolated) throw new Error("isolate: already isolated");
    this.isolated = true;
    this.isolatedSha = this.path === ":memory:" ? null : createHash("sha256").update(readFileSync(this.path)).digest("hex");
    this.db.exec("PRAGMA query_only = OFF");
    try {
      this.db.exec("PRAGMA temp_store = MEMORY");
      const ts = this.db.prepare("PRAGMA temp_store").get() as { temp_store?: number } | undefined;
      if (Number(ts?.temp_store) !== 2) throw new Error(`isolation_unavailable: temp_store is ${String(ts?.temp_store)}, not MEMORY — this SQLite build keeps temp objects on disk`);
      const clash = this.db.prepare("SELECT name FROM main.sqlite_master WHERE lower(name) = lower(?)");
      for (const v of views) {
        if (!/^[a-z][a-z0-9_]*$/.test(v.name)) throw new Error(`view_name: ${JSON.stringify(v.name)} is not snake_case`);
        if (clash.get(v.name)) throw new Error(`view_name: ${v.name} is already an object in the snapshot — a spec view may not shadow it`);
        try {
          this.db.exec(`CREATE TEMP VIEW ${v.name} AS ${v.sql}`);
        } catch (e) {
          throw new Error(`view ${v.name}: ${(e as Error).message}`);
        }
      }
    } finally {
      this.db.exec("PRAGMA query_only = ON");
    }
  }

  /** 1.3 (ruling ③): after an isolated run the snapshot's sha256 must equal the one taken before the views were
   *  created; returns the refusal, or null (also null when the run was not isolated). */
  untouched(): string | null {
    if (this.isolatedSha === null) return null;
    const now = createHash("sha256").update(readFileSync(this.path)).digest("hex");
    return now === this.isolatedSha ? null : `snapshot_changed: sha256 ${this.isolatedSha.slice(0, 12)} before the views, ${now.slice(0, 12)} after the run`;
  }

  /** 1.3 (#80 item 7): rows in each collector error table the snapshot has (Rust sqlite.rs `collect_errors`). */
  collectErrors(): Array<{ table: string; rows: number }> {
    const out: Array<{ table: string; rows: number }> = [];
    const has = this.db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name = ?");
    for (const table of COLLECT_ERROR_TABLES) {
      if (!has.get(table)) continue;
      const row = this.db.prepare(`SELECT count(*) AS n FROM main."${table}"`).get() as { n: number };
      out.push({ table, rows: Number(row.n) });
    }
    return out;
  }

  /** 1.3: views stored in the snapshot (main schema), by name — the engine refuses a 1.3 spec that reads one. */
  snapshotViews(): string[] {
    return (this.db.prepare("SELECT name FROM main.sqlite_master WHERE type='view' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  }

  query(sql: string): Row[] {
    const trimmed = trimSqlWs(sql);
    const ws = leadingNonAsciiWs(trimmed);
    if (ws !== null) {
      throw new Error(`SQL starts with non-ASCII whitespace ${ws}; only ASCII whitespace (tab, LF, VT, FF, CR, space) is trimmed`);
    }
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
    // 1.3: a whitelisted pragma source counts its own rows; it is re-parsed against the closed form, never spliced.
    const isPragma = /^pragma_/i.test(table);
    const pragma = isPragma ? parsePragmaSource(table) : null;
    if (isPragma ? !pragma : !/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`invalid table name: ${table}`);
    const stmt = this.db.prepare(pragma ? `SELECT count(*) AS n FROM ${pragma}` : `SELECT count(*) AS n FROM "${table}"`);
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
