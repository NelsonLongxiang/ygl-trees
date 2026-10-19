//! 跨实现 parity：直接读 TS 侧冻结的 canonical 向量文件，逐例比对。
//!
//! 这套向量是 contract 1.0 的一部分（`packages/verify/core/corpus/canonical/vectors.json`，
//! 只增不改）。Rust 实现不接受"另写一份测试数据"——必须吃同一份文件。

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use yglverify::canonical::canonical_stringify;

fn vectors_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("packages/verify/core/corpus/canonical/vectors.json")
}

#[test]
fn canonical_vectors_match_ts() {
    let raw = fs::read_to_string(vectors_path()).expect("vectors.json readable");
    let doc: Value = serde_json::from_str(&raw).expect("vectors.json parses");
    let cases = doc["cases"].as_array().expect("cases array");
    assert!(cases.len() >= 12, "vector set unexpectedly small: {}", cases.len());
    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let expected = case["expected"].as_str().expect("expected string");
        let got = canonical_stringify(&case["input"]);
        assert_eq!(got, expected, "canonical mismatch on case `{name}`");
    }
}
