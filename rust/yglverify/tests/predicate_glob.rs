//! Contract 1.3 glob / not-glob parity (#80, #232): the vectors in
//! packages/verify/core/tests/fixtures/predicate-glob.json come from the TS renderer (the reference). Rust must render
//! the same findSql byte for byte, match the same rows on SQLite, and refuse the same conditions. The CLI gate keeps
//! glob out of 1.1/1.2 specs.

use std::fs;
use std::path::Path;
use std::process::Command;

use serde_json::{json, Value};
use yglverify::contract::Predicate;
use yglverify::predicate::render_predicate;

mod common;
use common::TempDir;

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/verify/core/tests/fixtures/predicate-glob.json");
    serde_json::from_str(&fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

fn pred(cond: &Value) -> Predicate {
    serde_json::from_value(json!({ "from": "entries", "select": ["path"], "where": { "op": "and", "conditions": [cond] } }))
        .expect("predicate shape")
}

#[test]
fn glob_vectors_render_and_match_like_ts() {
    let doc = fixture();
    let cases = doc["cases"].as_array().expect("cases");
    assert!(cases.len() >= 20, "expected >=20 glob cases, got {}", cases.len());
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let p = pred(&json!({ "col": "path", "op": c["op"], "value": c["pattern"] }));
        let rendered = render_predicate(&p).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(rendered.find_sql, c["findSql"].as_str().unwrap(), "findSql parity: {name}");

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(doc["table"].as_str().unwrap()).unwrap();
        match c["value"].as_str() {
            Some(v) => conn.execute("INSERT INTO entries(path) VALUES (?1)", [v]).unwrap(),
            None => conn.execute("INSERT INTO entries(path) VALUES (NULL)", []).unwrap(),
        };
        let mut stmt = conn.prepare(&rendered.find_sql).unwrap();
        let rows = stmt.query_map([], |_| Ok(())).unwrap().count();
        assert_eq!(rows == 1, c["match"].as_bool().unwrap(), "match parity: {name}");
    }
}

#[test]
fn glob_rejects_match_ts() {
    let doc = fixture();
    for r in doc["rejects"].as_array().expect("rejects") {
        let name = r["name"].as_str().unwrap();
        let err = render_predicate(&pred(&r["condition"])).expect_err(name);
        let want = r["error"].as_str().unwrap();
        assert!(err.contains(want), "{name}: expected {want:?} in {err:?}");
    }
}

fn spec_with(contract: &str, op: &str, pattern: &str) -> Value {
    json!({
        "contract_version": contract, "spec_id": "spec_glob13", "spec_version": 1, "title": "glob", "domain": "test",
        "created": "2026-11-11T00:00:00.000Z", "runtime_min": "1",
        "verifier": { "engine_version": "test", "corpus_version": "1.2" },
        "as_of": { "kind": "snapshot", "value": "2026-11-11T00:00:00.000Z" },
        "vu": [{ "id": "V1", "role": "assert", "severity": "S1", "source_clause": "every entry lives under package/",
                 "checker": { "type": "sql", "fail_when": "rows>0",
                              "predicate": { "from": "entries", "select": ["path"],
                                             "where": { "op": "and", "conditions": [{ "col": "path", "op": op, "value": pattern }] } } } }],
        "attachments": [], "sealed": { "review": false }
    })
}

#[test]
fn cli_runs_glob_only_under_contract_13() {
    let dir = TempDir::new("yglverify-glob", "gate");
    let db = dir.join("snap.sqlite");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TABLE entries(path TEXT); INSERT INTO entries(path) VALUES ('package/a.js'), ('package/lib/b.js');")
        .unwrap();
    drop(conn);
    let run = |spec: &Value| {
        let path = dir.join("spec.json");
        fs::write(&path, serde_json::to_string(spec).unwrap()).unwrap();
        Command::new(env!("CARGO_BIN_EXE_yglverify"))
            .args(["run", "--spec", path.to_str().unwrap(), "--db", db.to_str().unwrap(), "--json"])
            .output()
            .expect("spawn")
    };

    let ok = run(&spec_with("1.3", "not-glob", "package/*"));
    assert_eq!(ok.status.code(), Some(0), "{}", String::from_utf8_lossy(&ok.stderr));
    let report: Value = serde_json::from_slice(&ok.stdout).expect("report json");
    assert_eq!(report["overall"], "PASS");
    assert_eq!(report["contract_version"], "1.3");

    for v in ["1.2", "1.1"] {
        let refused = run(&spec_with(v, "glob", "package/*"));
        assert_eq!(refused.status.code(), Some(1), "contract {v}");
        let stderr = String::from_utf8_lossy(&refused.stderr);
        assert!(stderr.contains(&format!("version_shape: this spec declares contract_version {v} but uses 1.3-only shapes")), "{stderr}");
    }
}
