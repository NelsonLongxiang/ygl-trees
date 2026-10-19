use std::process::ExitCode;

use yglverify::canonical;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") | Some("-V") => {
            println!("yglverify {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some("canonical-check") => {
            let _ = &canonical::canonical_stringify;
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: yglverify --version | canonical-check");
            ExitCode::from(2)
        }
    }
}
