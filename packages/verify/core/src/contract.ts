/**
 * verify 契约类型（docs/verify-contract.md v0.2）——三 JSON 的唯一真相。
 *
 * 冻结纪律：字段增删 = contract_version 变更；任何实现（TS 参考实现 / Rust 二进制）
 * 只认这里的形状。checker 是标签联合：`type` 决定其余键（评审 fdc757f6 ①）。
 */

// 1.0 冻结 2026-10-19（fdc757f6 持闸放行）；1.1（2026-10-20）新增报告 verifier.signature/signing_scheme/public_key_fingerprint 三个可选字段（封包签名身份），其余形状不变。升版纪律：形状变更走 1.1→1.2，不得静默改内文
export const CONTRACT_VERSION = "1.1";
/** 语料版本（与 corpus/manifest.json 同步；prepare/self-check/报告都用它）。升版=冻结快照重铸。 */
export const CORPUS_VERSION = "1.1";

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

export type PredicateOp =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "in"
  | "between"
  | "is null"
  | "is not null";

export interface PredicateCondition {
  /** 列名；可带表限定（bills.amount），但必须是裸标识符组合，不得是表达式 */
  col: string;
  op: PredicateOp;
  /** `in` 传数组、`between` 传两元素数组；`is null`/`is not null` 不需要值 */
  value?: string | number | number[] | string[];
}

/** 谓词节点：叶子是条件，组节点做 AND/OR/NOT 嵌套（NOT 也是一组，内部按 AND 连接后整体取反） */
export type PredicateNode = PredicateCondition | PredicateGroup;

export interface PredicateGroup {
  op: "and" | "or" | "not";
  conditions: PredicateNode[];
}

export interface PredicateAgg {
  fn: "count" | "sum" | "min" | "max";
  /** 列名；count(*) 时省略 */
  col?: string;
  /** 渲染后的别名（报告里可追溯） */
  as?: string;
}

export interface Predicate {
  /** 表/视图名（裸标识符） */
  from: string;
  /**
   * 取数列（裸标识符）。审计看不出「取了什么」的 `select *` 一律拒绝；
   * 纯聚合查询（agg 非空）时 select 必须为空数组——列与聚合混排需要 GROUP BY，
   * 而 GROUP BY 不在 AST 里，渲染出的 `SELECT batch, SUM(x)` 在 PG 直接报错（r8 F1）。
   */
  select: string[];
  /** 聚合列（可选）；给出时按 as 或 agg 名产出单列 */
  agg?: PredicateAgg[];
  /** 判据条件树（AND/OR/NOT 可嵌套）；找违规型（fail_when=rows>0）必须给出（否则就是整表非空冒充） */
  where?: PredicateGroup;
  /**
   * 扫描域过滤（AND/OR/NOT，可选）：只限定「这次检查看哪一批数据」（如 batch='2026-07'），
   * **不是判据**。域进 findSql 与 scopeSql 两侧，witness.rows_scanned 才是「看了多少行」；
   * 若把批次条件塞进 where，干净批次会扫出 0 行被判空洞（M13-1 端到端实测）。
   */
  scan?: PredicateGroup;
}

export interface SqlCheckerBase {
  type: "sql";
  /** 期望行数语义：none（只看违规行）/ nonempty（必须至少一行） */
  expect?: "none" | "nonempty";
  /** 违规判定：rows>0 即 FAIL（默认），或 rows==0 即 FAIL */
  fail_when?: "rows>0" | "rows==0";
  /** 来源标记：prepare 机械生成的 spec 只允许 mechanical；manual 须在报告的非机械清单里列出 */
  authored?: "mechanical" | "manual";
}

/** 手写 SQL 形态（authoring 例外）：必须自带 scope_sql 证明扫描面 */
export interface RawSqlChecker extends SqlCheckerBase {
  sql: string;
  /**
   * 扫描面查询（r3 意见 2）：找违规型必须能证明「扫的是本批范围」而不是整表非空。
   * 给出时 scanned = 本查询行数；未给出时回退源表行数，且构造守卫要求 sql 自带 WHERE。
   */
  scope_sql?: string;
  predicate?: never;
}

/** 谓词形态（机械生成的默认形态）：sql/scope_sql 由引擎渲染，不允许手写 */
export interface PredicateChecker extends SqlCheckerBase {
  predicate: Predicate;
  sql?: never;
  scope_sql?: never;
}

export type SqlChecker = RawSqlChecker | PredicateChecker;

export type PairSide =
  | { from: string; key: string; value: string }
  | { table: string; key: string; value: string }
  /**
   * 机械形态（r8 F1）：谓词侧自己产出一行——`{predicate, key?}`。
   * 值列 = predicate.agg 的唯一一列；key 缺省为常量 "total"（总额对总额）。
   */
  | { predicate: Predicate; key?: string };

export interface SqlPairChecker {
  type: "sql-pair";
  left: PairSide;
  right: PairSide;
  compare: CompareSpec;
}

export type CountChecker =
  | {
      /**
       * 计数型（评审 B5 + R2 形状 + r3 判别联合）：上游行集计数。
       * scanned = 上游行数；matched = 计数。
       */
      type: "count";
      from: string;
      sql?: never;
      op: ">=" | "<=" | "==" | "!=" | ">" | "<";
      value: number;
    }
  | {
      /**
       * 计数型：谓词形态（r8 F2）——`SELECT count(*)` 由引擎从同一谓词渲染，
       * 与 find/scope 共享同一 where；不允许再手写 sql。
       */
      type: "count";
      predicate: Predicate;
      from?: never;
      sql?: never;
      op: ">=" | "<=" | "==" | "!=" | ">" | "<";
      value: number;
    }
  | {
      /**
       * 计数型：业务数据源单语句计数（必须返回单行单列）。
       * scanned = 源表行数；matched = 计数。
       */
      type: "count";
      from?: never;
      sql: string;
      predicate?: never;
      op: ">=" | "<=" | "==" | "!=" | ">" | "<";
      value: number;
    };

export type ExistsChecker =
  | { type: "exists"; sql: string; predicate?: never; expect: boolean }
  /** 谓词形态（r8 F2）：`SELECT 1 ... WHERE` 由引擎从同一谓词渲染 */
  | { type: "exists"; predicate: Predicate; sql?: never; expect: boolean };

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
  /**
   * 排除 glob（相对提交物根、POSIX 分隔）。被排除的文件不进扫描面（scanned/matched），
   * 但 `require` / `sha256` 仍按字面路径校验。禁绝对路径、`..` 段与通吃 glob（星号通配一切）。
   */
  ignore?: string[];
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


/* ── review 层契约（B6 可验收形态）────────────────────────────────────────────
 * 自审/复核不是"再问一次模型"：它有一份可验收的形状——三问、锚点逐字复读、盲审、
 * 结论落 findings 数组（fail-closed：任何 reject / unclear / 缺项都不落 PASS）。
 */

/** §2.1 三问：每一问都必须有明确结论，不能"看起来没问题"就算过。 */
export type ReviewQuestion = "faithful" | "decidable" | "not-vacuous";

export type ReviewVerdict = "ok" | "reject" | "unclear";

/** 锚点复读：quote 必须逐字出现在冻结材料里，locator 指向可复核的位置。 */
export interface ReviewAnchor {
  quote: string;
  locator: string;
}

export interface ReviewFinding {
  /** rubric 检查点 id（W10）：优先于 reason 里的 "rubric:<id>" 前缀协议 */
  checkpoint?: string;
  vu_id: string;
  question: ReviewQuestion;
  verdict: ReviewVerdict;
  reason: string;
  /** faithful 结论必须带锚点（引擎会做逐字复读校验） */
  anchor?: ReviewAnchor;
}

/**
 * 盲审请求：只含「冻结材料 + 待审 VU」，**不含**构造理由、修订历史、历史结论。
 * blind 字段是常量 true——接口层面就不给传构造上下文的口子。
 */
export interface ReviewRequest {
  vu: VerifyUnit;
  /** 冻结材料全文（提交材料原文，不含任何解释性文字） */
  materials: string;
  submission_dir?: string;
  blind: true;
  round: number;
}

export interface ReviewRunner {
  review(req: ReviewRequest): Promise<ReviewFinding[]>;
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
  /** prepare 冻结的 schema 指纹；run 时与 witness 比对，不一致 → ERROR（评审 c） */
  schema_fingerprint?: string;
  /** 冻结材料的 sha256（W15）；runVerify 在开 review 前复核 materialsText，不一致 → ERROR */
  materials_sha256?: string;
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
  /** 产出该报告的 spec（run 期从 spec 复制；导出的报告必须自描述） */
  spec_id?: string;
  /** 数据来源（A 裁定：报告记快照来源 + sha256；纯语料跑无此键） */
  data_source?: { kind: string; sha256: string; source?: string; captured_at: string };
  started: string;
  finished: string;
  verifier: {
    mode: "sealed" | "open";
    binary_sha256?: string;
    engine_version: string;
    spec_version: number;
    corpus_version: string;
    sealed_review: boolean;
    /** 封包签名（contract 1.1）：签署 footer 规范字节的 ed25519 签名（base64）。
     *  封包自身不验签；真实性在导入/分发侧按仓库密钥表验证（§5）。 */
    signature?: string;
    signing_scheme?: string;
    public_key_fingerprint?: string;
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
