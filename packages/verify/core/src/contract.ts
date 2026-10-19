/**
 * verify 契约类型（docs/verify-contract.md v0.2）——三 JSON 的唯一真相。
 *
 * 冻结纪律：字段增删 = contract_version 变更；任何实现（TS 参考实现 / Rust 二进制）
 * 只认这里的形状。checker 是标签联合：`type` 决定其余键（评审 fdc757f6 ①）。
 */

export const CONTRACT_VERSION = "1.0";

export type Verdict = "PASS" | "FAIL" | "NEEDS-MATERIAL" | "ERROR";
export type VuRole = "assert" | "source";
export type Severity = "S1" | "S2" | "S3";
export type CheckerType = "sql" | "sql-pair" | "count" | "exists" | "file" | "command" | "agent";

/** 比较契约（评审 B5）：货币按最小单位整数、容差有域、基数与 NULL 显式。 */
export interface CompareSpec {
  mode: "exact" | "tolerance_abs" | "tolerance_rel" | "window" | "subset" | "superset" | "range" | "regex";
  /** tolerance_abs / window 的绝对差；tolerance_rel 的相对差；range 的下界；regex 不需要 */
  value?: number;
  /** range 的上界 */
  value_max?: number;
  /** 时间窗口单位（d/h/s），window 模式必填 */
  unit?: "d" | "h" | "s";
  /** 货币 + scale 同时出现时按最小单位整数比较（禁浮点直比） */
  currency?: string;
  scale?: number;
  /** sql-pair 键基数；默认 1:1，重复键 = ERROR；1:N 须带 agg */
  cardinality?: "1:1" | "1:N" | "N:1";
  agg?: "sum" | "max" | "min";
  /** NULL 语义；默认 error（NULL ≠ 0，也不静默放过） */
  null?: "error" | "equal" | "ignore";
}

export interface SqlChecker {
  type: "sql";
  sql: string;
  /** 期望行数语义：none（只看违规行）/ nonempty（必须至少一行） */
  expect?: "none" | "nonempty";
  /** 违规判定：rows>0 即 FAIL（默认），或 rows==0 即 FAIL */
  fail_when?: "rows>0" | "rows==0";
}

export type PairSide =
  | { from: string; key: string; value: string }
  | { table: string; key: string; value: string };

export interface SqlPairChecker {
  type: "sql-pair";
  left: PairSide;
  right: PairSide;
  compare: CompareSpec;
}

export interface CountChecker {
  /**
   * 计数型（评审 B5 + R2 形状闭合）：阈值比较。
   * 集合来源二选一（不得并存）：
   * - from：上游行集引用（"$Vx"，scanned = 上游行数，matched = 该行数）；
   * - sql：业务数据源单语句（scanned = 源表行数，matched = 计数结果）。
   */
  type: "count";
  from?: string;
  sql?: string;
  op: ">=" | "<=" | "==" | "!=" | ">" | "<";
  value: number;
}

export interface ExistsChecker {
  type: "exists";
  sql: string;
  expect: boolean;
}

export interface FileChecker {
  type: "file";
  /** 相对提交物根目录的 glob（全匹配守卫：不允许 `*` 单独出现，见 checkers/file.ts） */
  glob: string;
  min?: number;
  max?: number;
  /** 必须出现的文件名（逐字） */
  require?: string[];
  /** 校验和清单：path → sha256 */
  sha256?: Record<string, string>;
}

export interface CommandChecker {
  type: "command";
  /** argv 数组（禁 shell 展开）；二进制白名单在封包 build 时校验 */
  argv: string[];
  expect_exit?: number;
  stdout_matches?: string;
}

export interface RubricItem {
  id: string;
  /** 可证伪检查点（评审 C3-ii）：必须能定位到提交物中的具体内容 */
  point: string;
  /** 证据要求：必须引用提交物的某处（文本引文 / 页码 / 区域） */
  evidence_required: string;
}

export interface AgentChecker {
  type: "agent";
  rubric: RubricItem[];
  /** 判 PASS 需要的全部检查点；默认全部 */
  pass_if?: "all" | string[];
}

export type Checker =
  | SqlChecker
  | SqlPairChecker
  | CountChecker
  | ExistsChecker
  | FileChecker
  | CommandChecker
  | AgentChecker;

export type ExpectedFrom =
  | { kind: "material-extract"; source_id: string; anchor: string; quote: string }
  | { kind: "explicit"; note: string }
  | { kind: "runtime-query"; note: string };

export interface VerifyUnit {
  id: string;
  role: VuRole;
  title: string;
  severity: Severity;
  source_clause: string;
  checker: Checker;
  expected_from: ExpectedFrom;
  outputs?: Record<string, "rowset" | "number" | "string" | "boolean">;
}

export interface AttachmentRef {
  role: "baseline" | "submission";
  path: string;
  sha256: string;
  mime: string;
  size: number;
}

export interface AsOfRef {
  kind: "snapshot";
  value: string;
}

export interface VerifySpec {
  contract_version: string;
  spec_id: string;
  spec_version: number;
  title: string;
  domain: string;
  created: string;
  runtime_min: string;
  verifier: { engine_version: string; corpus_version: string };
  as_of: AsOfRef;
  vu: VerifyUnit[];
  attachments: AttachmentRef[];
  sealed: { review: boolean };
}

/**
 * scope witness（评审 B2）——防空洞通过：每个 fact checker 必须给出扫描面。
 * 语义按型定义见 docs/verify-contract.md §2.1（R1 表）：scanned/matched 口径因型而异，
 * 空范围与零匹配的结论必须引用该型的 expect/fail_when/op/min/require，不得一刀切。
 */
export interface ScopeWitness {
  rows_scanned: number;
  rows_matched: number;
  sources: Array<{ table: string; rows: number }>;
  schema_fingerprint: string;
}

export type FactCheckerType = "sql" | "sql-pair" | "count" | "exists" | "file";

interface VuResultBase {
  id: string;
  verdict: Verdict;
  severity: Severity;
  source_clause: string;
  checker_type: CheckerType;
  evidence?: Record<string, unknown>;
  guard?: { leniency_checks: string[] };
  trace?: string;
}

/** source 型：不参与折叠（R5）；失败表现为下游 ERROR 级联。 */
export interface VuResultSource extends VuResultBase {
  role: "source";
  verdict: "PASS" | "ERROR";
  witness?: ScopeWitness;
}

/** fact 型：witness 必填（R4 类型强制）——编译期就不允许缺扫描面。 */
export interface VuResultFact extends VuResultBase {
  role: "assert";
  checker_type: FactCheckerType;
  witness: ScopeWitness;
}

/** agent/command 型：无统一扫描面语义，witness 可选。 */
export interface VuResultNonFact extends VuResultBase {
  role: "assert";
  checker_type: "agent" | "command";
  witness?: ScopeWitness;
}

export type VuResult = VuResultSource | VuResultFact | VuResultNonFact;

export interface VerifyReport {
  contract_version: string;
  run_id: string;
  started: string;
  finished: string;
  verifier: {
    mode: "sealed" | "open";
    binary_sha256?: string;
    engine_version: string;
    spec_version: number;
    corpus_version: string;
    sealed_review: boolean;
  };
  as_of: AsOfRef;
  summary: { pass: number; fail: number; needs_material: number; error: number };
  overall: Verdict;
  reason: string;
  vu: VuResult[];
  exceptions: Array<{ vu: string; severity: Severity; row_count: number }>;
  payload_sha256?: string;
  artifacts?: { attachment_sha256: string[] };
}
