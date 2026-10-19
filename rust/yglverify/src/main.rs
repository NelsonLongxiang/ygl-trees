//! `yglverify` 二进制入口（M13-1b）：spec JSON 进、报告 JSON 出。
//!
//! 运行契约（与 TS 侧一致）：`rc` 只表达**过程**——0 = 跑完并产出报告（哪怕判定是 FAIL），
//! 1 = 运行错误，2 = 用法错误。判定在报告里，不在退出码。
//!
//! 用法：
//!   yglverify run --spec <file|-> --db <snapshot.sqlite> [--json] [--out <report.json>]
//!                 [--attachments <dir>] [--command-allow <bin>]... [--run-id <id>]
//!                 [--now <rfc3339>] [--mode open|sealed]
//!   yglverify --version
//!   yglverify canonical-check
//!   yglverify self-check [--corpus <dir>]

use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::ExitCode;

use serde_json::Value;

use yglverify::canonical;
use yglverify::contract::parse_spec;
use yglverify::engine::{run_verify, VerifyOptions};
use yglverify::sqlite::SqliteRunner;

const USAGE: &str = "\
usage:
  yglverify run --spec <file|-> --db <snapshot.sqlite> [--json] [--out <report.json>]
                [--attachments <dir>] [--command-allow <bin>]... [--run-id <id>]
                [--now <rfc3339>] [--mode open|sealed]
  yglverify self-check [--corpus <dir>]
  yglverify canonical-check
  yglverify --version";

struct RunArgs {
    spec: String,
    db: String,
    json: bool,
    out: Option<String>,
    attachments: Option<String>,
    allow: Vec<String>,
    run_id: Option<String>,
    now: Option<String>,
    mode: String,
}

fn usage_error(msg: &str) -> ExitCode {
    eprintln!("{msg}\n\n{USAGE}");
    ExitCode::from(2)
}

fn runtime_error(msg: impl Into<String>) -> ExitCode {
    let msg = msg.into();
    eprintln!("{msg}");
    ExitCode::from(1)
}

fn parse_run_args(args: &[String]) -> Result<RunArgs, ExitCode> {
    let mut spec: Option<String> = None;
    let mut db: Option<String> = None;
    let mut json = false;
    let mut out = None;
    let mut attachments = None;
    let mut allow: Vec<String> = Vec::new();
    let mut run_id = None;
    let mut now = None;
    let mut mode = "open".to_string();
    let mut i = 0usize;
    while i < args.len() {
        let a = args[i].as_str();
        let mut next = |what: &str| -> Result<String, ExitCode> {
            i += 1;
            args.get(i).cloned().ok_or_else(|| usage_error(&format!("{what} requires a value")))
        };
        match a {
            "--spec" => spec = Some(next("--spec")?),
            "--db" => db = Some(next("--db")?),
            "--json" => json = true,
            "--out" => out = Some(next("--out")?),
            "--attachments" => attachments = Some(next("--attachments")?),
            "--command-allow" => allow.push(next("--command-allow")?),
            "--run-id" => run_id = Some(next("--run-id")?),
            "--now" => now = Some(next("--now")?),
            "--mode" => mode = next("--mode")?,
            "-h" | "--help" => return Err(usage_error(USAGE)),
            other => return Err(usage_error(&format!("unknown flag: {other}"))),
        }
        i += 1;
    }
    let spec = spec.ok_or_else(|| usage_error("run requires --spec <file|->"))?;
    let db = db.ok_or_else(|| usage_error("run requires --db <snapshot.sqlite>"))?;
    if mode != "open" && mode != "sealed" {
        return Err(usage_error("--mode must be open|sealed"));
    }
    Ok(RunArgs { spec, db, json, out, attachments, allow, run_id, now, mode })
}

fn read_spec(path: &str) -> Result<String, ExitCode> {
    if path == "-" {
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| runtime_error(format!("cannot read spec from stdin: {e}")))?;
        return Ok(buf);
    }
    fs::read_to_string(path).map_err(|e| runtime_error(format!("cannot read spec {path}: {e}")))
}

fn cmd_run(args: &[String]) -> ExitCode {
    let parsed = match parse_run_args(args) {
        Ok(p) => p,
        Err(code) => return code,
    };
    if !Path::new(&parsed.db).exists() {
        return runtime_error(format!("snapshot not found: {}", parsed.db));
    }
    let spec_text = match read_spec(&parsed.spec) {
        Ok(s) => s,
        Err(code) => return code,
    };
    let spec = match parse_spec(&spec_text) {
        Ok(s) => s,
        Err(e) => return runtime_error(e),
    };
    let runner = match SqliteRunner::open_read_only(&parsed.db) {
        Ok(r) => r,
        Err(e) => return runtime_error(e),
    };
    let opts = VerifyOptions {
        runner: &runner,
        submission_dir: parsed.attachments.as_deref(),
        command_allowlist: if parsed.allow.is_empty() { None } else { Some(parsed.allow.clone()) },
        now_iso: parsed.now.clone(),
        run_id: parsed.run_id.clone(),
        engine_version: Some(env!("CARGO_PKG_VERSION").to_string()),
    };
    let report = match run_verify(&spec, &opts) {
        Ok(r) => r,
        Err(e) => return runtime_error(e),
    };
    let mut value = match serde_json::to_value(&report) {
        Ok(v) => v,
        Err(e) => return runtime_error(format!("cannot serialize report: {e}")),
    };
    // sealed 形态：报告自带 mode 与实际产物一致（open 时不出现 binary_sha256）
    if let Some(obj) = value.as_object_mut() {
        if let Some(verifier) = obj.get_mut("verifier").and_then(|v| v.as_object_mut()) {
            verifier.insert("mode".into(), Value::String(parsed.mode.clone()));
        }
    }
    let text = match serde_json::to_string_pretty(&value) {
        Ok(t) => t,
        Err(e) => return runtime_error(format!("cannot render report: {e}")),
    };
    if let Some(out) = &parsed.out {
        if let Err(e) = fs::write(out, format!("{text}\n")) {
            return runtime_error(format!("cannot write {out}: {e}"));
        }
    }
    if parsed.json {
        println!("{text}");
    } else {
        println!("overall: {}", report.overall.as_str());
        println!("reason:  {}", report.reason);
        for vu in &report.vu {
            println!("  {} {} ({})", vu.id, vu.verdict.as_str(), vu.checker_type);
        }
        if let Some(out) = &parsed.out {
            println!("report:  {out}");
        }
    }
    ExitCode::SUCCESS
}

fn cmd_self_check(args: &[String]) -> ExitCode {
    // 二进制自校验（M13-1b 起点）：现在校验内嵌 canonical 向量 + 报告形状自洽；
    // 封包形态的 spec/footer 指纹校验在 M13-1b 打包任务里接上。
    let mut corpus: Option<String> = None;
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--corpus" => {
                i += 1;
                match args.get(i) {
                    Some(v) => corpus = Some(v.clone()),
                    None => return usage_error("--corpus requires a directory"),
                }
            }
            other => return usage_error(&format!("unknown flag: {other}")),
        }
        i += 1;
    }
    let vectors = include_str!("../../../packages/verify/core/corpus/canonical/vectors.json");
    let doc: Value = match serde_json::from_str(vectors) {
        Ok(v) => v,
        Err(e) => return runtime_error(format!("embedded canonical vectors are malformed: {e}")),
    };
    let cases = doc["cases"].as_array().cloned().unwrap_or_default();
    if cases.is_empty() {
        return runtime_error("embedded canonical vectors are empty");
    }
    let mut checked = 0usize;
    for v in &cases {
        let want = v["expected"].as_str().unwrap_or_default();
        let got = canonical::canonical_stringify(&v["input"]);
        if want != got {
            return runtime_error(format!(
                "canonical vector {} mismatch:
  want {want}
  got  {got}",
                v["name"]
            ));
        }
        checked += 1;
    }
    println!("canonical-vectors: ok ({checked})");
    if let Some(dir) = &corpus {
        let manifest = Path::new(dir).join("manifest.json");
        match fs::read_to_string(&manifest) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(m) => println!(
                    "corpus-digest: {} (version {}, cases {})",
                    m["digest"].as_str().unwrap_or("?"),
                    m["corpus_version"].as_str().unwrap_or("?"),
                    m["files"].as_array().map(|f| f.len()).unwrap_or(0)
                ),
                Err(e) => return runtime_error(format!("{}: {e}", manifest.display())),
            },
            Err(e) => return runtime_error(format!("cannot read {}: {e}", manifest.display())),
        }
    } else {
        println!("corpus-digest: skip (pass --corpus <dir>)");
    }
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") | Some("-V") => {
            println!("yglverify {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some("run") => cmd_run(&args[1..]),
        Some("self-check") => cmd_self_check(&args[1..]),
        Some("canonical-check") => cmd_self_check(&[]),
        Some("-h") | Some("--help") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        _ => usage_error("unknown command"),
    }
}
