#!/usr/bin/env node
/**
 * B2 schema parity gate — SCHEMA_SQL (SQLite) vs MIGRATE_DDL (PG) 列集逐表对账。
 *
 * 契约 v1.2 B2 / PG 方案 §5：两条 DDL 必须表达同一张表结构（列集）。
 * 本门禁只做**机械对账**（列名集合 + 每表存在性），不做类型映射检查——
 * 类型差异按方言映射表（text↔text / integer↔integer / REAL↔double precision）视为已知。
 *
 * 用法：
 *   node scripts/schema-parity.mjs            # 对账，非零退出=不一致
 *   node scripts/schema-parity.mjs --json     # 机器可读
 *   node scripts/schema-parity.mjs --selftest # 自测：删一列必红（防门禁腐化）
 *
 * 排除面：SQLite 专有对象（FTS 虚拟表及影子表）在 PG 无对应物——
 * 由 SQLITE_ONLY 白名单显式列出；白名单外缺表视为漂移。
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** SQLite 专有、PG 不镜像的表（FTS 虚拟表 + 影子 + 内部表）。 */
const SQLITE_ONLY = new Set([
  "fts_notes", "fts_notes_data", "fts_notes_idx", "fts_notes_content", "fts_notes_docsize", "fts_notes_config",
  "fts_skills", "fts_skills_data", "fts_skills_idx", "fts_skills_content", "fts_skills_docsize", "fts_skills_config",
  "fts_queries", "fts_queries_data", "fts_queries_idx", "fts_queries_content", "fts_queries_docsize", "fts_queries_config",
]);

/** 从 DDL 文本解析 table → Set<column>（支持多列同行/跨行）。 */
export function parseTables(ddl) {
  const out = new Map();
  // 先剥行内注释：注释里有逗号/括号，会污染列切分与语句边界
  const clean = ddl.split(String.fromCharCode(10)).map((l) => l.replace(/--.*$/, "")).join(String.fromCharCode(10));
  const re = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\)\s*;/gi;
  let m;
  while ((m = re.exec(clean))) {
    out.set(m[1].toLowerCase(), parseColumns(m[2]));
  }
  return out;
}

/** 顶层逗号切分表体 → 列名集合（跳过表级约束；括号内逗号不切）。 */
export function parseColumns(body) {
  const cols = new Set();
  // 先剥行内注释（注释里的逗号/括号会污染切分）——对直接调用同样生效
  body = body.split(String.fromCharCode(10)).map((l) => l.replace(/--.*$/, "")).join(String.fromCharCode(10));
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  for (const rawPart of parts) {
    // 去行内注释（`-- L1: always in context` 里的词不能被当成列名）
    const part = rawPart.replace(/--[^\n]*/g, "").trim();
    if (!part) continue;
    if (/^(UNIQUE|PRIMARY|FOREIGN|CHECK|CONSTRAINT)\b/i.test(part)) continue;
    const colMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s+/.exec(part);
    if (!colMatch) continue;
    cols.add(colMatch[1].toLowerCase());
  }
  return cols;
}

export function loadSqliteDdl() {
  const dbSrc = readFileSync(resolve(ROOT, "packages/core/database/src/db.ts"), "utf8");
  const m = /export const SCHEMA_SQL\s*=\s*`([\s\S]*?)`;/.exec(dbSrc);
  if (!m) throw new Error("schema-parity: cannot locate SCHEMA_SQL in packages/core/database/src/db.ts");
  return m[1];
}

export function loadPgDdl() {
  const pgSrc = readFileSync(resolve(ROOT, "packages/ops/tools/src/pgsync.ts"), "utf8");
  const m = /const MIGRATE_DDL\s*=\s*`([\s\S]*?)`;/.exec(pgSrc);
  if (!m) throw new Error("schema-parity: cannot locate MIGRATE_DDL in packages/ops/tools/src/pgsync.ts");
  return m[1];
}

/** 纯对账（可注入 DDL 供自测）：返回 { rows, problems }。 */
export function compare(sqliteDdl, pgDdl, opts = {}) {
  const sqliteOnly = opts.sqliteOnly ?? SQLITE_ONLY;
  const sqlite = parseTables(sqliteDdl);
  const pg = parseTables(pgDdl);
  const problems = [];
  const rows = [];
  const sqliteTables = [...sqlite.keys()].filter((t) => !sqliteOnly.has(t)).sort();
  const pgTables = [...pg.keys()].sort();
  for (const t of sqliteTables) {
    if (!pg.has(t)) { problems.push(`table missing in MIGRATE_DDL: ${t}`); rows.push({ table: t, status: "missing-pg" }); continue; }
    const a = sqlite.get(t);
    const b = pg.get(t);
    const onlySqlite = [...a].filter((c) => !b.has(c)).sort();
    const onlyPg = [...b].filter((c) => !a.has(c)).sort();
    if (onlySqlite.length || onlyPg.length) {
      problems.push(`${t}: column set differs — only sqlite [${onlySqlite.join(",")}]; only pg [${onlyPg.join(",")}]`);
      rows.push({ table: t, status: "drift", onlySqlite, onlyPg });
    } else {
      rows.push({ table: t, status: "ok", columns: a.size });
    }
  }
  for (const t of pgTables) {
    if (!sqlite.has(t)) { problems.push(`table missing in SCHEMA_SQL: ${t}`); rows.push({ table: t, status: "missing-sqlite" }); }
  }
  return { rows, problems, sqliteTables: sqliteTables.length, pgTables: pgTables.length };
}

// ── 自测：删一列必红（防门禁自身腐化；schema-parity.spec 调用） ──
if (process.argv.includes("--selftest")) {
  const sqliteDdl = "CREATE TABLE t (a text PRIMARY KEY, b text NOT NULL, c integer DEFAULT 0);";
  const pgOk = "CREATE TABLE t (a text PRIMARY KEY, b text NOT NULL, c integer DEFAULT 0);";
  const pgMissing = "CREATE TABLE t (a text PRIMARY KEY, b text NOT NULL);";
  const okRes = compare(sqliteDdl, pgOk, { sqliteOnly: new Set() });
  const badRes = compare(sqliteDdl, pgMissing, { sqliteOnly: new Set() });
  const pass = okRes.problems.length === 0 && badRes.problems.length === 1 && /only sqlite \[c\]/.test(badRes.problems[0]);
  console.log(JSON.stringify({ selftest: pass ? "PASS" : "FAIL", okProblems: okRes.problems, badProblems: badRes.problems }));
  process.exit(pass ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith("schema-parity.mjs")) {
  const result = compare(loadSqliteDdl(), loadPgDdl());
  const json = process.argv.includes("--json");
  if (json) {
    console.log(JSON.stringify({ ok: result.problems.length === 0, sqliteTables: result.sqliteTables, pgTables: result.pgTables, excluded: SQLITE_ONLY.size, rows: result.rows, problems: result.problems }, null, 2));
  } else {
    console.log(`schema-parity: ${result.sqliteTables} sqlite table(s) vs ${result.pgTables} pg table(s) (${SQLITE_ONLY.size} sqlite-only excluded)`);
    for (const r of result.rows) {
      if (r.status === "ok") console.log(`  ✓ ${r.table} (${r.columns} cols)`);
      else if (r.status === "drift") console.log(`  ✗ ${r.table}: only-sqlite [${r.onlySqlite.join(",")}] only-pg [${r.onlyPg.join(",")}]`);
      else console.log(`  ✗ ${r.table}: ${r.status}`);
    }
    if (result.problems.length) {
      console.error(`schema-parity: ${result.problems.length} mismatch(es) — SCHEMA_SQL 与 MIGRATE_DDL 列集必须一致（B2）`);
      for (const p of result.problems) console.error(`  · ${p}`);
    } else {
      console.log("schema-parity: OK — column sets match");
    }
  }
  process.exit(result.problems.length ? 1 : 0);
}
