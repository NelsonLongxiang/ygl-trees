//! Contract 1.3 part 2b, derived tables and spec views (#80): the vectors in
//! packages/verify/core/tests/fixtures/predicate-derived.json come from the TS renderer (the reference). Rust must
//! render the same SQL byte for byte, return the same rows (views created as TEMP VIEWs), refuse the same shapes,
//! and run isolated specs through the CLI with the snapshot's bytes unchanged.

use std::fs;
use std::path::Path;
use std::process::Command;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use yglverify::contract::Predicate;
use yglverify::engine::isolation_refusal;
use yglverify::predicate::{render_predicate, render_views};

mod common;
use common::TempDir;

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/verify/core/tests/fixtures/predicate-derived.json");
    serde_json::from_str(&fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

fn check_case(conn: &rusqlite::Connection, c: &Value) {
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

#[test]
fn derived_and_view_vectors_render_and_match_like_ts() {
    let doc = fixture();
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    for ddl in doc["ddl"].as_array().unwrap() {
        conn.execute_batch(ddl.as_str().unwrap()).unwrap();
    }
    let cases = doc["cases"].as_array().expect("cases");
    assert!(cases.len() >= 6, "expected >=6 derived cases, got {}", cases.len());
    for c in cases {
        check_case(&conn, c);
    }
    let views = render_views(Some(&doc["views"])).expect("views render");
    let want: Vec<(String, String)> = doc["view_sql"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| (v["name"].as_str().unwrap().to_string(), v["sql"].as_str().unwrap().to_string()))
        .collect();
    assert_eq!(views, want, "view SQL parity");
    for (name, sql) in &views {
        conn.execute_batch(&format!("CREATE TEMP VIEW {name} AS {sql}")).unwrap();
    }
    for c in doc["view_cases"].as_array().expect("view_cases") {
        check_case(&conn, c);
    }
}

#[test]
fn derived_and_view_rejects_match_ts() {
    let doc = fixture();
    for r in doc["rejects"].as_array().expect("rejects") {
        let name = r["name"].as_str().unwrap();
        let p: Predicate = serde_json::from_value(json!({ "from": r["from"], "select": ["id"] })).expect("shape");
        let err = render_predicate(&p).expect_err(name);
        let want = r["error"].as_str().unwrap();
        assert!(err.contains(want), "{name}: expected {want:?} in {err:?}");
    }
    for r in doc["view_rejects"].as_array().expect("view_rejects") {
        let name = r["name"].as_str().unwrap();
        let err = render_views(Some(&r["views"])).expect_err(name);
        let want = r["error"].as_str().unwrap();
        assert!(err.contains(want), "{name}: expected {want:?} in {err:?}");
    }
}

#[test]
fn red_team_refusal_matches_ts() {
    assert!(isolation_refusal("SELECT 1 FROM t; ATTACH 'x' AS y").unwrap().contains("ATTACH"));
    assert_eq!(isolation_refusal("SELECT * FROM t WHERE p = 'file:snap.sqlite' -- detach"), None);
    assert_eq!(isolation_refusal("SELECT 'attach' FROM t /* ATTACH */"), None);
    assert!(isolation_refusal("SELECT * FROM file:x").unwrap().contains("FILE:"));
    assert_eq!(isolation_refusal("SELECT reattach_count FROM t"), None);
}

fn spec_with(contract: &str, vu: Value, views: Option<Value>) -> Value {
    let mut s = json!({
        "contract_version": contract, "spec_id": "spec_derived13", "spec_version": 1, "title": "derived", "domain": "test",
        "created": "2026-11-11T00:00:00.000Z", "runtime_min": "1",
        "verifier": { "engine_version": "test", "corpus_version": "1.2" },
        "as_of": { "kind": "snapshot", "value": "2026-11-11T00:00:00.000Z" },
        "vu": [vu], "attachments": [], "sealed": { "review": false }
    });
    if let Some(v) = views {
        s["views"] = v;
    }
    s
}

fn vu_of(predicate: Value) -> Value {
    json!({ "id": "V1", "role": "assert", "severity": "S1", "source_clause": "clause V1",
            "checker": { "type": "sql", "expect": "empty", "fail_when": "rows>0", "predicate": predicate } })
}

#[test]
fn cli_runs_isolated_specs_and_leaves_the_snapshot_unchanged() {
    let doc = fixture();
    let dir = TempDir::new("yglverify-derived", "iso");
    let db = dir.join("snap.sqlite");
    let conn = rusqlite::Connection::open(&db).unwrap();
    for ddl in doc["ddl"].as_array().unwrap() {
        conn.execute_batch(ddl.as_str().unwrap()).unwrap();
    }
    conn.execute_batch("CREATE VIEW stored_view AS SELECT id FROM orders").unwrap();
    drop(conn);
    let sha = || hex::encode(Sha256::digest(fs::read(&db).unwrap()));
    let run = |spec: &Value| {
        let path = dir.join("spec.json");
        fs::write(&path, serde_json::to_string(spec).unwrap()).unwrap();
        Command::new(env!("CARGO_BIN_EXE_yglverify"))
            .args(["run", "--spec", path.to_str().unwrap(), "--db", db.to_str().unwrap(), "--json"])
            .output()
            .expect("spawn")
    };
    let and = |c: Value| json!({ "op": "and", "conditions": [c] });
    let big = json!({ "from": "orders", "select": ["id", "amount", "batch"], "where": and(json!({ "col": "amount", "op": ">", "value": 10 })) });
    let views = json!([{ "name": "big_orders", "predicate": big }]);
    let before = sha();

    let pass = run(&spec_with("1.3", vu_of(json!({ "from": "big_orders", "select": ["id"], "where": and(json!({ "col": "amount", "op": ">", "value": 1000 })) })), Some(views.clone())));
    assert_eq!(pass.status.code(), Some(0), "{}", String::from_utf8_lossy(&pass.stderr));
    let report: Value = serde_json::from_slice(&pass.stdout).expect("report json");
    assert_eq!(report["overall"], "PASS");
    assert_eq!(report["vu"][0]["witness"]["rows_scanned"], 2);

    let fail = run(&spec_with("1.3", vu_of(json!({ "from": { "derived": big }, "select": ["id"], "where": and(json!({ "col": "batch", "op": "=", "value": "b2" })) })), None));
    assert_eq!(fail.status.code(), Some(0), "{}", String::from_utf8_lossy(&fail.stderr));
    assert_eq!(serde_json::from_slice::<Value>(&fail.stdout).unwrap()["overall"], "FAIL");
    assert_eq!(sha(), before, "snapshot bytes unchanged");

    let refused = |spec: Value, want: &str| {
        let out = run(&spec);
        assert_eq!(out.status.code(), Some(1), "{want}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains(want), "{want}: {stderr}");
    };
    refused(spec_with("1.3", vu_of(json!({ "from": "stored_view", "select": ["id"] })), None), "snapshot_view: stored_view");
    refused(spec_with("1.3", vu_of(json!({ "from": "orders", "select": ["id"] })), Some(json!([{ "name": "items", "predicate": big }]))), "view_name: items is already an object in the snapshot");
    refused(spec_with("1.2", vu_of(json!({ "from": "orders", "select": ["id"] })), Some(views)), "version_shape");
    refused(spec_with("1.2", vu_of(json!({ "from": { "derived": big }, "select": ["id"] })), None), "version_shape");
    let raw = json!({ "id": "V1", "role": "assert", "severity": "S1", "source_clause": "c",
                      "checker": { "type": "sql", "expect": "empty", "fail_when": "rows>0", "sql": "SELECT id FROM orders WHERE id < 0 AND detach" } });
    refused(spec_with("1.3", raw, None), "snapshot_reference");
}
