//! 语料 parity：33 例冻结语料（`packages/verify/core/corpus/cases`）逐例跑 Rust 引擎，
//! 与 `expected-report.json` 的投影比对（overall / summary / 每 VU verdict 与 witness 子集）。
//!
//! 这是 M13-1b 的验收门：TS 引擎与 Rust 二进制必须对同一语料给出同一份判定。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use yglverify::contract::parse_spec;
use yglverify::engine::{run_verify, summary_of, topo_order, VerifyOptions};
use yglverify::sqlite::SqliteRunner;

fn cases_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/verify/core/corpus/cases")
}

fn temp_db_path(tag: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    std::env::temp_dir().join(format!("yglverify-{tag}-{}-{nanos}.sqlite", std::process::id()))
}

fn materialize(db_sql: &Path) -> Result<PathBuf, String> {
    let path = temp_db_path("case");
    let script = fs::read_to_string(db_sql).map_err(|e| format!("read db.sql: {e}"))?;
    let conn = rusqlite::Connection::open(&path).map_err(|e| format!("open temp db: {e}"))?;
    conn.execute_batch(&script).map_err(|e| format!("seed db: {e}"))?;
    drop(conn);
    Ok(path)
}

fn run_case(dir: &Path) -> Result<Value, String> {
    let spec_text = fs::read_to_string(dir.join("spec.json")).map_err(|e| format!("read spec: {e}"))?;
    let spec = parse_spec(&spec_text)?;
    let db_path = materialize(&dir.join("db.sql"))?;
    let runner = SqliteRunner::open_read_only(&db_path.to_string_lossy())?;
    let attachments = dir.join("attachments");
    let submission = if attachments.is_dir() { attachments } else { dir.to_path_buf() };
    let opts = VerifyOptions {
        runner: &runner,
        submission_dir: Some(&submission.to_string_lossy()),
        command_allowlist: Some(vec!["node".to_string()]),
        now_iso: Some("2026-10-19T00:00:00.000Z".to_string()),
        run_id: Some(format!("run_{}", dir.file_name().unwrap().to_string_lossy())),
        engine_version: Some("0.1.0".to_string()),
    };
    let report = run_verify(&spec, &opts);
    let _ = fs::remove_file(&db_path);
    let report = report?;
    let summary = summary_of(&report.vu);
    Ok(serde_json::json!({
        "overall": report.overall.as_str(),
        "summary": {
            "pass": summary.pass,
            "fail": summary.fail,
            "needs_material": summary.needs_material,
            "error": summary.error,
        },
        "vu": report.vu.iter().map(|v| {
            let mut obj = serde_json::json!({
                "id": v.id,
                "verdict": v.verdict.as_str(),
            });
            if let Some(w) = &v.witness {
                obj["witness"] = serde_json::json!({
                    "rows_scanned": w.rows_scanned,
                    "rows_matched": w.rows_matched,
                });
            }
            obj
        }).collect::<Vec<_>>(),
    }))
}

fn diff(expected: &Value, got: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if expected["overall"] != got["overall"] {
        out.push(format!("overall: expected {}, got {}", expected["overall"], got["overall"]));
    }
    for key in ["pass", "fail", "needs_material", "error"] {
        if expected["summary"][key] != got["summary"][key] {
            out.push(format!(
                "summary.{key}: expected {}, got {}",
                expected["summary"][key], got["summary"][key]
            ));
        }
    }
    for ev in expected["vu"].as_array().cloned().unwrap_or_default() {
        let id = ev["id"].as_str().unwrap_or_default();
        let got_vu = got["vu"].as_array().cloned().unwrap_or_default();
        let Some(gv) = got_vu.iter().find(|v| v["id"].as_str() == Some(id)) else {
            out.push(format!("vu {id}: missing from report"));
            continue;
        };
        if ev["verdict"] != gv["verdict"] {
            out.push(format!("vu {id}: expected {}, got {}", ev["verdict"], gv["verdict"]));
        }
        if let Some(w) = ev.get("witness") {
            for (k, want) in w.as_object().cloned().unwrap_or_default() {
                let have = &gv["witness"][&k];
                if &want != have {
                    out.push(format!("vu {id}.witness.{k}: expected {want}, got {have}"));
                }
            }
        }
    }
    out
}

#[test]
fn corpus_reports_match_expected_projection() {
    let root = cases_dir();
    let mut entries: Vec<PathBuf> = fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("{}: {e}", root.display()))
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    entries.sort();
    assert!(entries.len() >= 30, "expected >=30 corpus cases, got {}", entries.len());

    let mut failures: Vec<String> = Vec::new();
    let mut ran = 0usize;
    let mut threw = 0usize;
    for dir in &entries {
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        let case_meta: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("case.json")).expect("case.json")).expect("case meta");
        if let Some(pattern) = case_meta["expect_throw"].as_str() {
            match run_case(dir) {
                Ok(report) => failures.push(format!(
                    "{name}: expected throw /{pattern}/, but run completed with {}",
                    report["overall"]
                )),
                Err(msg) => {
                    let re = regex::Regex::new(&format!("(?i){pattern}")).expect("pattern");
                    if !re.is_match(&msg) {
                        failures.push(format!("{name}: throw message did not match /{pattern}/: {msg}"));
                    }
                    threw += 1;
                }
            }
            continue;
        }
        let expected_path = dir.join("expected-report.json");
        if !expected_path.exists() {
            continue;
        }
        let expected: Value = serde_json::from_str(&fs::read_to_string(&expected_path).expect("expected")).expect("json");
        match run_case(dir) {
            Ok(got) => {
                ran += 1;
                for d in diff(&expected, &got) {
                    failures.push(format!("{name}: {d}"));
                }
            }
            Err(msg) => failures.push(format!("{name}: run failed: {msg}")),
        }
    }
    assert!(ran >= 20, "expected >=20 executed cases, got {ran}");
    if !failures.is_empty() {
        panic!("corpus parity mismatch:\n{}", failures.join("\n"));
    }
    println!("corpus parity ok: {ran} cases + {threw} throw cases");
}

#[test]
fn topo_order_rejects_cycles() {
    let spec: Value = serde_json::json!({
        "contract_version": "1.0",
        "spec_id": "spec_cycle",
        "spec_version": 1,
        "verifier": { "engine_version": "0.1.0", "corpus_version": "1.0" },
        "as_of": { "kind": "snapshot", "value": "2026-10-19T00:00:00.000Z" },
        "attachments": [],
        "sealed": { "review": false },
        "vu": [
            { "id": "V1", "role": "assert", "title": "a", "severity": "S2", "source_clause": "a",
              "expected_from": {}, "checker": { "type": "count", "from": "$vu:V2", "op": ">=", "value": 1 } },
            { "id": "V2", "role": "assert", "title": "b", "severity": "S2", "source_clause": "b",
              "expected_from": {}, "checker": { "type": "count", "from": "$vu:V1", "op": ">=", "value": 1 } }
        ]
    });
    let parsed = parse_spec(&spec.to_string()).expect("spec");
    let err = topo_order(&parsed.vu).unwrap_err();
    assert!(err.contains("cycle"), "{err}");
}
