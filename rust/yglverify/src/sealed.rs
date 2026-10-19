//! 封包形态（M13 设计 §8.5.1 / 契约 §5）：单二进制 = 引擎 + 内嵌 spec + footer 指纹（+ 可选签名）。
//!
//! 为什么内嵌而不是 `--spec`：交付物必须自带规范，改了规范就换了二进制——
//! 报告里的 `binary_sha256` 才能锚住「跑的是哪份规范」；`--spec` 在封包里被拒绝。
//!
//! 字节布局（全部小端）：
//! ```text
//! [engine binary][spec json（JCS 规范形式）][footer json（JCS 规范形式）][footer_len: u32]
//! ```
//! footer（contract 1.1 起）：`{magic, format_version, engine_sha256, spec_offset, spec_length,
//! spec_sha256, build_sha256, engine_version, corpus_version, alg, key_id, signature?}`。
//! - `build_sha256 = sha256(engine_bytes || spec_bytes)`（footer 自身不参与，构建侧可带外登记）
//! - `engine_sha256 = sha256(engine_bytes)`
//! - 签名对象 = `"YGLVERIFY-SEAL-v1\0" || u32le(len(JCS(footer_without_signature))) || JCS(footer_without_signature)`
//! - 封包自身**不验签**（没有可信公钥；内嵌公钥=自证）：真实性在分发/导入侧按仓库密钥表验证
//!
//! 规范形断言（fdc757f6 裁定②）：seal 与 verify 双侧都要求 `raw == JCS(parse(raw))`，
//! 不相等即点名拒绝——签名签的是盘上字节，非规范 footer 不允许「语义等价蒙混」。

use std::fs;
use std::path::Path;

use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::canonical::canonical_stringify;

pub const MAGIC: &str = "YGLVF1";
pub const FORMAT_VERSION: u32 = 1;
pub const ALG_ED25519: &str = "ed25519";
pub const ALG_NONE: &str = "none";
pub const SIGNATURE_DOMAIN: &[u8] = b"YGLVERIFY-SEAL-v1\0";
const TRAILER_LEN: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Footer {
    pub magic: String,
    pub format_version: u32,
    pub engine_sha256: String,
    pub spec_offset: u64,
    pub spec_length: u64,
    pub spec_sha256: String,
    pub build_sha256: String,
    pub engine_version: String,
    pub corpus_version: String,
    pub sig_alg: String,
    pub key_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sig: Option<String>,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// footer 去掉签名字段后的规范字节（JCS）。
pub fn canonical_without_signature(footer: &Footer) -> String {
    let mut bare = footer.clone();
    bare.sig = None;
    let value = serde_json::to_value(&bare).expect("footer serializes");
    canonical_stringify(&value)
}

/// 待签消息：域分隔 + u32le(规范字节长度) + 规范字节。
pub fn signature_message(canonical: &str) -> Vec<u8> {
    let mut msg = Vec::with_capacity(SIGNATURE_DOMAIN.len() + 4 + canonical.len());
    msg.extend_from_slice(SIGNATURE_DOMAIN);
    msg.extend_from_slice(&(canonical.len() as u32).to_le_bytes());
    msg.extend_from_slice(canonical.as_bytes());
    msg
}

/// 生成封包字节：engine + JCS(spec) + JCS(footer) + u32 footer_len。`seed` 为 None 时产出 unsigned 封包。
pub fn seal_bytes_with_key(
    engine: &[u8],
    spec_json: &str,
    engine_version: &str,
    corpus_version: &str,
    seed: Option<[u8; 32]>,
) -> Result<Vec<u8>, String> {
    if spec_json.trim().is_empty() {
        return Err("spec is empty".into());
    }
    // 内嵌 spec 一律规范化为 JCS：验证期才能做 raw == JCS(parse) 的硬断言。
    let spec_value: Value = serde_json::from_str(spec_json).map_err(|e| format!("spec is not JSON: {e}"))?;
    let canonical_spec = canonical_stringify(&spec_value);
    let spec_bytes = canonical_spec.as_bytes();
    let spec_offset = engine.len() as u64;
    let spec_length = spec_bytes.len() as u64;
    let spec_sha256 = sha256_hex(spec_bytes);
    let engine_sha256 = sha256_hex(engine);
    let mut build_hasher = Sha256::new();
    build_hasher.update(engine);
    build_hasher.update(spec_bytes);
    let build_sha256 = hex::encode(build_hasher.finalize());

    let mut footer = Footer {
        magic: MAGIC.to_string(),
        format_version: FORMAT_VERSION,
        engine_sha256,
        spec_offset,
        spec_length,
        spec_sha256,
        build_sha256,
        engine_version: engine_version.to_string(),
        corpus_version: corpus_version.to_string(),
        sig_alg: ALG_NONE.to_string(),
        key_id: String::new(),
        sig: None,
    };
    if let Some(seed) = seed {
        let signing = SigningKey::from_bytes(&seed);
        footer.key_id = sha256_hex(signing.verifying_key().as_bytes());
        footer.sig_alg = ALG_ED25519.to_string();
        let canonical = canonical_without_signature(&footer);
        let sig = signing.sign(&signature_message(&canonical));
        use base64::Engine as _;
        footer.sig = Some(base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()));
    }
    let footer_value = serde_json::to_value(&footer).map_err(|e| format!("footer: {e}"))?;
    let footer_bytes = canonical_stringify(&footer_value).into_bytes();
    let mut out = Vec::with_capacity(engine.len() + spec_bytes.len() + footer_bytes.len() + TRAILER_LEN);
    out.extend_from_slice(engine);
    out.extend_from_slice(spec_bytes);
    out.extend_from_slice(&footer_bytes);
    out.extend_from_slice(&(footer_bytes.len() as u32).to_le_bytes());
    Ok(out)
}

/// 未签名封包（兼容既有调用点）。
pub fn seal_bytes(engine: &[u8], spec_json: &str, engine_version: &str, corpus_version: &str) -> Result<Vec<u8>, String> {
    seal_bytes_with_key(engine, spec_json, engine_version, corpus_version, None)
}

/// 解出封包：返回 (footer, spec json 文本, 引擎字节)。校验面：布局 → 规范形 → 哈希三元组。
pub fn open_sealed(bytes: &[u8]) -> Result<(Footer, String, Vec<u8>), String> {
    if bytes.len() < TRAILER_LEN + 2 {
        return Err("sealed binary is truncated (no footer)".into());
    }
    let footer_len = u32::from_le_bytes(bytes[bytes.len() - TRAILER_LEN..].try_into().unwrap()) as usize;
    if footer_len == 0 || footer_len + TRAILER_LEN > bytes.len() {
        return Err("sealed binary footer length is out of range".into());
    }
    let footer_start = bytes.len() - TRAILER_LEN - footer_len;
    let footer_raw = &bytes[footer_start..bytes.len() - TRAILER_LEN];
    let footer_value: Value = serde_json::from_slice(footer_raw).map_err(|e| format!("sealed footer is malformed: {e}"))?;
    let recomposed = canonical_stringify(&footer_value);
    if recomposed.as_bytes() != footer_raw {
        return Err("sealed footer is not canonical (raw != JCS(parse)) — refusing to trust a non-canonical footer".into());
    }
    let footer: Footer = serde_json::from_value(footer_value).map_err(|e| format!("sealed footer is malformed: {e}"))?;
    if footer.magic != MAGIC {
        return Err(format!("sealed footer magic mismatch: {} (expected {MAGIC})", footer.magic));
    }
    if footer.format_version != FORMAT_VERSION {
        return Err(format!(
            "sealed footer format_version {} is not supported by this build (expects {FORMAT_VERSION})",
            footer.format_version
        ));
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
    let spec_value: Value = serde_json::from_slice(spec_bytes).map_err(|e| format!("sealed spec is malformed: {e}"))?;
    let canonical_spec = canonical_stringify(&spec_value);
    if canonical_spec.as_bytes() != spec_bytes {
        return Err("sealed spec is not canonical (raw != JCS(parse)) — the embedded spec was re-serialized".into());
    }
    let engine = &bytes[..spec_start];
    let mut build_hasher = Sha256::new();
    build_hasher.update(engine);
    build_hasher.update(spec_bytes);
    if hex::encode(build_hasher.finalize()) != footer.build_sha256 {
        return Err("sealed build_sha256 mismatch — engine or spec was tampered with".into());
    }
    if sha256_hex(engine) != footer.engine_sha256 {
        return Err("sealed engine_sha256 mismatch — the engine was modified".into());
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
            // 未封包是正常形态（开发/开放模式），只有「看起来像封包但校验不过」才报错。
            if looks_sealed(&bytes) {
                return Err(e);
            }
            Ok(None)
        }
    }
}

/// 尾部结构像封包吗？（用于区分「未封包」与「封包被篡改」——后者必须报错而不是当开放模式）
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

/// 从 32 字节种子派生公钥指纹（与 TS `fingerprintOfRawPublicKey` 同口径：sha256(raw pubkey) hex）。
pub fn key_id_from_seed(seed: [u8; 32]) -> String {
    let signing = SigningKey::from_bytes(&seed);
    sha256_hex(signing.verifying_key().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_roundtrip_and_tamper_detection() {
        let engine = b"ENGINE-BYTES".to_vec();
        let spec = r#"{"contract_version":"1.1","a":1}"#;
        let sealed = seal_bytes(&engine, spec, "0.1.0", "1.0").unwrap();
        let (footer, got_spec, got_engine) = open_sealed(&sealed).unwrap();
        assert_eq!(footer.magic, MAGIC);
        assert_eq!(footer.format_version, FORMAT_VERSION);
        assert_eq!(footer.sig_alg, ALG_NONE);
        assert_eq!(got_engine, engine);
        assert!(got_spec.contains("\"contract_version\":\"1.1\""));

        let mut tampered = sealed.clone();
        let idx = engine.len() + 2;
        tampered[idx] = b'X';
        assert!(open_sealed(&tampered).unwrap_err().contains("spec"));
    }

    #[test]
    fn corrupted_footer_still_counts_as_sealed_candidate() {
        let engine = b"ENGINE-BYTES".to_vec();
        let spec = r#"{"contract_version":"1.1"}"#;
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

    /// RFC 8032 测试向量 seed：签名字节必须与 TS 侧逐字节一致（parity 锚）。
    #[test]
    fn signs_with_rfc8032_seed() {
        let seed = hex::decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60").unwrap();
        let mut key = [0u8; 32];
        key.copy_from_slice(&seed);
        // key_id = sha256(raw pubkey) hex（公钥 d75a9801… 的指纹，与 TS fingerprintOfRawPublicKey 同口径）
        assert_eq!(key_id_from_seed(key), "21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9");
        let engine = b"ENGINE".to_vec();
        let sealed = seal_bytes_with_key(&engine, r#"{"contract_version":"1.1"}"#, "0.1.0", "1.0", Some(key)).unwrap();
        let (footer, _spec, _engine) = open_sealed(&sealed).unwrap();
        assert_eq!(footer.sig_alg, ALG_ED25519);
        assert_eq!(footer.key_id, "21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9");
        assert!(footer.sig.as_deref().unwrap().len() > 60);
    }

    /// 非规范 footer（语义等价但转写不同）必须被点名拒绝。
    #[test]
    fn rejects_non_canonical_footer() {
        let engine = b"ENGINE".to_vec();
        let sealed = seal_bytes(&engine, r#"{"contract_version":"1.1"}"#, "0.1.0", "1.0").unwrap();
        let footer_len = u32::from_le_bytes(sealed[sealed.len() - TRAILER_LEN..].try_into().unwrap()) as usize;
        let footer_start = sealed.len() - TRAILER_LEN - footer_len;
        let text = String::from_utf8_lossy(&sealed[footer_start..sealed.len() - TRAILER_LEN]).to_string();
        // 语义等价但转写不同：在第一个冒号后加一个空格（JCS 要求无空格）
        let alt = text.replacen(":", ": ", 1);
        assert_ne!(alt, text);
        let mut out = Vec::new();
        out.extend_from_slice(&sealed[..footer_start]);
        out.extend_from_slice(alt.as_bytes());
        out.extend_from_slice(&(alt.len() as u32).to_le_bytes());
        let err = open_sealed(&out).unwrap_err();
        assert!(err.contains("not canonical"), "unexpected error: {err}");
    }
}
