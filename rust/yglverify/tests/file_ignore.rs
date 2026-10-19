//! ④ walk ignore globs（Rust 侧）：排除面只减扫描域，require/sha256 仍按字面校验。
//! 与 TS `packages/verify/core/tests/file-ignore.spec.ts` 同语义；语料不含 ignore（冻结只增不改），
//! 所以这条契约用定向测试钉住两实现。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use yglverify::contract::parse_spec;
use yglverify::engine::{run_verify, VerifyOptions};
use yglverify::sqlite::SqliteRunner;

fn scratch(tag: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("yglverify-fileignore-{tag}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn empty_db(dir: &Path) -> PathBuf {
    let path = dir.join("empty.sqlite");
    drop(rusqlite::Connection::open(&path).unwrap());
    path
}

fn spec_with(ignore: &[&str]) -> String {
    let ignore_json: Vec<String> = ignore.iter().map(|s| format!("\"{s}\"")).collect();
    format!(
        r#"{{
  "contract_version": "1.1",
  "spec_id": "spec_file_ignore",
  "spec_version": 1,
  "verifier": {{ "engine_version": "0.1.0", "corpus_version": "1" }},
  "as_of": {{ "kind": "snapshot", "value": "2026-07-31T00:00:00.000Z" }},
  "attachments": [],
  "sealed": {{ "review": false }},
  "vu": [{{
    "id": "V1",
    "role": "assert",
    "title": "attachments",
    "severity": "S1",
    "source_clause": "clause",
    "expected_from": {{ "quote": "q", "locator": "l" }},
    "checker": {{ "type": "file", "glob": "*.pdf", "require": ["notes.tmp"], "ignore": [{}] }}
  }}]
}}"#,
        ignore_json.join(", ")
    )
}

#[test]
fn ignored_files_leave_the_scan_surface_but_still_satisfy_require() {
    let dir = scratch("pass");
    let attachments = dir.join("attachments");
    fs::create_dir_all(&attachments).unwrap();
    fs::write(attachments.join("invoice.pdf"), b"pdf").unwrap();
    fs::write(attachments.join("receipt.pdf"), b"pdf").unwrap();
    fs::write(attachments.join("notes.tmp"), b"tmp").unwrap();
    let db = empty_db(&dir);
    let runner = SqliteRunner::open_read_only(&db.to_string_lossy()).unwrap();
    let spec = parse_spec(&spec_with(&["*.tmp"])).unwrap();
    let opts = VerifyOptions {
        runner: &runner,
        submission_dir: Some(&attachments.to_string_lossy()),
        command_allowlist: None,
        now_iso: Some("2026-10-19T00:00:00.000Z".to_string()),
        run_id: Some("run_ignore".to_string()),
        engine_version: Some("0.1.0".to_string()),
        mode: Some("open".to_string()),
        binary_sha256: None,
        signature: None,
        signing_scheme: None,
        public_key_fingerprint: None,
        data_source: None,
    };
    let report = run_verify(&spec, &opts).unwrap();
    let v = &report.vu[0];
    assert_eq!(v.verdict.as_str(), "PASS");
    let w = v.witness.as_ref().unwrap();
    assert_eq!((w.rows_scanned, w.rows_matched), (2, 2));
    assert_eq!(report.overall.as_str(), "PASS");
}

#[test]
fn everything_ignored_is_needs_material_not_pass() {
    let dir = scratch("all");
    let attachments = dir.join("attachments");
    fs::create_dir_all(&attachments).unwrap();
    fs::write(attachments.join("notes.tmp"), b"tmp").unwrap();
    let db = empty_db(&dir);
    let runner = SqliteRunner::open_read_only(&db.to_string_lossy()).unwrap();
    let spec = parse_spec(&spec_with(&["*.tmp"])).unwrap();
    let opts = VerifyOptions {
        runner: &runner,
        submission_dir: Some(&attachments.to_string_lossy()),
        command_allowlist: None,
        now_iso: Some("2026-10-19T00:00:00.000Z".to_string()),
        run_id: Some("run_ignore_all".to_string()),
        engine_version: Some("0.1.0".to_string()),
        mode: Some("open".to_string()),
        binary_sha256: None,
        signature: None,
        signing_scheme: None,
        public_key_fingerprint: None,
        data_source: None,
    };
    let report = run_verify(&spec, &opts).unwrap();
    assert_eq!(report.vu[0].verdict.as_str(), "NEEDS-MATERIAL");
    let w = report.vu[0].witness.as_ref().unwrap();
    assert_eq!((w.rows_scanned, w.rows_matched), (0, 0));
}
