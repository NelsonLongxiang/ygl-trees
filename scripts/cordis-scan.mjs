#!/usr/bin/env node
/**
 * Cordis 应用情况扫描器（repo → sqlite 快照），供 `verify run` 当数据源使用。
 *
 * 为什么是独立脚本而不是 verify core 的一部分：verify 引擎只认「只读 SQLite 快照 + 谓词」，
 * 采集是工作区层的事——把扫描结果落成一张快照库，判定仍由冻结的 spec 完成（可复核、可重放）。
 *
 * 用法：
 *   node scripts/cordis-scan.mjs --out tmp/cordis-scan.sqlite [--root <repo>] [--json]
 *
 * 输出四张表（判定面）：
 *   cross_domain_imports(file, from_pkg, to_pkg, specifier, allowed)
 *   event_sites(file, api, detail)
 *   service_defs(file, class, ctx_key, has_declare_module)
 *   bare_event_inserts(file, line)
 * 外加 meta(key, value)：root/as_of/source_digest（报告 data_source 之外的自描述）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 域间直连白名单（冻结债务）：键 "from -> to"，值是为什么允许。
 * 不在表里的跨域 import 视为漂移——V1 断言其计数为 0。
 */
const ALLOWED_PAIRS = {
  "core/database -> research/pipeline": "ORM 实体注册表（AGENTS.md 明示：core 持有全实体清单）",
  "ops/tools -> research/pipeline": "ops 聚合面读研究域（命令行编排，非领域逻辑）",
  "ops/tools -> research/produce": "ops 聚合面读产出域",
  "ops/tools -> techtree/model": "ops 聚合面读树域",
  "ops/tools -> techtree/eval": "ops 聚合面读评估域（eval 服务化前的直连，0.86 起逐步收口）",
  "ops/tools -> web/app": "webui 宿主：ops 启动 WebAppService",
  "ops/tools -> verify/core": "verify 命令面接线",
  "knowledge/skills -> ops/tools": "技能命令面复用运维工具（历史直连）",
  "knowledge/skills -> research/pipeline": "技能命令面复用研究写入服务（历史直连）",
  "research/pipeline -> ops/tools": "研究域调用 eval-enhance（0.86 P0-1 服务化中的残留）",
  "research/produce -> ops/tools": "产出域调用 eval（同上）",
  "techtree/model -> ops/tools": "树域调用 eval（同上）",
};

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : true;
};
const ROOT = resolve(String(flag("root", process.cwd())));
const OUT = resolve(String(flag("out", join(ROOT, "tmp", "cordis-scan.sqlite"))));
const JSON_OUT = flag("json", false) === true;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "tests", "vendor", "tmp", ".git"].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 包身份：packages/<domain>/<module> 或 apps/<name>；不在 src/ 下的文件返回 null。 */
function packageOf(file) {
  const parts = relative(ROOT, file).split(sep);
  if (parts.includes("src") === false) return null;
  const i = parts.indexOf("packages");
  if (i >= 0 && parts[i + 2]) return `${parts[i + 1]}/${parts[i + 2]}`;
  const j = parts.indexOf("apps");
  if (j >= 0 && parts[j + 1]) return `apps/${parts[j + 1]}`;
  return null;
}

const files = [...walk(join(ROOT, "packages")), ...walk(join(ROOT, "apps"))].filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
const sourceDigest = createHash("sha256")
  .update(files.map((f) => `${relative(ROOT, f)}:${createHash("sha256").update(readFileSync(f)).digest("hex")}`).sort().join("\n"))
  .digest("hex");

const imports = [];
const eventSites = [];
const services = [];
const bareInserts = [];

const IMPORT_RE = /(?:from\s+|require\(\s*)["']([^"']+)["']/g;
const EVENT_RE = /\b(?:ctx\.on|ctx\.emit|onEvent|onEventKind|emitEvent)\s*\(/g;
const SERVICE_RE = /export\s+class\s+([A-Za-z0-9_]+)\s+extends\s+Service\b/g;
const CTX_KEY_RE = /interface\s+Context\s*\{([^}]*)\}/s;
const INSERT_RE = /INSERT\s+INTO\s+events\b/gi;

for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join("/");
  const src = readFileSync(file, "utf8");
  const from = packageOf(file);

  // 1) 跨域 import / require（只算相对路径；裸包名走 pnpm 依赖图，不在本表）
  if (from) {
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      const abs = resolve(dirname(file), spec);
      const to = packageOf(abs.endsWith(".ts") ? abs : `${abs}.ts`);
      if (!to || to === from) continue;
      const key = `${from} -> ${to}`;
      // 允许面：同域内模块互引、任何域 → core（共享基座）、apps/*（组合根）→ 任何包，
      // 以及下方 ALLOWED_PAIRS 里逐条写明理由的历史直连。其余 = 漂移。
      const sameDomain = from.split("/")[0] === to.split("/")[0];
      const allowed =
        sameDomain || to.startsWith("core/") || from.startsWith("apps/") ||
        Object.prototype.hasOwnProperty.call(ALLOWED_PAIRS, key)
          ? 1
          : 0;
      imports.push({ file: rel, from_pkg: from, to_pkg: to, specifier: spec, allowed });
    }
  }

  // 2) 事件面：监听/发射调用点（ctx.on / ctx.emit / onEvent / onEventKind / emitEvent）
  EVENT_RE.lastIndex = 0;
  let e;
  while ((e = EVENT_RE.exec(src))) {
    const before = src.slice(Math.max(0, e.index - 2), e.index + 12);
    if (before.trimStart().startsWith("*") || before.trimStart().startsWith("//")) continue; // 注释不算
    const call = e[0].replace(/[\s(]+$/, "");
    const line = src.slice(0, e.index).split("\n").length;
    eventSites.push({ file: rel, api: call, detail: `line ${line}` });
  }

  // 3) Cordis 服务定义 + 同文件是否声明了 ctx 合并（declare module）
  SERVICE_RE.lastIndex = 0;
  let s;
  const hasDeclare = /declare\s+module\s+["']@deepseek-ai\/cordis["']/.test(src);
  const ctxBlock = CTX_KEY_RE.exec(src)?.[1] ?? "";
  while ((s = SERVICE_RE.exec(src))) {
    const cls = s[1];
    const keyMatch = new RegExp(`${cls}\\b`).test(ctxBlock)
      ? (ctxBlock.match(new RegExp(`([A-Za-z0-9_]+)\\s*:\\s*${cls}\\b`))?.[1] ?? null)
      : null;
    services.push({ file: rel, class: cls, ctx_key: keyMatch, has_declare_module: hasDeclare ? 1 : 0 });
  }

  // 4) 事件表裸写：INSERT INTO events 只应出现在事件写入服务里
  INSERT_RE.lastIndex = 0;
  let ins;
  while ((ins = INSERT_RE.exec(src))) {
    bareInserts.push({ file: rel, line: src.slice(0, ins.index).split("\n").length });
  }
}

rmSync(OUT, { force: true });
mkdirSync(dirname(OUT), { recursive: true });
const db = new DatabaseSync(OUT);
db.exec(`
  CREATE TABLE cross_domain_imports(file TEXT, from_pkg TEXT, to_pkg TEXT, specifier TEXT, allowed INTEGER);
  CREATE TABLE event_sites(file TEXT, api TEXT, detail TEXT);
  CREATE TABLE service_defs(file TEXT, class TEXT, ctx_key TEXT, has_declare_module INTEGER);
  CREATE TABLE bare_event_inserts(file TEXT, line INTEGER);
  CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
`);
const insert = (table, cols, rows) => {
  const stmt = db.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`);
  db.exec("BEGIN");
  for (const row of rows) stmt.run(...cols.map((c) => row[c]));
  db.exec("COMMIT");
};
insert("cross_domain_imports", ["file", "from_pkg", "to_pkg", "specifier", "allowed"], imports);
insert("event_sites", ["file", "api", "detail"], eventSites);
insert("service_defs", ["file", "class", "ctx_key", "has_declare_module"], services);
insert("bare_event_inserts", ["file", "line"], bareInserts);
insert("meta", ["key", "value"], [
  { key: "root", value: ROOT },
  { key: "as_of", value: new Date().toISOString() },
  { key: "source_digest", value: sourceDigest },
  { key: "file_count", value: String(files.length) },
]);
const one = (sql) => db.prepare(sql).get()?.n ?? 0;
const summary = {
  out: OUT,
  as_of: new Date().toISOString(),
  source_digest: sourceDigest,
  files: files.length,
  cross_domain_imports: imports.length,
  cross_domain_unallowed: imports.filter((i) => !i.allowed).length,
  event_sites: eventSites.length,
  services: services.length,
  services_missing_declare: services.filter((s) => !s.has_declare_module || !s.ctx_key).length,
  bare_event_inserts: bareInserts.length,
  bare_insert_files: new Set(bareInserts.map((b) => b.file)).size,
  services_named: services.map((s) => `${s.class}:${s.ctx_key ?? "?"}`),
  unallowed_pairs: [...new Set(imports.filter((i) => !i.allowed).map((i) => `${i.from_pkg} -> ${i.to_pkg}`))],
  event_api_counts: eventSites.reduce((acc, x) => ({ ...acc, [x.api]: (acc[x.api] ?? 0) + 1 }), {}),
  table_counts: {
    cross_domain_imports: one("SELECT count(*) AS n FROM cross_domain_imports"),
    event_sites: one("SELECT count(*) AS n FROM event_sites"),
    service_defs: one("SELECT count(*) AS n FROM service_defs"),
    bare_event_inserts: one("SELECT count(*) AS n FROM bare_event_inserts"),
  },
};
db.close();

if (JSON_OUT) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`wrote ${relative(ROOT, OUT)} (${summary.files} source files, digest ${sourceDigest.slice(0, 12)}…)`);
  console.log(`  cross-domain imports ${summary.cross_domain_imports} (unallowed ${summary.cross_domain_unallowed})`);
  console.log(`  event sites ${summary.event_sites}  services ${summary.services} (missing declare ${summary.services_missing_declare})`);
  console.log(`  bare event inserts ${summary.bare_event_inserts} in ${summary.bare_insert_files} file(s)`);
  if (summary.unallowed_pairs.length) console.log(`  unallowed: ${summary.unallowed_pairs.join(", ")}`);
}
