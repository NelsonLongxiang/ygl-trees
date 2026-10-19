//! SQLite 数据面（对应 TS `sqlite-runner.ts`）：只读打开、单语句、schema 指纹。
//!
//! 纪律与 TS 一致：只允许 SELECT/WITH（单语句），表名白名单字符集，
//! 指纹算法逐字节相同（`name:normalized_sql` 用 `|` 连接后 sha256）——prepare 冻结值与 run 比对靠它。

use std::cell::RefCell;
use std::collections::HashMap;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// 一行结果按**列序**保存（TS 侧 `Object.values(row)[0]` 依赖列序）。
pub type Row = Vec<(String, Value)>;

pub struct SqliteRunner {
    conn: Connection,
    table_cache: RefCell<HashMap<String, i64>>,
}

fn value_of(raw: ValueRef<'_>) -> Value {
    match raw {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).to_string()),
        ValueRef::Blob(b) => Value::String(String::from_utf8_lossy(b).to_string()),
    }
}

/// 取首列（TS `Object.values(row)[0]`）。
pub fn first_value(row: &Row) -> Option<&Value> {
    row.first().map(|(_, v)| v)
}

/// 取某列（按列名）。
pub fn column<'a>(row: &'a Row, name: &str) -> Option<&'a Value> {
    row.iter().find(|(k, _)| k == name).map(|(_, v)| v)
}

impl SqliteRunner {
    pub fn open_read_only(path: &str) -> Result<Self, String> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| format!("cannot open snapshot read-only: {e}"))?;
        let _ = conn.execute_batch("PRAGMA query_only = ON;");
        Ok(Self { conn, table_cache: RefCell::new(HashMap::new()) })
    }

    pub fn query(&self, sql: &str) -> Result<Vec<Row>, String> {
        let trimmed = sql.trim();
        let lower = trimmed.to_ascii_lowercase();
        if !(lower.starts_with("select") || lower.starts_with("with")) {
            return Err(format!(
                "only SELECT/WITH allowed (read-only contract): {}",
                &trimmed.chars().take(40).collect::<String>()
            ));
        }
        let mut semis = trimmed.match_indices(';');
        if let Some((idx, _)) = semis.next() {
            if trimmed[idx + 1..].trim().chars().any(|c| !c.is_whitespace()) {
                return Err("multi-statement SQL rejected (single statement contract)".into());
            }
        }
        let clean = trimmed.trim_end_matches(|c: char| c == ';' || c.is_whitespace());
        let mut stmt = self.conn.prepare(clean).map_err(|e| format!("prepare failed: {e}"))?;
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let mut rows = stmt.query([]).map_err(|e| format!("query failed: {e}"))?;
        let mut out = Vec::new();
        loop {
            match rows.next() {
                Ok(Some(r)) => {
                    let mut row = Vec::with_capacity(names.len());
                    for (i, name) in names.iter().enumerate() {
                        let v = r.get_ref(i).map(|raw| value_of(raw)).map_err(|e| format!("read column {name}: {e}"))?;
                        row.push((name.clone(), v));
                    }
                    out.push(row);
                }
                Ok(None) => break,
                Err(e) => return Err(format!("iterate failed: {e}")),
            }
        }
        Ok(out)
    }

    pub fn table_rows(&self, table: &str) -> Result<i64, String> {
        if let Some(n) = self.table_cache.borrow().get(table) {
            return Ok(*n);
        }
        let ok = !table.is_empty()
            && table.chars().next().map(|c| c.is_ascii_alphabetic() || c == '_').unwrap_or(false)
            && table.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !ok {
            return Err(format!("invalid table name: {table}"));
        }
        let rows = self.query(&format!("SELECT count(*) AS n FROM \"{table}\""))?;
        let n = rows
            .first()
            .and_then(first_value)
            .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
            .unwrap_or(0);
        self.table_cache.borrow_mut().insert(table.to_string(), n);
        Ok(n)
    }

    /// 从 SQL 文本粗提源表（FROM/JOIN）——与 TS `extractTables` 同口径（尽力而为，子查询/CTE 可能漏）。
    pub fn source_tables(&self, sql: &str) -> Vec<String> {
        extract_tables(sql)
    }

    /// schema 指纹：用户表（名 + 规范化 DDL）按名排序后 `|` 连接再 sha256。
    pub fn schema_fingerprint(&self) -> Result<String, String> {
        let rows = self.query(
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?;
        let mut parts = Vec::with_capacity(rows.len());
        for r in rows {
            let name = column(&r, "name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let ddl = column(&r, "sql").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let normalized: String = ddl.split_whitespace().collect::<Vec<_>>().join(" ");
            parts.push(format!("{name}:{normalized}"));
        }
        let norm = parts.join("|");
        let mut hasher = Sha256::new();
        hasher.update(norm.as_bytes());
        Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
    }
}

/// `FROM`/`JOIN` 后的裸表名（大小写不敏感，去重保序）。
pub fn extract_tables(sql: &str) -> Vec<String> {
    let lower = sql.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let at_word = |kw: &[u8]| -> bool {
            if i + kw.len() > bytes.len() || &bytes[i..i + kw.len()] != kw {
                return false;
            }
            let before_ok = i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
            let after = i + kw.len();
            let after_ok = after >= bytes.len() || !(bytes[after].is_ascii_alphanumeric() || bytes[after] == b'_');
            before_ok && after_ok
        };
        if at_word(b"from") || at_word(b"join") {
            let kw_len = 4;
            let mut j = i + kw_len;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            let start = j;
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
                j += 1;
            }
            if j > start {
                let name: String = sql[start..j].to_string();
                if !out.iter().any(|x| x == &name) {
                    out.push(name);
                }
            }
            i = j.max(i + kw_len);
            continue;
        }
        i += 1;
    }
    out
}
