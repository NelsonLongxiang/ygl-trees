//! #162 single-statement parity: the TS `singleStatement` vectors
//! (packages/verify/core/tests/fixtures/sql-statements.json) must give the same result in Rust.

use std::fs;
use std::path::Path;

use serde_json::Value;
use yglverify::sqlite::{single_statement, trim_sql_ws};

#[test]
fn single_statement_matches_ts_vectors() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/verify/core/tests/fixtures/sql-statements.json");
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let doc: Value = serde_json::from_str(&text).unwrap();
    let vectors = doc["vectors"].as_array().expect("vectors array");
    assert!(vectors.len() >= 10, "expected >=10 vectors, got {}", vectors.len());
    for v in vectors {
        let sql = trim_sql_ws(v["sql"].as_str().unwrap());
        let want = v["clean"].as_str();
        assert_eq!(single_statement(sql), want, "sql: {sql:?}");
    }
}
