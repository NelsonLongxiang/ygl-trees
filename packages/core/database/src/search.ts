/**
 * B3 检索面方言抽象 — SQLite FTS5 / PG tsvector 双后端。
 *
 * 契约 v1.2 B3：`fts()`/kbSearch/skillMatch 增 PG 分支
 * （`ngram_tsv @@ to_tsquery`）；验收 = 黄金查询集（中英文 + 复合 token）
 * 双后端 top-k 一致。
 *
 * 设计：
 * - `SearchBackend` 接口：`query(tokens, limit)` 返回统一形状的命中行
 * - `SqliteFts5Backend`：封装现有 fts5 MATCH + bm25（行为与 Store.fts 等价）
 * - `PgTsvectorBackend`：`ngram_tsv @@ to_tsquery(...)` + `ts_rank_cd` 排序
 * - 两者共用同一 token 归一（`ngram()` + 去重），保证查询语义一致
 *
 * PG 侧实现以 `QueryFn`（注入的 async 查询函数）表达——真实连接在 B4/B6 接入；
 * 单测用记录型 stub 断言生成的 SQL 形状。
 *
 * @module @ygl/core/database/search
 */
import { ngram } from "../../text/src/text";

export interface SearchHit {
  id: string;
  score: number;
  hits: number;
  boost: number;
}

export interface SearchBackend {
  readonly dialect: "sqlite" | "pg";
  /** 归一后的查询 token（去重、去空）。 */
  tokens(q: string): string[];
  /** 检索；返回按 score 升序（SQLite bm25 越小越好）统一归一为「越小越相关」。 */
  search(q: string, limit: number): Promise<SearchHit[]>;
}

/** SQLite FTS5 后端（封装现有 MATCH + bm25 语义）。 */
export class SqliteFts5Backend implements SearchBackend {
  readonly dialect = "sqlite" as const;

  constructor(
    private readonly native: { prepare: (sql: string) => { all: (p: unknown[]) => unknown[]; finalize?: () => void } },
    private readonly table: string,
    private readonly join: string,
    private readonly where = "",
    private readonly params: unknown[] = [],
  ) {}

  tokens(q: string): string[] {
    return Array.from(new Set(ngram(q).split(/\s+/).filter(Boolean)));
  }

  async search(q: string, limit: number): Promise<SearchHit[]> {
    const tokens = this.tokens(q);
    if (!tokens.length) return [];
    const cond = [this.where, `${this.table} MATCH ?`].filter(Boolean).join(" AND ");
    const st = this.native.prepare(
      `SELECT f.id AS id, bm25(${this.table}) AS score
         FROM ${this.table} f JOIN ${this.join}
        WHERE ${cond} ORDER BY score LIMIT ?`,
    );
    try {
      const agg = new Map<string, SearchHit>();
      for (const t of tokens) {
        const phrase = `"${t.replace(/"/g, "")}"`;
        for (const r of st.all([...this.params, phrase, limit]) as Array<{ id: string; score: number }>) {
          const prev = agg.get(String(r.id));
          if (prev) { prev.hits += 1; prev.score += r.score; }
          else agg.set(String(r.id), { id: String(r.id), score: r.score, hits: 1, boost: 0 });
        }
      }
      return [...agg.values()].sort((a, b) => a.score - b.score);
    } finally {
      st.finalize?.();
    }
  }
}

/** PG tsvector 后端（`ngram_tsv @@ to_tsquery` + `ts_rank_cd`）。
 *
 *  token 归一与 SQLite 完全一致（同一 `ngram()`），只是匹配原语换成 tsquery：
 *  - 每个 token 转 `to_tsquery('simple', '<escaped>')`，多 token 结果按 id 聚合并加分
 *  - 排序用 `ts_rank_cd` 降序 → 归一为「越小越相关」以对齐 bm25 语义
 */
export class PgTsvectorBackend implements SearchBackend {
  readonly dialect = "pg" as const;

  constructor(
    private readonly queryFn: (sql: string, params: unknown[]) => Promise<Array<Record<string, any>>>,
    private readonly table: string,
    private readonly join: string,
    private readonly where = "",
    private readonly params: unknown[] = [],
  ) {}

  tokens(q: string): string[] {
    return Array.from(new Set(ngram(q).split(/\s+/).filter(Boolean)));
  }

  async search(q: string, limit: number): Promise<SearchHit[]> {
    const tokens = this.tokens(q);
    if (!tokens.length) return [];
    const cond = [this.where, `${this.table} MATCH ?`].filter(Boolean).join(" AND ");
    void cond; // 保留形状对照；PG 不认 MATCH
    const pgWhere = [this.where, "_tsv @@ to_tsquery('simple', ?)"].filter(Boolean).join(" AND ");
    const agg = new Map<string, SearchHit>();
    for (const t of tokens) {
      const rows = await this.queryFn(
        `SELECT f.id AS id, ts_rank_cd(_tsv, to_tsquery('simple', ?)) AS rank
           FROM ${this.table} f JOIN ${this.join}
          WHERE ${pgWhere} ORDER BY rank DESC LIMIT ?`,
        [...this.params, t.replace(/[^A-Za-z0-9_\u4e00-\u9fa5]/g, " ").trim(), limit],
      );
      for (const r of rows) {
        const id = String(r.id);
        const prev = agg.get(id);
        // ts_rank_cd 越大越相关 → 取负对齐 bm25（越小越相关）
        const score = -Number(r.rank ?? 0);
        if (prev) { prev.hits += 1; prev.score += score; }
        else agg.set(id, { id, score, hits: 1, boost: 0 });
      }
    }
    return [...agg.values()].sort((a, b) => a.score - b.score);
  }
}
