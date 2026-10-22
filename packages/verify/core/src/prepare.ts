/**
 * verify prepare（M13-1 轨 B）：材料 → 可执行 spec 的构造面。
 *
 * 五阶段（docs/verify-contract.md §1.5 与 tmp/prepare-contract-draft.md）：
 *   P0 材料冻结（调用方给 text + sha256；本模块只校验，不读盘）
 *   P1 判据抽取（模型 proposer 只做"原文摘录 + 锚点"）
 *   P2 翻译成 VU（只允许谓词 AST；形状/时间函数/占位符/compare 全部构造期校验）
 *   P3 盲审（≤3 轮，fail-closed：reject/unclear/缺问都不落 ready）
 *   P4 红队门禁（由调用方注入，因为要真库/真附件）
 *   P5 冻版（spec_version 自增、materials_sha256 绑定、报告带拒绝清单）
 */
import { createHash } from "node:crypto";

import { validateCompareSpec } from "./compare";
import { CONTRACT_VERSION, CORPUS_VERSION } from "./contract";
import { containsVerbatim, renderPredicate, renderScan } from "./engine";
import type {
  Checker,
  FileChecker,
  Predicate,
  ReviewFinding,
  ReviewRunner,
  SqlChecker,
  VerifySpec,
  VerifyUnit,
} from "./contract";

/** 材料索引：每个附件的冻结记录（P0 的产物，调用方负责生成） */
export interface MaterialFile {
  path: string;
  sha256: string;
  mime: string;
  /** 附件字节数（fdc F3：落 spec.attachments.size） */
  size?: number;
  /** 提取出的文本（xlsx 逐行、pdf 逐页、图片 OCR）；用于逐字复读与 locator 归属 */
  text?: string;
  /** 该文本里可被引用的 locator 集合（如 "bills!B7"、"p3"） */
  locators?: string[];
}

export interface MaterialIndex {
  files: MaterialFile[];
  /** 拼好的可复读全文（顺序稳定，同一 index 必得同一全文） */
  text: string;
}

/** 目标库 schema 探针结果（prepare 只读 schema，不取数） */
export interface SchemaProbe {
  tables: Record<string, string[]>;
}

export interface PrepareCandidate {
  source_clause: string;
  anchor: { quote: string; locator: string };
  expected_from?: { quote: string; locator: string };
  title?: string;
  severity?: "S1" | "S2" | "S3";
  checker: Checker;
  /** execute 型（command/agent）在 prepare 期需要显式声明，默认拒绝（封包边界） */
  requires_execution?: boolean;
}

export interface PrepareRequest {
  materialText: string;
  materialIndex?: MaterialIndex;
  hint?: string;
  schemaProbe?: SchemaProbe;
  /** 第几轮（1 起）；同一轮请求必须可复现 */
  round: number;
  /** 上一轮被拒原因的摘要（模型据此修正，不得看到评审原文） */
  feedback?: string[];
}

export interface PrepareRunner {
  prepare(req: PrepareRequest): Promise<PrepareCandidate[]>;
}

export interface RejectedCandidate {
  source_clause: string;
  stage: "P1" | "P2" | "P3";
  reason: string;
}

export interface PrepareOptions {
  /** 条件④：冻结时刻（快照口径）——必须由调用方给；快照容不得「现在」 */
  asOf: VerifySpec["as_of"];
  /** 条件④：同一材料的第 N 次冻结由调用方递增 */
  specVersion?: number;
  engineVersion?: string;
  corpusVersion?: string;
  runner: PrepareRunner;
  /** 盲审器；缺失时不允许落 ready（review 层是构造正确性的一半） */
  reviewer?: ReviewRunner;
  maxRounds?: number;
  nowIso?: () => string;
  /** 红队门禁：调用方注入（要真库/真附件）；返回失败项，空数组才算过 */
  redteam?: (spec: VerifySpec) => Promise<string[]> | string[];
  materialIndex?: MaterialIndex;
  schemaProbe?: SchemaProbe;
  hint?: string;
  specId?: string;
  title?: string;
  domain?: string;
  /** #34: named exemptions (clause id or exact text, never a line number) for
   *  declared clauses that no VU should cover; every other clause must be
   *  claimed by a frozen VU. */
  coverageExempt?: CoverageExemption[];
  /** #34: the clause pattern (first capture group = clause id); default
   *  DEFAULT_CLAUSE_PATTERN, the fleet convention `^([A-Z]+[0-9]+) `. */
  clausePattern?: RegExp;
  /** #34: the pattern was declared for this material (material.json
   *  `clause_pattern`) — then matching no line is an error, not a skip. */
  clausePatternDeclared?: boolean;
  /** #34: the source_clauses the caller's review file carries; one that no
   *  candidate claims is an orphan review and blocks ready (P3). */
  reviewedClauses?: string[];
  /** 之前已冻结的 materials_sha256 集合（防"旧材料重放"） */
  knownMaterialHashes?: string[];
}

export interface PrepareResult {
  verdict: "ready" | "needs-material" | "error";
  spec?: VerifySpec;
  units: VerifyUnit[];
  rejected: RejectedCandidate[];
  rounds: number;
  materials_sha256: string;
  /** 机器可读的诊断（CLI 的 --json 直接吐它） */
  diagnostics: Array<{ stage: string; message: string }>;
  /** #34: clause coverage the run was judged with (absent when nothing survived to be judged) */
  coverage?: CoverageResult;
}

const UNDECIDABLE = /(应尽量|尽量|建议|合理|酌情|视情况|适当)/;

/** 锚点 → 契约里的 ExpectedFrom（kind=material-extract，source_id 固定为冻结材料） */
function expectedFromOf(c: PrepareCandidate): VerifyUnit["expected_from"] {
  const anchor = c.expected_from ?? c.anchor;
  return { kind: "material-extract", source_id: "materials", anchor: anchor.locator, quote: anchor.quote };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function hasTimeFunction(sql: string): boolean {
  const stripped = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  return /(^|[^A-Za-z0-9_])(now\s*\(|'now'|"now"|(current_timestamp|current_date|current_time)(?![A-Za-z0-9_]))/i.test(stripped);
}

/** P1：判据必须能在冻结材料里逐字找到，锚点必须落在 material_index 声明的 locator 上 */
function p1(c: PrepareCandidate, materialText: string, index?: MaterialIndex, inventory?: ClauseInventory): string | null {
  if (!c.source_clause || !containsVerbatim(materialText, c.source_clause)) {
    return "source_clause is not a verbatim excerpt of the frozen materials (fabricated criterion)";
  }
  if (!c.anchor?.quote || !containsVerbatim(materialText, c.anchor.quote)) {
    return "anchor.quote is not a verbatim excerpt of the frozen materials (mis-transcription)";
  }
  if (!c.anchor.locator) return "anchor.locator is required";
  if (index?.files.length) {
    const locators = new Set(index.files.flatMap((f) => f.locators ?? []));
    if (locators.size > 0 && !locators.has(c.anchor.locator)) {
      return `anchor.locator ${JSON.stringify(c.anchor.locator)} is not declared by the material index (wrong cell/page?)`;
    }
  }
  const locErr = checkLocator(c.anchor.locator, c.anchor.quote, inventory ?? clauseInventory(materialText));
  if (locErr) return locErr;
  if (UNDECIDABLE.test(c.source_clause)) {
    return "criterion contains undecidable wording (应尽量/建议/合理/酌情) — machine cannot judge it";
  }
  return null;
}

/** GitHub #34 (follow-up to 0.114.1): frozen-material clause scope **by rule**.
 *
 *  A clause is a material line that matches the clause pattern; the pattern's
 *  first capture group is the clause id. The default is the fleet convention
 *  `^([A-Z]+[0-9]+) ` (an id, then a space: `S1 …`, `P12 …`); a material may
 *  declare its own at submit time (`material.json` `clause_pattern`, frozen
 *  with the material). Titles, `##` headings, blank lines and prose
 *  (`验收对象：…`) are out of scope by rule — never by exemption.
 *  No matching line is never a silent OK (SKIP ≠ OK): under a declared pattern
 *  it is a coverage problem (misconfigured pattern); under the default it is a
 *  named skip (`no clause lines matched pattern …`, `coverage.enforced:false`)
 *  instead of inventing clauses out of prose (the 0.114.1 regression).
 *
 *  Locator grammar (the fragment after the last `#`, file prefix optional):
 *    `#<id>`      — a declared clause id; resolved first, so `#S1`/`#L2` are ids;
 *    `#line=<n>`  — physical line n (1-based) of the frozen material.
 *  When the material declares clauses, any other `#fragment` is a P1 rejection
 *  (a typo or a stale id must not pass as an unverified anchor). Locators
 *  without `#` (`bills!B7`, `p3`) stay governed by the material index. */
export const DEFAULT_CLAUSE_PATTERN = /^([A-Z]+[0-9]+) /;

export interface CoverageExemption {
  /** clause id (`S3`) */
  id?: string;
  /** `#S3` / `material.md#S3` — must resolve as a clause id; `#line=<n>` is refused */
  locator?: string;
  /** exact clause line text (trimmed) */
  text?: string;
  reason?: string;
}

export interface MaterialClause {
  id: string;
  locator: string;
  text: string;
  /** physical line (1-based), for humans only — never an anchor */
  line: number;
}

export interface ClauseInventory {
  pattern: string;
  clauses: MaterialClause[];
  /** physical lines of the material (for `#line=<n>`) */
  lines: string[];
  /** declaration problems (duplicate ids) */
  problems: string[];
}

/** Validate a caller-supplied clause pattern (string or RegExp); it needs a
 *  capture group for the id. Returns the RegExp or a usage error message. */
export function compileClausePattern(p: string | RegExp | undefined): RegExp | string {
  if (p === undefined) return DEFAULT_CLAUSE_PATTERN;
  let re: RegExp;
  try {
    re = typeof p === "string" ? new RegExp(p) : p;
  } catch (e) {
    return `clause pattern ${JSON.stringify(String(p))} is not a valid regular expression: ${(e as Error).message}`;
  }
  const flags = re.flags.replace(/[gy]/g, "");
  // an alternation with the empty string always matches; its length = groups + 1
  if (new RegExp(`(?:${re.source})|`, flags).exec("")!.length < 2) {
    return `clause pattern ${JSON.stringify(re.source)} needs a capture group for the clause id, e.g. "^([A-Z]+[0-9]+) "`;
  }
  return new RegExp(re.source, flags);
}

export function clauseInventory(materialText: string, pattern: RegExp = DEFAULT_CLAUSE_PATTERN): ClauseInventory {
  const lines = materialText.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop(); // trailing newline ends the last line
  const clauses: MaterialClause[] = [];
  const problems: string[] = [];
  const firstLine = new Map<string, number>();
  lines.forEach((raw, i) => {
    const m = pattern.exec(raw);
    const id = m?.[1]?.trim();
    if (!m || !id) return;
    const prev = firstLine.get(id);
    if (prev !== undefined) {
      problems.push(`clause id ${id} is declared more than once (lines ${prev} and ${i + 1}) — ids must be unique`);
      return;
    }
    firstLine.set(id, i + 1);
    clauses.push({ id, locator: `#${id}`, text: raw.trim(), line: i + 1 });
  });
  return { pattern: pattern.source, clauses, lines, problems };
}

/** Back-compat name (0.114.1): now the declared-clause list, not every line. */
export function materialClauses(materialText: string, pattern?: RegExp): MaterialClause[] {
  return clauseInventory(materialText, pattern).clauses;
}

export type LocatorRef = { kind: "clause"; clause: MaterialClause } | { kind: "line"; line: number } | { kind: "unresolved"; fragment: string } | null;

/** Resolve a locator against the inventory; null = no `#` fragment (index-governed). */
export function resolveLocator(locator: string, inv: ClauseInventory): LocatorRef {
  if (typeof locator !== "string") return null;
  const at = locator.lastIndexOf("#");
  if (at < 0) return null;
  const fragment = locator.slice(at + 1);
  const clause = inv.clauses.find((c) => c.id === fragment);
  if (clause) return { kind: "clause", clause };
  const lm = /^line=([0-9]+)$/.exec(fragment);
  if (lm) return { kind: "line", line: Number(lm[1]) };
  return { kind: "unresolved", fragment };
}

function checkLocator(locator: string, quote: string, inv: ClauseInventory): string | null {
  const ref = resolveLocator(locator, inv);
  if (!ref) return null;
  const q = quote.trim();
  if (ref.kind === "clause") {
    if (!ref.clause.text.includes(q) && !q.includes(ref.clause.text)) {
      return `anchor.locator ${JSON.stringify(locator)} is clause ${ref.clause.id} ("${ref.clause.text.slice(0, 30)}") but the quoted text is not in that clause`;
    }
    return null;
  }
  if (ref.kind === "line") {
    const text = (inv.lines[ref.line - 1] ?? "").trim();
    if (ref.line < 1 || ref.line > inv.lines.length) {
      return `anchor.locator ${JSON.stringify(locator)} names line ${ref.line} but the frozen material has ${inv.lines.length} line(s)`;
    }
    if (!text) return `anchor.locator ${JSON.stringify(locator)} names line ${ref.line}, which is blank`;
    if (!text.includes(q) && !q.includes(text)) {
      return `anchor.locator ${JSON.stringify(locator)} is line ${ref.line} ("${text.slice(0, 30)}") but the quoted text is not on that line`;
    }
    return null;
  }
  // No declared clauses → nothing to resolve an id against (0.114.0 behaviour:
  // the fragment is unverified, not invented). With clauses, it must resolve.
  if (inv.clauses.length === 0) return null;
  const ids = inv.clauses.map((c) => c.id);
  return `anchor.locator ${JSON.stringify(locator)} names clause ${JSON.stringify(ref.fragment)}, which the frozen material does not declare (${ids.length} clause(s): ${ids.slice(0, 12).join(", ")}${ids.length > 12 ? ", …" : ""}); use #<clause id> or #line=<n>`;
}

export interface CoverageResult {
  /** clause pattern in force (source) */
  pattern: string;
  /** false when no material line matched the pattern — a named skip, not an OK */
  enforced: boolean;
  clauses: number;
  covered: number;
  exempted: number;
  uncovered: Array<{ id: string; locator: string; line: number; text: string }>;
  problems: string[];
}

/** Every declared clause must be claimed by a P1-passing candidate — one whose
 *  anchor.locator resolves to that clause (or its line), or whose source_clause
 *  contains the whole clause line — or be named in an exemption. A fragment
 *  quote without a resolving locator claims nothing (`S1` must not cover `S10`). */
export function checkCoverage(
  materialText: string,
  candidates: PrepareCandidate[],
  exempt: CoverageExemption[] = [],
  pattern: RegExp = DEFAULT_CLAUSE_PATTERN,
  /** the pattern was declared for this material (not the default) */
  declared = false,
): CoverageResult {
  const inv = clauseInventory(materialText, pattern);
  const problems = [...inv.problems];
  if (declared && inv.clauses.length === 0) {
    problems.push(`no clause lines matched pattern ${inv.pattern} — the material declared this pattern, so an empty clause set is a misconfiguration, not a pass`);
  }
  const covered = new Set<string>();
  for (const c of candidates) {
    const sc = String(c?.source_clause ?? "").trim();
    const ref = resolveLocator(String(c?.anchor?.locator ?? ""), inv);
    for (const clause of inv.clauses) {
      const byRef = (ref?.kind === "clause" && ref.clause.id === clause.id) || (ref?.kind === "line" && ref.line === clause.line);
      if (byRef || (sc && sc.includes(clause.text))) covered.add(clause.id);
    }
  }
  const exempted = new Set<string>();
  for (const [i, e] of exempt.entries()) {
    const label = JSON.stringify(e?.id ?? e?.locator ?? e?.text);
    let clause: MaterialClause | undefined;
    if (typeof e?.id === "string") clause = inv.clauses.find((x) => x.id === e.id);
    else if (typeof e?.locator === "string") {
      const ref = resolveLocator(e.locator.includes("#") ? e.locator : `#${e.locator}`, inv);
      if (ref?.kind === "line") {
        problems.push(`coverage exemption #${i} (${label}) anchors on a line number — exemptions name a clause id or its exact text, so an edit above it cannot retarget them`);
        continue;
      }
      if (ref?.kind === "clause") clause = ref.clause;
    } else if (typeof e?.text === "string") clause = inv.clauses.find((x) => x.text === e.text!.trim());
    else {
      problems.push(`coverage exemption #${i} names no clause (expected { id | locator | text, reason })`);
      continue;
    }
    if (!clause) {
      problems.push(`coverage exemption #${i} (${label}) names no declared clause (${inv.clauses.length} clause(s) match ${inv.pattern})`);
      continue;
    }
    if (typeof e.reason !== "string" || !e.reason.trim()) {
      problems.push(`coverage exemption #${i} (${clause.id}) needs a reason — an unnamed exemption is not auditable`);
      continue;
    }
    if (covered.has(clause.id)) {
      problems.push(`coverage exemption #${i} (${clause.id}) exempts a clause a candidate already covers — drop the exemption`);
      continue;
    }
    exempted.add(clause.id);
  }
  const uncovered = inv.clauses
    .filter((c) => !covered.has(c.id) && !exempted.has(c.id))
    .map((c) => ({ id: c.id, locator: c.locator, line: c.line, text: c.text }));
  return { pattern: inv.pattern, enforced: inv.clauses.length > 0, clauses: inv.clauses.length, covered: covered.size, exempted: exempted.size, uncovered, problems };
}

/** The named skip for a material whose lines match no clause pattern. */
export function noClauseLinesMessage(pattern: string): string {
  return `no clause lines matched pattern ${pattern} — clause coverage not enforced (a skip, not a pass): number criteria "<id> <text>" or declare the pattern with submit --clause-pattern`;
}

/** GitHub #34 negative fixture "orphan review": a review whose source_clause no
 *  candidate carries means a criterion was dropped or renamed after review — the
 *  1:1 candidate↔review pairing is part of the construction evidence. */
export function orphanReviews(candidates: Array<{ source_clause?: unknown }>, reviewedClauses: string[]): string[] {
  const claimed = new Set(candidates.map((c) => String(c?.source_clause ?? "")));
  return reviewedClauses.filter((s) => !claimed.has(s));
}

/** P2 子步骤：谓词里的表/列必须在探针里存在（E5②/E5⑤：sql、sql-pair、count、exists 共用） */
const PREDICATE_OPS = new Set(["=", "!=", ">", ">=", "<", "<=", "in", "between", "is null", "is not null"]);
const GROUP_OPS = new Set(["and", "or", "not"]);

/** GitHub #19: the op value is interpolated into SQL, so an unknown op is an
 *  injection surface (arbitrary fragments/subqueries). Typed closed set at the
 *  construction gate; engine's renderCondition enforces the same set again. */
function validatePredicateOps(n: unknown): string | null {
  if (!n || typeof n !== "object") return null;
  const node = n as { op?: unknown; conditions?: unknown[] };
  if (typeof node.op === "string") {
    if (GROUP_OPS.has(node.op)) {
      for (const c of node.conditions ?? []) {
        const err = validatePredicateOps(c);
        if (err) return err;
      }
      return null;
    }
    if (!PREDICATE_OPS.has(node.op)) {
      return `unknown predicate op ${JSON.stringify(node.op)} — closed set is ${[...PREDICATE_OPS].join(", ")}`;
    }
  }
  for (const c of node.conditions ?? []) {
    const err = validatePredicateOps(c);
    if (err) return err;
  }
  return null;
}

function checkPredicateSchema(pred: Predicate, schema: SchemaProbe, label = "predicate"): string | null {
  const table = pred.from;
  const cols = schema.tables[table];
  const opErr = validatePredicateOps(pred.where as unknown);
  if (opErr) return `${label}: ${opErr}`;
  if (pred.scan) {
    const scanErr = validatePredicateOps(pred.scan as unknown);
    if (scanErr) return `${label}: ${scanErr}`;
  }
  if (!cols) {
    return `${label}.from ${JSON.stringify(table)} is not in the probed schema (tables: ${Object.keys(schema.tables).slice(0, 8).join(", ")})`;
  }
  const wanted = [...pred.select];
  const collect = (n: unknown): string[] => {
    if (!n || typeof n !== "object") return [];
    const node = n as { col?: string; conditions?: unknown[]; value?: unknown };
    const out: string[] = [];
    if (typeof node.col === "string") out.push(node.col);
    // 1.2: `value:{col}` is a column reference too — the rhs must exist in the
    // same probed table (a missing rhs column would otherwise surface as a
    // runtime "no such column" instead of a construction rejection).
    const v = node.value;
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { col?: unknown }).col === "string") {
      out.push((v as { col: string }).col);
    }
    for (const c of node.conditions ?? []) out.push(...collect(c));
    return out;
  };
  wanted.push(...collect(pred.where as unknown));
  wanted.push(...collect(pred.scan as unknown));
  for (const a of pred.agg ?? []) if (a.col) wanted.push(a.col);
  for (const raw of wanted) {
    const col = String(raw).includes(".") ? String(raw).split(".")[1] : String(raw);
    if (!cols.includes(col)) return `${label} column ${JSON.stringify(raw)} is not in ${table} (columns: ${cols.slice(0, 10).join(", ")})`;
  }
  return null;
}

/** P2：只允许谓词 AST；形状/时间函数/占位符/schema 归属全部构造期校验 */
function p2(c: PrepareCandidate, schema?: SchemaProbe): string | null {
  const checker = c.checker as Checker;
  if (!checker || typeof checker !== "object" || !("type" in checker)) return "checker is missing or malformed";
  // 0.110.0: an unknown checker.type used to fall through every branch and
  // "pass" P2 (then only the engine rejected it later). The closed set is
  // contract 1.x; lint-candidates relies on this same gate (single projection).
  const KNOWN_CHECKERS = ["sql", "sql-pair", "count", "exists", "file", "command", "agent"];
  if (!KNOWN_CHECKERS.includes(String((checker as { type?: unknown }).type))) {
    return `unknown checker type ${JSON.stringify((checker as { type?: unknown }).type)} — the closed set is ${KNOWN_CHECKERS.join(", ")}`;
  }

  if (checker.type === "sql") {
    const sqlChecker = checker as SqlChecker;
    if (sqlChecker.sql) {
      return 'hand-written sql is not allowed in prepared specs — use predicate (authored:"manual" is for reviewed exceptions only)';
    }
    if (!sqlChecker.predicate) return "sql checker needs a predicate";
    const predicate = sqlChecker.predicate as Predicate;
    // r9 E2：sql 型是行集检查器，带 agg 就恒定一行——聚合对必须写成 sql-pair 双侧谓词
    if ((predicate.agg ?? []).length > 0) {
      return "sql predicate must not carry agg — an aggregate is always one row; use sql-pair with two predicate sides";
    }
    const text = JSON.stringify(predicate);
    if (text.includes("$vu:")) return '"$vu:" refs are not allowed inside a predicate — pipeline refs belong to count.from / sql-pair sides';
    try {
      const rendered = renderPredicate(predicate);
      if (hasTimeFunction(rendered.findSql)) return "predicate renders a time function (now()/current_timestamp) — not replayable";
    } catch (e) {
      return (e as Error).message;
    }
    if (schema) {
      const schemaErr = checkPredicateSchema(predicate, schema);
      if (schemaErr) return schemaErr;
    }
  }

  // F1：sql-pair 的两侧——谓词侧必须恰好一列 agg；compare 走同一套校验
  if (checker.type === "sql-pair") {
    const pair = checker as { left: unknown; right: unknown; compare: unknown };
    for (const [name, side] of [["left", pair.left], ["right", pair.right]] as const) {
      const pred = (side as { predicate?: Predicate }).predicate;
      if (!pred) continue;
      if ((pred.agg ?? []).length !== 1) return `sql-pair ${name} predicate side needs exactly one agg column`;
      try {
        renderPredicate(pred);
      } catch (e) {
        return `sql-pair ${name}: ${(e as Error).message}`;
      }
      // E5②：谓词侧同样要过 schema 探针（否则聚合列写错只会跑出 NULL）
      if (schema) {
        const schemaErr = checkPredicateSchema(pred, schema, `sql-pair ${name}`);
        if (schemaErr) return schemaErr;
      }
    }
    const errs = validateCompareSpec(pair.compare as never);
    if (errs.length) return `invalid compare spec: ${errs.join("; ")}`;
  }

  // E5①：count/exists 只允许谓词形态——手写 sql 在 prepare 里没有合法来源
  if (checker.type === "count" || checker.type === "exists") {
    if ((checker as { sql?: string }).sql) {
      return `${checker.type} sql form is not allowed in prepared specs — use the predicate form (mechanical generation only)`;
    }
    // 1.2: count.against must name an existing table/column and carry agg.
    const against = (checker as { against?: { from?: string; col?: string; agg?: string } }).against;
    if (against) {
      if (!against.agg) {
        return "count.against requires agg (max|min|sum|count) — missing_agg (no default is applied, so spec validity never depends on data)";
      }
      if (!against.from || !against.col) return "count.against needs {from, col, agg}";
      if (!["max", "min", "sum", "count"].includes(against.agg)) return `count.against agg ${JSON.stringify(against.agg)} is not one of max|min|sum|count`;
      if (schema) {
        const cols = schema.tables[against.from];
        if (!cols) return `count.against.from ${JSON.stringify(against.from)} is not in the probed schema (tables: ${Object.keys(schema.tables).slice(0, 8).join(", ")})`;
        if (!cols.includes(against.col)) return `count.against column ${JSON.stringify(against.col)} is not in ${against.from} (columns: ${cols.slice(0, 10).join(", ")})`;
      }
    }
    const pred = (checker as { predicate?: Predicate }).predicate;
    if (pred) {
      const text = JSON.stringify(pred);
      if (text.includes("$vu:")) return '"$vu:" refs are not allowed inside a predicate — pipeline refs belong to count.from / sql-pair sides';
      try {
        const rendered = renderScan(pred);
        if (hasTimeFunction(rendered.whereSql) || hasTimeFunction(rendered.scanSql)) return "predicate renders a time function (now()/current_timestamp) — not replayable";
      } catch (e) {
        return (e as Error).message;
      }
      if (schema) {
        const schemaErr = checkPredicateSchema(pred, schema, checker.type);
        if (schemaErr) return schemaErr;
      }
    }
  }
  // ④ walk ignore globs：排除面只减扫描域，构造期就把「通吃 / 越界」形态拒掉
  if (checker.type === "file") {
    const fc = checker as FileChecker;
    if (fc.glob === "*" || fc.glob === "**" || fc.glob === "**/*") {
      return 'file glob "*" matches everything and proves nothing';
    }
    for (const ig of fc.ignore ?? []) {
      if (typeof ig !== "string" || ig.trim() === "") return "file ignore entries must be non-empty strings";
      if (ig.startsWith("/") || /^[A-Za-z]:/.test(ig) || ig.split(/[\/]/).includes("..")) {
        return `file ignore entry ${JSON.stringify(ig)} must be a relative path without ".."`;
      }
      if (ig === "*" || ig === "**" || ig === "**/*") return "file ignore glob may not match everything";
    }
  }
  if (c.requires_execution !== undefined) {
    return "requires_execution is only meaningful for agent checkers, which M13-1 rejects — fact checkers are re-runnable by construction";
  }
  if (checker.type === "agent") {
    return "agent checkers are out of scope for M13-1 (fact-only closed set) — prepare emits fact checkers; review-layer specs land with M13-1b";
  }
  if (checker.type === "command") return "command checkers are not allowed in prepared specs (execution surface) unless explicitly enabled";
  const compare = (checker as { compare?: unknown }).compare;
  if (compare) {
    const errs = validateCompareSpec(compare as never);
    if (errs.length) return `invalid compare spec: ${errs.join("; ")}`;
  }
  return null;
}

/** P3：盲审结论映射为"候选是否可进 spec"（fail-closed，与 run 期 judgeReview 同口径） */
/** 0.110.0 (可发现性): read-only shape check for candidates.
 *
 * Shares p1/p2 with prepareSpec so `verify lint-candidates` is the same gate as
 * prepare, not a lookalike: a candidate that lint rejects is exactly one prepare
 * would record as rejected (fdc757f6 pre-audit condition ⑤).
 * P1 needs the frozen material text; when it is not supplied that check is
 * skipped and reported (`p1_skipped:true`) rather than silently passing. */
export interface LintIssue {
  index: number;
  source_clause: string;
  stage: string;
  reason: string;
}

export interface LintResult {
  checked: number;
  p1_skipped: boolean;
  /** P2's schema sub-checks (columns/tables) need a probed snapshot; without
   *  `--db` they are skipped exactly like P1 without material text. */
  schema_skipped: boolean;
  ok: boolean;
  issues: LintIssue[];
  /** #34: frozen-material clause coverage (null when no material text was given) */
  coverage: CoverageResult | null;
  /** #34: material given but no line matched the (default) clause pattern —
   *  coverage was skipped, which is reported, not folded into `ok` silently */
  coverage_skipped: boolean;
}

export function lintCandidates(
  candidates: PrepareCandidate[],
  opts: {
    materialText?: string;
    materialIndex?: MaterialIndex;
    schema?: SchemaProbe;
    coverageExempt?: CoverageExemption[];
    clausePattern?: RegExp;
    clausePatternDeclared?: boolean;
    /** source_clauses of the review file, when given (`--reviews`) */
    reviewedClauses?: string[];
  } = {},
): LintResult {
  const issues: LintIssue[] = [];
  let coverage: CoverageResult | null = null;
  const p1Passing: PrepareCandidate[] = [];
  const pattern = opts.clausePattern ?? DEFAULT_CLAUSE_PATTERN;
  const inventory = opts.materialText !== undefined ? clauseInventory(opts.materialText, pattern) : undefined;
  candidates.forEach((c, index) => {
    let stage = "P1";
    let reason: string | null = null;
    if (opts.materialText !== undefined) reason = p1(c, opts.materialText, opts.materialIndex, inventory);
    if (!reason) {
      p1Passing.push(c);
      stage = "P2";
      reason = p2(c, opts.schema);
    }
    if (reason) issues.push({ index, source_clause: c.source_clause, stage, reason });
  });
  if (opts.materialText !== undefined) {
    // #34: coverage is judged on candidates that survived P1/P2 — a rejected
    // candidate cannot claim a clause, or the drop stays invisible.
    // #34: a clause is "claimed" once some candidate passed P1 (is a verbatim
    // clause claim). P2/P3 rejection already blocks ready on its own; coverage is
    // the orthogonal guard against a clause nobody even tried to assert.
    coverage = checkCoverage(opts.materialText, p1Passing, opts.coverageExempt ?? [], pattern, opts.clausePatternDeclared === true);
    for (const u of coverage.uncovered) {
      issues.push({ index: -1, source_clause: u.text, stage: "COVERAGE", reason: `clause ${u.id} is not covered by any candidate — add a candidate or declare a named exemption` });
    }
    for (const p of coverage.problems) issues.push({ index: -1, source_clause: "", stage: "COVERAGE", reason: p });
  }
  if (opts.reviewedClauses) {
    for (const s of orphanReviews(candidates, opts.reviewedClauses)) {
      issues.push({ index: -1, source_clause: s, stage: "REVIEW", reason: "orphan review: no candidate carries this source_clause (dropped or renamed criterion?)" });
    }
    const reviewed = new Set(opts.reviewedClauses);
    candidates.forEach((c, index) => {
      if (!reviewed.has(String(c?.source_clause ?? ""))) {
        issues.push({ index, source_clause: c.source_clause, stage: "REVIEW", reason: "candidate has no review (P3 would reject it: self-review incomplete)" });
      }
    });
  }
  return {
    checked: candidates.length,
    p1_skipped: opts.materialText === undefined,
    schema_skipped: opts.schema === undefined,
    ok: issues.length === 0,
    issues,
    coverage,
    coverage_skipped: coverage !== null && !coverage.enforced && !opts.clausePatternDeclared,
  };
}

async function p3(
  candidate: PrepareCandidate,
  index: number,
  reviewer: ReviewRunner,
  materialText: string,
  round: number,
): Promise<{ ok: boolean; reason?: string }> {
  const vu: VerifyUnit = {
    id: `C${index + 1}`,
    role: "assert",
    title: candidate.title ?? candidate.source_clause.slice(0, 40),
    severity: candidate.severity ?? "S1",
    source_clause: candidate.source_clause,
    checker: candidate.checker,
    expected_from: expectedFromOf(candidate),
  };
  const findings: ReviewFinding[] = await reviewer.review({
    vu,
    materials: materialText,
    blind: true,
    round,
  });
  const mine = findings.filter((f) => f.vu_id === vu.id);
  const byQ = new Map<string, ReviewFinding>();
  for (const f of mine) {
    if (!["ok", "reject", "unclear"].includes(String(f.verdict))) {
      return { ok: false, reason: `review returned unknown verdict ${JSON.stringify(f.verdict)}` };
    }
    const prev = byQ.get(f.question);
    if (prev && prev.verdict !== f.verdict) return { ok: false, reason: `conflicting review conclusions on ${f.question}` };
    byQ.set(f.question, f);
  }
  const missing = ["faithful", "decidable", "not-vacuous"].filter((q) => !byQ.has(q));
  if (missing.length) return { ok: false, reason: `self-review incomplete: no conclusion on ${missing.join(", ")}` };
  const rejected = [...byQ.entries()].filter(([, f]) => f.verdict === "reject");
  if (rejected.length) return { ok: false, reason: `self-review rejected: ${rejected.map(([q, f]) => `${q} — ${f.reason}`).join("; ")}` };
  const unclear = [...byQ.entries()].filter(([, f]) => f.verdict === "unclear");
  if (unclear.length) return { ok: false, reason: `self-review unclear: ${unclear.map(([q, f]) => `${q} — ${f.reason}`).join("; ")}` };
  const faithful = byQ.get("faithful")!;
  if (!faithful.anchor?.quote || !faithful.anchor.locator) return { ok: false, reason: "faithful conclusion carries no anchor" };
  if (!containsVerbatim(materialText, faithful.anchor.quote)) {
    return { ok: false, reason: "faithful anchor quote is not verbatim in the frozen materials (wrong cell or paraphrase)" };
  }
  return { ok: true };
}

/**
 * 主流水线：多轮 prepare（≤maxRounds），每轮 P1→P2→P3 过滤，最后 P4 红队 + P5 冻版。
 * 任一候选在任何阶段被拒都记进 rejected（带阶段与原因），不静默丢。
 *
 * GitHub #21：P1/P2 是**确定性**拒绝（同一候选跨轮必得同一结论），轮循环只为 P3 盲审重试而存在——
 * 因此确定性拒绝按内容键跨轮去重（保留首次顺序），且当一整轮没有任何候选进入 P3（全部确定性拒）
 * 时直接收敛，避免 1 候选 × 3 轮 → rejected=3 的重复记账。
 */
export async function prepareSpec(materialText: string, opts: PrepareOptions): Promise<PrepareResult> {
  const now = opts.nowIso ?? (() => new Date().toISOString());
  const materialsSha = sha256(materialText);
  const diagnostics: PrepareResult["diagnostics"] = [];
  const rejected: RejectedCandidate[] = [];
  const maxRounds = opts.maxRounds ?? 3;

  // P0：冻结校验——材料必须非空，且不与历史材料同哈希（防旧材料重放）
  if (!materialText.trim()) {
    return { verdict: "needs-material", units: [], rejected, rounds: 0, materials_sha256: materialsSha, diagnostics: [{ stage: "P0", message: "material text is empty" }] };
  }
  if (opts.knownMaterialHashes?.includes(materialsSha)) {
    diagnostics.push({ stage: "P0", message: "material hash already frozen in a previous spec — reusing it will not be accepted as a new baseline" });
  }
  if (!opts.reviewer) {
    return {
      verdict: "error",
      units: [],
      rejected,
      rounds: 0,
      materials_sha256: materialsSha,
      diagnostics: [{ stage: "P3", message: "no blind reviewer available — self-review is half of the construction contract; provide ReviewRunner" }],
    };
  }

  const kept: Array<{ candidate: PrepareCandidate; vu: VerifyUnit }> = [];
  const p1Passing: PrepareCandidate[] = [];
  const pattern = opts.clausePattern ?? DEFAULT_CLAUSE_PATTERN;
  const inventory = clauseInventory(materialText, pattern);
  const seenClauses = new Set<string>();
  let coverageResult: CoverageResult | undefined;
  // Deterministic-rejection dedupe key (#21): a replayed P1/P2 verdict is the
  // same fact, not a new rejection — round only exists for P3 retries.
  const rejectedKeys = new Set<string>();
  const pushDeterministic = (source_clause: string, stage: "P1" | "P2", reason: string) => {
    const key = `${stage} ${source_clause} ${reason}`;
    if (rejectedKeys.has(key)) return false;
    rejectedKeys.add(key);
    rejected.push({ source_clause, stage, reason });
    return true;
  };
  let round = 0;
  let feedback: string[] | undefined;
  while (round < maxRounds) {
    round++;
    const candidates = await opts.runner.prepare({
      materialText,
      materialIndex: opts.materialIndex,
      schemaProbe: opts.schemaProbe,
      hint: opts.hint,
      round,
      feedback,
    });
    feedback = [];
    let reachedP3 = 0;
    for (const [i, candidate] of candidates.entries()) {
      seenClauses.add(String(candidate?.source_clause ?? ""));
      const r1 = p1(candidate, materialText, opts.materialIndex, inventory);
      if (r1) {
        if (pushDeterministic(candidate.source_clause, "P1", r1)) feedback.push(r1);
        continue;
      }
      p1Passing.push(candidate);
      const r2 = p2(candidate, opts.schemaProbe);
      if (r2) {
        if (pushDeterministic(candidate.source_clause, "P2", r2)) feedback.push(r2);
        continue;
      }
      reachedP3++;
      const r3 = await p3(candidate, kept.length + i, opts.reviewer, materialText, round);
      if (!r3.ok) {
        rejected.push({ source_clause: candidate.source_clause, stage: "P3", reason: r3.reason ?? "rejected by self-review" });
        feedback.push(r3.reason ?? "rejected by self-review");
        continue;
      }
      const vu: VerifyUnit = {
        id: `V${kept.length + 1}`,
        role: "assert",
        title: candidate.title ?? candidate.source_clause.slice(0, 40),
        severity: candidate.severity ?? "S1",
        source_clause: candidate.source_clause,
        checker: candidate.checker,
        expected_from: expectedFromOf(candidate),
      };
      kept.push({ candidate, vu });
    }
    if (feedback.length === 0) break; // 全过，提前收敛
    if (kept.length > 0) break; // 有可用的就不再多轮（避免反复烧模型）
    // #21 short-circuit: nothing reached P3 this round → no candidate is left
    // for the blind-review retry loop; retrying would only duplicate facts.
    if (reachedP3 === 0) break;
  }

  if (kept.length > 0) {
    // #34: every declared clause must be claimed by a P1-passing candidate (or
    // exempted by id/text), and every review must pair with a candidate.
    const coverage = checkCoverage(materialText, p1Passing, opts.coverageExempt ?? [], pattern, opts.clausePatternDeclared === true);
    coverageResult = coverage;
    const orphans = orphanReviews([...seenClauses].map((source_clause) => ({ source_clause })), opts.reviewedClauses ?? []);
    if (coverage.uncovered.length || coverage.problems.length || orphans.length) {
      const diagnostics: Array<{ stage: string; message: string }> = coverage.uncovered.map((u) => ({
        stage: "P1c",
        message: `clause ${u.id} is not covered by any frozen VU: "${u.text.slice(0, 60)}" — add a candidate or declare --coverage-exempt (an unnamed drop must not freeze)`,
      }));
      diagnostics.push(...coverage.problems.map((p) => ({ stage: "P1c", message: p })));
      diagnostics.push(
        ...orphans.map((o) => ({ stage: "P3", message: `orphan review: no candidate carries source_clause "${o.slice(0, 60)}" — a reviewed criterion was dropped or renamed` })),
      );
      return {
        verdict: "error",
        units: kept.map((k) => k.vu),
        rejected,
        rounds: round,
        materials_sha256: materialsSha,
        diagnostics,
        coverage,
      };
    }
  }
  if (kept.length === 0) {
    return {
      verdict: "needs-material",
      units: [],
      rejected,
      rounds: round,
      materials_sha256: materialsSha,
      diagnostics: [{ stage: "P1-P3", message: "no candidate survived extraction/translation/self-review — ask the business expert for the missing material" }],
    };
  }

  const spec: VerifySpec = {
    contract_version: CONTRACT_VERSION,
    spec_id: opts.specId ?? `spec_${materialsSha.slice(0, 12)}`,
    // 条件④：版本由调用方递增（同一材料的第 N 次冻结），缺省 1 只对首次成立
    spec_version: opts.specVersion ?? 1,
    title: opts.title ?? "prepared spec",
    domain: opts.domain ?? "prepared",
    created: now(),
    runtime_min: "1",
    verifier: { engine_version: opts.engineVersion ?? "0.1.0", corpus_version: opts.corpusVersion ?? CORPUS_VERSION },
    // 条件④：as_of 由调用方给（快照口径必须指向真库副本的那个时刻，不是"现在"）
    as_of: opts.asOf,
    vu: kept.map((k) => k.vu),
    // fdc F3：附件级 sha256 落到 spec——同一文本不同二进制不能过重放
    attachments: (opts.materialIndex?.files ?? []).map((f) => ({ role: "baseline" as const, path: f.path, sha256: f.sha256, mime: f.mime, size: f.size ?? 0 })),
    // M13-1 冻结的是 fact 层：review 层（agent 复核）随 M13-1b 进入，报告标 sealed_review=false
    sealed: { review: false },
    materials_sha256: materialsSha,
  } as VerifySpec;

  // P4：红队门禁（调用方注入；未注入 = 未验证，不得落 ready）
  if (!opts.redteam) {
    return {
      verdict: "error",
      spec: undefined, // 条件③：未过红队一律不落可冻结 spec
      units: spec.vu,
      rejected,
      rounds: round,
      materials_sha256: materialsSha,
      diagnostics: [{ stage: "P4", message: "no red-team gate provided — a spec that was never run against adversarial input cannot be frozen" }],
    };
  }
  const failures = await opts.redteam(spec);
  if (failures.length) {
    return {
      verdict: "error",
      spec: undefined, // 条件③：红队失败不落盘，冻结是单向门
      units: spec.vu,
      rejected,
      rounds: round,
      materials_sha256: materialsSha,
      diagnostics: failures.map((f) => ({ stage: "P4", message: f })),
    };
  }

  // P5：冻版（#34: the clause scope the coverage gate ran with is part of the record）
  diagnostics.push({
    stage: "P1c",
    message: inventory.clauses.length
      ? `clause coverage: ${inventory.clauses.length} clause(s) match ${inventory.pattern}, all covered or exempted`
      : noClauseLinesMessage(inventory.pattern),
  });
  diagnostics.push({ stage: "P5", message: `frozen with ${spec.vu.length} units after ${round} round(s)` });
  return { verdict: "ready", spec, units: spec.vu, rejected, rounds: round, materials_sha256: materialsSha, diagnostics, coverage: coverageResult };
}
