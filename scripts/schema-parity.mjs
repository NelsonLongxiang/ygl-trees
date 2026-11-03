#!/usr/bin/env node
/**
 * B2 schema parity gate — SCHEMA_SQL (SQLite) vs MIGRATE_DDL + MIGRATE_INDEXES (PG) 逐表对账。
 *
 * 契约 v1.2 B2 / PG 方案 §5：两条 DDL 必须表达同一张表结构。两层检查：
 *  ① 列集 + 每表存在性（compare，原 B2 门禁）；
 *  ② 结构（compareStructure，#176 W5a）：类型类、NOT NULL、DEFAULT、主键、外键（含 ON DELETE）、
 *     唯一约束（表内 UNIQUE / 列级 UNIQUE / UNIQUE INDEX 归一）与普通索引（表 + 列序）。
 *     类型按方言映射归一（INTEGER↔bigint、REAL↔double precision 同类）；方言上不可能一致的差异
 *     逐条登记在 DIALECT_EXCEPTIONS 并写理由，登记项失效同样判红。
 *
 * 用法：
 *   node scripts/schema-parity.mjs            # 对账，非零退出=不一致
 *   node scripts/schema-parity.mjs --json     # 机器可读
 *   node scripts/schema-parity.mjs --selftest # 自测：删一列、改约束、删索引都必红（防门禁腐化）
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

/** PG 侧普通索引（MIGRATE_INDEXES，migrate 时紧随 MIGRATE_DDL 执行）。结构对账把两段拼起来看。 */
export function loadPgIndexes() {
  const pgSrc = readFileSync(resolve(ROOT, "packages/ops/tools/src/pgsync.ts"), "utf8");
  const m = /const MIGRATE_INDEXES\s*=\s*`([\s\S]*?)`;/.exec(pgSrc);
  if (!m) throw new Error("schema-parity: cannot locate MIGRATE_INDEXES in packages/ops/tools/src/pgsync.ts");
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

// ── W5a（#176）结构对账：列集之外再比类型类、NOT NULL、DEFAULT、主键、外键、唯一约束与普通索引 ──
//
// 类型按方言映射归一成类（text / integer / real / blob）：INTEGER↔bigint、REAL↔double precision 视为同类。
// 唯一约束不看写法：表内 UNIQUE(...)、列级 UNIQUE 与 CREATE UNIQUE INDEX 归一成同一个键集合。
// 索引只比 (表, 列序)，不比索引名。方言上不可能一致的差异必须登记在 DIALECT_EXCEPTIONS 里并写明理由；
// 登记项若已不再出现，也判红（防止豁免表腐化成永久白名单）。

/** 已登记的方言差异：key 与 structuralDiffs 的输出逐字相同。 */
export const DIALECT_EXCEPTIONS = new Map([
  [
    "events.seq: default sqlite=null pg=nextval('events_seq')",
    "PG 原生写入靠 events_seq 序列给出单调序；SQLite 侧 seq 恒为 NULL，rowid 本身就是顺序（v10/PG-A④）",
  ],
]);

const stripComments = (s) => s.split(String.fromCharCode(10)).map((l) => l.replace(/--.*$/, "")).join(String.fromCharCode(10));
const keyOf = (s) => s.split(",").map((c) => c.trim().toLowerCase().replace(/"/g, "")).join(",");

function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

export function typeClass(raw) {
  const t = String(raw ?? "").toLowerCase();
  if (/^(text|varchar|char|character)/.test(t)) return "text";
  if (/^(integer|int|bigint|smallint)/.test(t)) return "integer";
  if (/^(real|double|float|numeric|decimal)/.test(t)) return "real";
  if (/^(blob|bytea)/.test(t)) return "blob";
  return t || "none";
}

/** DDL 文本 → Map<table, { pk, cols: Map<col,{type,notnull,default,ref}>, uniques:Set, indexes:Set }>。FTS 虚拟表跳过。 */
export function parseStructure(ddl) {
  const s = stripComments(ddl);
  const tables = new Map();
  const tableRe = /CREATE\s+(VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:USING\s+\w+\s*)?\(([\s\S]*?)\)\s*;/gi;
  let m;
  while ((m = tableRe.exec(s))) {
    if (m[1]) continue;
    const t = { pk: "", cols: new Map(), uniques: new Set(), indexes: new Set() };
    for (const part of splitTopLevel(m[3])) {
      let k;
      if ((k = /^UNIQUE\s*\(([^)]*)\)/i.exec(part))) { t.uniques.add(keyOf(k[1])); continue; }
      if ((k = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(part))) { t.pk = keyOf(k[1]); continue; }
      if (/^(FOREIGN|CHECK|CONSTRAINT)\b/i.test(part)) continue;
      const cm = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z]+(?:\s+precision)?)?([\s\S]*)$/i.exec(part);
      if (!cm) continue;
      const name = cm[1].toLowerCase();
      const rest = cm[3] ?? "";
      const pk = /PRIMARY\s+KEY/i.test(rest);
      if (pk) t.pk = name;
      if (/\bUNIQUE\b/i.test(rest)) t.uniques.add(name);
      const def = /DEFAULT\s+(\([^)]*\)|'[^']*'|nextval\([^)]*\)|[^\s,]+)/i.exec(rest);
      const ref = /REFERENCES\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)((?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION))*)/i.exec(rest);
      t.cols.set(name, {
        type: typeClass(cm[2]),
        notnull: pk || /NOT\s+NULL/i.test(rest),
        default: def ? def[1].replace(/^\((.*)\)$/, "$1").toLowerCase() : null,
        ref: ref ? `${ref[1].toLowerCase()}(${keyOf(ref[2])})${ref[3].replace(/\s+/g, " ").toLowerCase()}` : null,
      });
    }
    tables.set(m[2].toLowerCase(), t);
  }
  const indexRe = /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[A-Za-z_][A-Za-z0-9_]*\s+ON\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/gi;
  while ((m = indexRe.exec(s))) {
    const t = tables.get(m[2].toLowerCase());
    if (t) (m[1] ? t.uniques : t.indexes).add(keyOf(m[3]));
  }
  return tables;
}

/** 两侧结构的全部差异（未过滤豁免），每条一行、可逐字登记。只比两侧都有的表（存在性由 compare 负责）。 */
export function structuralDiffs(sqliteDdl, pgDdl, opts = {}) {
  const sqliteOnly = opts.sqliteOnly ?? SQLITE_ONLY;
  const a = parseStructure(sqliteDdl);
  const b = parseStructure(pgDdl);
  const out = [];
  for (const [name, x] of a) {
    const y = b.get(name);
    if (!y || sqliteOnly.has(name)) continue;
    if (x.pk !== y.pk) out.push(`${name}: primary key sqlite=(${x.pk}) pg=(${y.pk})`);
    for (const [col, cx] of x.cols) {
      const cy = y.cols.get(col);
      if (!cy) continue;
      for (const f of ["type", "notnull", "default", "ref"]) {
        if (String(cx[f]) !== String(cy[f])) out.push(`${name}.${col}: ${f} sqlite=${cx[f]} pg=${cy[f]}`);
      }
    }
    for (const u of x.uniques) if (!y.uniques.has(u)) out.push(`${name}: unique (${u}) missing in pg`);
    for (const u of y.uniques) if (!x.uniques.has(u)) out.push(`${name}: unique (${u}) missing in sqlite`);
    for (const i of x.indexes) if (!y.indexes.has(i)) out.push(`${name}: index (${i}) missing in pg`);
    for (const i of y.indexes) if (!x.indexes.has(i)) out.push(`${name}: index (${i}) missing in sqlite`);
  }
  return out;
}

/** 结构门禁：未登记的差异 + 已失效的登记项都算问题。 */
export function compareStructure(sqliteDdl, pgDdl, opts = {}) {
  const exceptions = opts.exceptions ?? DIALECT_EXCEPTIONS;
  const diffs = structuralDiffs(sqliteDdl, pgDdl, opts);
  const problems = diffs.filter((d) => !exceptions.has(d));
  for (const key of exceptions.keys()) {
    if (!diffs.includes(key)) problems.push(`stale dialect exception (no longer observed, remove it): ${key}`);
  }
  return { diffs, problems, excepted: diffs.filter((d) => exceptions.has(d)) };
}

// ── 自测：删一列必红（防门禁自身腐化；schema-parity.spec 调用） ──
if (process.argv.includes("--selftest")) {
  const sqliteDdl = "CREATE TABLE t (a text PRIMARY KEY, b text NOT NULL, c integer DEFAULT 0);";
  const pgOk = "CREATE TABLE t (a text PRIMARY KEY, b text NOT NULL, c integer DEFAULT 0);";
  const pgMissing = "CREATE TABLE t (a text PRIMARY KEY, b text NOT NULL);";
  const okRes = compare(sqliteDdl, pgOk, { sqliteOnly: new Set() });
  const badRes = compare(sqliteDdl, pgMissing, { sqliteOnly: new Set() });
  const columnsPass = okRes.problems.length === 0 && badRes.problems.length === 1 && /only sqlite \[c\]/.test(badRes.problems[0]);
  // W5a：每种结构变异都必须单独判红
  const base = "CREATE TABLE p (id text PRIMARY KEY); CREATE TABLE t (a text PRIMARY KEY, b text NOT NULL REFERENCES p(id) ON DELETE CASCADE, c integer DEFAULT 0, UNIQUE(b, c)); CREATE INDEX i ON t(c);";
  const mutations = {
    "not null": base.replace("b text NOT NULL", "b text"),
    default: base.replace("DEFAULT 0", "DEFAULT 1"),
    type: base.replace("c integer", "c text"),
    "foreign key": base.replace(" ON DELETE CASCADE", ""),
    unique: base.replace(", UNIQUE(b, c)", ""),
    index: base.replace(" CREATE INDEX i ON t(c);", ""),
  };
  const noExceptions = { sqliteOnly: new Set(), exceptions: new Map() };
  const structureOk = compareStructure(base, base, noExceptions).problems.length === 0;
  const mutationResults = Object.fromEntries(Object.entries(mutations).map(([k, pgDdl]) => [k, compareStructure(base, pgDdl, noExceptions).problems.length]));
  const pass = columnsPass && structureOk && Object.values(mutationResults).every((n) => n > 0);
  console.log(JSON.stringify({ selftest: pass ? "PASS" : "FAIL", okProblems: okRes.problems, badProblems: badRes.problems, structureOk, mutations: mutationResults }));
  process.exit(pass ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith("schema-parity.mjs")) {
  const result = compare(loadSqliteDdl(), loadPgDdl());
  const structure = compareStructure(loadSqliteDdl(), loadPgDdl() + loadPgIndexes());
  const problems = [...result.problems, ...structure.problems];
  const json = process.argv.includes("--json");
  if (json) {
    console.log(JSON.stringify({ ok: problems.length === 0, sqliteTables: result.sqliteTables, pgTables: result.pgTables, excluded: SQLITE_ONLY.size, rows: result.rows, structure: { excepted: structure.excepted.map((d) => ({ diff: d, reason: DIALECT_EXCEPTIONS.get(d) })), problems: structure.problems }, problems }, null, 2));
  } else {
    console.log(`schema-parity: ${result.sqliteTables} sqlite table(s) vs ${result.pgTables} pg table(s) (${SQLITE_ONLY.size} sqlite-only excluded)`);
    for (const r of result.rows) {
      if (r.status === "ok") console.log(`  ✓ ${r.table} (${r.columns} cols)`);
      else if (r.status === "drift") console.log(`  ✗ ${r.table}: only-sqlite [${r.onlySqlite.join(",")}] only-pg [${r.onlyPg.join(",")}]`);
      else console.log(`  ✗ ${r.table}: ${r.status}`);
    }
    for (const d of structure.excepted) console.log(`  ~ ${d}  [dialect exception: ${DIALECT_EXCEPTIONS.get(d)}]`);
    if (problems.length) {
      console.error(`schema-parity: ${problems.length} mismatch(es) — SCHEMA_SQL 与 MIGRATE_DDL/MIGRATE_INDEXES 的列集与结构必须一致（B2 / #176 W5a）`);
      for (const p of problems) console.error(`  · ${p}`);
    } else {
      console.log(`schema-parity: OK — column sets and structure match (${structure.excepted.length} registered dialect exception(s))`);
    }
  }
  process.exit(problems.length ? 1 : 0);
}
