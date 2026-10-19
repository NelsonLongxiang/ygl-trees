//! 判定引擎（对应 TS `engine.ts`）——七型检查器 → witness → 折叠。
//!
//! M13-1b 范围：fact 层（sql / sql-pair / count / exists / file）+ command（带 allowlist）。
//! agent 型属 review 层：Rust 二进制默认 fact-only，遇到 agent 判 ERROR（与封包默认一致）。
//!
//! 结论纪律（契约 §2）：零扫描 → NEEDS-MATERIAL；构造问题（渲染失败/比较非法/形状不一致）→ ERROR；
//! 只有「扫描过、比较过、确实违反」才落 FAIL。fold：FAIL > NEEDS-MATERIAL > ERROR > PASS。

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::canonical::canonical_sha256;
use crate::compare::{compare_values, validate_compare_spec, CompareOutcome};
use crate::contract::*;
use crate::predicate::{agg_alias_of, render_predicate, render_scan};
use crate::sqlite::{column, first_value, Row, SqliteRunner};

const EMPTY_SCHEMA: &str = "sha256:empty";

pub struct VerifyOptions<'a> {
    pub runner: &'a SqliteRunner,
    pub submission_dir: Option<&'a str>,
    pub command_allowlist: Option<Vec<String>>,
    pub now_iso: Option<String>,
    /// 语料/测试可钉 run_id，保证报告字节可复现。
    pub run_id: Option<String>,
    pub engine_version: Option<String>,
    /// "open"（spec 由调用方给）或 "sealed"（spec 内嵌在二进制里）
    pub mode: Option<String>,
    /// 封包二进制的 sha256（报告身份锚；open 模式为 None）
    pub binary_sha256: Option<String>,
    /// 报告里的数据源锚（快照副本的 sha256/来源）——CLI 接线，引擎不猜
    pub data_source: Option<crate::contract::DataSource>,
}

fn get(row: &Row, key: &str) -> Value {
    column(row, key).cloned().unwrap_or(Value::Null)
}

/// 从 SQL 文本粗提源表并按表取行数：`scanned` = 源表行数之和（scope 的粗粒度回退）。
fn rows_scanned_from_sql(runner: &SqliteRunner, sql: &str) -> (i64, Vec<SourceRow>) {
    let tables = runner.source_tables(sql);
    let mut sources = Vec::with_capacity(tables.len());
    let mut scanned = 0i64;
    for t in tables {
        match runner.table_rows(&t) {
            Ok(n) => {
                scanned += n;
                sources.push(SourceRow { table: t, rows: n });
            }
            Err(_) => sources.push(SourceRow { table: t, rows: -1 }),
        }
    }
    (scanned, sources)
}

fn witness(scanned: i64, matched: i64, sources: Vec<SourceRow>, fingerprint: &str) -> ScopeWitness {
    ScopeWitness {
        rows_scanned: scanned,
        rows_matched: matched,
        sources,
        schema_fingerprint: fingerprint.to_string(),
    }
}

fn vu_result(vu: &VerifyUnit, verdict: Verdict, witness: Option<ScopeWitness>, evidence: Option<Value>) -> VuResult {
    VuResult {
        id: vu.id.clone(),
        verdict,
        severity: vu.severity.clone(),
        source_clause: vu.source_clause.clone(),
        checker_type: vu.checker.kind().to_string(),
        role: Some(vu.role.clone()),
        witness,
        evidence,
        guard: None,
        trace: None,
    }
}

fn err(vu: &VerifyUnit, reason: impl Into<String>) -> VuResult {
    vu_result(vu, Verdict::Error, None, Some(json!({ "reason": reason.into() })))
}

fn number_of(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// 单语句文本（谓词引用 `$vu:` 不允许出现在 sql 文本里，r3 意见 b）。
fn has_dollar_placeholder(sql: &str) -> bool {
    sql.contains('$')
}

/// 找违规型守卫：无 WHERE 且无 scope_sql 的整表查询是「整表非空」冒充，拒绝。
fn strip_sql_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let bytes = sql.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            out.push(' ');
            continue;
        }
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            out.push(' ');
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn has_where(sql: &str) -> bool {
    let clean = strip_sql_comments(sql).to_ascii_lowercase();
    clean.split(|c: char| !c.is_ascii_alphanumeric() && c != '_').any(|w| w == "where")
}

fn parse_rowside_row(
    tbl: PairSide,
    runner: &SqliteRunner,
    outputs: &HashMap<String, Vec<Row>>,
) -> Result<Vec<Row>, String> {
    if let Some(pred) = &tbl.predicate {
        let aggs = pred.agg.as_ref().map(|a| a.len()).unwrap_or(0);
        if aggs != 1 {
            return Err("sql-pair predicate side needs exactly one agg column (that column is the compared value)".into());
        }
        let alias = agg_alias_of(pred, 0)?;
        let rendered = render_predicate(pred)?;
        let rows = runner.query(&rendered.find_sql)?;
        if rows.len() != 1 {
            return Err(format!(
                "sql-pair predicate side must yield exactly one row (aggregate), got {}",
                rows.len()
            ));
        }
        let k_name = pred.alias_key(&tbl);
        let v = get(&rows[0], &alias);
        let mut r: Row = Vec::new();
        r.push((k_name.clone(), Value::String(k_name)));
        r.push(("value".into(), v));
        return Ok(vec![r]);
    }
    if let Some(from) = &tbl.from {
        let key = ref_id(from);
        return match outputs.get(&key) {
            Some(rows) => Ok(rows.clone()),
            None => Err(format!("pipeline reference {from} is not available (topological order violated)")),
        };
    }
    let table = tbl.table.clone().unwrap_or_default();
    let key = tbl.key.clone().unwrap_or_else(|| "key".into());
    let value = tbl.value.clone().unwrap_or_else(|| "value".into());
    let sql = format!("SELECT {} AS \"{}\", {} AS \"{}\" FROM {}", key, key, value, value, table);
    runner.query(&sql)
}

trait PairSideExt {
    fn alias_key(&self, side: &PairSide) -> String;
}
impl PairSideExt for Predicate {
    fn alias_key(&self, side: &PairSide) -> String {
        side.key.clone().unwrap_or_else(|| "total".into())
    }
}

fn reduce_values(vals: &[Value], agg: Option<&str>) -> Value {
    if vals.len() == 1 {
        return vals[0].clone();
    }
    let nums: Option<Vec<f64>> = vals.iter().map(number_of).collect();
    match nums {
        Some(nums) => match agg {
            Some("sum") => json!(nums.iter().sum::<f64>()),
            Some("max") => json!(nums.iter().cloned().fold(f64::NEG_INFINITY, f64::max)),
            Some("min") => json!(nums.iter().cloned().fold(f64::INFINITY, f64::min)),
            _ => vals[0].clone(),
        },
        None => Value::Null,
    }
}

fn group_rows(rows: &[Row], key: &str, value: &str) -> BTreeMap<String, Vec<Value>> {
    let mut map: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for r in rows {
        let k = match get(r, key) {
            Value::String(s) => s,
            other => other.to_string(),
        };
        map.entry(k).or_default().push(get(r, value));
    }
    map
}

/// 单个 VU 的 fact 判定（异步/管线输出不在本层：`$vu:` 引用由调用方解析后传入）。
pub fn run_fact_checker(
    vu: &VerifyUnit,
    runner: &SqliteRunner,
    opts: &VerifyOptions,
    outputs: &HashMap<String, Vec<Row>>,
) -> VuResult {
    let fingerprint = runner.schema_fingerprint().unwrap_or_else(|_| EMPTY_SCHEMA.to_string());
    match &vu.checker {
        Checker::Sql(c) => {
            let fail_when = c.fail_when.clone().unwrap_or_else(|| "rows>0".into());
            if let Some(pred) = &c.predicate {
                if pred.agg.as_ref().map(|a| !a.is_empty()).unwrap_or(false) {
                    return err(vu, "predicate.agg belongs to sql-pair predicate sides only — a plain sql rowset with agg is always one row and proves nothing (r9 E2)");
                }
                if fail_when == "rows>0" && pred.where_.is_none() {
                    return err(vu, "predicate has no where clause — a full-table scan cannot prove the intended batch (vacuous-pass risk)");
                }
                let rendered = match render_predicate(pred) {
                    Ok(r) => r,
                    Err(e) => return err(vu, e),
                };
                let find_rows = match runner.query(&rendered.find_sql) {
                    Ok(r) => r,
                    Err(e) => return err(vu, format!("rendered query failed: {e}")),
                };
                let scope_rows = match runner.query(&rendered.scope_sql) {
                    Ok(r) => r,
                    Err(e) => return err(vu, format!("rendered query failed: {e}")),
                };
                if scope_rows.len() != 1 || scope_rows[0].len() != 1 {
                    return err(vu, "rendered scope query must return one row and one column");
                }
                let n_raw = first_value(&scope_rows[0]).cloned().unwrap_or(Value::Null);
                let n = match number_of(&n_raw) {
                    Some(v) if v >= 0.0 && v.fract() == 0.0 => v as i64,
                    _ => {
                        return err(
                            vu,
                            format!("rendered scope count is not a non-negative integer (got {n_raw})"),
                        )
                    }
                };
                let (_, sources) = rows_scanned_from_sql(runner, &rendered.find_sql);
                let w = witness(n, find_rows.len() as i64, sources, &fingerprint);
                if n == 0 {
                    return vu_result(
                        vu,
                        Verdict::NeedsMaterial,
                        Some(w),
                        Some(json!({ "reason": "zero rows scanned — wrong table or empty data", "rendered": { "findSql": rendered.find_sql, "scopeSql": rendered.scope_sql } })),
                    );
                }
                let bad = if fail_when == "rows>0" { find_rows.len() } else if find_rows.is_empty() { 1 } else { 0 };
                if bad > 0 {
                    return vu_result(
                        vu,
                        Verdict::Fail,
                        Some(w),
                        Some(json!({
                            "violations": bad,
                            "rows": canonical_rows(&find_rows, 1).into_iter().take(5).collect::<Vec<_>>(),
                            "rows_total": find_rows.len(),
                            "rendered": { "findSql": rendered.find_sql, "scopeSql": rendered.scope_sql }
                        })),
                    );
                }
                return vu_result(vu, Verdict::Pass, Some(w), Some(json!({ "rows": find_rows.len(), "rendered": { "findSql": rendered.find_sql, "scopeSql": rendered.scope_sql } })));
            }

            if c.authored.as_deref() == Some("mechanical") {
                return err(vu, "authored=mechanical is inconsistent with hand-written sql — mechanical specs must use predicate");
            }
            let raw = match &c.sql {
                Some(s) => s.clone(),
                None => return err(vu, "sql checker needs either predicate or sql text"),
            };
            if has_dollar_placeholder(&raw) {
                return err(vu, "raw sql must not contain \"$\" (placeholders are only allowed in predicate form via $vu:)");
            }
            if fail_when == "rows>0" && c.scope_sql.is_none() && !has_where(&raw) {
                return err(vu, "find-violation sql has no WHERE and no scope_sql — cannot prove the scan covers the intended batch (vacuous-pass risk)");
            }
            let rows = match runner.query(&raw) {
                Ok(r) => r,
                Err(e) => return err(vu, format!("query failed: {e}")),
            };
            let (scanned, sources) = match &c.scope_sql {
                Some(scope_sql) => {
                    let scope_rows = match runner.query(scope_sql) {
                        Ok(r) => r,
                        Err(e) => return err(vu, format!("scope_sql failed: {e}")),
                    };
                    if scope_rows.len() != 1 {
                        return err(vu, format!("scope_sql must return exactly one row (got {})", scope_rows.len()));
                    }
                    if scope_rows[0].len() != 1 {
                        return err(vu, format!("scope_sql must return exactly one column (got {})", scope_rows[0].len()));
                    }
                    let v = first_value(&scope_rows[0]).cloned().unwrap_or(Value::Null);
                    let n = match number_of(&v) {
                        Some(x) if x >= 0.0 && x.fract() == 0.0 => x as i64,
                        _ => return err(vu, format!("scope_sql must return a non-negative integer row count (got {v})")),
                    };
                    let (_, srcs) = rows_scanned_from_sql(runner, &raw);
                    (n, srcs)
                }
                None => rows_scanned_from_sql(runner, &raw),
            };
            let w = witness(scanned, rows.len() as i64, sources, &fingerprint);
            if scanned == 0 {
                return vu_result(vu, Verdict::NeedsMaterial, Some(w), Some(json!({ "reason": "zero rows scanned — wrong table or empty data" })));
            }
            let violations = if fail_when == "rows>0" { rows.len() } else if rows.is_empty() { 1 } else { 0 };
            if violations > 0 {
                return vu_result(
                    vu,
                    Verdict::Fail,
                    Some(w),
                    Some(json!({
                        "violations": violations,
                        "rows": canonical_rows(&rows, 1).into_iter().take(5).collect::<Vec<_>>(),
                        "rows_total": rows.len()
                    })),
                );
            }
            vu_result(vu, Verdict::Pass, Some(w), Some(json!({ "rows": rows.len() })))
        }
        Checker::SqlPair(c) => {
            let spec_errs = validate_compare_spec(&c.compare);
            if !spec_errs.is_empty() {
                return err(vu, format!("invalid compare spec: {}", spec_errs.join("; ")));
            }
            let left_pred = c.left.predicate.is_some();
            let right_pred = c.right.predicate.is_some();
            if left_pred != right_pred {
                return err(vu, "sql-pair sides must be the same shape family — an aggregate predicate side cannot be paired with a rowset side (key spaces do not intersect)");
            }
            if left_pred {
                for side in [&c.left, &c.right] {
                    let pred = side.predicate.as_ref().unwrap();
                    let rendered = match render_predicate(pred) {
                        Ok(r) => r,
                        Err(e) => return err(vu, e),
                    };
                    let scope_rows = match runner.query(&rendered.scope_sql) {
                        Ok(r) => r,
                        Err(e) => return err(vu, format!("rendered query failed: {e}")),
                    };
                    let v = scope_rows.first().and_then(first_value).cloned().unwrap_or(Value::Null);
                    match number_of(&v) {
                        Some(n) if n >= 0.0 && n.fract() == 0.0 => {
                            if n == 0.0 {
                                return vu_result(
                                    vu,
                                    Verdict::NeedsMaterial,
                                    Some(witness(0, 0, Vec::new(), &fingerprint)),
                                    Some(json!({ "reason": "aggregate side scanned zero rows — wrong batch or empty data (r9 E3)" })),
                                );
                            }
                        }
                        _ => return err(vu, format!("aggregate side scope is not a non-negative integer (got {v})")),
                    }
                }
            }
            let left_rows = match parse_rowside_row(c.left.clone(), runner, outputs) {
                Ok(r) => r,
                Err(e) => return err(vu, e),
            };
            let right_rows = match parse_rowside_row(c.right.clone(), runner, outputs) {
                Ok(r) => r,
                Err(e) => return err(vu, e),
            };
            let side_key = |side: &PairSide| -> String {
                if side.predicate.is_some() {
                    side.key.clone().unwrap_or_else(|| "total".into())
                } else {
                    side.key.clone().unwrap_or_else(|| "key".into())
                }
            };
            let side_val = |side: &PairSide| -> String {
                if side.predicate.is_some() {
                    "value".to_string()
                } else {
                    side.value.clone().unwrap_or_else(|| "value".into())
                }
            };
            let (lk, lv) = (side_key(&c.left), side_val(&c.left));
            let (rk, rv) = (side_key(&c.right), side_val(&c.right));
            let card = c.compare.cardinality.clone().unwrap_or_else(|| "1:1".into());
            let left_map = group_rows(&left_rows, &lk, &lv);
            let right_map = group_rows(&right_rows, &rk, &rv);
            if card == "1:1" {
                for (side, map) in [("left", &left_map), ("right", &right_map)] {
                    for (k, vals) in map {
                        if vals.len() > 1 {
                            return err(vu, format!(
                                "duplicate key {k} on {side} ({} rows) under cardinality 1:1 — declare 1:N + agg if fan-out is expected",
                                vals.len()
                            ));
                        }
                    }
                }
            }
            let sources = {
                let mut srcs = Vec::new();
                for side in [&c.left, &c.right] {
                    if let Some(t) = &side.table {
                        let rows = runner.table_rows(t).unwrap_or(-1);
                        srcs.push(SourceRow { table: t.clone(), rows });
                    } else if let Some(p) = &side.predicate {
                        let rows = runner.table_rows(&p.from).unwrap_or(-1);
                        srcs.push(SourceRow { table: p.from.clone(), rows });
                    }
                }
                srcs
            };
            let mut keys: BTreeSet<String> = BTreeSet::new();
            keys.extend(left_map.keys().cloned());
            keys.extend(right_map.keys().cloned());
            let mut compared = 0usize;
            let mut violations: Vec<Value> = Vec::new();
            for k in &keys {
                let lvals = left_map.get(k);
                let rvals = right_map.get(k);
                if lvals.is_none() || rvals.is_none() {
                    violations.push(json!({
                        "key": k,
                        "left": lvals.map(|v| reduce_values(v, c.compare.agg.as_deref())).unwrap_or(Value::Null),
                        "right": rvals.map(|v| reduce_values(v, c.compare.agg.as_deref())).unwrap_or(Value::Null),
                        "diff": "missing-side"
                    }));
                    continue;
                }
                compared += 1;
                let l = reduce_values(lvals.unwrap(), c.compare.agg.as_deref());
                let r = reduce_values(rvals.unwrap(), c.compare.agg.as_deref());
                match compare_values(&l, &r, &c.compare) {
                    CompareOutcome::Error(e) => {
                        return vu_result(
                            vu,
                            Verdict::Error,
                            Some(witness(keys.len() as i64, violations.len() as i64, sources.clone(), &fingerprint)),
                            Some(json!({ "reason": format!("comparison is not well-formed at key {k}: {e}"), "key": k, "left": l, "right": r })),
                        )
                    }
                    CompareOutcome::Equal(false) => {
                        let diff = match (number_of(&l), number_of(&r)) {
                            (Some(a), Some(b)) => json!(((a - b) * 1e6).round() / 1e6),
                            _ => json!("mismatch"),
                        };
                        violations.push(json!({ "key": k, "left": l, "right": r, "diff": diff }));
                    }
                    CompareOutcome::Equal(true) => {}
                }
            }
            let w = witness(keys.len() as i64, violations.len() as i64, sources, &fingerprint);
            if keys.is_empty() {
                return vu_result(vu, Verdict::NeedsMaterial, Some(w), Some(json!({ "reason": "no keys to compare — empty source" })));
            }
            if !violations.is_empty() {
                return vu_result(vu, Verdict::Fail, Some(w), Some(json!({ "violations": violations.len(), "compared": compared, "rows": violations.iter().take(5).collect::<Vec<_>>() })));
            }
            vu_result(vu, Verdict::Pass, Some(w), Some(json!({ "compared": compared })))
        }
        Checker::Count(c) => {
            let forms = [c.from.is_some(), c.sql.is_some(), c.predicate.is_some()].iter().filter(|x| **x).count();
            if forms != 1 {
                return err(vu, "count checker declares nothing or multiple forms — exactly one of from/sql/predicate is required");
            }
            let (n, scanned, sources) = if let Some(from) = &c.from {
                let key = from.trim_start_matches("$vu:");
                match outputs.get(key) {
                    Some(rows) => (rows.len() as f64, rows.len() as i64, Vec::new()),
                    None => return err(vu, format!("count from {from} is not available (topological order violated)")),
                }
            } else if let Some(pred) = &c.predicate {
                if pred.agg.as_ref().map(|a| !a.is_empty()).unwrap_or(false) {
                    return err(vu, "count predicate must not carry agg — the count itself is the aggregate (r9 E2)");
                }
                let scan = match render_scan(pred) {
                    Ok(s) => s,
                    Err(e) => return err(vu, e),
                };
                let sql = format!("SELECT count(*) AS n FROM {}{}", scan.from, scan.where_sql);
                let rows = match runner.query(&sql) {
                    Ok(r) => r,
                    Err(e) => return err(vu, format!("query failed: {e}")),
                };
                let n = rows.first().and_then(first_value).and_then(number_of).unwrap_or(0.0);
                let (scanned, sources) = rows_scanned_from_sql(runner, &sql);
                (n, scanned, sources)
            } else {
                let sql = c.sql.clone().unwrap_or_default();
                if has_dollar_placeholder(&sql) {
                    return err(vu, "raw sql must not contain \"$\"");
                }
                let rows = match runner.query(&sql) {
                    Ok(r) => r,
                    Err(e) => return err(vu, format!("query failed: {e}")),
                };
                if rows.len() > 1 || rows.first().map(|r| r.len() != 1).unwrap_or(false) {
                    return err(vu, "count.sql must return exactly one row and one column");
                }
                let n = rows.first().and_then(first_value).and_then(number_of).unwrap_or(0.0);
                let (scanned, sources) = rows_scanned_from_sql(runner, &sql);
                (n, scanned, sources)
            };
            let pass = match c.op.as_str() {
                ">=" => n >= c.value,
                "<=" => n <= c.value,
                "==" => n == c.value,
                "!=" => n != c.value,
                ">" => n > c.value,
                _ => n < c.value,
            };
            let w = witness(scanned, n as i64, sources, &fingerprint);
            vu_result(
                vu,
                if pass { Verdict::Pass } else { Verdict::Fail },
                Some(w),
                Some(json!({ "count": n, "op": c.op, "expected": c.value })),
            )
        }
        Checker::Exists(c) => {
            let sql = if let Some(pred) = &c.predicate {
                if pred.agg.as_ref().map(|a| !a.is_empty()).unwrap_or(false) {
                    return err(vu, "exists predicate must not carry agg (r9 E2)");
                }
                let scan = match render_scan(pred) {
                    Ok(s) => s,
                    Err(e) => return err(vu, e),
                };
                format!("SELECT 1 FROM {}{}", scan.from, scan.where_sql)
            } else {
                match &c.sql {
                    Some(s) => {
                        if has_dollar_placeholder(s) {
                            return err(vu, "raw sql must not contain \"$\"");
                        }
                        s.clone()
                    }
                    None => return err(vu, "exists checker needs sql or predicate"),
                }
            };
            let rows = match runner.query(&sql) {
                Ok(r) => r,
                Err(e) => return err(vu, format!("query failed: {e}")),
            };
            let present = !rows.is_empty();
            let (scanned, sources) = rows_scanned_from_sql(runner, &sql);
            let w = witness(scanned, rows.len() as i64, sources, &fingerprint);
            vu_result(
                vu,
                if present == c.expect { Verdict::Pass } else { Verdict::Fail },
                Some(w),
                Some(json!({ "present": present, "expect": c.expect })),
            )
        }
        Checker::File(c) => {
            let dir = match opts.submission_dir {
                Some(d) => d,
                None => return err(vu, "file checker requires --attachments <dir>"),
            };
            if c.glob == "*" || c.glob == "**" || c.glob == "**/*" {
                return err(vu, "glob \"*\" matches everything and proves nothing — construct rejected");
            }
            let all = walk_files(Path::new(dir));
            let re = glob_to_regex(&c.glob);
            let matched: Vec<PathBuf> = all
                .iter()
                .filter(|p| {
                    let rel = p.strip_prefix(dir).unwrap_or(p).to_string_lossy().replace('\\', "/");
                    re.as_ref().map(|r| r.is_match(&rel)).unwrap_or(false)
                })
                .cloned()
                .collect();
            let w = witness(all.len() as i64, matched.len() as i64, Vec::new(), &fingerprint);
            let mut problems: Vec<String> = Vec::new();
            if let Some(min) = c.min {
                if (matched.len() as u64) < min {
                    problems.push(format!("expected >={min} files, got {}", matched.len()));
                }
            }
            if let Some(max) = c.max {
                if (matched.len() as u64) > max {
                    problems.push(format!("expected <={max} files, got {}", matched.len()));
                }
            }
            for must in c.require.clone().unwrap_or_default() {
                if !all.iter().any(|p| p.file_name().map(|f| f == must.as_str()).unwrap_or(false)) {
                    problems.push(format!("required file missing: {must}"));
                }
            }
            if let Some(sha_map) = &c.sha256 {
                for (rel, want) in sha_map {
                    let full = Path::new(dir).join(rel);
                    match std::fs::read(&full) {
                        Ok(bytes) => {
                            let mut hasher = sha2::Sha256::new();
                            use sha2::Digest;
                            hasher.update(&bytes);
                            let got = hex::encode(hasher.finalize());
                            if &got != want {
                                problems.push(format!("sha256 mismatch: {rel}"));
                            }
                        }
                        Err(_) => problems.push(format!("file not readable: {rel}")),
                    }
                }
            }
            if all.is_empty() {
                return vu_result(vu, Verdict::NeedsMaterial, Some(w), Some(json!({ "reason": "submission directory is empty" })));
            }
            vu_result(
                vu,
                if problems.is_empty() { Verdict::Pass } else { Verdict::Fail },
                Some(w),
                Some(json!({ "files": all.len(), "matched": matched.len(), "problems": problems.iter().take(5).collect::<Vec<_>>() })),
            )
        }
        Checker::Command(c) => {
            let allow = opts.command_allowlist.clone().unwrap_or_default();
            if allow.is_empty() {
                return err(vu, "command checker requires an explicit argv[0] allowlist (sealed builds reject specs with commands otherwise)");
            }
            let bin = c.argv.first().cloned().unwrap_or_default();
            if !allow.contains(&bin) {
                return err(vu, format!("command not in allowlist: {bin}"));
            }
            let mut cmd = std::process::Command::new(&bin);
            cmd.args(c.argv.iter().skip(1));
            if let Some(dir) = opts.submission_dir {
                cmd.current_dir(dir);
            }
            let out = match cmd.output() {
                Ok(o) => o,
                Err(e) => return err(vu, format!("spawn failed: {e}")),
            };
            let exit = out.status.code().unwrap_or(-1);
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let expect_exit = c.expect_exit.unwrap_or(0);
            let mut pass = exit == expect_exit;
            if pass {
                if let Some(pattern) = &c.stdout_matches {
                    match regex::Regex::new(pattern) {
                        Ok(re) => pass = re.is_match(&stdout),
                        Err(e) => return err(vu, format!("invalid stdout_matches regex: {e}")),
                    }
                }
            }
            vu_result(
                vu,
                if pass { Verdict::Pass } else { Verdict::Fail },
                None,
                Some(json!({ "exit": exit, "expected_exit": expect_exit, "stdout": stdout.chars().take(2000).collect::<String>() })),
            )
        }
        Checker::Agent(_) => err(vu, "review layer not available in fact-only mode (sealed build without --with-review)"),
    }
}

fn walk_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

fn glob_to_regex(glob: &str) -> Option<regex::Regex> {
    let mut re = String::from("^");
    let bytes: Vec<char> = glob.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            '*' => {
                if i + 1 < bytes.len() && bytes[i + 1] == '*' {
                    if i + 2 < bytes.len() && bytes[i + 2] == '/' {
                        re.push_str("(?:.*/)?");
                        i += 3;
                        continue;
                    }
                    re.push_str(".*");
                    i += 2;
                    continue;
                }
                re.push_str("[^/]*");
                i += 1;
            }
            '?' => {
                re.push_str("[^/]");
                i += 1;
            }
            c => {
                re.push_str(&regex::escape(&c.to_string()));
                i += 1;
            }
        }
    }
    re.push('$');
    regex::Regex::new(&re).ok()
}

/// `$vu:` 引用（管线依赖）→ VU id。
pub fn ref_id(text: &str) -> String {
    text.trim().trim_start_matches("$vu:").to_string()
}

/// 拓扑排序（引用必须先产出）；环 = 构造错误。
pub fn topo_order(vu: &[VerifyUnit]) -> Result<Vec<VerifyUnit>, String> {
    let ids: BTreeSet<String> = vu.iter().map(|u| u.id.clone()).collect();
    let mut deps: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for u in vu {
        let mut set = BTreeSet::new();
        let json = serde_json::to_string(&u.checker).unwrap_or_default();
        let mut rest = json.as_str();
        while let Some(idx) = rest.find("$vu:") {
            rest = &rest[idx + 4..];
            let end = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
                .unwrap_or(rest.len());
            let id = &rest[..end];
            if !id.is_empty() && ids.contains(id) && id != u.id {
                set.insert(id.to_string());
            }
            rest = &rest[end..];
        }
        deps.insert(u.id.clone(), set);
    }
    let mut sorted = Vec::new();
    let mut done: BTreeSet<String> = BTreeSet::new();
    let mut remaining: Vec<&VerifyUnit> = vu.iter().collect();
    while !remaining.is_empty() {
        let (ready, rest): (Vec<&VerifyUnit>, Vec<&VerifyUnit>) = remaining
            .into_iter()
            .partition(|u| deps.get(&u.id).map(|d| d.iter().all(|x| done.contains(x))).unwrap_or(true));
        if ready.is_empty() {
            let cycle: Vec<String> = rest.iter().map(|u| u.id.clone()).collect();
            return Err(format!("pipeline cycle detected: {}", cycle.join(" -> ")));
        }
        for u in &ready {
            done.insert(u.id.clone());
            sorted.push((*u).clone());
        }
        remaining = rest;
    }
    Ok(sorted)
}

/// 折叠：FAIL > NEEDS-MATERIAL > ERROR > PASS；只算 role=assert（source 不参与折叠）。
pub fn fold_overall(results: &[VuResult]) -> (Verdict, String) {
    let asserted: Vec<&VuResult> = results.iter().filter(|r| r.role.as_deref() != Some("source")).collect();
    // reason 文案与 TS foldOverall 逐字一致（评审 r13 ②：三处口径不一是伪装成 parity 的裂缝）
    let ids = |v: Verdict, with_sev: bool| -> String {
        asserted
            .iter()
            .filter(|r| r.verdict == v)
            .map(|r| if with_sev { format!("{}({})", r.id, r.severity) } else { r.id.clone() })
            .collect::<Vec<_>>()
            .join(", ")
    };
    if asserted.iter().any(|r| r.verdict == Verdict::Fail) {
        return (Verdict::Fail, format!("{} FAIL", ids(Verdict::Fail, true)));
    }
    if asserted.iter().any(|r| r.verdict == Verdict::NeedsMaterial) {
        return (Verdict::NeedsMaterial, format!("{} need material", ids(Verdict::NeedsMaterial, false)));
    }
    if asserted.iter().any(|r| r.verdict == Verdict::Error) {
        return (Verdict::Error, format!("{} errored", ids(Verdict::Error, false)));
    }
    if asserted.is_empty() {
        return (Verdict::NeedsMaterial, "no assert units — spec asserts nothing".into());
    }
    (Verdict::Pass, format!("all {} assert units passed", asserted.len()))
}

pub fn summary_of(results: &[VuResult]) -> Summary {
    let asserted = || results.iter().filter(|r| r.role.as_deref() != Some("source"));
    let count = |v: Verdict| asserted().filter(|r| r.verdict == v).count() as u32;
    Summary {
        pass: count(Verdict::Pass),
        fail: count(Verdict::Fail),
        needs_material: count(Verdict::NeedsMaterial),
        error: count(Verdict::Error),
    }
}

/// 跑整份 spec（fact 层）。`run_id` 缺省由 spec_id + as_of 派生，保证同输入同报告字节。
pub fn run_verify(spec: &VerifySpec, opts: &VerifyOptions) -> Result<VerifyReport, String> {
    // 契约钉版：1.0 引擎只跑 1.0 spec（形状变了必须升版重出）
    if spec.contract_version != CONTRACT_VERSION {
        return Err(format!(
            "unsupported contract_version {} — this engine implements {CONTRACT_VERSION}",
            spec.contract_version
        ));
    }
    // N2：sql 文本不支持占位展开（$vu: 只允许出现在 count.from / sql-pair 侧引用）
    for vu in &spec.vu {
        if let Checker::Sql(c) = &vu.checker {
            let text = format!("{} {}", c.sql.clone().unwrap_or_default(), c.scope_sql.clone().unwrap_or_default());
            if text.contains('$') {
                return Err(format!(
                    "{}: \"$\" in sql text is not supported — pipeline refs belong to count.from / sql-pair sides (no placeholder expansion)",
                    vu.id
                ));
            }
        }
    }
    // R13：as_of 必须锚定——时间函数在构造期拒绝（NOW()/CURRENT_TIMESTAMP 无法重放）
    let time_fn = regex::Regex::new(r#"(?i)(^|[^A-Za-z0-9_])(now\s*\(|'now'|"now"|(current_timestamp|current_date|current_time)([^A-Za-z0-9_]|$))"#)
        .expect("time fn regex");
    for vu in &spec.vu {
        let (sql, scope) = match &vu.checker {
            Checker::Sql(c) => (c.sql.clone().unwrap_or_default(), c.scope_sql.clone().unwrap_or_default()),
            Checker::Count(c) => (c.sql.clone().unwrap_or_default(), String::new()),
            Checker::Exists(c) => (c.sql.clone().unwrap_or_default(), String::new()),
            _ => (String::new(), String::new()),
        };
        let text = strip_sql_comments(&format!("{sql} {scope}"));
        if time_fn.is_match(&text) {
            return Err(format!(
                "{}: non-deterministic time function in sql — freeze the timestamp via as_of/parameters (R13)",
                vu.id
            ));
        }
        if let Value::Object(map) = &vu.expected_from {
            if map.contains_key("as_of") {
                let scoped = !scope.is_empty() || text.to_ascii_lowercase().contains("as of");
                if !scoped {
                    return Err(format!(
                        "{}: expected_from.as_of requires scope_sql (or an explicit AS OF clause) — as_of alone is not replayable (N6)",
                        vu.id
                    ));
                }
            }
        }
    }
    // S2：scope_sql 与 sql 必须落在同一批表上（部分重叠即可，完全不相交 = 各查各的表）
    for vu in &spec.vu {
        if let Checker::Sql(c) = &vu.checker {
            if let (Some(sql), Some(scope)) = (&c.sql, &c.scope_sql) {
                let a: BTreeSet<String> = crate::sqlite::extract_tables(sql).into_iter().collect();
                let b: BTreeSet<String> = crate::sqlite::extract_tables(scope).into_iter().collect();
                if !a.is_empty() && !b.is_empty() && a.is_disjoint(&b) {
                    return Err(format!(
                        "{}: scope_sql reads {} while sql reads {} — no shared table means the \"batch\" is not the one being checked (S2)",
                        vu.id,
                        b.into_iter().collect::<Vec<_>>().join(", "),
                        a.into_iter().collect::<Vec<_>>().join(", ")
                    ));
                }
            }
        }
    }
    if !spec.vu.iter().any(|u| u.role == "assert") {
        return Err("spec has no assert units — nothing to verify".into());
    }
    let order = topo_order(&spec.vu)?;
    let mut outputs: HashMap<String, Vec<Row>> = HashMap::new();
    let mut results: Vec<VuResult> = Vec::new();
    let mut skipped: BTreeSet<String> = BTreeSet::new();
    // started/finished 是真时刻（评审 fdc757f6 ④⑤：Rust 侧曾恒为 1970，报告两个实现就对不齐）；
    // 语料 parity 用 --now 固定，真实运行用系统时钟。
    let started = opts.now_iso.clone().unwrap_or_else(now_iso);

    for vu in &order {
        let refs: BTreeSet<String> = {
            let json = serde_json::to_string(&vu.checker).unwrap_or_default();
            let mut set = BTreeSet::new();
            let mut rest = json.as_str();
            while let Some(idx) = rest.find("$vu:") {
                rest = &rest[idx + 4..];
                let end = rest
                    .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
                    .unwrap_or(rest.len());
                if !rest[..end].is_empty() {
                    set.insert(rest[..end].to_string());
                }
                rest = &rest[end..];
            }
            set
        };
        // source 型：真正取数（下游按引用消费）；取数失败 → ERROR 且级联（不参与折叠）
        if vu.role == "source" {
            match fetch_source_rows(vu, opts.runner) {
                Ok(rows) => {
                    let n = rows.len();
                    outputs.insert(vu.id.clone(), rows);
                    let mut r = vu_result(vu, Verdict::Pass, None, Some(json!({ "rows": n })));
                    r.trace = Some("PASS-by-construction (source; not folded — downstream failure surfaces as ERROR)".into());
                    results.push(r);
                }
                Err(e) => {
                    skipped.insert(vu.id.clone());
                    outputs.insert(vu.id.clone(), Vec::new());
                    let mut r = vu_result(
                        vu,
                        Verdict::Error,
                        None,
                        Some(json!({ "rows": 0, "error": e })),
                    );
                    r.trace = Some("source fetch failed — downstream references turn ERROR (not folded into overall)".into());
                    results.push(r);
                }
            }
            continue;
        }
        let mut result = run_fact_checker(vu, opts.runner, opts, &outputs);
        // 级联（评审 a）：引用了取数失败/构造错误的单元 → 下游一律 ERROR
        let broken: Vec<String> = refs
            .iter()
            .filter(|r| results.iter().any(|x| &x.id == *r && x.verdict == Verdict::Error))
            .cloned()
            .collect();
        if !broken.is_empty() {
            result.verdict = Verdict::Error;
            let mut ev = result.evidence.clone().unwrap_or_else(|| json!({}));
            if let Some(obj) = ev.as_object_mut() {
                obj.insert("reason".into(), json!(format!("upstream source failed: {}", broken.join(", "))));
            }
            result.evidence = Some(ev);
        }
        // schema 漂移（评审 c）：prepare 冻结的指纹与本次运行不一致 → ERROR
        if let Some(frozen) = &spec.schema_fingerprint {
            let current = opts.runner.schema_fingerprint().unwrap_or_default();
            if &current != frozen {
                result.verdict = Verdict::Error;
                let mut ev = result.evidence.clone().unwrap_or_else(|| json!({}));
                if let Some(obj) = ev.as_object_mut() {
                    obj.insert("schema_drift".into(), json!({ "frozen": frozen, "current": current }));
                    obj.insert("reason".into(), json!("schema_drift: fingerprint differs from the one frozen at prepare"));
                }
                result.evidence = Some(ev);
            }
        }
        let ct = vu.checker.type_name();
        // 装配期守卫：PASS 必须带非零扫描（防空洞通过；command/agent 不适用）
        if result.verdict == Verdict::Pass {
            let zero = result.witness.as_ref().map(|w| w.rows_scanned == 0).unwrap_or(false);
            if zero && ct != "command" && ct != "agent" {
                result.verdict = Verdict::NeedsMaterial;
                let mut ev = result.evidence.clone().unwrap_or_else(|| json!({}));
                if let Some(obj) = ev.as_object_mut() {
                    obj.insert("degraded_from".into(), json!("PASS"));
                    obj.insert("reason".into(), json!("zero rows scanned — cannot assert PASS (vacuous prevention)"));
                }
                result.evidence = Some(ev);
            }
        }
        result.guard = Some(json!({ "leniency_checks": ["not-same-source", "has-where", "falsifiable"] }));
        // 契约要求 fact 型 VuResult 必带 witness（TS 用零值兜底）；ERROR 早退路径尤其容易漏。
        if matches!(ct, "sql" | "sql-pair" | "count" | "exists" | "file") && result.witness.is_none() {
            result.witness = Some(ScopeWitness {
                rows_scanned: 0,
                rows_matched: 0,
                sources: Vec::new(),
                schema_fingerprint: opts.runner.schema_fingerprint().unwrap_or_default(),
            });
        }
        if result.verdict == Verdict::Pass {
            if let Some(rows) = pipeline_rows(vu, opts.runner) {
                outputs.insert(vu.id.clone(), rows);
            }
        }
        results.push(result);
    }

    // schema 指纹二次汇总：witness 里与冻结值不一致的单元同样降级（TS 同口径）
    if let Some(frozen) = &spec.schema_fingerprint {
        for r in results.iter_mut() {
            if let Some(w) = &r.witness {
                if &w.schema_fingerprint != frozen {
                    r.verdict = Verdict::Error;
                    let mut ev = r.evidence.clone().unwrap_or_else(|| json!({}));
                    if let Some(obj) = ev.as_object_mut() {
                        obj.insert("schema_drift".into(), json!(true));
                        obj.insert("expected_schema".into(), json!(frozen));
                        obj.insert("seen".into(), json!(w.schema_fingerprint));
                    }
                    r.evidence = Some(ev);
                }
            }
        }
    }
    let exceptions: Vec<Value> = results
        .iter()
        .filter(|r| r.role.as_deref() == Some("assert") && (r.verdict == Verdict::Fail || r.verdict == Verdict::NeedsMaterial))
        .map(|r| {
            let row_count = r
                .evidence
                .as_ref()
                .and_then(|e| e.get("violations"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            json!({ "vu": r.id, "severity": r.severity, "row_count": row_count })
        })
        .collect();
    let (overall, reason) = fold_overall(&results);
    let summary = summary_of(&results);
    let run_id = opts
        .run_id
        .clone()
        .unwrap_or_else(|| format!("run_{}", &canonical_sha256(&json!({ "spec": spec.spec_id, "as_of": spec.as_of.value, "started": started }))[7..19]));
    let mut report = VerifyReport {
        contract_version: CONTRACT_VERSION.to_string(),
        run_id,
        spec_id: Some(spec.spec_id.clone()),
        data_source: opts.data_source.clone(),
        started: started.clone(),
        // 与 TS 同口径：--now 钉住时 started/finished 都用它（可重放报告必须字节稳定）
        finished: opts.now_iso.clone().unwrap_or_else(now_iso),
        verifier: ReportVerifier {
            mode: opts.mode.clone().unwrap_or_else(|| "open".into()),
            binary_sha256: opts.binary_sha256.clone(),
            engine_version: opts.engine_version.clone().unwrap_or_else(|| "0.1.0".into()),
            spec_version: spec.spec_version,
            corpus_version: spec.verifier.corpus_version.clone(),
            sealed_review: spec.sealed.review,
        },
        as_of: spec.as_of.clone(),
        summary,
        overall,
        reason,
        vu: results,
        exceptions,
        payload_sha256: None,
        artifacts: Some(json!({
            "attachment_sha256": spec.attachments.iter().map(|a| a.sha256.clone()).collect::<Vec<_>>()
        })),
    };
    let mut value = serde_json::to_value(&report).map_err(|e| e.to_string())?;
    if let Some(obj) = value.as_object_mut() {
        obj.remove("payload_sha256");
    }
    report.payload_sha256 = Some(format!("sha256:{}", canonical_sha256(&value)));
    Ok(report)
}

/// source 型 VU 的取数（sql 或谓词形态）；失败返回错误文本供级联判定。
fn fetch_source_rows(vu: &VerifyUnit, runner: &SqliteRunner) -> Result<Vec<Row>, String> {
    match &vu.checker {
        Checker::Sql(c) => {
            if let Some(pred) = &c.predicate {
                let rendered = render_predicate(pred)?;
                runner.query(&rendered.find_sql)
            } else if let Some(sql) = &c.sql {
                if has_dollar_placeholder(sql) {
                    return Err("raw sql must not contain \"$\"".into());
                }
                runner.query(sql)
            } else {
                Err("source unit needs sql or predicate".into())
            }
        }
        _ => Ok(Vec::new()),
    }
}

/// 产出行集（管线引用 / count from 用）：谓词 sid？这里只处理 from 引用型。
fn pipeline_rows(vu: &VerifyUnit, runner: &SqliteRunner) -> Option<Vec<Row>> {
    match &vu.checker {
        Checker::Sql(c) => {
            if let Some(pred) = &c.predicate {
                let rendered = render_predicate(pred).ok()?;
                runner.query(&rendered.find_sql).ok()
            } else {
                c.sql.as_ref().and_then(|s| runner.query(s).ok())
            }
        }
        _ => None,
    }
}

/// 当前 UTC 时刻（RFC3339 毫秒）——与 TS `new Date().toISOString()` 同形。
fn now_iso() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    crate::predicate::format_iso_utc(ms)
}

/// TS `String(value)` 口径（排序键用）。
fn value_to_key(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn row_to_json(row: &Row) -> Value {
    let mut map = serde_json::Map::new();
    for (k, v) in row {
        map.insert(k.clone(), v.clone());
    }
    Value::Object(map)
}

/// 按前 `key_cols` 列的字符串键排序（TS canonicalRows 同口径：键串以 NUL 连接）。
fn canonical_rows(rows: &[Row], key_cols: usize) -> Vec<Value> {
    let mut keyed: Vec<(String, Value)> = rows
        .iter()
        .map(|r| {
            let k = r
                .iter()
                .take(key_cols)
                .map(|(_, v)| value_to_key(v))
                .collect::<Vec<_>>()
                .join("\u{0}");
            (k, row_to_json(r))
        })
        .collect();
    keyed.sort_by(|a, b| a.0.cmp(&b.0));
    keyed.into_iter().map(|(_, v)| v).collect()
}
