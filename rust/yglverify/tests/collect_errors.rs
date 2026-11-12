//! Contract 1.3 part 3, no silent empty pass (#80 item 7): a snapshot with rows in a collector error table
//! (`archive_errors`) never yields PASS for a 1.3 spec — every assert unit that would PASS becomes ERROR with
//! `input_errors` and the same reason text as engine.ts; FAIL stays FAIL; 1.2 specs are untouched.

use std::fs;
use std::process::Command;

use serde_json::{json, Value};

mod common;
use common::TempDir;

fn snapshot(dir: &TempDir, name: &str, errors: usize) -> String {
    let db = dir.join(name);
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE archive_entries(seq INTEGER PRIMARY KEY, path TEXT); INSERT INTO archive_entries(path) VALUES ('package/a'), ('package/b');
         CREATE TABLE archive_errors(seq INTEGER PRIMARY KEY, kind TEXT);",
    )
    .unwrap();
    for _ in 0..errors {
        conn.execute_batch("INSERT INTO archive_errors(kind) VALUES ('truncated')").unwrap();
    }
    db.to_string_lossy().into_owned()
}

fn spec(contract: &str, v1_where: Value) -> Value {
    json!({
        "contract_version": contract, "spec_id": "spec_collect13", "spec_version": 1, "title": "collect", "domain": "test",
        "created": "2026-11-11T00:00:00.000Z", "runtime_min": "1",
        "verifier": { "engine_version": "test", "corpus_version": "1.2" },
        "as_of": { "kind": "snapshot", "value": "2026-11-11T00:00:00.000Z" },
        "attachments": [], "sealed": { "review": false },
        "vu": [
            { "id": "V1", "role": "assert", "severity": "S1", "source_clause": "paths stay in package/",
              "checker": { "type": "sql", "expect": "empty", "fail_when": "rows>0",
                           "predicate": { "from": "archive_entries", "select": ["path"], "where": v1_where } } },
            { "id": "V2", "role": "assert", "severity": "S1", "source_clause": "no b",
              "checker": { "type": "sql", "expect": "empty", "fail_when": "rows>0",
                           "predicate": { "from": "archive_entries", "select": ["path"],
                                          "where": { "op": "and", "conditions": [{ "col": "path", "op": "=", "value": "package/b" }] } } } }
        ]
    })
}

fn run(dir: &TempDir, spec: &Value, db: &str) -> Value {
    let path = dir.join("spec.json");
    fs::write(&path, serde_json::to_string(spec).unwrap()).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_yglverify"))
        .args(["run", "--spec", path.to_str().unwrap(), "--db", db, "--json"])
        .output()
        .expect("spawn");
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).expect("report json")
}

fn verdicts(report: &Value) -> Vec<String> {
    report["vu"].as_array().unwrap().iter().map(|v| v["verdict"].as_str().unwrap().to_string()).collect()
}

#[test]
fn collector_error_rows_turn_pass_into_error_for_1_3_only() {
    let dir = TempDir::new("yglverify-collect", "rule");
    let not_glob = json!({ "op": "and", "conditions": [{ "col": "path", "op": "not-glob", "value": "package/*" }] });

    let clean = run(&dir, &spec("1.3", not_glob.clone()), &snapshot(&dir, "clean.sqlite", 0));
    assert_eq!(verdicts(&clean), vec!["PASS", "FAIL"]);

    let errs = run(&dir, &spec("1.3", not_glob), &snapshot(&dir, "errors.sqlite", 2));
    assert_eq!(verdicts(&errs), vec!["ERROR", "FAIL"]);
    assert_eq!(errs["vu"][0]["evidence"]["input_errors"], json!([{ "table": "archive_errors", "rows": 2 }]));
    let reason = errs["vu"][0]["evidence"]["reason"].as_str().unwrap();
    assert_eq!(reason, "input_errors: 2 row(s) in archive_errors — the collected input is incomplete, so this unit cannot PASS");
    assert_eq!(errs["overall"], "FAIL");
    // #270: summary is folded after the downgrade (same as engine.ts after the fix)
    assert_eq!(errs["summary"]["pass"], 0);
    assert_eq!(errs["summary"]["fail"], 1);
    assert_eq!(errs["summary"]["error"], 1);

    // #270: schema drift downgrades before summary and overall
    let mut drift = spec("1.3", json!({ "op": "and", "conditions": [{ "col": "path", "op": "=", "value": "elsewhere/x" }] }));
    drift["vu"] = json!([drift["vu"][0].clone()]);
    drift["schema_fingerprint"] = json!("sha256:not-the-snapshot");
    let d = run(&dir, &drift, &snapshot(&dir, "drift.sqlite", 0));
    assert_eq!(verdicts(&d), vec!["ERROR"]);
    assert_eq!(d["summary"]["pass"], 0);
    assert_eq!(d["summary"]["error"], 1);
    assert_eq!(d["overall"], "ERROR");

    let eq = json!({ "op": "and", "conditions": [{ "col": "path", "op": "=", "value": "elsewhere/x" }] });
    let twelve = run(&dir, &spec("1.2", eq), &snapshot(&dir, "errors12.sqlite", 1));
    assert_eq!(verdicts(&twelve)[0], "PASS");
}
