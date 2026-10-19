//! 二进制 CLI 契约（M13-1b）：rc 只表达过程，判定在报告里。
//!
//! - `run` 跑完（哪怕 FAIL）→ rc=0 且 --json 输出单对象
//! - 快照缺失 / spec 形状不对 / 版本不认 → rc=1
//! - 用法错（缺 flag、未知 flag）→ rc=2

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_yglverify")
}

fn cases_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/verify/core/corpus/cases")
}

fn temp_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("yglverify-cli-{tag}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// 用 rusqlite 建库（与 corpus_parity 同口径；测试自足，不依赖外部 sqlite3）。
fn seed_db(case: &str, out: &Path) {
    let sql = fs::read_to_string(cases_dir().join(case).join("db.sql")).expect("db.sql");
    let conn = rusqlite::Connection::open(out).expect("open db");
    conn.execute_batch(&sql).expect("seed");
}

#[test]
fn run_reports_fail_with_exit_zero() {
    let dir = temp_dir("fail");
    let db = dir.join("case.sqlite");
    seed_db("sql-find-violation", &db);
    let spec = cases_dir().join("sql-find-violation").join("spec.json");
    let out = dir.join("report.json");
    let output = Command::new(bin())
        .args([
            "run",
            "--spec",
            spec.to_str().unwrap(),
            "--db",
            db.to_str().unwrap(),
            "--json",
            "--out",
            out.to_str().unwrap(),
            "--run-id",
            "run_cli_fail",
            "--now",
            "2026-10-19T00:00:00.000Z",
        ])
        .output()
        .expect("spawn");
    assert_eq!(output.status.code(), Some(0), "rc must be 0 even when the verdict is FAIL");
    let report: Value = serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).expect("single JSON object");
    assert_eq!(report["overall"], "FAIL");
    assert_eq!(report["summary"]["fail"], 1);
    assert_eq!(report["vu"][0]["witness"]["rows_scanned"], 3);
    assert_eq!(report["vu"][0]["witness"]["rows_matched"], 1);
    let written: Value = serde_json::from_str(&fs::read_to_string(&out).expect("report file")).expect("json");
    assert_eq!(written["overall"], "FAIL");
}

#[test]
fn usage_errors_exit_two() {
    for args in [vec!["run", "--db", "x.sqlite"], vec!["run", "--spec", "s.json"], vec!["run", "--bogus", "1"]] {
        let output = Command::new(bin()).args(&args).output().expect("spawn");
        assert_eq!(output.status.code(), Some(2), "args {args:?} should be a usage error");
    }
}

#[test]
fn missing_snapshot_is_a_runtime_error() {
    let output = Command::new(bin())
        .args(["run", "--spec", "whatever.json", "--db", "no-such-snapshot.sqlite"])
        .output()
        .expect("spawn");
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn unsupported_contract_version_is_refused() {
    let dir = temp_dir("version");
    let db = dir.join("case.sqlite");
    seed_db("sql-find-violation", &db);
    let mut spec: Value =
        serde_json::from_str(&fs::read_to_string(cases_dir().join("sql-find-violation").join("spec.json")).unwrap())
            .unwrap();
    spec["contract_version"] = Value::String("0.9".into());
    let spec_path = dir.join("spec.json");
    fs::write(&spec_path, serde_json::to_string(&spec).unwrap()).unwrap();
    let output = Command::new(bin())
        .args(["run", "--spec", spec_path.to_str().unwrap(), "--db", db.to_str().unwrap()])
        .output()
        .expect("spawn");
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("unsupported contract_version"), "{stderr}");
}

#[test]
fn self_check_validates_embedded_vectors() {
    let output = Command::new(bin()).args(["self-check"]).output().expect("spawn");
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("canonical-vectors: ok (12)"), "{stdout}");
}

fn sealed_binary(dir: &Path, case: &str) -> PathBuf {
    let out = dir.join("concrete");
    let spec = cases_dir().join(case).join("spec.json");
    let status = Command::new(bin())
        .args(["seal", "--spec", spec.to_str().unwrap(), "--out", out.to_str().unwrap()])
        .status()
        .expect("spawn seal");
    assert!(status.success(), "seal failed");
    out
}

#[test]
fn sealed_binary_embeds_spec_and_reports_identity() {
    let dir = temp_dir("sealed");
    let db = dir.join("case.sqlite");
    seed_db("sql-find-violation", &db);
    let sealed = sealed_binary(&dir, "sql-find-violation");

    // 无 --spec：读内嵌规范，报告记 sealed 与 binary_sha256
    let output = Command::new(&sealed)
        .args([
            "run",
            "--db",
            db.to_str().unwrap(),
            "--json",
            "--run-id",
            "run_sealed",
            "--now",
            "2026-10-19T00:00:00.000Z",
        ])
        .output()
        .expect("spawn sealed");
    assert_eq!(output.status.code(), Some(0));
    let report: Value = serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).expect("json");
    assert_eq!(report["overall"], "FAIL");
    assert_eq!(report["verifier"]["mode"], "sealed");
    let identity = report["verifier"]["binary_sha256"].as_str().expect("binary_sha256");
    assert!(identity.starts_with("sha256:"), "{identity}");

    // 封包拒绝 --spec：改规范必须重打二进制
    let spec = cases_dir().join("sql-find-violation").join("spec.json");
    let refused = Command::new(&sealed)
        .args(["run", "--spec", spec.to_str().unwrap(), "--db", db.to_str().unwrap()])
        .output()
        .expect("spawn");
    assert_eq!(refused.status.code(), Some(2));

    // 篡改内嵌规范 → 运行期 rc=1 且点名 spec_sha256
    let mut bytes = fs::read(&sealed).expect("read sealed");
    let idx = bytes.len() / 2;
    bytes[idx] ^= 0xff;
    let tampered = dir.join("tampered");
    fs::write(&tampered, &bytes).expect("write tampered");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tampered, fs::Permissions::from_mode(0o755));
    }
    let bad = Command::new(&tampered)
        .args(["run", "--db", db.to_str().unwrap()])
        .output()
        .expect("spawn tampered");
    assert_eq!(bad.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&bad.stderr);
    assert!(stderr.contains("spec_sha256") || stderr.contains("build_sha256"), "{stderr}");
}

#[test]
fn sealing_a_sealed_binary_is_refused() {
    let dir = temp_dir("reseal");
    let sealed = sealed_binary(&dir, "sql-find-violation");
    let spec = cases_dir().join("sql-find-violation").join("spec.json");
    let out = dir.join("again");
    let output = Command::new(&sealed)
        .args(["seal", "--spec", spec.to_str().unwrap(), "--out", out.to_str().unwrap()])
        .output()
        .expect("spawn");
    assert_eq!(output.status.code(), Some(2));
}
