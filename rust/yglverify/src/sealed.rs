//! 封包形态（M13 设计 §8.5.1）：单二进制 = 引擎 + 内嵌 spec + footer 指纹。
//!
//! 为什么内嵌而不是 `--spec`：交付物必须自带规范，改了规范就换了二进制——
//! 报告里的 `binary_sha256` 才能锚住「跑的是哪份规范」；`--spec` 在封包里被拒绝。
//!
//! 字节布局（全部小端）：
//! ```text
//! [engine binary][spec json][footer json][footer_len: u32]
//! ```
//! footer 是 JSON：`{magic:"YGLVF1", spec_offset, spec_length, spec_sha256, build_sha256, engine_version, corpus_version}`，
//! `build_sha256 = sha256(engine_bytes || spec_bytes)`——footer 自身不参与计算，
//! 因此「引擎 + 规范」的摘要可以被构建侧带外登记，import 时比对而不是自证。

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAGIC: &str = "YGLVF1";
const TRAILER_LEN: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Footer {
    pub magic: String,
    pub spec_offset: u64,
    pub spec_length: u64,
    pub spec_sha256: String,
    pub build_sha256: String,
    pub engine_version: String,
    pub corpus_version: String,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// 生成封包字节：engine + spec + footer + u32 footer_len。
pub fn seal_bytes(engine: &[u8], spec_json: &str, engine_version: &str, corpus_version: &str) -> Result<Vec<u8>, String> {
    if spec_json.trim().is_empty() {
        return Err("spec is empty".into());
    }
    let spec_bytes = spec_json.as_bytes();
    let spec_offset = engine.len() as u64;
    let spec_length = spec_bytes.len() as u64;
    let spec_sha256 = sha256_hex(spec_bytes);
    let mut build_hasher = Sha256::new();
    build_hasher.update(engine);
    build_hasher.update(spec_bytes);
    let build_sha256 = hex::encode(build_hasher.finalize());
    let footer = Footer {
        magic: MAGIC.to_string(),
        spec_offset,
        spec_length,
        spec_sha256,
        build_sha256,
        engine_version: engine_version.to_string(),
        corpus_version: corpus_version.to_string(),
    };
    let footer_bytes = serde_json::to_vec(&footer).map_err(|e| format!("footer: {e}"))?;
    let mut out = Vec::with_capacity(engine.len() + spec_bytes.len() + footer_bytes.len() + TRAILER_LEN);
    out.extend_from_slice(engine);
    out.extend_from_slice(spec_bytes);
    out.extend_from_slice(&footer_bytes);
    out.extend_from_slice(&(footer_bytes.len() as u32).to_le_bytes());
    Ok(out)
}

/// 解出封包：返回 (footer, spec json 文本, 引擎字节)。
pub fn open_sealed(bytes: &[u8]) -> Result<(Footer, String, Vec<u8>), String> {
    if bytes.len() < TRAILER_LEN + 2 {
        return Err("sealed binary is truncated (no footer)".into());
    }
    let footer_len = u32::from_le_bytes(bytes[bytes.len() - TRAILER_LEN..].try_into().unwrap()) as usize;
    if footer_len == 0 || footer_len + TRAILER_LEN > bytes.len() {
        return Err("sealed binary footer length is out of range".into());
    }
    let footer_start = bytes.len() - TRAILER_LEN - footer_len;
    let footer: Footer = serde_json::from_slice(&bytes[footer_start..bytes.len() - TRAILER_LEN])
        .map_err(|e| format!("sealed footer is malformed: {e}"))?;
    if footer.magic != MAGIC {
        return Err(format!("sealed footer magic mismatch: {} (expected {MAGIC})", footer.magic));
    }
    let spec_start = footer.spec_offset as usize;
    let spec_end = spec_start
        .checked_add(footer.spec_length as usize)
        .ok_or_else(|| "sealed spec range overflows".to_string())?;
    if spec_end != footer_start {
        return Err("sealed layout mismatch: spec bytes are not adjacent to the footer".into());
    }
    let spec_bytes = &bytes[spec_start..spec_end];
    if sha256_hex(spec_bytes) != footer.spec_sha256 {
        return Err("sealed spec_sha256 mismatch — the embedded spec was modified".into());
    }
    let engine = &bytes[..spec_start];
    let mut build_hasher = Sha256::new();
    build_hasher.update(engine);
    build_hasher.update(spec_bytes);
    if hex::encode(build_hasher.finalize()) != footer.build_sha256 {
        return Err("sealed build_sha256 mismatch — engine or spec was tampered with".into());
    }
    let spec_json = String::from_utf8(spec_bytes.to_vec()).map_err(|e| format!("sealed spec is not UTF-8: {e}"))?;
    Ok((footer, spec_json, engine.to_vec()))
}

/// 读自身（或指定文件）判定是否封包；未封包返回 None。
pub fn read_sealed_file(path: &Path) -> Result<Option<(Footer, String)>, String> {
    let bytes = fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    match open_sealed(&bytes) {
        Ok((footer, spec, _engine)) => Ok(Some((footer, spec))),
        Err(e) => {
            // 未封包是正常形态（开发/开放模式），只有「看起来像封包但校验不过」才报错：
            // 尾部 4 字节能指到一个 magic 为 YGLVF1 的 footer，就算封包。
            if looks_sealed(&bytes) {
                return Err(e);
            }
            Ok(None)
        }
    }
}

/// 尾部结构像封包吗？（用于区分「未封包」与「封包被篡改」——后者必须报错而不是当开放模式）
///
/// r14 R3：只看「能解析出 Footer 且 magic 正确」会让两类破坏 fail-open——magic 字节坏、footer JSON 语法坏
/// 都会被判成「未封包」，然后按开放模式跑并接受 --spec（rc=2 而不是 rc=1）。
/// 判定改成结构性候选：长度窗口合法，且（含 MAGIC 字样 或 窗口是 `{...}` 形态）。
pub fn looks_sealed(bytes: &[u8]) -> bool {
    if bytes.len() < TRAILER_LEN + 8 {
        return false;
    }
    let footer_len = u32::from_le_bytes(bytes[bytes.len() - TRAILER_LEN..].try_into().unwrap()) as usize;
    if footer_len == 0 || footer_len + TRAILER_LEN > bytes.len() {
        return false;
    }
    let start = bytes.len() - TRAILER_LEN - footer_len;
    let window = &bytes[start..bytes.len() - TRAILER_LEN];
    if let Ok(f) = serde_json::from_slice::<Footer>(window) {
        if f.magic == MAGIC {
            return true;
        }
    }
    let text = String::from_utf8_lossy(window);
    text.contains(MAGIC) || (text.trim_start().starts_with('{') && text.trim_end().ends_with('}'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_roundtrip_and_tamper_detection() {
        let engine = b"ENGINE-BYTES".to_vec();
        let spec = r#"{"contract_version":"1.0"}"#;
        let sealed = seal_bytes(&engine, spec, "0.1.0", "1.0").unwrap();
        let (footer, got_spec, got_engine) = open_sealed(&sealed).unwrap();
        assert_eq!(footer.magic, MAGIC);
        assert_eq!(got_spec, spec);
        assert_eq!(got_engine, engine);
        assert_eq!(footer.spec_sha256, sha256_hex(spec.as_bytes()));

        let mut tampered = sealed.clone();
        let idx = engine.len() + 2;
        tampered[idx] = b'X';
        assert!(open_sealed(&tampered).unwrap_err().contains("spec_sha256"));
    }

    /// r14 R3：footer 的 magic 字节坏 / JSON 语法坏，都必须仍被认成「封包被改」（rc=1），
    /// 而不是当开放模式继续跑（那会把篡改降级成用法错误 rc=2）。
    #[test]
    fn corrupted_footer_still_counts_as_sealed_candidate() {
        let engine = b"ENGINE-BYTES".to_vec();
        let spec = r#"{"contract_version":"1.0"}"#;
        let sealed = seal_bytes(&engine, spec, "0.1.0", "1.0").unwrap();
        let footer_len = u32::from_le_bytes(sealed[sealed.len() - TRAILER_LEN..].try_into().unwrap()) as usize;
        let footer_start = sealed.len() - TRAILER_LEN - footer_len;

        let mut bad_magic = sealed.clone();
        let at = footer_start + String::from_utf8_lossy(&sealed[footer_start..]).find("YGLVF1").unwrap();
        bad_magic[at] = b'X';
        assert!(looks_sealed(&bad_magic), "broken magic must still look sealed");
        assert!(open_sealed(&bad_magic).is_err());

        let mut bad_json = sealed.clone();
        let brace = footer_start + String::from_utf8_lossy(&sealed[footer_start..]).find('{').unwrap();
        bad_json[brace] = b'[';
        assert!(looks_sealed(&bad_json), "broken footer JSON must still look sealed");
        assert!(open_sealed(&bad_json).is_err());
    }
}
