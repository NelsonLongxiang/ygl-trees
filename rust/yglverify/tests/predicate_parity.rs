//! 谓词渲染 parity：TS `renderPredicate` 的输出是唯一真值（corpus/predicate/vectors.json），
//! Rust 必须逐字节相同——报告里的 rendered.findSql 依赖它。

use std::fs;
use std::path::Path;

use serde_json::Value;
use yglverify::contract::Predicate;
use yglverify::predicate::{agg_alias_of, render_predicate};

#[test]
fn rendered_sql_matches_ts_vectors() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/verify/core/corpus/predicate/vectors.json");
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let doc: Value = serde_json::from_str(&text).unwrap();
    let vectors = doc["vectors"].as_array().expect("vectors array");
    assert!(vectors.len() >= 6, "expected >=6 predicate vectors, got {}", vectors.len());
    for v in vectors {
        let pred: Predicate = serde_json::from_value(v["predicate"].clone()).expect("predicate shape");
        let rendered = render_predicate(&pred).expect("render");
        assert_eq!(rendered.find_sql, v["findSql"].as_str().unwrap(), "findSql parity");
        assert_eq!(rendered.scope_sql, v["scopeSql"].as_str().unwrap(), "scopeSql parity");
        if let Some(aliases) = v["aggAliases"].as_array() {
            for (i, want) in aliases.iter().enumerate() {
                let got = agg_alias_of(&pred, i).expect("agg alias");
                assert_eq!(got, want.as_str().unwrap(), "agg alias parity");
            }
        }
    }
}

#[test]
fn find_and_scope_share_the_scan_clause() {
    let pred: Predicate = serde_json::from_value(serde_json::json!({
        "from": "bills",
        "select": ["id"],
        "where": { "op": "and", "conditions": [{ "col": "amount", "op": ">", "value": 0 }] },
        "scan": { "op": "and", "conditions": [{ "col": "batch", "op": "=", "value": "2026-07" }] }
    }))
    .unwrap();
    let rendered = render_predicate(&pred).unwrap();
    assert!(rendered.find_sql.contains("batch = '2026-07'"));
    assert!(rendered.scope_sql.contains("batch = '2026-07'"), "scope 必须只含 scan 域");
    assert!(!rendered.scope_sql.contains("amount > 0"), "判据不能进 scope");
}

#[test]
fn injection_and_identifier_guards() {
    let bad: Predicate = serde_json::from_value(serde_json::json!({
        "from": "bills; drop table bills",
        "select": ["id"]
    }))
    .unwrap();
    assert!(render_predicate(&bad).unwrap_err().contains("bare identifier"));

    let inj: Predicate = serde_json::from_value(serde_json::json!({
        "from": "t",
        "select": ["id"],
        "where": { "op": "and", "conditions": [{ "col": "x", "op": "=", "value": "a'; drop table t; --" }] }
    }))
    .unwrap();
    let sql = render_predicate(&inj).unwrap().find_sql;
    assert!(sql.contains("'a''; drop table t; --'"), "quotes must be doubled: {sql}");
}
