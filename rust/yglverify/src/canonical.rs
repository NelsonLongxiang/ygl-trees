//! Canonical JSON（RFC 8785 JCS 子集）——与 TS `packages/verify/core/src/canonical.ts` 逐字节一致。
//!
//! 规则见 `packages/verify/core/corpus/canonical/vectors.json`：键按 UTF-16 code unit 升序；
//! 数字用 ECMAScript `Number::toString` 形态；字符串做 NFC 后按 JSON 规则转义（非 ASCII 原样输出）。

use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

/// 把 `serde_json::Value` 序列化成 canonical 形式。
pub fn canonical_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

/// canonical 字符串的 sha256（hex）。
pub fn canonical_sha256(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(canonical_stringify(value).as_bytes());
    hex::encode(hasher.finalize())
}

fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => out.push_str(&number_to_string(n)),
        Value::String(s) => write_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            // 键序按 UTF-16 code unit，不是 Rust String 的字节序
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| utf16_units(a).cmp(&utf16_units(b)));
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                write_value(&map[*key], out);
            }
            out.push('}');
        }
    }
}

fn utf16_units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn write_string(s: &str, out: &mut String) {
    let normalized: String = s.nfc().collect();
    out.push('"');
    for ch in normalized.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// ECMAScript `Number::toString`（规范 7.1.12.1）——与 JS `JSON.stringify(number)` 一致。
pub fn number_to_string(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let v = n.as_f64().expect("serde_json number is int or f64");
    if v == 0.0 {
        return "0".to_string();
    }
    assert!(v.is_finite(), "canonical JSON rejects non-finite number");
    let negative = v < 0.0;
    let abs = v.abs();
    // Rust 的 `{:e}` 给出最短往返的科学计数法，如 "1e21" / "1.234e-7"
    let sci = format!("{:e}", abs);
    let (mantissa, exp) = sci.split_once('e').expect("scientific form");
    let exp: i32 = exp.parse().expect("exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    // JS 规范术语：n 是小数点位置（digits 首位之后），即 exp + 1
    let n_pos = exp + 1;

    let mut body = String::new();
    if k <= n_pos && n_pos <= 21 {
        body.push_str(&digits);
        for _ in 0..(n_pos - k) {
            body.push('0');
        }
    } else if 0 < n_pos && n_pos <= 21 {
        body.push_str(&digits[..n_pos as usize]);
        body.push('.');
        body.push_str(&digits[n_pos as usize..]);
    } else if -6 < n_pos && n_pos <= 0 {
        body.push_str("0.");
        for _ in 0..(-n_pos) {
            body.push('0');
        }
        body.push_str(&digits);
    } else {
        let sign = if n_pos - 1 >= 0 { '+' } else { '-' };
        let e = (n_pos - 1).abs();
        body.push_str(&digits[..1]);
        if k > 1 {
            body.push('.');
            body.push_str(&digits[1..]);
        }
        body.push('e');
        body.push(sign);
        body.push_str(&e.to_string());
    }

    if negative {
        format!("-{}", body)
    } else {
        body
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> Value {
        serde_json::from_str(v).unwrap()
    }

    fn num(v: &str) -> String {
        match s(v) {
            Value::Number(n) => number_to_string(&n),
            other => panic!("not a number literal: {other}"),
        }
    }

    #[test]
    fn numbers_match_es_form() {
        assert_eq!(num("1"), "1");
        assert_eq!(num("1e21"), "1e+21");
        assert_eq!(num("1e-7"), "1e-7");
        assert_eq!(num("0.1"), "0.1");
        assert_eq!(num("-0"), "0");
        assert_eq!(num("1234.5"), "1234.5");
        assert_eq!(num("9007199254740992"), "9007199254740992");
        assert_eq!(num("0.0000015"), "0.0000015");
    }

    #[test]
    fn key_order_is_utf16() {
        assert_eq!(canonical_stringify(&s(r#"{"b":1,"a":2,"B":3}"#)), r#"{"B":3,"a":2,"b":1}"#);
    }

    #[test]
    fn strings_escape_and_nfc() {
        assert_eq!(
            canonical_stringify(&s(r#"{"s":"a\"b\\c\n\t\u001f"}"#)),
            r#"{"s":"a\"b\\c\n\t\u001f"}"#
        );
        assert_eq!(canonical_stringify(&s(r#"{"s":"cafe\u0301"}"#)), r#"{"s":"café"}"#);
    }
}
