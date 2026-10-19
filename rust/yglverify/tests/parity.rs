//! 四向 parity 的 Rust 侧锚点：
//! 1) 每一份冻结语料 spec.json 都能按契约解出来（形状 parity）；
//! 2) compare 八模式的语义与 TS 侧断言逐条一致（语义 parity）；
//! 3) canonical 向量由 tests/vectors.rs 负责（序列化 parity）。

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use yglverify::compare::{compare_values, validate_compare_spec, CompareOutcome};
use yglverify::contract::{parse_spec, CompareSpec};

fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/verify/core/corpus")
}

fn spec(mode: &str, extra: Value) -> CompareSpec {
    let mut base = json!({ "mode": mode });
    if let (Some(obj), Some(extra_obj)) = (base.as_object_mut(), extra.as_object()) {
        for (k, v) in extra_obj {
            obj.insert(k.clone(), v.clone());
        }
    }
    serde_json::from_value(base).expect("compare spec shape")
}

fn eq(left: Value, right: Value, spec: &CompareSpec) -> bool {
    match compare_values(&left, &right, spec) {
        CompareOutcome::Equal(b) => b,
        CompareOutcome::Error(e) => panic!("unexpected compare error: {e}"),
    }
}

fn err(left: Value, right: Value, spec: &CompareSpec) -> String {
    match compare_values(&left, &right, spec) {
        CompareOutcome::Error(e) => e,
        CompareOutcome::Equal(b) => panic!("expected error, got equal={b}"),
    }
}

#[test]
fn every_frozen_corpus_spec_parses() {
    let cases = corpus_dir().join("cases");
    let mut seen = 0usize;
    let mut dirs: Vec<PathBuf> = fs::read_dir(&cases)
        .expect("corpus cases dir")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    for dir in dirs {
        let spec_path = dir.join("spec.json");
        if !spec_path.exists() {
            continue;
        }
        let text = fs::read_to_string(&spec_path).expect("read spec");
        let parsed = parse_spec(&text).unwrap_or_else(|e| panic!("{}: {e}", spec_path.display()));
        assert!(!parsed.vu.is_empty(), "{}: unit list must not be empty", spec_path.display());
        for vu in &parsed.vu {
            assert!(["assert", "source"].contains(&vu.role.as_str()), "{}: bad role {}", vu.id, vu.role);
            assert!(["S1", "S2", "S3"].contains(&vu.severity.as_str()), "{}: bad severity", vu.id);
        }
        seen += 1;
    }
    assert!(seen >= 30, "expected the frozen corpus (>=30 specs), saw {seen}");
}

#[test]
fn contract_version_mismatch_is_rejected() {
    let cases = corpus_dir().join("cases");
    let any = fs::read_dir(&cases)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path().join("spec.json"))
        .find(|p| p.exists() && fs::read_to_string(p).map(|t| t.contains("\"type\": \"sql\"")).unwrap_or(false))
        .expect("at least one sql spec");
    let text = fs::read_to_string(any).unwrap();
    let mut value: Value = serde_json::from_str(&text).unwrap();
    value["contract_version"] = json!("0.4");
    let err = parse_spec(&value.to_string()).expect_err("old contract must be rejected");
    assert!(err.contains("unsupported contract_version"), "{err}");
}

#[test]
fn currency_exact_uses_minor_units() {
    let s = spec("exact", json!({ "currency": "CNY", "scale": 2 }));
    assert!(eq(json!(0.1 + 0.2), json!(0.3), &s));
    assert!(eq(json!(1290.4), json!(1290.40), &s));
    assert!(!eq(json!(412.5), json!(412.49), &s));
    // exact 域禁止静默舍入（W2）
    assert!(err(json!(1290.404), json!(1290.40), &s).contains("not representable at scale 2"));
}

#[test]
fn tolerances_cover_abs_rel_and_boundaries() {
    let abs = spec("tolerance_abs", json!({ "value": 0.01 }));
    assert!(eq(json!(1204.0), json!(1204.01), &abs));
    assert!(!eq(json!(1204.0), json!(1204.02), &abs));
    let rel = spec("tolerance_rel", json!({ "value": 0.01 }));
    assert!(eq(json!(2.35), json!(2.36), &rel));
    assert!(!eq(json!(2.35), json!(2.4), &rel));
    // W3：分母取期望侧，r=0 退化为 l==0
    assert!(!eq(json!(0.001), json!(0), &rel));
    assert!(eq(json!(0), json!(0), &rel));
    let bad = spec("tolerance_abs", json!({ "value": -1 }));
    assert!(err(json!(1), json!(1), &bad).contains("invalid tolerance value"));
}

#[test]
fn window_requires_timezone_and_real_width() {
    let s = spec("window", json!({ "value": 1, "unit": "d" }));
    assert!(eq(json!("2026-07-01T00:00:00Z"), json!("2026-06-30T20:00:00+08:00"), &s));
    assert!(eq(json!("2026-07-01"), json!("2026-07-01T23:59:59Z"), &s));
    // 无时区 datetime 一律 ERROR（W1b：换机器窗口就漂）
    let e = err(json!("2026-07-01 10:00:00"), json!("2026-07-01T12:00:00Z"), &s);
    assert!(e.contains("requires date values"), "{e}");
    // 非 ISO 也不收
    assert!(err(json!("2026/07/01"), json!("2026-07-01T00:00:00Z"), &s).contains("requires date values"));
    // ±hh 偏移（只有小时）也要正确归一（r10 F2）
    assert!(eq(json!("2026-07-01T08:00:00+08"), json!("2026-07-01T00:00:00Z"), &s));
}

#[test]
fn null_semantics_are_explicit() {
    let s = spec("exact", json!({}));
    assert!(err(json!(null), json!(0), &s).contains("null value compared"));
    assert!(eq(json!(null), json!(null), &s));
    let ignore = spec("exact", json!({ "null": "ignore" }));
    assert!(eq(json!(null), json!(0), &ignore));
    let equal = spec("exact", json!({ "null": "equal" }));
    assert!(eq(json!(null), json!(0), &equal));
}

#[test]
fn subset_superset_range_regex() {
    let sub = spec("subset", json!({}));
    assert!(eq(json!("a,b"), json!("a,b,c"), &sub));
    assert!(!eq(json!("a,b,c"), json!("a,b"), &sub));
    let sup = spec("superset", json!({}));
    assert!(eq(json!("a,b,c"), json!("a,b"), &sup));
    let range = spec("range", json!({ "value": 0, "value_max": 10 }));
    assert!(eq(json!(5), json!(null), &range));
    assert!(!eq(json!(11), json!(null), &range));
    let re = spec("regex", json!({}));
    assert!(eq(json!("INV-2026-1187"), json!("^INV-\\d{4}-\\d+$"), &re));
    assert!(!eq(json!("INV-26"), json!("^INV-\\d{4}-\\d+$"), &re));
    let long = format!("^{}$", "a".repeat(250));
    assert!(err(json!("a"), json!(long), &re).contains("regex pattern too long"));
}

#[test]
fn validate_matches_ts_rules() {
    let one_to_n = spec("exact", json!({ "cardinality": "1:N" }));
    assert!(validate_compare_spec(&one_to_n).iter().any(|e| e.contains("requires agg")));
    let window_no_unit = spec("window", json!({ "value": 7 }));
    assert!(validate_compare_spec(&window_no_unit).iter().any(|e| e.contains("requires unit")));
    let exact_with_eps = spec("exact", json!({ "value": 0.5 }));
    assert!(validate_compare_spec(&exact_with_eps).iter().any(|e| e.contains("takes no tolerance")));
    let ok = spec("tolerance_abs", json!({ "value": 0.01, "currency": "CNY", "scale": 2 }));
    assert!(validate_compare_spec(&ok).is_empty(), "{:?}", validate_compare_spec(&ok));
}
