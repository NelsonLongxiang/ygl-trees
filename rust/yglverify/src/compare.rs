//! CompareSpec 求值器（评审 B5 / R7 / W1b / W2 / W3 / W4）——TS `compare.ts` 的 Rust 镜像。
//!
//! 逐条对齐 TS 实现，因为 TS 与 Rust 必须对同一 spec 给出同一结论（四向 parity）：
//! - 有 currency+scale 时化到最小单位整数再比；
//! - exact 域禁止静默舍入（1e-6 分容差内才算可精确表示）；
//! - NULL 默认 error（NULL ≠ 0）；
//! - window 只收 ISO 8601 且**带时区**（无时区会被本机时区解释）；
//! - regex 模式 pattern 上限 200。

use crate::contract::CompareSpec;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum CompareOutcome {
    Equal(bool),
    Error(String),
}

impl CompareOutcome {
    pub fn is_equal(&self) -> Option<bool> {
        match self {
            CompareOutcome::Equal(b) => Some(*b),
            CompareOutcome::Error(_) => None,
        }
    }
}

fn as_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64().filter(|x| x.is_finite()),
        Value::String(s) if !s.trim().is_empty() => s.trim().parse::<f64>().ok().filter(|x| x.is_finite()),
        _ => None,
    }
}

fn as_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn is_null(v: &Value) -> bool {
    matches!(v, Value::Null)
}

fn exact_minor_units(v: &Value, scale: u32) -> Option<i64> {
    let raw = as_number(v)?;
    let scaled = raw * 10f64.powi(scale as i32);
    let rounded = scaled.round();
    if (scaled - rounded).abs() > 1e-6 {
        return None;
    }
    Some(rounded as i64)
}

fn to_minor_units(v: &Value, scale: u32) -> Option<i64> {
    let raw = as_number(v)?;
    Some((raw * 10f64.powi(scale as i32)).round() as i64)
}

fn set_of(v: &Value) -> Option<Vec<String>> {
    match v {
        Value::Array(a) => Some(a.iter().map(json_scalar).collect()),
        Value::String(s) => Some(
            s.split(',')
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect(),
        ),
        _ => None,
    }
}

fn json_scalar(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// `+08` → `+08:00`（TS 里只有小时偏移的写法在 Date.parse 是 NaN）。
fn with_offset_minutes(s: &str) -> String {
    let bytes = s.as_bytes();
    if bytes.len() >= 3 {
        let tail = &bytes[bytes.len() - 3..];
        if (tail[0] == b'+' || tail[0] == b'-') && tail[1].is_ascii_digit() && tail[2].is_ascii_digit() {
            let mut out = s.to_string();
            out.push_str(":00");
            return out;
        }
    }
    s.to_string()
}

fn is_digits(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit())
}

/// 仅日期 `YYYY-MM-DD`（整天锚点）。
pub fn is_iso_date_only(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && is_digits(&s[0..4], 4)
        && b[4] == b'-'
        && is_digits(&s[5..7], 2)
        && b[7] == b'-'
        && is_digits(&s[8..10], 2)
}

/// 带时区的 ISO 8601 datetime：`YYYY-MM-DD[T ]HH:MM[:SS[.fff]][Z|±HH[:MM]|±HHMM|±HH]`。
pub fn is_iso_datetime_tz(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 16 {
        return false;
    }
    if !is_digits(&s[0..4], 4) || b[4] != b'-' || !is_digits(&s[5..7], 2) || b[7] != b'-' || !is_digits(&s[8..10], 2) {
        return false;
    }
    if b[10] != b'T' && b[10] != b' ' {
        return false;
    }
    if !is_digits(&s[11..13], 2) || b[13] != b':' || !is_digits(&s[14..16], 2) {
        return false;
    }
    let mut i = 16;
    if i < b.len() && b[i] == b':' {
        if i + 3 > b.len() || !is_digits(&s[i + 1..i + 3], 2) {
            return false;
        }
        i += 3;
        if i < b.len() && b[i] == b'.' {
            let start = i + 1;
            let mut j = start;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j == start {
                return false;
            }
            i = j;
        }
    }
    let tz = &s[i..];
    if tz == "Z" || tz == "z" {
        return true;
    }
    let tb = tz.as_bytes();
    if tb.len() < 3 || (tb[0] != b'+' && tb[0] != b'-') {
        return false;
    }
    // 偏移三种写法：+08（2 位）/ +0800（4 位）/ +08:00（2+冒号+2）
    if tb.len() == 3 {
        return tb[1].is_ascii_digit() && tb[2].is_ascii_digit();
    }
    if tb.len() == 6 {
        return is_digits(&tz[1..3], 2) && tb[3] == b':' && is_digits(&tz[4..6], 2);
    }
    if tb.len() == 5 {
        return is_digits(&tz[1..3], 2) && is_digits(&tz[3..5], 2);
    }
    false
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// ISO 字符串 → epoch ms。非 ISO / 无时区 → None（调用方判 ERROR）。
fn to_epoch_ms(v: &Value) -> Option<i64> {
    let s = match v {
        Value::String(s) => s.trim().to_string(),
        _ => return None,
    };
    if is_iso_date_only(&s) {
        let y: i64 = s[0..4].parse().ok()?;
        let m: i64 = s[5..7].parse().ok()?;
        let d: i64 = s[8..10].parse().ok()?;
        return Some(days_from_civil(y, m, d) * 86_400_000);
    }
    if !is_iso_datetime_tz(&s) {
        return None;
    }
    let t = with_offset_minutes(&s);
    let y: i64 = t[0..4].parse().ok()?;
    let mo: i64 = t[5..7].parse().ok()?;
    let d: i64 = t[8..10].parse().ok()?;
    let h: i64 = t[11..13].parse().ok()?;
    let mi: i64 = t[14..16].parse().ok()?;
    let mut idx = 16;
    let mut sec = 0i64;
    let mut ms = 0i64;
    let bytes = t.as_bytes();
    if idx < bytes.len() && bytes[idx] == b':' {
        sec = t[idx + 1..idx + 3].parse().ok()?;
        idx += 3;
        if idx < bytes.len() && bytes[idx] == b'.' {
            let start = idx + 1;
            let mut j = start;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            let frac = &t[start..j];
            let mut padded = frac.to_string();
            while padded.len() < 3 {
                padded.push('0');
            }
            ms = padded[0..3].parse().ok()?;
            idx = j;
        }
    }
    let tz = &t[idx..];
    let offset_min: i64 = if tz == "Z" || tz == "z" {
        0
    } else {
        let sign = if tz.as_bytes()[0] == b'-' { -1 } else { 1 };
        let body = &tz[1..];
        let (hh, mm) = if body.contains(':') {
            let parts: Vec<&str> = body.split(':').collect();
            (parts[0].parse::<i64>().ok()?, parts[1].parse::<i64>().ok()?)
        } else if body.len() == 4 {
            (body[0..2].parse::<i64>().ok()?, body[2..4].parse::<i64>().ok()?)
        } else {
            (body.parse::<i64>().ok()?, 0)
        };
        sign * (hh * 60 + mm)
    };
    let local_ms = days_from_civil(y, mo, d) * 86_400_000 + h * 3_600_000 + mi * 60_000 + sec * 1_000 + ms;
    Some(local_ms - offset_min * 60_000)
}

fn mode_is(spec: &CompareSpec, want: &str) -> bool {
    spec.mode == want
}

fn positive_eps(spec: &CompareSpec) -> Result<f64, String> {
    match spec.value {
        Some(v) if v.is_finite() && v > 0.0 => Ok(v),
        Some(v) => Err(format!("invalid tolerance value: {} (must be > 0; ε=0 is exact)", v)),
        None => Err(format!("{} requires numeric value (ε)", spec.mode)),
    }
}

/// 单值比较：返回 Equal 或 Error（构造/数据问题，调用方应判 ERROR/NM，绝不落 PASS）。
pub fn compare_values(left: &Value, right: &Value, spec: &CompareSpec) -> CompareOutcome {
    let null_mode = spec.null_mode.as_deref().unwrap_or("error");

    if mode_is(spec, "range") {
        let (lo_v, hi_v) = match (spec.value, spec.value_max) {
            (Some(a), Some(b)) => (a, b),
            _ => return CompareOutcome::Error("range mode requires \"value\" (min) and \"value_max\" (max)".into()),
        };
        if is_null(left) {
            return CompareOutcome::Error("null value under range compare (null is never inside a band)".into());
        }
        let actual = match as_number(left) {
            Some(n) => n,
            None => return CompareOutcome::Error(format!("non-numeric value under range ({})", json_scalar(left))),
        };
        let lo = lo_v.min(hi_v);
        let hi = lo_v.max(hi_v);
        return CompareOutcome::Equal(actual >= lo && actual <= hi);
    }

    let left_null = is_null(left);
    let right_null = is_null(right);
    if left_null || right_null {
        if left_null && right_null {
            return CompareOutcome::Equal(true);
        }
        if null_mode == "ignore" || null_mode == "equal" {
            return CompareOutcome::Equal(true);
        }
        return CompareOutcome::Error(format!(
            "null value compared under mode \"{}\" (null={})",
            spec.mode, null_mode
        ));
    }

    match spec.mode.as_str() {
        "exact" => {
            if let (Some(scale), Some(_currency)) = (spec.scale, spec.currency.as_ref()) {
                let (li, ri) = (exact_minor_units(left, scale), exact_minor_units(right, scale));
                return match (li, ri) {
                    (Some(a), Some(b)) => CompareOutcome::Equal(a == b),
                    _ => CompareOutcome::Error(format!(
                        "value is not representable at scale {} under exact compare ({} vs {}) — use tolerance_abs if rounding is acceptable",
                        scale,
                        json_scalar(left),
                        json_scalar(right)
                    )),
                };
            }
            match (as_string(left), as_string(right)) {
                (Some(a), Some(b)) => CompareOutcome::Equal(a == b),
                _ => CompareOutcome::Equal(left == right),
            }
        }
        "window" => {
            let unit = match spec.unit.as_deref() {
                Some(u) if ["d", "h", "s"].contains(&u) => u.to_string(),
                _ => return CompareOutcome::Error("window mode requires \"unit\" (d|h|s)".into()),
            };
            let width = match spec.value {
                Some(v) if v.is_finite() && v > 0.0 => v,
                other => return CompareOutcome::Error(format!("invalid window width: {:?} (must be > 0)", other)),
            };
            let unit_ms = match unit.as_str() {
                "d" => 86_400_000f64,
                "h" => 3_600_000f64,
                _ => 1_000f64,
            };
            let (lm, rm) = (to_epoch_ms(left), to_epoch_ms(right));
            match (lm, rm) {
                (Some(a), Some(b)) => CompareOutcome::Equal(((a - b) as f64).abs() <= width * unit_ms),
                _ => CompareOutcome::Error(format!(
                    "window mode requires date values (got {} vs {})",
                    json_scalar(left),
                    json_scalar(right)
                )),
            }
        }
        "tolerance_abs" => {
            let eps = match positive_eps(spec) {
                Ok(v) => v,
                Err(e) => return CompareOutcome::Error(e),
            };
            if let (Some(scale), Some(_currency)) = (spec.scale, spec.currency.as_ref()) {
                let (l, r) = (to_minor_units(left, scale), to_minor_units(right, scale));
                return match (l, r) {
                    (Some(a), Some(b)) => {
                        let tol = (eps * 10f64.powi(scale as i32)).round() as i64;
                        CompareOutcome::Equal((a - b).abs() <= tol)
                    }
                    _ => CompareOutcome::Error("non-numeric value under currency tolerance compare".into()),
                };
            }
            match (as_number(left), as_number(right)) {
                (Some(a), Some(b)) => CompareOutcome::Equal((a - b).abs() <= eps),
                _ => CompareOutcome::Error(format!(
                    "non-numeric value under tolerance ({} vs {})",
                    json_scalar(left),
                    json_scalar(right)
                )),
            }
        }
        "tolerance_rel" => {
            let eps = match positive_eps(spec) {
                Ok(v) => v,
                Err(e) => return CompareOutcome::Error(e),
            };
            match (as_number(left), as_number(right)) {
                (Some(a), Some(b)) => {
                    let base = b.abs();
                    if base == 0.0 {
                        CompareOutcome::Equal(a == 0.0)
                    } else {
                        CompareOutcome::Equal((a - b).abs() / base <= eps)
                    }
                }
                _ => CompareOutcome::Error("non-numeric value under relative tolerance".into()),
            }
        }
        "subset" | "superset" => {
            let (l, r) = match (set_of(left), set_of(right)) {
                (Some(a), Some(b)) => (a, b),
                _ => return CompareOutcome::Error("subset/superset requires array or comma-separated values".into()),
            };
            let ls: std::collections::BTreeSet<&String> = l.iter().collect();
            let rs: std::collections::BTreeSet<&String> = r.iter().collect();
            if spec.mode == "subset" {
                CompareOutcome::Equal(ls.is_subset(&rs))
            } else {
                CompareOutcome::Equal(ls.is_superset(&rs))
            }
        }
        "regex" => {
            let (ls, rs) = match (as_string(left), as_string(right)) {
                (Some(a), Some(b)) => (a, b),
                _ => return CompareOutcome::Error("regex requires string values".into()),
            };
            if rs.chars().count() > 200 {
                return CompareOutcome::Error(format!(
                    "regex pattern too long ({} > 200) — pathological backtracking risk",
                    rs.chars().count()
                ));
            }
            match regex::Regex::new(&rs) {
                Ok(re) => CompareOutcome::Equal(re.is_match(&ls)),
                Err(e) => CompareOutcome::Error(format!("invalid regex: {e}")),
            }
        }
        other => CompareOutcome::Error(format!("unknown compare mode: {other}")),
    }
}

/// 构造期校验：CompareSpec 自身是否可判（与 TS validateCompareSpec 同口径）。
pub fn validate_compare_spec(spec: &CompareSpec) -> Vec<String> {
    let mut errs = Vec::new();
    let known = ["exact", "tolerance_abs", "tolerance_rel", "window", "subset", "superset", "range", "regex"];
    if !known.contains(&spec.mode.as_str()) {
        errs.push(format!("unknown compare mode: {}", spec.mode));
    }
    if spec.currency.is_some() != spec.scale.is_some() {
        errs.push("currency and scale must be provided together".into());
    }
    if let Some(scale) = spec.scale {
        if scale > 6 {
            errs.push("scale must be an integer 0..6".into());
        }
    }
    let tol = matches!(spec.mode.as_str(), "tolerance_abs" | "tolerance_rel" | "window");
    if spec.mode == "exact" && spec.value.is_some() {
        errs.push("exact takes no tolerance value (use tolerance_abs for ε)".into());
    }
    if tol {
        match spec.value {
            None => errs.push(format!("{} requires numeric value (ε)", spec.mode)),
            Some(v) if !(v > 0.0) => errs.push(format!("{} requires ε > 0 (ε=0 is exact)", spec.mode)),
            _ => {}
        }
    }
    if spec.mode == "window" && spec.unit.is_none() {
        errs.push("window requires unit (d|h|s)".into());
    }
    if spec.unit.is_some() && spec.mode != "window" {
        errs.push("unit only applies to window mode".into());
    }
    if let Some(u) = spec.unit.as_deref() {
        if !["d", "h", "s"].contains(&u) {
            errs.push("unit must be d|h|s".into());
        }
    }
    if spec.mode == "range" && (spec.value.is_none() || spec.value_max.is_none()) {
        errs.push("range requires value and value_max".into());
    }
    if spec.cardinality.as_deref() == Some("1:N") && spec.agg.is_none() {
        errs.push("cardinality \"1:N\" requires agg (sum|max|min)".into());
    }
    errs
}
