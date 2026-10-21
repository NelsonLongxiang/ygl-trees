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

import { canonicalStringify } from "./canonical";
import { CONTRACT_VERSION } from "./contract";
import { compareValues, ISO_DATETIME_TZ, validateCompareSpec, withOffsetMinutes } from "./compare";
import type {
  AgentChecker,
  Checker,
  FactCheckerType,
  CompareSpec,
  ScopeWitness,
  Severity,
  Verdict,
  VerifyReport,
  VerifySpec,
  ReviewFinding,
  ReviewQuestion,
  ReviewRunner,
  VerifyUnit,
  VuResult,
  Predicate,
  PredicateCondition,
  PredicateGroup,
  PredicateNode,
} from "./contract";

export type Row = Record<string, unknown>;

export interface QueryRunner {
  query(sql: string): Row[];
  /** 源表指纹：表名 → 行数（同时用于 witness 与 schema 漂移检测） */
  tableRows(table: string): number;
  schemaFingerprint(): string;
  sourceTables?: (sql: string) => string[];
}

/** #28: the file checker's scan trace. Emitted only to callers that ask for it
 *  (CLI → workspace sidecar + archive); the report evidence shape stays frozen
 *  on contract 1.2 (adding paths/hashes there is a contract 1.3 change). */
export interface FileScanRecord {
  vu_id: string;
  dir: string;
  files: number;
  ignored: number;
  matched: Array<{ path: string; sha256: string; size: number }>;
}

export interface VerifyOptions {
  runner: QueryRunner;
  /** 提交物根目录（file 型）与 program 执行 cwd */
  submissionDir?: string;
  /** 允许执行的 command argv[0] 白名单；未给则 command 型返回 ERROR */
  commandAllowlist?: string[];
  /** review 层执行器（agent 型）；缺省 = fact-only，agent 型给 ERROR */
  reviewRunner?: ReviewRunner;
  /** 冻结材料全文（review 层盲审输入；没有它 agent 型只能判 NEEDS-MATERIAL） */
  materialsText?: string;
  /** review 圈数（写进报告；同一 VU 的多轮复核取最后一轮） */
  reviewRound?: number;
  nowIso?: () => string;
  engineVersion?: string;
  mode?: "sealed" | "open";
  binarySha256?: string;
  /** 可钉 run_id（双实现 parity / 重放）；缺省随机——报告不是必须逐字节可复现的运行产物吗？
   *  是：语料与 parity 场景必须给钉值，线上运行保留随机以免撞名。 */
  runId?: string;
  /** 封包签名身份（contract 1.1）：来自 footer 的 signature/signing_scheme/key_id；open 模式无 */
  signature?: string;
  signingScheme?: string;
  publicKeyFingerprint?: string;
  /** #28: optional file-scan recorder (CLI persists it as run provenance). */
  onFileScan?: (record: FileScanRecord) => void;
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
/** 剥掉 SQL 注释——守卫要判断"代码里到底有没有"，不能把注释里的字样当真。 */
/** 取这个 sql 型 checker 的"实际查询文本"：谓词形态返回渲染后的 find 查询 */
export function sqlTextOf(c: Checker): string | undefined {
  if (c.type !== "sql") return undefined;
  if ("predicate" in c && c.predicate) return renderPredicate(c.predicate).findSql;
  return c.sql;
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

export function extractTables(sql: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.add(m[1]);
  return [...out];
}

/** 1.2: find the first column-to-column comparison so the witness evidence can
 *  carry both sides. Only the first pair is projected (bounded, auditable);
 *  nested predicates with several {col} leaves compare them all in SQL but
 *  report the first pair's samples — documented in the contract. */
function firstColRefPair(node: unknown): { lhs: string; rhs: string } | null {
  if (!node || typeof node !== "object") return null;
  const n = node as { col?: unknown; op?: unknown; value?: unknown; conditions?: unknown[] };
  if (typeof n.col === "string") {
    const v = n.value;
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { col?: unknown }).col === "string") {
      return { lhs: n.col, rhs: (v as { col: string }).col };
    }
  }
  for (const c of n.conditions ?? []) {
    const hit = firstColRefPair(c);
    if (hit) return hit;
  }
  return null;
}

function canonicalRows(rows: Row[], keyFields: string[]): Row[] {
  const keyed = rows.map((r) => ({ r, k: keyFields.map((f) => String(r[f])).join("\u0000") }));
  keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return keyed.map((x) => x.r);
}

function witness(scanned: number, matched: number, sources: Array<{ table: string; rows: number }>, fingerprint: string): ScopeWitness {
  return { rows_scanned: scanned, rows_matched: matched, sources, schema_fingerprint: fingerprint };
}

/** 引擎内部：把 spec 级的冻结哈希带给检查器（不暴露给调用方） */
interface FactContext extends VerifyOptions {
  expectedMaterialsSha?: string;
}

async function runFactChecker(
  vu: VerifyUnit,
  opts: FactContext,
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

      // ---- 谓词形态（prepare 机械生成）：sql/scope_sql 由渲染器产出 ----
      if ("predicate" in c && c.predicate) {
        const pred = c.predicate;
        if ((pred.agg ?? []).length > 0) {
          return { verdict: "ERROR", evidence: { reason: "predicate.agg belongs to sql-pair predicate sides only — a plain sql rowset with agg is always one row and proves nothing (r9 E2)" } };
        }
        if (failWhen === "rows>0" && !pred.where) {
          return { verdict: "ERROR", evidence: { reason: "predicate has no where clause — a full-table scan cannot prove the intended batch (vacuous-pass risk)" } };
        }
        let rendered: RenderedPredicate;
        try {
          rendered = renderPredicate(pred);
        } catch (e) {
          // 1.2 closed code table: a render-time rejection carries its code so
          // reports stay machine-comparable across TS/Rust (reason stays human).
          const msg = (e as Error).message;
          const code = msg.startsWith("cross_table_col")
            ? "cross_table_col"
            : msg.startsWith("null_rhs_for_null_op")
              ? "null_rhs_for_null_op"
              : undefined;
          return { verdict: "ERROR", evidence: { reason: msg, ...(code ? { spec_error: code } : {}) } };
        }
        // 1.2 (freeze): when the predicate compares two columns, project both
        // sides into the rowset (aliased) and order by rowid so samples are
        // deterministic across TS/Rust. `compared_total` is ALWAYS present
        // (consumers must be able to tell "3 rows" from "3 of N sampled").
        const colRef = firstColRefPair(pred.where) ?? firstColRefPair(pred.scan);
        let cmpSql = rendered.findSql;
        if (colRef) {
          const at = cmpSql.indexOf(" FROM ");
          if (at > 0) {
            cmpSql = `${cmpSql.slice(0, at)}, ${colRef.lhs} AS __cmp_left, ${colRef.rhs} AS __cmp_right${cmpSql.slice(at)}`;
            cmpSql += " ORDER BY rowid";
          }
        }
        let findRows: Row[];
        let scopeRows: Row[];
        try {
          findRows = runner.query(cmpSql);
          scopeRows = runner.query(rendered.scopeSql);
        } catch (e) {
          return { verdict: "ERROR", evidence: { reason: `rendered query failed: ${(e as Error).message}`, rendered } };
        }
        if (scopeRows.length !== 1 || Object.values(scopeRows[0] ?? {}).length !== 1) {
          return { verdict: "ERROR", evidence: { reason: "rendered scope query must return one row and one column", rendered } };
        }
        const n = Number(Object.values(scopeRows[0])[0]);
        if (!Number.isInteger(n) || n < 0) {
          return { verdict: "ERROR", evidence: { reason: `rendered scope count is not a non-negative integer (got ${JSON.stringify(Object.values(scopeRows[0])[0])})`, rendered } };
        }
        const sources = rowsScannedFromSql(runner, rendered.findSql).sources;
        const w1 = witness(n, findRows.length, sources, fingerprint);
        if (n === 0) return { verdict: "NEEDS-MATERIAL", witness: w1, evidence: { reason: "zero rows scanned — wrong table or empty data", rendered } };
        const bad = failWhen === "rows>0" ? findRows.length : findRows.length === 0 ? 1 : 0;
        const comparedEvidence = colRef
          ? {
              compared_rows: findRows.slice(0, 5).map((r) => ({ left: r.__cmp_left ?? null, right: r.__cmp_right ?? null })),
              compared_total: findRows.length,
            }
          : {};
        if (bad > 0) {
          return {
            verdict: "FAIL",
            witness: w1,
            evidence: { violations: bad, rows: canonicalRows(findRows, Object.keys(findRows[0] ?? {}).slice(0, 1)).slice(0, 5), rows_total: findRows.length, ...comparedEvidence, rendered },
          };
        }
        return { verdict: "PASS", witness: w1, evidence: { rows: findRows.length, ...comparedEvidence, rendered } };
      }

      // ---- 手写 SQL 形态：prepare 产物禁止（authored=manual 只留给存量/评审例外） ----
      if (c.authored === "mechanical") {
        return { verdict: "ERROR", evidence: { reason: "authored=mechanical is inconsistent with hand-written sql — mechanical specs must use predicate" } };
      }
      const rawSql = c.sql;
      if (typeof rawSql !== "string") {
        return { verdict: "ERROR", evidence: { reason: "sql checker needs either predicate or sql text" } };
      }
      // 构造守卫（r3 意见 2）：找违规型必须能证明扫的是本批范围——
      // 要么给 scope_sql，要么 sql 自带 WHERE（否则「整表非空」冒充「扫过本批」）。
      const sqlNoComments = stripSqlComments(rawSql);
      if (failWhen === "rows>0" && !c.scope_sql && !/\bwhere\b/i.test(sqlNoComments)) {
        return { verdict: "ERROR", evidence: { reason: "find-violation sql has no WHERE and no scope_sql — cannot prove the scan covers the intended batch (vacuous-pass risk)" } };
      }
      const rows = runner.query(rawSql);
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
        sources = rowsScannedFromSql(runner, rawSql).sources;
      } else {
        const scope = rowsScannedFromSql(runner, rawSql);
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
        if ("predicate" in side && side.predicate) {
          const aggs = side.predicate.agg ?? [];
          if (aggs.length !== 1) {
            throw new Error("sql-pair predicate side needs exactly one agg column (that column is the compared value)");
          }
          const alias = aggAliasOf(side.predicate);
          const { findSql } = renderPredicate(side.predicate); // 单次渲染，兼做 agg/别名/where 规则校验
          const rows = runner.query(findSql);
          if (rows.length !== 1) {
            throw new Error(`sql-pair predicate side must yield exactly one row (aggregate), got ${rows.length}`);
          }
          // 键列名 = side.key（缺省 "total"），值 = 该键常量；与 sideKey/sideVal 访问口径一致（r9 E1）
          const kName = side.key ?? "total";
          return [{ [kName]: kName, value: rows[0][alias] }];
        }
        if ("from" in side) {
          const ref = refId(side.from);
          const rows = outputs.get(ref);
          if (!rows) throw new Error(`pipeline reference ${side.from} is not available (topological order violated)`);
          return rows;
        }
        const tbl = (side as { table: string; key: string; value: string });
        return runner.query(`SELECT ${tbl.key}, ${tbl.value} FROM ${tbl.table}`);
      };
      const compareSpec: CompareSpec = c.compare;
      const specErrs = validateCompareSpec(compareSpec);
      if (specErrs.length) return { verdict: "ERROR", evidence: { reason: `invalid compare spec: ${specErrs.join("; ")}` } };
      const isPredicateSide = (sd: typeof c.left): boolean => "predicate" in sd && Boolean((sd as { predicate?: unknown }).predicate);
      if (isPredicateSide(c.left) !== isPredicateSide(c.right)) {
        return { verdict: "ERROR", evidence: { reason: "sql-pair sides must be the same shape family — an aggregate predicate side cannot be paired with a rowset side (key spaces do not intersect)" } };
      }
      // E3：聚合对的空批守卫——两侧 SUM 都是 NULL 时「同构缺失」会被误判为相等
      for (const sd of [c.left, c.right]) {
        if (!isPredicateSide(sd)) continue;
        const pred = (sd as { predicate: Predicate }).predicate;
        const { scopeSql } = renderPredicate(pred);
        const scopeRows = runner.query(scopeSql);
        const n = Number(Object.values(scopeRows[0] ?? {})[0]);
        if (!Number.isInteger(n) || n < 0) {
          return { verdict: "ERROR", evidence: { reason: `aggregate side scope is not a non-negative integer (got ${JSON.stringify(Object.values(scopeRows[0] ?? {})[0])})` } };
        }
        if (n === 0) {
          return { verdict: "NEEDS-MATERIAL", witness: witness(0, 0, [], fingerprint), evidence: { reason: "aggregate side scanned zero rows — wrong batch or empty data (r9 E3)" } };
        }
      }
      let left: Row[];
      let right: Row[];
      try {
        left = readSide(c.left);
        right = readSide(c.right);
      } catch (e) {
        return { verdict: "ERROR", evidence: { reason: (e as Error).message } };
      }
      const sideKey = (sd: typeof c.left): string => {
        if ("predicate" in sd && sd.predicate) return sd.key ?? "total";
        return (sd as { key: string }).key;
      };
      const sideVal = (sd: typeof c.left): string => {
        if ("predicate" in sd && sd.predicate) return "value";
        return (sd as { value: string }).value;
      };
      const lk = sideKey(c.left);
      const lv = sideVal(c.left);
      const rk = sideKey(c.right);
      const rv = sideVal(c.right);
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
      const sourcesOf = () => {
        const tableSides: string[] = [];
        for (const side of [c.left, c.right]) {
          if ("table" in side) tableSides.push(side.table);
          else if ("predicate" in side && side.predicate) tableSides.push(side.predicate.from);
        }
        return tableSides.map((t) => {
          try {
            return { table: t, rows: runner.tableRows(t) };
          } catch {
            return { table: t, rows: -1 };
          }
        });
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
          // 比较本身失败（类型/精度/形态不合法）是构造问题，不是"业务违规"——判 ERROR 而不是 FAIL
          return {
            verdict: "ERROR",
            witness: witness(keys.length, violations.length, sourcesOf(), fingerprint),
            evidence: { reason: `comparison is not well-formed at key ${k}: ${outcome.error}`, key: k, left: l, right: r },
          };
        }
        if (!outcome.equal) {
          const ln = typeof l === "number" ? l : Number(l);
          const rn = typeof r === "number" ? r : Number(r);
          violations.push({ key: k, left: l, right: r, diff: Number.isFinite(ln) && Number.isFinite(rn) ? Number((ln - rn).toFixed(6)) : "mismatch" });
        }
      }
      const sources = sourcesOf();
      // matched = 违规对数（与契约示例 rows_matched=3 对齐，r3 意见 1）
      const w = witness(keys.length, violations.length, sources, fingerprint);
      if (keys.length === 0) return { verdict: "NEEDS-MATERIAL", witness: w, evidence: { reason: "no keys to compare — empty source" } };
      if (violations.length > 0) {
        return { verdict: "FAIL", witness: w, evidence: { violations: violations.length, compared, rows: violations.slice(0, 5) } };
      }
      return { verdict: "PASS", witness: w, evidence: { compared } };
    }
    case "count": {
      const cc = c as Record<string, any>;
      const hasAgainst = cc.against !== undefined;
      const countForms = ["from", "sql", "predicate"].filter((k) => cc[k] !== undefined);
      if (countForms.length !== 1) {
        return { verdict: "ERROR", evidence: { reason: `count checker declares ${countForms.join("+") || "nothing"} — exactly one of from/sql/predicate is required` } };
      }
      let n: number;
      let scanned: number;
      let sources: Array<{ table: string; rows: number }> = [];
      // 1.2: the right-hand side may be a scalar from another table instead of
      // a literal. `agg` is mandatory (no default): a default would silently
      // pick max() when a policy table unexpectedly has several rows, and the
      // "reject only when multi-row" alternative is data-dependent — a spec's
      // validity must be decidable from the schema alone.
      let target: number;
      let compared: { left: number; right: number | null } | undefined;
      if (hasAgainst) {
        const a = cc.against as { from?: string; col?: string; agg?: string };
        if (!a || typeof a.from !== "string" || typeof a.col !== "string") {
          return { verdict: "ERROR", evidence: { reason: "count.against needs {from, col, agg}", spec_error: "missing_column" } };
        }
        if (!a.agg) {
          return { verdict: "ERROR", evidence: { reason: "count.against requires agg (max|min|sum|count) — no default is applied", spec_error: "missing_agg" } };
        }
        if (!cc.predicate) {
          return { verdict: "ERROR", evidence: { reason: "count.against requires the predicate form (count is the left side)" } };
        }
        const { from, whereSql } = renderScan(cc.predicate);
        const rhsSql = `${a.agg.toUpperCase()}(${ident(a.col, "against column")})`;
        const rows = runner.query(
          `SELECT (SELECT count(*) FROM ${from}${whereSql}) AS left_count, (SELECT ${rhsSql} FROM ${ident(a.from, "against table")}) AS right_value`
        );
        const leftN = Number(rows[0]?.left_count ?? 0);
        const rawRight = rows[0]?.right_value;
        const scope = rowsScannedFromSql(runner, `SELECT count(*) AS n FROM ${from}${whereSql}`);
        scanned = scope.scanned;
        sources = scope.sources;
        n = leftN;
        if (rawRight === null || rawRight === undefined) {
          return {
            verdict: "ERROR",
            witness: witness(scanned, n, sources, fingerprint),
            evidence: {
              reason: `count.against right side is NULL (${a.agg}(${a.from}.${a.col}) over an empty/all-NULL table) — a NULL cannot satisfy '${cc.op}'`,
              compared: { left: leftN, right: null },
            },
          };
        }
        const rightN = Number(rawRight);
        if (!Number.isFinite(rightN)) return { verdict: "ERROR", evidence: { reason: "count.against right side is not a number" } };
        compared = { left: leftN, right: rightN };
        target = rightN;
      } else if (cc.from !== undefined) {
        const ref = refId(cc.from);
        const upstream = outputs.get(ref);
        if (!upstream) {
          return { verdict: "ERROR", evidence: { reason: `count from ${cc.from} is not available (topological order violated)` } };
        }
        n = upstream.length;
        scanned = upstream.length;
        target = Number(cc.value);
      } else if (cc.predicate) {
        if ((cc.predicate.agg ?? []).length > 0) {
          return { verdict: "ERROR", evidence: { reason: "count predicate must not carry agg — the count itself is the aggregate (r9 E2)" } };
        }
        const { from, whereSql } = renderScan(cc.predicate);
        const rows = runner.query(`SELECT count(*) AS n FROM ${from}${whereSql}`);
        n = rows.length > 0 ? Number(Object.values(rows[0])[0]) : 0;
        const scope = rowsScannedFromSql(runner, `SELECT count(*) AS n FROM ${from}${whereSql}`);
        scanned = scope.scanned;
        sources = scope.sources;
        target = Number(cc.value);
      } else if (cc.sql !== undefined) {
        const rows = runner.query(cc.sql);
        if (rows.length > 1 || (rows.length === 1 && Object.keys(rows[0]).length !== 1)) {
          return { verdict: "ERROR", evidence: { reason: "count.sql must return exactly one row and one column" } };
        }
        n = rows.length > 0 ? Number(Object.values(rows[0])[0]) : 0;
        const scope = rowsScannedFromSql(runner, cc.sql);
        scanned = scope.scanned;
        sources = scope.sources;
        target = Number(cc.value);
      } else {
        return { verdict: "ERROR", evidence: { reason: "count checker requires from ($Vx) or sql" } };
      }
      if (!Number.isFinite(n)) return { verdict: "ERROR", evidence: { reason: "count query did not return a number" } };
      if (!Number.isFinite(target)) return { verdict: "ERROR", evidence: { reason: "count target is not a number" } };
      const pass =
        cc.op === ">=" ? n >= target : cc.op === "<=" ? n <= target : cc.op === "==" ? n === target : cc.op === "!=" ? n !== target : cc.op === ">" ? n > target : n < target;
      const evidence: Record<string, unknown> = { count: n, op: cc.op, expected: target };
      if (compared) evidence.compared = compared;
      return { verdict: pass ? "PASS" : "FAIL", witness: witness(scanned, n, sources, fingerprint), evidence };
    }
    case "exists": {
      let sql: string;
      if ("predicate" in c && c.predicate) {
        if ((c.predicate.agg ?? []).length > 0) {
          return { verdict: "ERROR", evidence: { reason: "exists predicate must not carry agg (r9 E2)" } };
        }
        const { from, whereSql } = renderScan(c.predicate);
        sql = `SELECT 1 FROM ${from}${whereSql}`;
      } else {
        sql = c.sql;
      }
      const rows = runner.query(sql);
      const present = rows.length > 0;
      const { scanned, sources } = rowsScannedFromSql(runner, sql);
      return { verdict: present === c.expect ? "PASS" : "FAIL", witness: witness(scanned, rows.length, sources, fingerprint), evidence: { present, expect: c.expect } };
    }
    case "file": {
      const dir = opts.submissionDir;
      if (!dir) return { verdict: "ERROR", evidence: { reason: "file checker requires --attachments <dir>" } };
      if (c.glob === "*" || c.glob === "**" || c.glob === "**/*") {
        return { verdict: "ERROR", evidence: { reason: 'glob "*" matches everything and proves nothing — construct rejected' } };
      }
      const all = walk(dir);
      const relOf = (p: string) => relative(dir, p).split("\\").join("/");
      const ignoreRes = (c.ignore ?? []).map(globToRegExp);
      const visible = all.filter((p) => !ignoreRes.some((r) => r.test(relOf(p))));
      const re = globToRegExp(c.glob);
      const matched = visible.filter((p) => re.test(relOf(p)));
      const w = witness(visible.length, matched.length, [], fingerprint);
      if (opts.onFileScan) {
        // Trace what PASS/FAIL actually pointed at: matched paths + per-file
        // sha256. Runs even for NEEDS-MATERIAL/FAIL so audit sees the scan.
        const rec: FileScanRecord = {
          vu_id: vu.id,
          dir,
          files: visible.length,
          ignored: all.length - visible.length,
          matched: matched.map((p) => {
            const bytes = readFileSync(p);
            return { path: relOf(p), sha256: createHash("sha256").update(bytes).digest("hex"), size: statSync(p).size };
          }),
        };
        try {
          opts.onFileScan(rec);
        } catch {
          /* trace recording must never change the verdict */
        }
      }
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
      if (visible.length === 0) return { verdict: "NEEDS-MATERIAL", witness: w, evidence: { reason: "every file was excluded by ignore globs — nothing left to scan" } };
      return {
        verdict: problems.length ? "FAIL" : "PASS",
        witness: w,
        evidence: { files: visible.length, matched: matched.length, ignored: all.length - visible.length, problems: problems.slice(0, 5) },
      };
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
      if (!opts.materialsText) {
        return { verdict: "NEEDS-MATERIAL", evidence: { reason: "review layer needs frozen materials (materialsText) — a blind review without materials asserts nothing" } };
      }
      // W15：材料哈希绑定——spec 声明了 materials_sha256 就必须逐字对上，否则 review 审的不是冻结材料
      if (opts.expectedMaterialsSha) {
        const got = createHash("sha256").update(opts.materialsText, "utf8").digest("hex");
        if (got !== opts.expectedMaterialsSha) {
          return { verdict: "ERROR", evidence: { reason: `materials hash mismatch: spec expects ${opts.expectedMaterialsSha}, got ${got}` } };
        }
      }
      const checker = c as AgentChecker;
      try {
        const findings = await opts.reviewRunner.review({
          vu,
          materials: opts.materialsText,
          submission_dir: opts.submissionDir,
          blind: true,
          round: opts.reviewRound ?? 1,
        });
        return judgeReview(checker, vu, findings, opts.materialsText);
      } catch (e) {
        return { verdict: "ERROR", evidence: { reason: (e as Error).message } };
      }
    }
    default:
      return { verdict: "ERROR", evidence: { reason: `unknown checker type: ${String((c as { type?: string }).type)}` } };
  }
}


/** 盲审结论的机械判定：缺项 / 矛盾 / 锚点不复读，一律不落 PASS（B6）。 */
function judgeReview(
  checker: AgentChecker,
  vu: VerifyUnit,
  findings: ReviewFinding[],
  materials: string,
): { verdict: VuResult["verdict"]; evidence: Record<string, unknown> } {
  const ALLOWED = new Set(["ok", "reject", "unclear"]);
  const byQuestion = new Map<string, ReviewFinding>();
  for (const f of findings ?? []) {
    if (!ALLOWED.has(String(f.verdict))) {
      return { verdict: "ERROR", evidence: { reason: `review finding has an unknown verdict ${JSON.stringify(f.verdict)} (allowed: ok|reject|unclear)`, findings } };
    }
    if (f.vu_id !== vu.id) continue;
    // 同一问重复出现且结论不一致 = 复核自身不稳定，交回人工材料环节
    const prev = byQuestion.get(f.question);
    if (prev && prev.verdict !== f.verdict) {
      return { verdict: "NEEDS-MATERIAL", evidence: { reason: `conflicting review conclusions on "${f.question}"`, findings } };
    }
    byQuestion.set(f.question, f);
  }

  const required: ReviewQuestion[] = ["faithful", "decidable", "not-vacuous"];
  const missing = required.filter((q) => !byQuestion.has(q));
  if (missing.length > 0) {
    return { verdict: "NEEDS-MATERIAL", evidence: { reason: `review is incomplete: no conclusion on ${missing.join(", ")}`, findings } };
  }

  const rejected = [...byQuestion.values()].filter((f) => f.verdict === "reject");
  if (rejected.length > 0) {
    return { verdict: "FAIL", evidence: { reason: `review rejected: ${rejected.map((f) => f.question).join(", ")}`, findings } };
  }
  const unclear = [...byQuestion.values()].filter((f) => f.verdict === "unclear");
  if (unclear.length > 0) {
    return { verdict: "NEEDS-MATERIAL", evidence: { reason: `review unclear: ${unclear.map((f) => f.question).join(", ")}`, findings } };
  }

  // 锚点复读：faithful 必须引原文，且引文要能在冻结材料里逐字找到（空白归一后）
  const faithful = byQuestion.get("faithful")!;
  if (!faithful.anchor || !faithful.anchor.quote || !faithful.anchor.locator) {
    return { verdict: "NEEDS-MATERIAL", evidence: { reason: "faithful conclusion carries no anchor (quote + locator)", findings } };
  }
  if (!containsVerbatim(materials, faithful.anchor.quote)) {
    return { verdict: "FAIL", evidence: { reason: "anchor quote does not appear verbatim in the frozen materials (mis-transcription or wrong cell)", findings } };
  }

  // rubric 覆盖：pass_if=all 时每个检查点都要有"ok"结论
  const rubric = checker.rubric ?? [];
  if (rubric.length === 0) {
    // W9：没有检查点的 agent 型 = 没有判据，不能因为"没要求"就免检通过
    return { verdict: "NEEDS-MATERIAL", evidence: { reason: "agent checker declares no rubric points — there is nothing a reviewer could check", findings } };
  }
  const need = checker.pass_if === "all" || checker.pass_if === undefined ? rubric.map((r) => r.id) : checker.pass_if;
  // W13：只认同一个 VU 的 ok 结论（跨 VU 的 ok 不能冒领检查点）；W10：checkpoint 字段优先，reason 前缀是兼容协议
  const covered = new Set(
    findings
      .filter((f) => f.verdict === "ok" && f.vu_id === vu.id)
      .map((f) => String(f.checkpoint ?? f.reason.match(/^rubric:([^\s]+)/)?.[1] ?? "")),
  );
  const uncovered = need.filter((id) => !covered.has(id));
  if (uncovered.length > 0) {
    return { verdict: "NEEDS-MATERIAL", evidence: { reason: `rubric points without an ok finding: ${uncovered.join(", ")}`, findings } };
  }

  return { verdict: "PASS", evidence: { findings } };
}

/**
 * 逐字复读：NFC 归一 + 空白折叠，不做同义替换/模糊匹配——"大致一样"不算复读。
 * 与契约 §5.2 的 canonical 口径一致（W16）：Unicode NFC 先行，然后把连续空白折成一个空格。
 */
export function containsVerbatim(haystack: string, needle: string): boolean {
  const norm = (t: string) => t.normalize("NFC").replace(/\s+/g, " ").trim();
  return norm(haystack).includes(norm(needle));
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
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 标识符守门：只允许裸列名/表名（可选表限定 a.b），禁止表达式与子查询进判据 */
function ident(name: string, what: string): string {
  const parts = String(name).split(".");
  if (parts.length > 2 || parts.some((x) => !IDENT.test(x))) {
    throw new Error(`predicate ${what} must be a bare identifier (optionally table-qualified), got ${JSON.stringify(name)}`);
  }
  return parts.join(".");
}

/**
 * 时间字面量规范化（r8 F5）：带偏移的时间统一折成 UTC Z。
 * 原因：SQLite 里日期是字符串，`BETWEEN '2026-07-01T00:00:00+08:00' AND ...` 是字典序比较，
 * 与真实时间序不等价；折成 Z 后同一 spec 在任何机器上给出同一结论（Rust 侧同口径）。
 */
function normalizeIsoLiteral(v: string): string {
  if (!ISO_DATETIME_TZ.test(v)) return v;
  const ms = Date.parse(withOffsetMinutes(v.replace(" ", "T")));
  if (!Number.isFinite(ms)) throw new Error(`predicate literal ${JSON.stringify(v)} looks like an ISO datetime but cannot be parsed`);
  return new Date(ms).toISOString();
}

/** 字面量渲染：数字走白名单字符串，字符串按 '' 转义（永不拼接外部 SQL 片段） */
function literal(v: string | number): string {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`predicate literal is not a finite number: ${v}`);
    return String(v);
  }
  const norm = normalizeIsoLiteral(v);
  return `'${norm.replace(/'/g, "''")}'`;
}

/** in/between 的元素必须同型（r8 F3：混合 number/string 在 PG 报错、SQLite 按类型序比较） */
function assertSameScalarType(values: unknown[], col: string): void {
  const kinds = new Set(values.map((v) => (typeof v === "number" ? "number" : typeof v === "string" ? "string" : "other")));
  if (kinds.has("other")) throw new Error(`predicate where ${col} list contains a non-scalar value`);
  if (kinds.size > 1) throw new Error(`predicate where ${col} list mixes numbers and strings — declare one type (r8 F3)`);
}

/** 1.2：右值是否是列引用（`{col}`），以及它的表限定是否合法（只许同表）。 */
function columnRefOf(v: unknown): string | null {
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { col?: unknown }).col === "string") {
    return (v as { col: string }).col;
  }
  return null;
}

function renderCondition(w: PredicateCondition, fromTable = ""): string {
  const col = ident(w.col, "where column");
  const rhsCol = columnRefOf(w.value);
  switch (w.op) {
    case "is null":
    case "is not null":
      // r8 F3：is null 带 value 是构造错误，不能静默忽略（会让人以为在比较值）
      if (rhsCol !== null) {
        throw new Error(`null_rhs_for_null_op: predicate where ${col} ${w.op} must not carry a {col} value`);
      }
      if (w.value !== undefined) throw new Error(`predicate where ${col} ${w.op} must not carry a value`);
      return `${col} ${w.op.toUpperCase()}`;
    case "in": {
      if (!Array.isArray(w.value) || w.value.length === 0) {
        throw new Error(`predicate where ${col} in (...) needs a non-empty array value`);
      }
      assertSameScalarType(w.value, col);
      return `${col} IN (${w.value.map((v) => literal(v)).join(", ")})`;
    }
    case "between": {
      if (!Array.isArray(w.value) || w.value.length !== 2) {
        throw new Error(`predicate where ${col} between needs a two-element array value`);
      }
      assertSameScalarType(w.value, col);
      // 闭区间（含两端），写进契约；端点为 null 由 assertSameScalarType 拒绝
      return `${col} BETWEEN ${literal(w.value[0])} AND ${literal(w.value[1])}`;
    }
    default: {
      // GitHub #19: the switch used to treat every unknown op as an operator
      // and interpolate it into SQL (`${col} ${w.op} ${literal}`), so
      // `op:"= 1 OR 1=(SELECT …)"` smuggled a subquery past the closed-set
      // promise. Enforce the typed closed set at the renderer too (P2 rejects
      // it first; this is the defence-in-depth layer).
      const COMPARE = new Set(["=", "!=", ">", ">=", "<", "<="]);
      if (!COMPARE.has(String(w.op))) {
        throw new Error(`unknown predicate op ${JSON.stringify(w.op)} — closed set is ${[...COMPARE].join(", ")}, plus in|between|is null|is not null`);
      }
      if (rhsCol !== null) {
        // 1.2 column-to-column: same table only (a cross-table compare needs an
        // explicit join key, which belongs to sql-pair).
        const parts = rhsCol.split(".");
        const qualifier = parts.length > 1 ? parts[0] : "";
        const name = parts.length > 1 ? parts[1] : parts[0];
        if (qualifier && fromTable && qualifier !== fromTable) {
          throw new Error(
            `cross_table_col: predicate where ${col} ${w.op} ${rhsCol} — column-to-column comparison is same-table only; a cross-table compare needs sql-pair (join key)`
          );
        }
        return `${col} ${w.op} ${ident(name, "where column ref")}`;
      }
      if (w.value === undefined || Array.isArray(w.value)) {
        throw new Error(`predicate where ${col} ${w.op} needs a scalar value`);
      }
      return `${col} ${w.op} ${literal(w.value as string | number)}`;
    }
  }
}

/** 递归渲染谓词树：条件叶 / AND-OR 组 / NOT 组（NOT 内部按 AND 连接后整体取反） */
function renderNode(n: PredicateNode, fromTable = ""): string {
  if ("op" in n && (n.op === "and" || n.op === "or" || n.op === "not")) {
    const group = n as PredicateGroup;
    if (group.conditions.length === 0) throw new Error("predicate group has no conditions");
    const parts = group.conditions.map((c) => renderNode(c, fromTable));
    if (group.op === "not") return `NOT (${parts.join(" AND ")})`;
    return `(${parts.join(` ${group.op.toUpperCase()} `)})`;
  }
  return renderCondition(n as PredicateCondition, fromTable);
}

function renderWhere(where?: PredicateGroup, fromTable = ""): string {
  if (!where) return "";
  return ` WHERE ${renderNode(where, fromTable)}`;
}

export interface RenderedPredicate {
  findSql: string;
  scopeSql: string;
}

/**
 * 从同一谓词 AST 渲染两段查询（裁定「同源生成」，r5 S2）：
 * find 与 scope **共享同一 where 子句字符串**，物理上不可能伪造扫描面。
 */
/** 谓词渲染的公共部分：from 与 where（find/scope/count/exists 共用，保证同源） */
export function renderScan(pred: Predicate): { from: string; whereSql: string; scanSql: string } {
  const from = ident(pred.from, "from");
  const scanSql = renderWhere(pred.scan, pred.from);
  const whereSql = renderWhere(andGroups(pred.scan, pred.where), pred.from);
  return { from, whereSql, scanSql };
}

/** 域过滤 AND 判据 —— 两侧共用同一渲染器，保证 scope 与 find 的差异只在判据本身 */
function andGroups(...groups: Array<PredicateGroup | undefined>): PredicateGroup | undefined {
  const live = groups.filter((g): g is PredicateGroup => g !== undefined);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  return { op: "and", conditions: live };
}

/** 聚合列的渲染 + 规则校验（r8 F1）：别名唯一、count 之外必须给列、select 不得与 agg 混排 */
function renderAggs(pred: Predicate): string[] {
  const aggs = pred.agg ?? [];
  if (aggs.length === 0) return [];
  if (pred.select.length > 0) {
    throw new Error("predicate mixes select columns with agg without GROUP BY (renders invalid SQL on PG) — use agg-only");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of aggs) {
    const col = a.col ? ident(a.col, "agg column") : "*";
    if (col === "*" && a.fn !== "count") throw new Error(`predicate agg ${a.fn} needs a column (only count allows *)`);
    const alias = ident(a.as ?? `${a.fn}_${a.col ?? "all"}`, "agg alias");
    if (seen.has(alias)) throw new Error(`predicate agg alias ${JSON.stringify(alias)} is duplicated — aliases must be unique`);
    seen.add(alias);
    out.push(`${a.fn.toUpperCase()}(${col}) AS ${alias}`);
  }
  return out;
}

export interface RenderedPredicate {
  findSql: string;
  scopeSql: string;
}

/**
 * 从同一谓词 AST 渲染两段查询（裁定「同源生成」，r5 S2 / R3）：
 * scan 域**同一次渲染**进两侧（find 与 scope 的 FROM/域过滤逐字相同），where 判据只进 find，
 * rows_scanned 因此是「域内看了多少行」而不是「判据命中多少行」。
 * 纯聚合形态（agg 非空、select 为空）产出 `SELECT SUM(x) AS sum_x ...`，报告可比对聚合值（r8 F1）。
 */
export function renderPredicate(pred: Predicate): RenderedPredicate {
  const { from, whereSql, scanSql } = renderScan(pred);
  const aggs = renderAggs(pred);
  const plain = pred.select.map((c) => ident(c, "select column"));
  const cols = [...plain, ...aggs];
  if (cols.length === 0) {
    throw new Error("predicate.select must list at least one column (or use agg for an aggregate query)");
  }
  const select = cols.join(", ");
  return {
    findSql: `SELECT ${select} FROM ${from}${whereSql}`,
    scopeSql: `SELECT count(*) AS n FROM ${from}${scanSql}`,
  };
}

/** 谓词形态的聚合别名（sql-pair 谓词侧 / count 谓词形态用） */
export function aggAliasOf(pred: Predicate, index = 0): string {
  const a = (pred.agg ?? [])[index];
  if (!a) throw new Error("predicate has no agg column at index " + index);
  return a.as ?? `${a.fn}_${a.col ?? "all"}`;
}

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

/** 1.2 shapes must not sneak into a spec that declares 1.1: new capabilities
 *  are only admissible under the version that froze them (`version_shape`). */
function uses12Shapes(spec: VerifySpec): boolean {
  const hasColRef = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    const n = node as { value?: unknown; conditions?: unknown[]; where?: unknown; scan?: unknown; predicate?: unknown };
    if (n.value && typeof n.value === "object" && !Array.isArray(n.value)) {
      if (typeof (n.value as { col?: unknown }).col === "string") return true;
    }
    if ((n.conditions ?? []).some(hasColRef)) return true;
    return hasColRef(n.where) || hasColRef(n.scan) || hasColRef(n.predicate);
  };
  const hasAgainst = (node: unknown): boolean =>
    !!node && typeof node === "object" && (node as { against?: unknown }).against !== undefined;
  return (spec.vu ?? []).some((vu) => {
    const c = vu.checker as { predicate?: unknown; against?: unknown };
    return hasAgainst(c) || hasColRef(c.predicate);
  });
}

export async function runVerify(spec: VerifySpec, opts: VerifyOptions): Promise<VerifyReport> {
  // 契约钉版：旧 spec 不会"大概能跑"——形状变了必须升版重出。1.2 起，
  // 1.1 的 spec 仍可跑（向后兼容），但不得携带 1.2 才冻结的形态。
  if (spec.contract_version === "1.1") {
    if (uses12Shapes(spec)) {
      throw new Error(
        "version_shape: this spec declares contract_version 1.1 but uses 1.2-only shapes ({col} right-hand side / count.against) — bump the spec to 1.2"
      );
    }
  } else if (spec.contract_version !== CONTRACT_VERSION) {
    throw new Error(`unsupported contract_version ${String(spec.contract_version)} — this engine implements ${CONTRACT_VERSION}`);
  }
  const fopts: FactContext = { ...opts, expectedMaterialsSha: spec.materials_sha256 };
  const now = opts.nowIso ?? (() => new Date().toISOString());
  const started = now();
  const runId = opts.runId ?? `run_${randomBytes(8).toString("hex")}`;
  // N2：sql 文本不支持占位展开（$vu: 只允许出现在 count.from / sql-pair 的侧引用）
  for (const vu of spec.vu) {
    const c = vu.checker as { sql?: string; scope_sql?: string };
    if (/\$/.test(`${c.sql ?? ""} ${c.scope_sql ?? ""}`)) {
      throw new Error(`${vu.id}: "$" in sql text is not supported — pipeline refs belong to count.from / sql-pair sides (no placeholder expansion)`);
    }
  }
  const orderResult = topoOrder(spec.vu);
  if ("cycle" in orderResult) {
    throw new Error(`pipeline cycle detected among: ${orderResult.cycle.join(", ")}`);
  }
  // R13：as_of 必须锚定——时间函数在构造期拒绝（NOW()/CURRENT_TIMESTAMP 无法重放）
  // 形态：now( / now () / CURRENT_TIMESTAMP（关键字可无括号）/ CURRENT_DATE / CURRENT_TIME；
  // 词边界两侧都排掉标识符（current_timestamp_utc 不算），注释先剥（注释里的 now 不误伤）。
  const timeFn = /(^|[^A-Za-z0-9_])(now\s*\(|'now'|"now"|(current_timestamp|current_date|current_time)(?![A-Za-z0-9_]))/i;
  for (const vu of spec.vu) {
    const c = vu.checker as { sql?: string; scope_sql?: string; as_of?: unknown };
    const text = stripSqlComments(`${c.sql ?? ""} ${c.scope_sql ?? ""}`);
    if (timeFn.test(text)) {
      throw new Error(`${vu.id}: non-deterministic time function in sql — freeze the timestamp via as_of/parameters (R13)`);
    }
    // as_of 必须可锚定：只声明 as_of 却没有任何 scope 过滤 = 无法证明"取的是那一刻的数据"
    if (vu.expected_from && typeof vu.expected_from === "object" && "as_of" in vu.expected_from) {
      const scoped = Boolean(c.scope_sql) || /\bas\s+of\b/i.test(text);
      if (!scoped) {
        throw new Error(`${vu.id}: expected_from.as_of requires scope_sql (or an explicit AS OF clause) — as_of alone is not replayable (N6)`);
      }
    }
  }
  // S2：scope_sql 与 sql 必须落在同一批表上——否则"批次过滤"和"违规查询"各查各的表，能冒充同批
  for (const vu of spec.vu) {
    const c = vu.checker as { sql?: string; scope_sql?: string };
    if (!c.sql || !c.scope_sql) continue;
    const sqlTables = extractTables(c.sql);
    const scopeTables = extractTables(c.scope_sql);
    const disjoint = sqlTables.length > 0 && scopeTables.length > 0 && scopeTables.every((t) => !sqlTables.includes(t));
    if (disjoint) {
      throw new Error(`${vu.id}: scope_sql reads ${scopeTables.join(", ")} while sql reads ${sqlTables.join(", ")} — no shared table means the "batch" is not the one being checked (S2)`);
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
      outcome = await runFactChecker(vu, fopts, outputs);
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
      const st = sqlTextOf(vu.checker);
      if (st) outputs.set(vu.id, safeQuery(opts.runner, st));
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
    spec_id: spec.spec_id,
    started,
    finished: now(),
    verifier: {
      mode: opts.mode ?? "open",
      binary_sha256: opts.binarySha256,
      engine_version: opts.engineVersion ?? "0.1.0",
      spec_version: spec.spec_version,
      corpus_version: spec.verifier.corpus_version,
      sealed_review: spec.sealed.review,
      ...(opts.signature ? { signature: opts.signature } : {}),
      ...(opts.signingScheme ? { signing_scheme: opts.signingScheme } : {}),
      ...(opts.publicKeyFingerprint ? { public_key_fingerprint: opts.publicKeyFingerprint } : {}),
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
    const st = sqlTextOf(vu.checker);
    if (!st) return { rows: [], error: "sql checker needs either predicate or sql text" };
    try {
      return { rows: runner.query(st) };
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
  // 序列化走 canonical JSON（N4/R10）：键序、数字形态、Unicode 都逐字节确定，
  // 与 Rust 实现共用同一套规则（corpus/canonical/vectors.json 是跨实现锚）。
  return `sha256:${createHash("sha256").update(canonicalStringify(clone)).digest("hex")}`;
}
