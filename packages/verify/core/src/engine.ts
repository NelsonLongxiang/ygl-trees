/**
 * verify 引擎（M13-1 参考实现）：约定 → 管线 → 检查器 → 报告。
 *
 * 纪律（对应 docs/spec-validator.md）：
 * - fact 层七型（agent 除外）确定性执行，证据 canonical 排序；
 * - scope witness 强制：rows_scanned=0 → NEEDS-MATERIAL（绝不落 PASS）；
 * - overall 折叠 FAIL > NEEDS-MATERIAL > ERROR > PASS，只算 role=assert；
 * - 报告 rc 由调用方决定：引擎只产报告，不决定退出码。
 */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { compareValues, validateCompareSpec } from "./compare";
import type {
  Checker,
  FactCheckerType,
  CompareSpec,
  ScopeWitness,
  Severity,
  Verdict,
  VerifyReport,
  VerifySpec,
  VerifyUnit,
  VuResult,
} from "./contract";

export type Row = Record<string, unknown>;

export interface QueryRunner {
  query(sql: string): Row[];
  /** 源表指纹：表名 → 行数（同时用于 witness 与 schema 漂移检测） */
  tableRows(table: string): number;
  schemaFingerprint(): string;
  sourceTables?: (sql: string) => string[];
}

export interface VerifyOptions {
  runner: QueryRunner;
  /** 提交物根目录（file 型）与 program 执行 cwd */
  submissionDir?: string;
  /** 允许执行的 command argv[0] 白名单；未给则 command 型返回 ERROR */
  commandAllowlist?: string[];
  /** review 层执行器（agent 型）；缺省 = fact-only，agent 型给 ERROR */
  reviewRunner?: (vu: VerifyUnit, submissionDir?: string) => Promise<{ pass: boolean; evidence: Record<string, unknown>; needsMaterial?: boolean }>;
  nowIso?: () => string;
  engineVersion?: string;
  mode?: "sealed" | "open";
  binarySha256?: string;
}

const EMPTY_SCHEMA = "sha256:unknown";

function rowsScannedFromSql(runner: QueryRunner, sql: string): { scanned: number; sources: Array<{ table: string; rows: number }> } {
  const tables = runner.sourceTables ? runner.sourceTables(sql) : extractTables(sql);
  const sources = tables.map((t) => {
    try {
      return { table: t, rows: runner.tableRows(t) };
    } catch {
      return { table: t, rows: -1 };
    }
  });
  const scanned = sources.reduce((acc, s) => acc + Math.max(0, s.rows), 0);
  return { scanned, sources };
}

/** 粗提取 SQL 源表（FROM/JOIN）——witness 用；解析失败不阻断执行。 */
export function extractTables(sql: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.add(m[1]);
  return [...out];
}

function canonicalRows(rows: Row[], keyFields: string[]): Row[] {
  const keyed = rows.map((r) => ({ r, k: keyFields.map((f) => String(r[f])).join("\u0000") }));
  keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return keyed.map((x) => x.r);
}

function witness(scanned: number, matched: number, sources: Array<{ table: string; rows: number }>, fingerprint: string): ScopeWitness {
  return { rows_scanned: scanned, rows_matched: matched, sources, schema_fingerprint: fingerprint };
}

async function runFactChecker(
  vu: VerifyUnit,
  opts: VerifyOptions,
  outputs: Map<string, Row[]>,
): Promise<{ verdict: Verdict; witness?: ScopeWitness; evidence?: Record<string, unknown>; guard?: string[] }> {
  const c: Checker = vu.checker;
  const runner = opts.runner;
  const fingerprint = (() => {
    try {
      return runner.schemaFingerprint();
    } catch {
      return EMPTY_SCHEMA;
    }
  })();

  switch (c.type) {
    case "sql": {
      const failWhen = c.fail_when ?? "rows>0";
      // 构造守卫（r3 意见 2）：找违规型必须能证明扫的是本批范围——
      // 要么给 scope_sql，要么 sql 自带 WHERE（否则「整表非空」冒充「扫过本批」）。
      const sqlNoComments = c.sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
      if (failWhen === "rows>0" && !c.scope_sql && !/\bwhere\b/i.test(sqlNoComments)) {
        return { verdict: "ERROR", evidence: { reason: "find-violation sql has no WHERE and no scope_sql — cannot prove the scan covers the intended batch (vacuous-pass risk)" } };
      }
      const rows = runner.query(c.sql);
      let scanned: number;
      let sources: Array<{ table: string; rows: number }>;
      if (c.scope_sql) {
        // N1：scope_sql 必须是「单行单列整数」的扫描面行数；多行/多列/非整数一律 ERROR
        // （否则 Number('INV-1') = NaN 会以 NaN witness 参与判定，JSON 序列化后变 null）。
        try {
          const scopeRows = runner.query(c.scope_sql);
          if (scopeRows.length !== 1) {
            return { verdict: "ERROR", evidence: { reason: `scope_sql must return exactly one row (got ${scopeRows.length}); return a single count(*)` } };
          }
          const cols = Object.values(scopeRows[0]);
          if (cols.length !== 1) {
            return { verdict: "ERROR", evidence: { reason: `scope_sql must return exactly one column (got ${cols.length})` } };
          }
          const n = Number(cols[0]);
          if (!Number.isInteger(n) || n < 0) {
            return { verdict: "ERROR", evidence: { reason: `scope_sql must return a non-negative integer row count (got ${JSON.stringify(cols[0])})` } };
          }
          scanned = n;
        } catch (e) {
          return { verdict: "ERROR", evidence: { reason: `scope_sql failed: ${(e as Error).message}` } };
        }
        sources = rowsScannedFromSql(runner, c.sql).sources;
      } else {
        const scope = rowsScannedFromSql(runner, c.sql);
        scanned = scope.scanned;
        sources = scope.sources;
      }
      const w = witness(scanned, rows.length, sources, fingerprint);
      if (scanned === 0) return { verdict: "NEEDS-MATERIAL", witness: w, evidence: { reason: "zero rows scanned — wrong table or empty data" } };
      const violations = failWhen === "rows>0" ? rows.length : rows.length === 0 ? 1 : 0;
      const sorted = canonicalRows(rows, Object.keys(rows[0] ?? {}).slice(0, 1));
      if (violations > 0) {
        return { verdict: "FAIL", witness: w, evidence: { violations, rows: sorted.slice(0, 5), rows_total: rows.length } };
      }
      return { verdict: "PASS", witness: w, evidence: { rows: rows.length } };
    }
    case "sql-pair": {
      const readSide = (side: typeof c.left): Row[] => {
        if ("from" in side) {
          const ref = refId(side.from);
          const rows = outputs.get(ref);
          if (!rows) throw new Error(`pipeline reference ${side.from} is not available (topological order violated)`);
          return rows;
        }
        return runner.query(`SELECT ${side.key}, ${side.value} FROM ${side.table}`);
      };
      const compareSpec: CompareSpec = c.compare;
      const specErrs = validateCompareSpec(compareSpec);
      if (specErrs.length) return { verdict: "ERROR", evidence: { reason: `invalid compare spec: ${specErrs.join("; ")}` } };
      let left: Row[];
      let right: Row[];
      try {
        left = readSide(c.left);
        right = readSide(c.right);
      } catch (e) {
        return { verdict: "ERROR", evidence: { reason: (e as Error).message } };
      }
      const lk = (c.left as { key: string }).key;
      const lv = (c.left as { value: string }).value;
      const rk = (c.right as { key: string }).key;
      const rv = (c.right as { value: string }).value;
      const card = compareSpec.cardinality ?? "1:1";
      const agg = compareSpec.agg;
      const group = (rows: Row[], key: string, value: string) => {
        const m = new Map<string, unknown[]>();
        for (const r of rows) {
          const k = String(r[key]);
          const arr = m.get(k) ?? [];
          arr.push(r[value]);
          m.set(k, arr);
        }
        return m;
      };
      const leftMap = group(left, lk, lv);
      const rightMap = group(right, rk, rv);
      // 基数守卫：重复键默认 ERROR（1:N 需显式 agg）
      if (card === "1:1") {
        for (const [side, map] of [["left", leftMap], ["right", rightMap]] as const) {
          for (const [k, vals] of map) {
            if (vals.length > 1) {
              return { verdict: "ERROR", evidence: { reason: `duplicate key ${k} on ${side} (${vals.length} rows) under cardinality 1:1 — declare 1:N + agg if fan-out is expected` } };
            }
          }
        }
      }
      const reduce = (vals: unknown[]): unknown => {
        if (vals.length === 1) return vals[0];
        const nums = vals.map((v) => (typeof v === "number" ? v : Number(v))).filter((n) => Number.isFinite(n));
        if (nums.length !== vals.length) return undefined;
        if (agg === "sum") return nums.reduce((a, b) => a + b, 0);
        if (agg === "max") return Math.max(...nums);
        if (agg === "min") return Math.min(...nums);
        return vals[0];
      };
      const keys = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort();
      const violations: Array<Record<string, unknown>> = [];
      let compared = 0;
      for (const k of keys) {
        const lvals = leftMap.get(k);
        const rvals = rightMap.get(k);
        if (!lvals || !rvals) {
          violations.push({ key: k, left: lvals ? reduce(lvals) : null, right: rvals ? reduce(rvals) : null, diff: "missing-side" });
          continue;
        }
        compared++;
        const l = reduce(lvals);
        const r = reduce(rvals);
        const outcome = compareValues(l, r, compareSpec);
        if ("error" in outcome) {
          violations.push({ key: k, left: l, right: r, diff: outcome.error });
          continue;
        }
        if (!outcome.equal) {
          const ln = typeof l === "number" ? l : Number(l);
          const rn = typeof r === "number" ? r : Number(r);
          violations.push({ key: k, left: l, right: r, diff: Number.isFinite(ln) && Number.isFinite(rn) ? Number((ln - rn).toFixed(6)) : "mismatch" });
        }
      }
      const tableSides: string[] = [];
      for (const side of [c.left, c.right]) {
        if ("table" in side) tableSides.push(side.table);
      }
      const sources = tableSides.map((t) => {
        try {
          return { table: t, rows: runner.tableRows(t) };
        } catch {
          return { table: t, rows: -1 };
        }
      });
      // matched = 违规对数（与契约示例 rows_matched=3 对齐，r3 意见 1）
      const w = witness(keys.length, violations.length, sources, fingerprint);
      if (keys.length === 0) return { verdict: "NEEDS-MATERIAL", witness: w, evidence: { reason: "no keys to compare — empty source" } };
      if (violations.length > 0) {
        return { verdict: "FAIL", witness: w, evidence: { violations: violations.length, compared, rows: violations.slice(0, 5) } };
      }
      return { verdict: "PASS", witness: w, evidence: { compared } };
    }
    case "count": {
      if (c.from !== undefined && c.sql !== undefined) {
        return { verdict: "ERROR", evidence: { reason: "count checker declares both from and sql (must be exactly one)" } };
      }
      let n: number;
      let scanned: number;
      let sources: Array<{ table: string; rows: number }> = [];
      if (c.from !== undefined) {
        const ref = refId(c.from);
        const upstream = outputs.get(ref);
        if (!upstream) {
          return { verdict: "ERROR", evidence: { reason: `count from ${c.from} is not available (topological order violated)` } };
        }
        n = upstream.length;
        scanned = upstream.length;
      } else if (c.sql !== undefined) {
        const rows = runner.query(c.sql);
        if (rows.length > 1 || (rows.length === 1 && Object.keys(rows[0]).length !== 1)) {
          return { verdict: "ERROR", evidence: { reason: "count.sql must return exactly one row and one column" } };
        }
        n = rows.length > 0 ? Number(Object.values(rows[0])[0]) : 0;
        const scope = rowsScannedFromSql(runner, c.sql);
        scanned = scope.scanned;
        sources = scope.sources;
      } else {
        return { verdict: "ERROR", evidence: { reason: "count checker requires from ($Vx) or sql" } };
      }
      if (!Number.isFinite(n)) return { verdict: "ERROR", evidence: { reason: "count query did not return a number" } };
      const pass =
        c.op === ">=" ? n >= c.value : c.op === "<=" ? n <= c.value : c.op === "==" ? n === c.value : c.op === "!=" ? n !== c.value : c.op === ">" ? n > c.value : n < c.value;
      return { verdict: pass ? "PASS" : "FAIL", witness: witness(scanned, n, sources, fingerprint), evidence: { count: n, op: c.op, expected: c.value } };
    }
    case "exists": {
      const rows = runner.query(c.sql);
      const present = rows.length > 0;
      const { scanned, sources } = rowsScannedFromSql(runner, c.sql);
      return { verdict: present === c.expect ? "PASS" : "FAIL", witness: witness(scanned, rows.length, sources, fingerprint), evidence: { present, expect: c.expect } };
    }
    case "file": {
      const dir = opts.submissionDir;
      if (!dir) return { verdict: "ERROR", evidence: { reason: "file checker requires --attachments <dir>" } };
      if (c.glob === "*" || c.glob === "**" || c.glob === "**/*") {
        return { verdict: "ERROR", evidence: { reason: 'glob "*" matches everything and proves nothing — construct rejected' } };
      }
      const all = walk(dir);
      const re = globToRegExp(c.glob);
      const matched = all.filter((p) => re.test(relative(dir, p).split("\\").join("/")));
      const w = witness(all.length, matched.length, [], fingerprint);
      const problems: string[] = [];
      if (c.min !== undefined && matched.length < c.min) problems.push(`expected >=${c.min} files, got ${matched.length}`);
      if (c.max !== undefined && matched.length > c.max) problems.push(`expected <=${c.max} files, got ${matched.length}`);
      for (const must of c.require ?? []) {
        if (!all.some((p) => basename(p) === must)) problems.push(`required file missing: ${must}`);
      }
      for (const [rel, want] of Object.entries(c.sha256 ?? {})) {
        const full = join(dir, rel);
        try {
          const got = createHash("sha256").update(readFileSync(full)).digest("hex");
          if (got !== want) problems.push(`sha256 mismatch: ${rel}`);
        } catch {
          problems.push(`file not readable: ${rel}`);
        }
      }
      if (all.length === 0) return { verdict: "NEEDS-MATERIAL", witness: w, evidence: { reason: "submission directory is empty" } };
      return { verdict: problems.length ? "FAIL" : "PASS", witness: w, evidence: { files: all.length, matched: matched.length, problems: problems.slice(0, 5) } };
    }
    case "command": {
      const allow = opts.commandAllowlist;
      if (!allow || allow.length === 0) {
        return { verdict: "ERROR", evidence: { reason: "command checker requires an explicit argv[0] allowlist (sealed builds reject specs with commands otherwise)" } };
      }
      if (!allow.includes(c.argv[0])) return { verdict: "ERROR", evidence: { reason: `command not in allowlist: ${c.argv[0]}` } };
      const res = spawnSync(c.argv[0], c.argv.slice(1), { cwd: opts.submissionDir, encoding: "utf8", timeout: 30_000 });
      const exit = res.status ?? -1;
      const stdout = (res.stdout ?? "").trim();
      const expectExit = c.expect_exit ?? 0;
      let pass = exit === expectExit;
      if (pass && c.stdout_matches && !new RegExp(c.stdout_matches).test(stdout)) pass = false;
      return { verdict: pass ? "PASS" : "FAIL", evidence: { exit, expected_exit: expectExit, stdout: stdout.slice(0, 2000) } };
    }
    case "agent": {
      if (!opts.reviewRunner) {
        return { verdict: "ERROR", evidence: { reason: "review layer not available in fact-only mode (sealed build without --with-review)" } };
      }
      try {
        const r = await opts.reviewRunner(vu, opts.submissionDir);
        if (r.needsMaterial) return { verdict: "NEEDS-MATERIAL", evidence: r.evidence };
        return { verdict: r.pass ? "PASS" : "FAIL", evidence: r.evidence };
      } catch (e) {
        return { verdict: "ERROR", evidence: { reason: (e as Error).message } };
      }
    }
    default:
      return { verdict: "ERROR", evidence: { reason: `unknown checker type: ${String((c as { type?: string }).type)}` } };
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) visit(p);
      else out.push(p);
    }
  };
  visit(dir);
  return out.sort();
}

function globToRegExp(glob: string): RegExp {
  // N7：尾 `a/**` 也匹配（此前只处理了 `**/` 前缀形态）
  const trailingAny = glob.endsWith("/**");
  const base = trailingAny ? glob.slice(0, -3) : glob;
  let body = base
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000") // `**/` 可匹配零层目录（r3 意见 d）
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .split("\u0000")
    .join("(?:.*/)?");
  if (trailingAny) body += "(?:/.*)?";
  return new RegExp(`^${body}$`);
}

/** 从 VU 的 checker JSON 中提取 $Vx 引用（管线依赖）。 */
export function refsOf(c: Checker): string[] {
  const refs = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      // 命名空间 `$vu:V1`（r3 意见 b）：避免把 PG 占位符 $1/$$、金额 $50 误认成管线引用。
      const re = /\$vu:([A-Za-z0-9_-]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(v))) refs.add(m[1]);
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(visit);
    }
  };
  visit(c);
  return [...refs];
}

/** 拓扑排序 + 环检测（评审 §5.5；环=ERROR 整 spec）。 */
export function topoOrder(vu: VerifyUnit[]): { order: VerifyUnit[] } | { cycle: string[] } {
  const byId = new Map(vu.map((v) => [v.id, v]));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const v of vu) {
    indeg.set(v.id, 0);
    adj.set(v.id, []);
  }
  for (const v of vu) {
    for (const ref of refsOf(v.checker)) {
      if (!byId.has(ref)) throw new Error(`${v.id} references unknown unit $${ref}`);
      indeg.set(v.id, (indeg.get(v.id) ?? 0) + 1);
      adj.get(ref)!.push(v.id);
    }
  }
  const queue = [...vu.filter((v) => (indeg.get(v.id) ?? 0) === 0).map((v) => v.id)].sort();
  const order: VerifyUnit[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 1) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
    queue.sort();
  }
  if (order.length !== vu.length) {
    return { cycle: [...indeg.entries()].filter(([, d]) => d > 0).map(([id]) => id).sort() };
  }
  return { order };
}

export function foldOverall(results: VuResult[]): { overall: Verdict; reason: string } {
  const asserts = results.filter((r) => r.role === "assert");
  if (asserts.some((r) => r.verdict === "FAIL")) {
    const ids = asserts.filter((r) => r.verdict === "FAIL").map((r) => `${r.id}(${r.severity})`);
    return { overall: "FAIL", reason: `${ids.join(", ")} FAIL` };
  }
  if (asserts.some((r) => r.verdict === "NEEDS-MATERIAL")) {
    const ids = asserts.filter((r) => r.verdict === "NEEDS-MATERIAL").map((r) => r.id);
    return { overall: "NEEDS-MATERIAL", reason: `${ids.join(", ")} need material` };
  }
  if (asserts.some((r) => r.verdict === "ERROR")) {
    const ids = asserts.filter((r) => r.verdict === "ERROR").map((r) => r.id);
    return { overall: "ERROR", reason: `${ids.join(", ")} errored` };
  }
  if (asserts.length === 0) return { overall: "NEEDS-MATERIAL", reason: "no assert units — spec asserts nothing" };
  return { overall: "PASS", reason: `all ${asserts.length} assert units passed` };
}

export async function runVerify(spec: VerifySpec, opts: VerifyOptions): Promise<VerifyReport> {
  const now = opts.nowIso ?? (() => new Date().toISOString());
  const started = now();
  const runId = `run_${randomBytes(8).toString("hex")}`;
  const orderResult = topoOrder(spec.vu);
  if ("cycle" in orderResult) {
    throw new Error(`pipeline cycle detected among: ${orderResult.cycle.join(", ")}`);
  }
  // N2：sql 文本不支持占位展开（$vu: 只允许出现在 count.from / sql-pair 的侧引用）
  for (const vu of spec.vu) {
    const c = vu.checker as { sql?: string; scope_sql?: string };
    if (/\$/.test(`${c.sql ?? ""} ${c.scope_sql ?? ""}`)) {
      throw new Error(`${vu.id}: "$" in sql text is not supported — pipeline refs belong to count.from / sql-pair sides (no placeholder expansion)`);
    }
  }
  // R13：as_of 必须锚定——时间函数在构造期拒绝（NOW()/CURRENT_TIMESTAMP 无法重放）
  const timeFn = /\b(now\s*\(|current_timestamp|current_date|current_time)\b/i;
  for (const vu of spec.vu) {
    const c = vu.checker as { sql?: string; scope_sql?: string };
    const text = `${c.sql ?? ""} ${c.scope_sql ?? ""}`;
    if (timeFn.test(text)) {
      throw new Error(`${vu.id}: non-deterministic time function in sql — freeze the timestamp via as_of/parameters (R13)`);
    }
  }
  if (!spec.vu.some((v) => v.role === "assert")) {
    throw new Error("spec has no assert units — a spec that asserts nothing must not report PASS");
  }
  const outputs = new Map<string, Row[]>();
  const results: VuResult[] = [];
  for (const vu of orderResult.order) {
    if (vu.role === "source") {
      const fetched = executeSourceRows(vu, opts, runnerOf(opts));
      outputs.set(vu.id, fetched.rows);
      results.push({
        id: vu.id,
        role: "source",
        verdict: fetched.error ? "ERROR" : "PASS",
        severity: vu.severity,
        source_clause: vu.source_clause,
        checker_type: vu.checker.type,
        trace: fetched.error
          ? "source fetch failed — downstream references turn ERROR (not folded into overall)"
          : "PASS-by-construction (source; not folded — downstream failure surfaces as ERROR)",
        evidence: fetched.error ? { rows: 0, error: fetched.error } : { rows: fetched.rows.length },
      });
      continue;
    }
    let outcome: Awaited<ReturnType<typeof runFactChecker>>;
    try {
      outcome = await runFactChecker(vu, opts, outputs);
    } catch (e) {
      outcome = { verdict: "ERROR", evidence: { reason: (e as Error).message } };
    }
    if (outcome.verdict === "PASS" || outcome.verdict === "FAIL" || outcome.verdict === "NEEDS-MATERIAL" || outcome.verdict === "ERROR") {
      // ok
    }
    const evidence = { ...(outcome.evidence ?? {}) };
    let verdict = outcome.verdict;
    // 级联（评审 a）：引用了取数失败的 source -> 下游一律 ERROR，不允许把"没数据"当成 PASS/FAIL 证据
    const brokenRef = refsOf(vu.checker).filter((ref) => results.some((r) => r.id === ref && r.verdict === "ERROR"));
    if (brokenRef.length) {
      verdict = "ERROR";
      evidence.reason = `upstream source failed: ${brokenRef.join(", ")}`;
    }
    // schema 漂移（评审 c）：prepare 冻结的指纹与本次运行不一致 -> ERROR
    if (spec.schema_fingerprint && fingerprintOf(opts.runner) !== spec.schema_fingerprint) {
      verdict = "ERROR";
      evidence.schema_drift = { frozen: spec.schema_fingerprint, current: fingerprintOf(opts.runner) };
      evidence.reason = "schema_drift: fingerprint differs from the one frozen at prepare";
    }
    // 装配期守卫：PASS 必须带 witness 且非零扫描（防空洞通过）
    if (verdict === "PASS" && outcome.witness && outcome.witness.rows_scanned === 0 && vu.checker.type !== "command" && vu.checker.type !== "agent") {
      verdict = "NEEDS-MATERIAL";
      evidence.degraded_from = "PASS";
      evidence.reason = "zero rows scanned — cannot assert PASS (vacuous prevention)";
    }
    const FACT_TYPES = new Set(["sql", "sql-pair", "count", "exists", "file"]);
    if (FACT_TYPES.has(vu.checker.type)) {
      results.push({
        id: vu.id,
        role: "assert",
        verdict,
        severity: vu.severity,
        source_clause: vu.source_clause,
        checker_type: vu.checker.type as FactCheckerType,
        witness: outcome.witness ?? { rows_scanned: 0, rows_matched: 0, sources: [], schema_fingerprint: fingerprintOf(opts.runner) },
        evidence,
        guard: { leniency_checks: ["not-same-source", "has-where", "falsifiable"] },
      });
    } else {
      results.push({
        id: vu.id,
        role: "assert",
        verdict,
        severity: vu.severity,
        source_clause: vu.source_clause,
        checker_type: vu.checker.type as "agent" | "command",
        witness: outcome.witness,
        evidence,
        guard: { leniency_checks: ["not-same-source", "has-where", "falsifiable"] },
      });
    }
    if (vu.checker.type === "sql" && (vu.outputs?.rows === "rowset") && !outputs.has(vu.id)) {
      outputs.set(vu.id, safeQuery(opts.runner, vu.checker.sql));
    }
  }
  const summary = { pass: 0, fail: 0, needs_material: 0, error: 0 };
  for (const r of results) {
    if (r.role !== "assert") continue;
    if (r.verdict === "PASS") summary.pass++;
    else if (r.verdict === "FAIL") summary.fail++;
    else if (r.verdict === "NEEDS-MATERIAL") summary.needs_material++;
    else summary.error++;
  }
  const { overall, reason } = foldOverall(results);
  const exceptions = results
    .filter((r) => r.role === "assert" && (r.verdict === "FAIL" || r.verdict === "NEEDS-MATERIAL"))
    .map((r) => ({ vu: r.id, severity: r.severity as Severity, row_count: Number((r.evidence as { violations?: number; rows_total?: number } | undefined)?.violations ?? 0) }));
  if (spec.schema_fingerprint) {
    for (const r of results) {
      if (r.witness && r.witness.schema_fingerprint !== spec.schema_fingerprint) {
        (r as { verdict: string }).verdict = "ERROR";
        r.evidence = { ...(r.evidence ?? {}), schema_drift: true, expected_schema: spec.schema_fingerprint, seen: r.witness.schema_fingerprint };
      }
    }
  }
  const report: VerifyReport = {
    contract_version: spec.contract_version,
    run_id: runId,
    started,
    finished: now(),
    verifier: {
      mode: opts.mode ?? "open",
      binary_sha256: opts.binarySha256,
      engine_version: opts.engineVersion ?? "0.1.0",
      spec_version: spec.spec_version,
      corpus_version: spec.verifier.corpus_version,
      sealed_review: spec.sealed.review,
    },
    as_of: spec.as_of,
    summary,
    overall,
    reason,
    vu: results,
    exceptions,
    artifacts: { attachment_sha256: spec.attachments.map((a) => a.sha256) },
  };
  report.payload_sha256 = payloadHash(report);
  return report;
}

/** `$vu:V1` / `$vu:V1.rows` → `V1`（r3 命名空间解析）。 */
function refId(ref: string): string {
  const m = ref.match(/^\$vu:([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`invalid pipeline reference "${ref}" — expected $vu:<vu-id>[.<field>]`);
  return m[1];
}

function fingerprintOf(runner: QueryRunner): string {
  try {
    return runner.schemaFingerprint();
  } catch {
    return EMPTY_SCHEMA;
  }
}

function runnerOf(opts: VerifyOptions): QueryRunner {
  return opts.runner;
}

function safeQuery(runner: QueryRunner, sql: string): Row[] {
  try {
    return runner.query(sql);
  } catch {
    return [];
  }
}

function executeSourceRows(vu: VerifyUnit, opts: VerifyOptions, runner: QueryRunner): { rows: Row[]; error?: string } {
  if (vu.checker.type === "sql") {
    try {
      return { rows: runner.query(vu.checker.sql) };
    } catch (e) {
      return { rows: [], error: (e as Error).message };
    }
  }
  return { rows: [], error: `source role requires a sql checker (got ${vu.checker.type})` };
}

/** 报告载荷哈希（评审 B3）：除 payload_sha256 自身外的规范化哈希。 */
export function payloadHash(report: VerifyReport): string {
  const clone = { ...report } as Record<string, unknown>;
  delete clone.payload_sha256;
  return `sha256:${createHash("sha256").update(stableStringify(clone)).digest("hex")}`;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
