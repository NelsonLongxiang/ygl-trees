//! verify 契约类型（docs/verify-contract.md v1.0）——TS 参考实现的 Rust 镜像。
//!
//! 纪律：形状只认契约；本文件不做业务判断，只负责「能不能解成契约形状」。
//! 标签联合用「宽结构 + 显式校验」而不是一次性 enum：同一份 spec 由 TS 产出，
//! 解析失败要能指出缺哪个键，而不是 serde 的一行 "data did not match any variant"。

use serde::{Deserialize, Serialize};

pub const CONTRACT_VERSION: &str = "1.2";

/// 1.1 specs remain runnable under the 1.2 engine (new shapes are optional and
/// gated by the version-shape check); anything else is rejected.
pub fn is_known_contract(version: &str) -> bool {
    version == CONTRACT_VERSION || version == "1.1"
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Verdict {
    #[serde(rename = "PASS")]
    Pass,
    #[serde(rename = "FAIL")]
    Fail,
    #[serde(rename = "NEEDS-MATERIAL")]
    NeedsMaterial,
    #[serde(rename = "ERROR")]
    Error,
}

impl Verdict {
    /// 报告里的字面量（serde rename 同值——报告与判定共用一份字符串）。
    pub fn as_str(&self) -> &'static str {
        match self {
            Verdict::Pass => "PASS",
            Verdict::Fail => "FAIL",
            Verdict::NeedsMaterial => "NEEDS-MATERIAL",
            Verdict::Error => "ERROR",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompareSpec {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cardinality: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agg: Option<String>,
    #[serde(default, rename = "null", skip_serializing_if = "Option::is_none")]
    pub null_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredicateCondition {
    pub col: String,
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredicateGroup {
    pub op: String,
    pub conditions: Vec<PredicateNode>,
}

/// 叶子是条件、组节点做 AND/OR/NOT 嵌套（契约 §1.5）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PredicateNode {
    Condition(PredicateCondition),
    Group(PredicateGroup),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredicateAgg {
    #[serde(rename = "fn")]
    pub fn_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub col: Option<String>,
    #[serde(default, rename = "as", skip_serializing_if = "Option::is_none")]
    pub as_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Predicate {
    pub from: String,
    #[serde(default)]
    pub select: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agg: Option<Vec<PredicateAgg>>,
    /// `where` 只描述判据（进 findSql）；`scan` 描述看哪一批（进 findSql 与 scopeSql 两侧）。
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    pub where_: Option<PredicateGroup>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scan: Option<PredicateGroup>,
}

/// sql 型 checker：手写形态（sql）与谓词形态（predicate）互斥，引擎负责守卫。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlChecker {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fail_when: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authored: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_sql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predicate: Option<Predicate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairSide {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predicate: Option<Predicate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlPairChecker {
    pub left: PairSide,
    pub right: PairSide,
    pub compare: CompareSpec,
}

/// 1.2：count 的右值取自另一张表的单值标量（`agg` 必填，无默认）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgainstSpec {
    pub from: String,
    pub col: String,
    /// Missing `agg` must reach the engine as `missing_agg` (a construction
    /// verdict), not die in serde as a shape error.
    #[serde(default)]
    pub agg: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CountChecker {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predicate: Option<Predicate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub against: Option<AgainstSpec>,
    pub op: String,
    /// 1.2: optional — a count with `against` carries no literal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExistsChecker {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predicate: Option<Predicate>,
    pub expect: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChecker {
    pub glob: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<std::collections::BTreeMap<String, String>>,
    /// 排除 glob（相对提交物根、POSIX 分隔）；被排除的不进扫描面，但 require/sha256 仍按字面校验。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignore: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandChecker {
    pub argv: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect_exit: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_matches: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RubricItem {
    pub id: String,
    /// 早期语料用过 id/question/fail_if 形态；冻结语料只增不改，缺省字段保持容忍，
    /// 真正的 rubric 校验在引擎/自审层做（fact-only 模式下 agent 型本来就被拒）。
    #[serde(default)]
    pub point: String,
    #[serde(default)]
    pub evidence_required: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentChecker {
    pub rubric: Vec<RubricItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pass_if: Option<serde_json::Value>,
}

/// checker 是标签联合：先按 `type` 粗解，再按形状收窄（契约 §1）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Checker {
    #[serde(rename = "sql")]
    Sql(SqlChecker),
    #[serde(rename = "sql-pair")]
    SqlPair(SqlPairChecker),
    #[serde(rename = "count")]
    Count(CountChecker),
    #[serde(rename = "exists")]
    Exists(ExistsChecker),
    #[serde(rename = "file")]
    File(FileChecker),
    #[serde(rename = "command")]
    Command(CommandChecker),
    #[serde(rename = "agent")]
    Agent(AgentChecker),
}

impl Checker {
    /// 报告里的 checker_type（与 serde 标签同值）。
    pub fn type_name(&self) -> &'static str {
        match self {
            Checker::Sql(_) => "sql",
            Checker::SqlPair(_) => "sql-pair",
            Checker::Count(_) => "count",
            Checker::Exists(_) => "exists",
            Checker::File(_) => "file",
            Checker::Command(_) => "command",
            Checker::Agent(_) => "agent",
        }
    }
}

impl Checker {
    pub fn kind(&self) -> &'static str {
        match self {
            Checker::Sql(_) => "sql",
            Checker::SqlPair(_) => "sql-pair",
            Checker::Count(_) => "count",
            Checker::Exists(_) => "exists",
            Checker::File(_) => "file",
            Checker::Command(_) => "command",
            Checker::Agent(_) => "agent",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyUnit {
    pub id: String,
    pub role: String, // assert | source
    #[serde(default)]
    pub title: String,
    pub severity: String, // S1 | S2 | S3
    pub source_clause: String,
    pub checker: Checker,
    #[serde(default)]
    pub expected_from: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outputs: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentRef {
    /// 语料最小 spec 只记 path/sha256；role/mime/size 由 prepare 侧补全，解析时容忍缺省。
    #[serde(default)]
    pub role: String,
    pub path: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsOfRef {
    pub kind: String, // snapshot
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecVerifier {
    pub engine_version: String,
    pub corpus_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sealed {
    pub review: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifySpec {
    pub contract_version: String,
    pub spec_id: String,
    #[serde(default)]
    pub spec_version: i64,
    /// 语料里的最小 spec 不带标题域等"导出元数据"（TS 侧同样容忍），缺省为空。
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub domain: String,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub runtime_min: String,
    pub verifier: SpecVerifier,
    pub as_of: AsOfRef,
    pub vu: Vec<VerifyUnit>,
    #[serde(default)]
    pub attachments: Vec<AttachmentRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materials_sha256: Option<String>,
    pub sealed: Sealed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScopeWitness {
    pub rows_scanned: i64,
    pub rows_matched: i64,
    pub sources: Vec<SourceRow>,
    pub schema_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceRow {
    pub table: String,
    pub rows: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VuResult {
    pub id: String,
    pub verdict: Verdict,
    pub severity: String,
    pub source_clause: String,
    pub checker_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub witness: Option<ScopeWitness>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guard: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Summary {
    pub pass: u32,
    pub fail: u32,
    pub needs_material: u32,
    pub error: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportVerifier {
    pub mode: String, // sealed | open
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_sha256: Option<String>,
    pub engine_version: String,
    pub spec_version: i64,
    pub corpus_version: String,
    pub sealed_review: bool,
    /// 封包签名（contract 1.1）：签署的 footer 规范字节的 ed25519 签名，base64。
    /// 封包自身不验签（无公钥），真实性在导入/分发侧按仓库密钥表验证。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signing_scheme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataSource {
    pub kind: String,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub captured_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyReport {
    pub contract_version: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_source: Option<DataSource>,
    pub started: String,
    pub finished: String,
    pub verifier: ReportVerifier,
    pub as_of: AsOfRef,
    pub summary: Summary,
    pub overall: Verdict,
    pub reason: String,
    pub vu: Vec<VuResult>,
    #[serde(default)]
    pub exceptions: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<serde_json::Value>,
}

/// 解析 spec 并校验契约版本（版本不符 = 拒绝，不静默降级）。
pub fn parse_spec(json: &str) -> Result<VerifySpec, String> {
    let spec: VerifySpec = serde_json::from_str(json).map_err(|e| format!("spec is not contract-shaped: {e}"))?;
    if !is_known_contract(&spec.contract_version) {
        return Err(format!(
            "unsupported contract_version {:?} (this build supports {})",
            spec.contract_version, CONTRACT_VERSION
        ));
    }
    Ok(spec)
}
