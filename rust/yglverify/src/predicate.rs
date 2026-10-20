//! 谓词 AST 渲染（r5 S2 / R3 / r8 F1）——TS `renderScan/renderPredicate` 的 Rust 镜像。
//!
//! 同源生成：find 与 scope 共享同一 FROM 与同一 scan 子句字符串，
//! `rows_scanned` 因此是「域内看了多少行」，构造上不可能伪造扫描面。
//!
//! 逐字 parity 要求：渲染结果进报告（rendered.findSql），Rust 与 TS 必须同字节。

use crate::compare::{is_iso_datetime_tz, CompareOutcome};
use crate::contract::{Predicate, PredicateAgg, PredicateCondition, PredicateGroup, PredicateNode};

const IDENT_RE_OK: fn(&str) -> bool = |s: &str| {
    if s.is_empty() {
        return false;
    }
    let mut chars = s.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
};

/// 标识符守门：只允许裸列名/表名（可选 `a.b`），禁止表达式与子查询进判据。
/// Public wrapper for the identifier guard (engine's count.against uses it).
pub fn ident_public(name: &str, what: &str) -> Result<String, String> {
    ident(name, what)
}

fn ident(name: &str, what: &str) -> Result<String, String> {
    let parts: Vec<&str> = name.split('.').collect();
    if parts.len() > 2 || parts.iter().any(|p| !IDENT_RE_OK(p)) {
        return Err(format!(
            "predicate {what} must be a bare identifier (optionally table-qualified), got {name:?}"
        ));
    }
    Ok(parts.join("."))
}

/// 时间字面量规范化（r8 F5）：带偏移的时间统一折成 UTC Z（SQLite 里日期是字符串，字典序 ≠ 时间序）。
fn normalize_iso_literal(v: &str) -> Result<String, String> {
    if !is_iso_datetime_tz(v) {
        return Ok(v.to_string());
    }
    match crate::compare::iso_to_utc_millis(v) {
        Some(ms) => Ok(format_iso_utc(ms)),
        None => Err(format!(
            "predicate literal {v:?} looks like an ISO datetime but cannot be parsed"
        )),
    }
}

pub fn format_iso_utc(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let h = rem / 3_600_000;
    let mi = (rem % 3_600_000) / 60_000;
    let s = (rem % 60_000) / 1_000;
    let milli = rem % 1_000;
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 字面量渲染：数字走 ES `Number::toString` 近似（整数原样、小数最短往返），
/// 字符串按 `''` 转义——永不拼接外部 SQL 片段。
fn literal(v: &serde_json::Value) -> Result<String, String> {
    match v {
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                return Ok(i.to_string());
            }
            if let Some(u) = n.as_u64() {
                return Ok(u.to_string());
            }
            let f = n.as_f64().ok_or_else(|| format!("predicate literal is not a finite number: {n}"))?;
            if !f.is_finite() {
                return Err(format!("predicate literal is not a finite number: {f}"));
            }
            if f.fract() == 0.0 && f.abs() < 1e21 {
                return Ok(format!("{:.0}", f));
            }
            Ok(format!("{f}"))
        }
        serde_json::Value::String(s) => {
            let norm = normalize_iso_literal(s)?;
            Ok(format!("'{}'", norm.replace('\'', "''")))
        }
        other => Err(format!("predicate literal must be number or string, got {other}")),
    }
}

fn scalar_kind(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        _ => "other",
    }
}

fn assert_same_scalar_type(values: &[serde_json::Value], col: &str) -> Result<(), String> {
    let mut kinds: Vec<&str> = values.iter().map(scalar_kind).collect();
    kinds.sort_unstable();
    kinds.dedup();
    if kinds.contains(&"other") {
        return Err(format!("predicate where {col} list contains a non-scalar value"));
    }
    if kinds.len() > 1 {
        return Err(format!(
            "predicate where {col} list mixes numbers and strings — declare one type (r8 F3)"
        ));
    }
    Ok(())
}

/// 1.2: right-hand side that references a column (`{col}`).
fn column_ref(v: &Option<serde_json::Value>) -> Option<String> {
    match v {
        Some(serde_json::Value::Object(m)) => m.get("col").and_then(|c| c.as_str()).map(|s| s.to_string()),
        _ => None,
    }
}

/// 1.2: does the predicate contain any column-to-column comparison? Used by the
/// version-shape gate (declared 1.1 + 1.2 shapes must be rejected).
pub fn contains_col_ref(pred: &Predicate) -> bool {
    fn walk_node(n: &PredicateNode) -> bool {
        match n {
            PredicateNode::Condition(c) => column_ref(&c.value).is_some(),
            PredicateNode::Group(g) => g.conditions.iter().any(walk_node),
        }
    }
    fn walk_group(g: &Option<PredicateGroup>) -> bool {
        match g {
            Some(g) => g.conditions.iter().any(walk_node),
            None => false,
        }
    }
    walk_group(&pred.where_) || walk_group(&pred.scan)
}

/// 1.2: first column-to-column comparison in render order (`where` then `scan`) —
/// mirrors engine.ts so both implementations project the same pair.
pub fn first_col_ref_pair(pred: &Predicate) -> Option<(String, String)> {
    fn walk(n: &PredicateNode) -> Option<(String, String)> {
        match n {
            PredicateNode::Condition(c) => column_ref(&c.value).map(|rhs| (c.col.clone(), rhs)),
            PredicateNode::Group(g) => g.conditions.iter().find_map(walk),
        }
    }
    fn walk_group(g: &Option<PredicateGroup>) -> Option<(String, String)> {
        g.as_ref().and_then(|g| g.conditions.iter().find_map(walk))
    }
    walk_group(&pred.where_).or_else(|| walk_group(&pred.scan))
}

fn render_condition(w: &PredicateCondition, from_table: &str) -> Result<String, String> {
    let col = ident(&w.col, "where column")?;
    let rhs_col = column_ref(&w.value);
    match w.op.as_str() {
        "is null" | "is not null" => {
            if rhs_col.is_some() {
                return Err(format!(
                    "null_rhs_for_null_op: predicate where {col} {} must not carry a {{col}} value",
                    w.op
                ));
            }
            if w.value.is_some() {
                return Err(format!("predicate where {col} {} must not carry a value", w.op));
            }
            Ok(format!("{col} {}", w.op.to_uppercase()))
        }
        "in" => {
            let arr = match &w.value {
                Some(serde_json::Value::Array(a)) if !a.is_empty() => a,
                _ => return Err(format!("predicate where {col} in (...) needs a non-empty array value")),
            };
            assert_same_scalar_type(arr, &col)?;
            let mut parts = Vec::with_capacity(arr.len());
            for v in arr {
                parts.push(literal(v)?);
            }
            Ok(format!("{col} IN ({})", parts.join(", ")))
        }
        "between" => {
            let arr = match &w.value {
                Some(serde_json::Value::Array(a)) if a.len() == 2 => a,
                _ => return Err(format!("predicate where {col} between needs a two-element array value")),
            };
            assert_same_scalar_type(arr, &col)?;
            Ok(format!("{col} BETWEEN {} AND {}", literal(&arr[0])?, literal(&arr[1])?))
        }
        op => {
            if let Some(rhs) = &rhs_col {
                // 1.2 column-to-column: same table only.
                let parts: Vec<&str> = rhs.split('.').collect();
                let (qualifier, name) = if parts.len() > 1 {
                    (parts[0], parts[1])
                } else {
                    ("", parts[0])
                };
                if !qualifier.is_empty() && !from_table.is_empty() && qualifier != from_table {
                    return Err(format!(
                        "cross_table_col: predicate where {col} {op} {rhs} — column-to-column comparison is same-table only; a cross-table compare needs sql-pair (join key)"
                    ));
                }
                return Ok(format!("{col} {op} {}", ident(name, "where column ref")?));
            }
            let v = match &w.value {
                Some(serde_json::Value::Array(_)) | None => {
                    return Err(format!("predicate where {col} {op} needs a scalar value"))
                }
                Some(v) => v,
            };
            Ok(format!("{col} {op} {}", literal(v)?))
        }
    }
}

fn render_node(n: &PredicateNode, from_table: &str) -> Result<String, String> {
    match n {
        PredicateNode::Group(g) => {
            if g.conditions.is_empty() {
                return Err("predicate group has no conditions".into());
            }
            let mut parts = Vec::with_capacity(g.conditions.len());
            for c in &g.conditions {
                parts.push(render_node(c, from_table)?);
            }
            match g.op.as_str() {
                "not" => Ok(format!("NOT ({})", parts.join(" AND "))),
                "and" => Ok(format!("({})", parts.join(" AND "))),
                "or" => Ok(format!("({})", parts.join(" OR "))),
                other => Err(format!("predicate group op must be and|or|not, got {other:?}")),
            }
        }
        PredicateNode::Condition(c) => render_condition(c, from_table),
    }
}

fn render_where(where_: Option<&PredicateGroup>, from_table: &str) -> Result<String, String> {
    match where_ {
        None => Ok(String::new()),
        Some(g) => Ok(format!(" WHERE {}", render_node(&PredicateNode::Group(g.clone()), from_table)?)),
    }
}

/// 域过滤 AND 判据（两侧共用同一渲染器）。
fn and_groups(scan: Option<&PredicateGroup>, where_: Option<&PredicateGroup>) -> Option<PredicateGroup> {
    match (scan, where_) {
        (None, None) => None,
        (Some(g), None) => Some(g.clone()),
        (None, Some(g)) => Some(g.clone()),
        (Some(a), Some(b)) => Some(PredicateGroup {
            op: "and".into(),
            conditions: vec![PredicateNode::Group(a.clone()), PredicateNode::Group(b.clone())],
        }),
    }
}

#[derive(Debug, Clone)]
pub struct RenderedScan {
    pub from: String,
    pub where_sql: String,
    pub scan_sql: String,
}

/// 谓词渲染的公共部分：from 与 where/scan 两段（find/scope/count/exists 共用）。
pub fn render_scan(pred: &Predicate) -> Result<RenderedScan, String> {
    let from = ident(&pred.from, "from")?;
    let scan_sql = render_where(pred.scan.as_ref(), &pred.from)?;
    let where_sql = render_where(and_groups(pred.scan.as_ref(), pred.where_.as_ref()).as_ref(), &pred.from)?;
    Ok(RenderedScan { from, where_sql, scan_sql })
}

fn agg_alias(a: &PredicateAgg) -> String {
    a.as_name
        .clone()
        .unwrap_or_else(|| format!("{}_{}", a.fn_name, a.col.clone().unwrap_or_else(|| "all".into())))
}

/// 聚合列渲染 + 规则校验（r8 F1）：别名唯一、count 之外必须给列、select 不得与 agg 混排。
fn render_aggs(pred: &Predicate) -> Result<Vec<String>, String> {
    let aggs = match &pred.agg {
        None => return Ok(vec![]),
        Some(a) if a.is_empty() => return Ok(vec![]),
        Some(a) => a,
    };
    if !pred.select.is_empty() {
        return Err("predicate mixes select columns with agg without GROUP BY (renders invalid SQL on PG) — use agg-only".into());
    }
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::with_capacity(aggs.len());
    for a in aggs {
        let col = match &a.col {
            Some(c) => ident(c, "agg column")?,
            None => "*".to_string(),
        };
        if col == "*" && a.fn_name != "count" {
            return Err(format!("predicate agg {} needs a column (only count allows *)", a.fn_name));
        }
        let alias = ident(&agg_alias(a), "agg alias")?;
        if seen.contains(&alias) {
            return Err(format!("predicate agg alias {alias:?} is duplicated — aliases must be unique"));
        }
        seen.push(alias.clone());
        out.push(format!("{}({col}) AS {alias}", a.fn_name.to_uppercase()));
    }
    Ok(out)
}

#[derive(Debug, Clone)]
pub struct RenderedPredicate {
    pub find_sql: String,
    pub scope_sql: String,
}

/// 从同一 AST 渲染 find 与 scope 两段查询（同源生成）。
pub fn render_predicate(pred: &Predicate) -> Result<RenderedPredicate, String> {
    let scan = render_scan(pred)?;
    let aggs = render_aggs(pred)?;
    let mut cols = Vec::new();
    for c in &pred.select {
        cols.push(ident(c, "select column")?);
    }
    cols.extend(aggs);
    if cols.is_empty() {
        return Err("predicate.select must list at least one column (or use agg for an aggregate query)".into());
    }
    Ok(RenderedPredicate {
        find_sql: format!("SELECT {} FROM {}{}", cols.join(", "), scan.from, scan.where_sql),
        scope_sql: format!("SELECT count(*) AS n FROM {}{}", scan.from, scan.scan_sql),
    })
}

/// 谓词形态的聚合别名（sql-pair 谓词侧 / count 谓词形态用）。
pub fn agg_alias_of(pred: &Predicate, index: usize) -> Result<String, String> {
    match pred.agg.as_ref().and_then(|a| a.get(index)) {
        Some(a) => Ok(agg_alias(a)),
        None => Err(format!("predicate has no agg column at index {index}")),
    }
}

/// compare 结果转成「equal/错误」两分（引擎里用）。
pub fn outcome_equal(o: CompareOutcome) -> Result<bool, String> {
    match o {
        CompareOutcome::Equal(b) => Ok(b),
        CompareOutcome::Error(e) => Err(e),
    }
}
