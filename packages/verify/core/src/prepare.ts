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
import { containsVerbatim, renderPredicate, renderScan } from "./engine";
import type {
  Checker,
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
function p1(c: PrepareCandidate, materialText: string, index?: MaterialIndex): string | null {
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
  if (UNDECIDABLE.test(c.source_clause)) {
    return "criterion contains undecidable wording (应尽量/建议/合理/酌情) — machine cannot judge it";
  }
  return null;
}

/** P2：只允许谓词 AST；形状/时间函数/占位符/schema 归属全部构造期校验 */
function p2(c: PrepareCandidate, schema?: SchemaProbe): string | null {
  const checker = c.checker as Checker;
  if (!checker || typeof checker !== "object" || !("type" in checker)) return "checker is missing or malformed";

  if (checker.type === "sql") {
    const sqlChecker = checker as SqlChecker;
    if (sqlChecker.sql) {
      return 'hand-written sql is not allowed in prepared specs — use predicate (authored:"manual" is for reviewed exceptions only)';
    }
    if (!sqlChecker.predicate) return "sql checker needs a predicate";
    const predicate = sqlChecker.predicate as Predicate;
    const text = JSON.stringify(predicate);
    if (text.includes("$")) return '"$" in predicate text is not supported — pipeline refs belong to count.from / sql-pair sides';
    try {
      const rendered = renderPredicate(predicate);
      if (hasTimeFunction(rendered.findSql)) return "predicate renders a time function (now()/current_timestamp) — not replayable";
    } catch (e) {
      return (e as Error).message;
    }
    if (schema) {
      const table = predicate.from;
      const cols = schema.tables[table];
      if (!cols) {
        return `predicate.from ${JSON.stringify(table)} is not in the probed schema (tables: ${Object.keys(schema.tables).slice(0, 8).join(", ")})`;
      }
      const wanted = [...predicate.select];
      const where = predicate.where as unknown;
      const collect = (n: unknown): string[] => {
        if (!n || typeof n !== "object") return [];
        const node = n as { col?: string; conditions?: unknown[] };
        if (typeof node.col === "string") return [node.col];
        return (node.conditions ?? []).flatMap(collect);
      };
      wanted.push(...collect(where));
      const agg = predicate.agg ?? [];
      for (const a of agg) if (a.col) wanted.push(a.col);
      for (const raw of wanted) {
        const col = String(raw).includes(".") ? String(raw).split(".")[1] : String(raw);
        if (!cols.includes(col)) return `predicate column ${JSON.stringify(raw)} is not in ${table} (columns: ${cols.slice(0, 10).join(", ")})`;
      }
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
    }
    const errs = validateCompareSpec(pair.compare as never);
    if (errs.length) return `invalid compare spec: ${errs.join("; ")}`;
  }

  // F2：count/exists 的谓词形态也只走同一渲染器（禁手写 sql）
  if (checker.type === "count" || checker.type === "exists") {
    const pred = (checker as { predicate?: Predicate }).predicate;
    if (pred) {
      const text = JSON.stringify(pred);
      if (text.includes("$")) return '"$" in predicate text is not supported — pipeline refs belong to count.from / sql-pair sides';
      try {
        const rendered = renderScan(pred);
        if (hasTimeFunction(rendered.whereSql)) return "predicate renders a time function (now()/current_timestamp) — not replayable";
      } catch (e) {
        return (e as Error).message;
      }
    }
  }
  if (checker.type === "command") return "command checkers are not allowed in prepared specs (execution surface) unless explicitly enabled";
  if (checker.type === "agent") {
    const rubric = checker.rubric ?? [];
    if (rubric.length === 0) return "agent checker needs at least one rubric point";
  }
  const compare = (checker as { compare?: unknown }).compare;
  if (compare) {
    const errs = validateCompareSpec(compare as never);
    if (errs.length) return `invalid compare spec: ${errs.join("; ")}`;
  }
  return null;
}

/** P3：盲审结论映射为"候选是否可进 spec"（fail-closed，与 run 期 judgeReview 同口径） */
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
      verdict: "needs-material",
      units: [],
      rejected,
      rounds: 0,
      materials_sha256: materialsSha,
      diagnostics: [{ stage: "P3", message: "no blind reviewer available — self-review is half of the construction contract; provide ReviewRunner" }],
    };
  }

  const kept: Array<{ candidate: PrepareCandidate; vu: VerifyUnit }> = [];
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
    for (const [i, candidate] of candidates.entries()) {
      const r1 = p1(candidate, materialText, opts.materialIndex);
      if (r1) {
        rejected.push({ source_clause: candidate.source_clause, stage: "P1", reason: r1 });
        feedback.push(r1);
        continue;
      }
      const r2 = p2(candidate, opts.schemaProbe);
      if (r2) {
        rejected.push({ source_clause: candidate.source_clause, stage: "P2", reason: r2 });
        feedback.push(r2);
        continue;
      }
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
    contract_version: "0.4",
    spec_id: opts.specId ?? `spec_${materialsSha.slice(0, 12)}`,
    spec_version: 1,
    title: opts.title ?? "prepared spec",
    domain: opts.domain ?? "prepared",
    created: now(),
    runtime_min: "1",
    verifier: { engine_version: "0.1.0", corpus_version: "1" },
    as_of: { kind: "snapshot", value: now() },
    vu: kept.map((k) => k.vu),
    attachments: [],
    sealed: { review: true },
    materials_sha256: materialsSha,
  } as VerifySpec;

  // P4：红队门禁（调用方注入；未注入 = 未验证，不得落 ready）
  if (!opts.redteam) {
    return {
      verdict: "needs-material",
      spec,
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
      spec,
      units: spec.vu,
      rejected,
      rounds: round,
      materials_sha256: materialsSha,
      diagnostics: failures.map((f) => ({ stage: "P4", message: f })),
    };
  }

  // P5：冻版
  diagnostics.push({ stage: "P5", message: `frozen with ${spec.vu.length} units after ${round} round(s)` });
  return { verdict: "ready", spec, units: spec.vu, rejected, rounds: round, materials_sha256: materialsSha, diagnostics };
}
