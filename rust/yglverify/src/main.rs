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
//!   yglverify seal --spec <spec.json> --out <sealed-binary>   # 产出封包二进制（内嵌 spec）
//!   yglverify self-check [--corpus <dir>]

use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::ExitCode;

use serde_json::Value;

use yglverify::canonical;
use yglverify::contract::{parse_spec, DataSource};
use yglverify::engine::{run_verify, VerifyOptions};
use yglverify::sealed::{open_sealed, read_sealed_file, seal_bytes_with_key, sha256_hex};
use yglverify::sqlite::SqliteRunner;

const USAGE: &str = "\
usage:
  yglverify run --spec <file|-> --db <snapshot.sqlite> [--json] [--out <report.json>]
                [--attachments <dir>] [--command-allow <bin>]... [--run-id <id>]
                [--now <rfc3339>] [--mode open|sealed]
  yglverify seal --spec <spec.json> --out <sealed-binary>
  yglverify self-check [--corpus <dir>]
  yglverify canonical-check
  yglverify --version";

struct RunArgs {
    spec: Option<String>,
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
    // 封包形态：spec 内嵌，拒绝 --spec（规范改了就该换二进制，而不是换参数）
    let self_path = std::env::current_exe().unwrap_or_else(|_| Path::new("yglverify").to_path_buf());
    let sealed = match read_sealed_file(&self_path) {
        Ok(s) => s,
        Err(e) => return runtime_error(e),
    };
    let sealed_bytes = if sealed.is_some() {
        match fs::read(&self_path) {
            Ok(b) => Some(b),
            Err(e) => return runtime_error(format!("cannot read own binary: {e}")),
        }
    } else {
        None
    };
    let mut sealed_sig: (Option<String>, Option<String>, Option<String>) = (None, None, None);
    let (spec_text, mode, binary_sha) = match (&sealed, parsed.spec.as_deref()) {
        (Some((footer, spec)), None) => {
            let sha = sealed_bytes
                .as_ref()
                .map(|b| format!("sha256:{}", sha256_hex(b)))
                .unwrap_or_default();
            // 签名身份进报告（contract 1.1）：alg/key_id/signature 来自 footer；
            // 二进制自己不做信任判断（没有可信公钥，内嵌公钥=自证）。
            sealed_sig = (
                footer.sig.clone(),
                if footer.sig_alg == "none" { None } else { Some(footer.sig_alg.clone()) },
                if footer.key_id.is_empty() { None } else { Some(footer.key_id.clone()) },
            );
            (spec.clone(), "sealed".to_string(), Some(sha))
        }
        (Some(_), Some(_)) => {
            return usage_error("sealed binary does not accept --spec — the spec is embedded; rebuild the binary to change it")
        }
        (None, Some(path)) => match read_spec(path) {
            Ok(s) => (s, parsed.mode.clone(), None),
            Err(code) => return code,
        },
        (None, None) => return usage_error("run requires --spec <file|-> (or run a sealed binary)"),
    };
    if !Path::new(&parsed.db).exists() {
        return runtime_error(format!("snapshot not found: {}", parsed.db));
    }
    let spec = match parse_spec(&spec_text) {
        Ok(s) => s,
        Err(e) => return runtime_error(e),
    };
    let runner = match SqliteRunner::open_read_only(&parsed.db) {
        Ok(r) => r,
        Err(e) => return runtime_error(e),
    };
    // 数据源锚（评审 r13 ③）：报告必须能说清"这份判定跑在哪个快照上"，
    // 否则 `verify archive --with snapshot` 与重放都断链。sha256 由二进制自己算。
    let (ds_sha, ds_at) = match std::fs::read(&parsed.db) {
        Ok(bytes) => (
            format!("sha256:{}", sha256_hex(&bytes)),
            parsed.now.clone().unwrap_or_else(|| {
                let ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                yglverify::predicate::format_iso_utc(ms)
            }),
        ),
        Err(e) => return runtime_error(format!("cannot read --db {}: {e}", parsed.db)),
    };
    let data_source = Some(DataSource {
        kind: "sqlite-snapshot".into(),
        sha256: ds_sha,
        source: Some(parsed.db.clone()),
        captured_at: ds_at,
    });
    let opts = VerifyOptions {
        runner: &runner,
        submission_dir: parsed.attachments.as_deref(),
        command_allowlist: if parsed.allow.is_empty() { None } else { Some(parsed.allow.clone()) },
        now_iso: parsed.now.clone(),
        run_id: parsed.run_id.clone(),
        engine_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        mode: Some(mode.clone()),
        binary_sha256: binary_sha.clone(),
        signature: sealed_sig.0.clone(),
        signing_scheme: sealed_sig.1.clone(),
        public_key_fingerprint: sealed_sig.2.clone(),
        data_source,
    };
    let report = match run_verify(&spec, &opts) {
        Ok(r) => r,
        Err(e) => return runtime_error(e),
    };
    let mut value = match serde_json::to_value(&report) {
        Ok(v) => v,
        Err(e) => return runtime_error(format!("cannot serialize report: {e}")),
    };
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

fn cmd_seal(args: &[String]) -> ExitCode {
    let mut spec_path: Option<String> = None;
    let mut out: Option<String> = None;
    let mut key_path: Option<String> = None;
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--spec" => {
                i += 1;
                match args.get(i) {
                    Some(v) => spec_path = Some(v.clone()),
                    None => return usage_error("--spec requires a file"),
                }
            }
            "--out" => {
                i += 1;
                match args.get(i) {
                    Some(v) => out = Some(v.clone()),
                    None => return usage_error("--out requires a path"),
                }
            }
            "--key" => {
                i += 1;
                match args.get(i) {
                    Some(v) => key_path = Some(v.clone()),
                    None => return usage_error("--key requires a seed file (32 bytes raw or 64 hex chars)"),
                }
            }
            other => return usage_error(&format!("unknown flag: {other}")),
        }
        i += 1;
    }
    let spec_path = match spec_path {
        Some(p) => p,
        None => return usage_error("seal requires --spec <spec.json>"),
    };
    let out = match out {
        Some(p) => p,
        None => return usage_error("seal requires --out <file>"),
    };
    let spec_text = match fs::read_to_string(&spec_path) {
        Ok(t) => t,
        Err(e) => return runtime_error(format!("cannot read spec {spec_path}: {e}")),
    };
    let spec = match parse_spec(&spec_text) {
        Ok(s) => s,
        Err(e) => return runtime_error(e),
    };
    let self_path = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => return runtime_error(format!("cannot locate own binary: {e}")),
    };
    let engine = match fs::read(&self_path) {
        Ok(b) => b,
        Err(e) => return runtime_error(format!("cannot read own binary: {e}")),
    };
    // 不允许二次封包（footer 里再塞 footer 会破坏 build_sha256 的语义）
    if open_sealed(&engine).is_ok() {
        return usage_error("this binary is already sealed — seal the open build instead");
    }
    let seed = match key_path.as_deref() {
        None => {
            eprintln!("warning: sealing without --key produces an unsigned build (no signature to verify)");
            None
        }
        Some(path) => match read_seed(path) {
            Ok(seed) => Some(seed),
            Err(e) => return runtime_error(e),
        },
    };
    let sealed = match seal_bytes_with_key(&engine, &spec_text, env!("CARGO_PKG_VERSION"), &spec.verifier.corpus_version, seed) {
        Ok(b) => b,
        Err(e) => return runtime_error(e),
    };
    if let Err(e) = fs::write(&out, &sealed) {
        return runtime_error(format!("cannot write {out}: {e}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&out, fs::Permissions::from_mode(0o755));
    }
    let footer = match open_sealed(&sealed) {
        Ok((f, _, _)) => f,
        Err(e) => return runtime_error(e),
    };
    println!("sealed {} (spec {} v{}, build {})", out, spec.spec_id, spec.spec_version, footer.build_sha256);
    ExitCode::SUCCESS
}

/// 读封包签名种子：64 hex 字符 或 32 字节裸文件。
fn read_seed(path: &str) -> Result<[u8; 32], String> {
    let raw = fs::read(path).map_err(|e| format!("cannot read key {path}: {e}"))?;
    let mut seed = [0u8; 32];
    let text = String::from_utf8_lossy(&raw).trim().to_string();
    if raw.len() == 64 && text.chars().all(|c| c.is_ascii_hexdigit()) {
        let decoded = hex::decode(&text).map_err(|e| format!("key {path} is not valid hex: {e}"))?;
        seed.copy_from_slice(&decoded);
        return Ok(seed);
    }
    if raw.len() == 32 {
        seed.copy_from_slice(&raw);
        return Ok(seed);
    }
    Err(format!(
        "key {path} must be 32 raw bytes or 64 hex chars (got {} bytes)",
        raw.len()
    ))
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
    if let Ok(exe) = std::env::current_exe() {
        match read_sealed_file(&exe) {
            Ok(Some((footer, spec_text))) => match parse_spec(&spec_text) {
                Ok(spec) => {
                    println!(
                        "sealed-spec: ok ({} v{}, build {}, corpus {})",
                        spec.spec_id, spec.spec_version, footer.build_sha256, footer.corpus_version
                    );
                }
                Err(e) => return runtime_error(format!("embedded spec does not parse: {e}")),
            },
            Ok(None) => println!("sealed-spec: skip (open build)"),
            Err(e) => return runtime_error(e),
        }
    }
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
        Some("seal") => cmd_seal(&args[1..]),
        Some("self-check") => cmd_self_check(&args[1..]),
        Some("canonical-check") => cmd_self_check(&[]),
        Some("-h") | Some("--help") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        _ => usage_error("unknown command"),
    }
}
