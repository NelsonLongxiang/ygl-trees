//! Contract 1.3 part 2a, pragma sources (#80): the vectors in
//! packages/verify/core/tests/fixtures/predicate-pragma.json come from the TS renderer (the reference). Rust must
//! render the same findSql / scopeSql byte for byte, return the same rows on the fixture schema, refuse the same
//! sources, and count a pragma source's own rows in the witness.

use std::fs;
use std::path::Path;
use std::process::Command;

use serde_json::{json, Value};
use yglverify::contract::Predicate;
use yglverify::predicate::{parse_pragma_source, render_predicate};
use yglverify::sqlite::extract_tables;

mod common;
use common::TempDir;

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/verify/core/tests/fixtures/predicate-pragma.json");
    serde_json::from_str(&fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

fn seeded(doc: &Value) -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    for ddl in doc["ddl"].as_array().unwrap() {
        conn.execute_batch(ddl.as_str().unwrap()).unwrap();
    }
    conn
}

#[test]
fn pragma_vectors_render_and_match_like_ts() {
    let doc = fixture();
    let conn = seeded(&doc);
    let cases = doc["cases"].as_array().expect("cases");
    assert!(cases.len() >= 10, "expected >=10 pragma cases, got {}", cases.len());
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let p: Predicate = serde_json::from_value(c["predicate"].clone()).expect("predicate shape");
        let r = render_predicate(&p).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(r.find_sql, c["findSql"].as_str().unwrap(), "findSql parity: {name}");
        assert_eq!(r.scope_sql, c["scopeSql"].as_str().unwrap(), "scopeSql parity: {name}");
        let rows = conn.prepare(&r.find_sql).unwrap().query_map([], |_| Ok(())).unwrap().count();
        assert_eq!(rows as u64, c["rows"].as_u64().unwrap(), "rows parity: {name}");
        let scanned: i64 = conn.query_row(&r.scope_sql, [], |row| row.get(0)).unwrap();
        assert_eq!(scanned as u64, c["scanned"].as_u64().unwrap(), "scanned parity: {name}");
    }
}

#[test]
fn pragma_rejects_match_ts() {
    let doc = fixture();
    for r in doc["rejects"].as_array().expect("rejects") {
        let name = r["name"].as_str().unwrap();
        let p: Predicate = serde_json::from_value(json!({ "from": r["from"], "select": ["name"] })).expect("shape");
        let err = render_predicate(&p).expect_err(name);
        let want = r["error"].as_str().unwrap();
        assert!(err.contains(want), "{name}: expected {want:?} in {err:?}");
    }
}

#[test]
fn extraction_and_parsing_accept_only_the_closed_form() {
    assert_eq!(extract_tables("SELECT name FROM pragma_table_info('orders') WHERE x"), vec!["pragma_table_info('orders')"]);
    assert_eq!(parse_pragma_source("pragma_user_version").as_deref(), Some("pragma_user_version"));
    assert_eq!(parse_pragma_source("pragma_writable_schema"), None);
    assert_eq!(parse_pragma_source("pragma_table_info('orders'); DROP TABLE orders"), None);
}

fn spec_with(contract: &str, from: Value, where_: Value) -> Value {
    json!({
        "contract_version": contract, "spec_id": "spec_pragma13", "spec_version": 1, "title": "pragma", "domain": "test",
        "created": "2026-11-11T00:00:00.000Z", "runtime_min": "1",
        "verifier": { "engine_version": "test", "corpus_version": "1.2" },
        "as_of": { "kind": "snapshot", "value": "2026-11-11T00:00:00.000Z" },
        "vu": [{ "id": "V1", "role": "assert", "severity": "S1", "source_clause": "orders.amount must be NOT NULL",
                 "checker": { "type": "sql", "expect": "nonempty", "fail_when": "rows==0",
                              "predicate": { "from": from, "select": ["name"], "where": where_ } } }],
        "attachments": [], "sealed": { "review": false }
    })
}

#[test]
fn cli_counts_pragma_rows_and_gates_the_version() {
    let doc = fixture();
    let dir = TempDir::new("yglverify-pragma", "gate");
    let db = dir.join("snap.sqlite");
    let conn = rusqlite::Connection::open(&db).unwrap();
    for ddl in doc["ddl"].as_array().unwrap() {
        conn.execute_batch(ddl.as_str().unwrap()).unwrap();
    }
    drop(conn);
    let run = |spec: &Value| {
        let path = dir.join("spec.json");
        fs::write(&path, serde_json::to_string(spec).unwrap()).unwrap();
        Command::new(env!("CARGO_BIN_EXE_yglverify"))
            .args(["run", "--spec", path.to_str().unwrap(), "--db", db.to_str().unwrap(), "--json"])
            .output()
            .expect("spawn")
    };
    let where_ = json!({ "op": "and", "conditions": [{ "col": "name", "op": "=", "value": "amount" }, { "col": "notnull", "op": "=", "value": 1 }] });
    let ok = run(&spec_with("1.3", json!({ "pragma": "table_info", "arg": "orders" }), where_.clone()));
    assert_eq!(ok.status.code(), Some(0), "{}", String::from_utf8_lossy(&ok.stderr));
    let report: Value = serde_json::from_slice(&ok.stdout).expect("report json");
    assert_eq!(report["overall"], "PASS");
    assert_eq!(report["vu"][0]["witness"]["rows_scanned"], 3);
    assert_eq!(report["vu"][0]["witness"]["sources"], json!([{ "table": "pragma_table_info('orders')", "rows": 3 }]));

    let refused = run(&spec_with("1.2", json!({ "pragma": "table_info", "arg": "orders" }), where_));
    assert_eq!(refused.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&refused.stderr);
    assert!(stderr.contains("version_shape"), "{stderr}");
}
