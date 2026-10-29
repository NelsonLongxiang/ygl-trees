/**
 * B4 写路径原语 — 方言中立 upsert（`INSERT ... ON CONFLICT DO NOTHING RETURNING`）。
 *
 * 背景（PG 方案 §5 B4）：现有幂等写是「事务内 SELECT → 无则 INSERT」。两个进程
 * 同内容并发时都会 SELECT 到空，然后一个 INSERT 成功、另一个撞 UNIQUE 报错。
 * `ON CONFLICT ... DO NOTHING RETURNING` 把「判重 + 写入」合成一条原子语句：
 *  - 有 RETURNING 行 → 本次创建（dup:false）
 *  - 无 RETURNING 行 → 已被别的进程建了 → 再 SELECT 现有行（dup:true）
 *
 * SQLite ≥3.35 与 PG 都支持该语法（含 RETURNING），因此同一段 SQL 双端可用；
 * 差异只在参数占位符（`?` vs `$1..$n`）与是否在事务里跑。
 *
 * 不改 TypeORM 路径（mgr.save 仍用于非去重写）；本原语供「以内容哈希为唯一键」
 * 的写服务（query/source/evidence/claim/kb）在 B4 批内逐步替换 SELECT→INSERT。
 *
 * @module @ygl/core/database/upsert
 */
import { createHash } from "node:crypto";

export interface UpsertSpec {
  /** 表名（已存在，含唯一约束覆盖 conflict 列组）。 */
  table: string;
  /** 列名（INSERT 的列序，与 values 一一对应）。 */
  cols: string[];
  /** 值（与 cols 一一对应）。 */
  values: unknown[];
  /** 冲突判定的列组（必须被该表唯一约束/主键覆盖）。 */
  conflictCols: string[];
}

export interface UpsertOutcome {
  row: Record<string, any> | null;
  /** true = 本次未创建（已存在）。 */
  duplicate: boolean;
}

/** 生成方言中立 upsert SQL。`ph(i)` 决定第 i 个占位符（sqlite `?` / pg `$n`）。 */
export function upsertSql(
  spec: UpsertSpec,
  opts: { ph?: (i: number) => string; selectWhere?: string } = {},
): { insertSql: string; selectSql: string } {
  const ph = opts.ph ?? (() => "?");
  const placeholders = spec.cols.map((_, i) => ph(i));
  const insertSql =
    `INSERT INTO ${spec.table} (${spec.cols.join(",")}) VALUES (${placeholders.join(",")}) ` +
    `ON CONFLICT(${spec.conflictCols.join(",")}) DO NOTHING RETURNING *`;
  const where = spec.conflictCols.map((_, i) => `${spec.conflictCols[i]} = ${ph(i)}`).join(" AND ");
  const selectSql = `SELECT * FROM ${spec.table} WHERE ${opts.selectWhere ?? where}`;
  return { insertSql, selectSql };
}

/** 执行一次原子 upsert。`run`/`all` 由后端注入（SQLite 同步包 Promise；PG 原生 async）。 */
export async function insertOrFetch(
  spec: UpsertSpec,
  exec: {
    all: (sql: string, params: unknown[]) => Promise<Record<string, any>[]>;
    dialect: "sqlite" | "pg";
  },
): Promise<UpsertOutcome> {
  const { insertSql, selectSql } = upsertSql(spec, {
    ph: exec.dialect === "pg" ? (i) => `$${i + 1}` : () => "?",
  });
  // RETURNING *：创建成功返回一行；冲突返回空
  try {
    const inserted = await exec.all(insertSql, spec.values);
    if (inserted.length) return { row: inserted[0], duplicate: false };
  } catch (e: any) {
    // SQLite 的 better-sqlite3 在 RETURNING 上返回空而不是抛错；若驱动版本
    // 不支持 RETURNING 会抛语法错——按「未知方言能力」向上抛，不静默降级。
    throw new Error(`upsert RETURNING failed (${spec.table}): ${e?.message || e}`);
  }
  // SELECT 的参数必须按 conflictCols 从 cols 里取（不是 values 末尾——那是另一组列）
  const byCol = new Map<string, unknown>();
  spec.cols.forEach((c, i) => byCol.set(c, spec.values[i]));
  const conflictValues = spec.conflictCols.map((c) => byCol.get(c));
  const existing = await exec.all(selectSql, conflictValues);
  return { row: existing[0] ?? null, duplicate: true };
}

/** 内容哈希（与 writes.ts 的 contentHash 同源约定：sha1 of normalized text）——
 *  供写服务在构造 UpsertSpec 时复用，保证「同内容」判定跨后端一致。 */
export function contentKey(parts: string[]): string {
  return createHash("sha1").update(parts.join("\u0000")).digest("hex");
}
