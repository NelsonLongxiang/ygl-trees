//! SQLite 数据面（对应 TS `sqlite-runner.ts`）：只读打开、单语句、schema 指纹。
//!
//! 纪律与 TS 一致：只允许 SELECT/WITH（单语句），表名白名单字符集，
//! 指纹算法逐字节相同（`name:normalized_sql` 用 `|` 连接后 sha256）——prepare 冻结值与 run 比对靠它。

use std::cell::{Cell, RefCell};
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
    path: String,
    isolated: Cell<bool>,
    /// 1.3: the snapshot file's sha256 when `isolate` ran — `untouched` proves it unchanged at the end of the run.
    isolated_sha: RefCell<Option<String>>,
}

fn file_sha256(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read snapshot {path}: {e}"))?;
    let mut h = Sha256::new();
    h.update(&bytes);
    Ok(hex::encode(h.finalize()))
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
/// 单语句判定（#162）：只把引号、标识符与注释之外的分号当语句分隔符，
/// 与 TS `singleStatement`（packages/verify/core/src/sqlite-runner.ts）同算法、同向量。
/// 返回去掉末尾分隔符后的语句；顶层分号之后还有非空白内容则返回 None。
/// SQL 空白：只认 ASCII 0x09–0x0D 与空格，与 TS `SQL_WS` 同集（#162 增补：不用 char::is_whitespace，避免 U+FEFF/U+0085 两端判定相反）。
pub fn is_sql_ws(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\x0b' | '\x0c' | '\r' | ' ')
}

pub fn trim_sql_ws(s: &str) -> &str {
    s.trim_matches(is_sql_ws)
}

/// 开头是非 ASCII 空白时返回其码位（如 "U+00A0"），否则 None——只用于给出准确报错（#162 P4），不改变拒收结论。
/// 字符集显式列出，与 TS `leadingNonAsciiWs` 同集。
pub fn leading_non_ascii_ws(s: &str) -> Option<String> {
    let c = s.chars().next()?;
    let hit = matches!(c, '\u{0085}' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}');
    if hit { Some(format!("U+{:04X}", c as u32)) } else { None }
}

pub fn single_statement(sql: &str) -> Option<&str> {
    let b = sql.as_bytes();
    let n = b.len();
    let mut i = 0;
    while i < n {
        let c = b[i];
        match c {
            b'\'' | b'"' | b'`' => {
                i += 1;
                while i < n {
                    if b[i] == c {
                        if i + 1 < n && b[i + 1] == c {
                            i += 2;
                        } else {
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
                i += 1;
            }
            b'[' => {
                i = match sql[i + 1..].find(']') {
                    Some(off) => i + 1 + off + 1,
                    None => n,
                };
            }
            b'-' if i + 1 < n && b[i + 1] == b'-' => {
                i = match sql[i + 2..].find('\n') {
                    Some(off) => i + 2 + off + 1,
                    None => n,
                };
            }
            b'/' if i + 1 < n && b[i + 1] == b'*' => {
                i = match sql[i + 2..].find("*/") {
                    Some(off) => i + 2 + off + 2,
                    None => n,
                };
            }
            b';' => {
                return if !trim_sql_ws(&sql[i + 1..]).is_empty() {
                    None
                } else {
                    Some(trim_sql_ws(&sql[..i]))
                };
            }
            _ => i += 1,
        }
    }
    Some(sql)
}

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
        Ok(Self {
            conn,
            table_cache: RefCell::new(HashMap::new()),
            path: path.to_string(),
            isolated: Cell::new(false),
            isolated_sha: RefCell::new(None),
        })
    }

    /// 1.3 (#80, rulings ② ③): derived tables and spec views run in memory only — sqlite-runner.ts `isolate`. The
    /// snapshot stays opened read-only; temp storage is forced to memory and checked, each view is created as a TEMP
    /// VIEW, then `query_only` locks the connection again. A view name equal to a snapshot object is refused.
    pub fn isolate(&self, views: &[(String, String)]) -> Result<(), String> {
        if self.isolated.get() {
            return Err("isolate: already isolated".into());
        }
        self.isolated.set(true);
        if self.path != ":memory:" {
            *self.isolated_sha.borrow_mut() = Some(file_sha256(&self.path)?);
        }
        self.conn.execute_batch("PRAGMA query_only = OFF;").map_err(|e| format!("isolate: {e}"))?;
        let res = (|| -> Result<(), String> {
            self.conn.execute_batch("PRAGMA temp_store = MEMORY;").map_err(|e| format!("isolate: {e}"))?;
            let ts: i64 = self.conn.query_row("PRAGMA temp_store", [], |r| r.get(0)).map_err(|e| format!("isolate: {e}"))?;
            if ts != 2 {
                return Err(format!(
                    "isolation_unavailable: temp_store is {ts}, not MEMORY — this SQLite build keeps temp objects on disk"
                ));
            }
            let mut clash = self
                .conn
                .prepare("SELECT name FROM main.sqlite_master WHERE lower(name) = lower(?1)")
                .map_err(|e| format!("isolate: {e}"))?;
            for (name, sql) in views {
                let snake = name.chars().next().map(|c| c.is_ascii_lowercase()).unwrap_or(false)
                    && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
                if !snake {
                    return Err(format!("view_name: {} is not snake_case", serde_json::to_string(name).unwrap_or_default()));
                }
                if clash.exists([name]).map_err(|e| format!("isolate: {e}"))? {
                    return Err(format!("view_name: {name} is already an object in the snapshot — a spec view may not shadow it"));
                }
                self.conn
                    .execute_batch(&format!("CREATE TEMP VIEW {name} AS {sql}"))
                    .map_err(|e| format!("view {name}: {e}"))?;
            }
            Ok(())
        })();
        let _ = self.conn.execute_batch("PRAGMA query_only = ON;");
        res
    }

    /// 1.3 (ruling ③): None when the run was not isolated or the snapshot bytes are unchanged, else the refusal.
    pub fn untouched(&self) -> Option<String> {
        let before = self.isolated_sha.borrow().clone()?;
        match file_sha256(&self.path) {
            Ok(now) if now == before => None,
            Ok(now) => Some(format!("snapshot_changed: sha256 {} before the views, {} after the run", &before[..12], &now[..12])),
            Err(e) => Some(e),
        }
    }

    /// 1.3: names of views stored in the snapshot (main schema) — a 1.3 spec may never read one.
    pub fn snapshot_views(&self) -> Result<Vec<String>, String> {
        let rows = self.query("SELECT name FROM main.sqlite_master WHERE type='view' ORDER BY name")?;
        Ok(rows.iter().filter_map(|r| column(r, "name").and_then(|v| v.as_str()).map(|s| s.to_string())).collect())
    }

    pub fn query(&self, sql: &str) -> Result<Vec<Row>, String> {
        let trimmed = trim_sql_ws(sql);
        if let Some(ws) = leading_non_ascii_ws(trimmed) {
            return Err(format!(
                "SQL starts with non-ASCII whitespace {ws}; only ASCII whitespace (tab, LF, VT, FF, CR, space) is trimmed"
            ));
        }
        let lower = trimmed.to_ascii_lowercase();
        if !(lower.starts_with("select") || lower.starts_with("with")) {
            return Err(format!(
                "only SELECT/WITH allowed (read-only contract): {}",
                &trimmed.chars().take(40).collect::<String>()
            ));
        }
        let clean = single_statement(trimmed)
            .ok_or_else(|| "multi-statement SQL rejected (single statement contract)".to_string())?;
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
        // 1.3: a whitelisted pragma source counts its own rows, re-parsed against the closed form (never spliced).
        let is_pragma = table.len() >= 7 && table[..7].eq_ignore_ascii_case("pragma_");
        let pragma = if is_pragma { crate::predicate::parse_pragma_source(table) } else { None };
        let ok = if is_pragma {
            pragma.is_some()
        } else {
            !table.is_empty()
                && table.chars().next().map(|c| c.is_ascii_alphabetic() || c == '_').unwrap_or(false)
                && table.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        };
        if !ok {
            return Err(format!("invalid table name: {table}"));
        }
        let rows = match &pragma {
            Some(p) => self.query(&format!("SELECT count(*) AS n FROM {p}"))?,
            None => self.query(&format!("SELECT count(*) AS n FROM \"{table}\""))?,
        };
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
            // 1.3: keep a whitelisted pragma source whole — `pragma_table_info('orders')` — so its rows can be counted.
            if j > start && lower[start..j].starts_with("pragma_") && bytes.get(j) == Some(&b'(') {
                if let Some(close) = sql[j..].find(')') {
                    let whole = &sql[start..j + close + 1];
                    if crate::predicate::parse_pragma_source(whole).is_some() {
                        let name = whole.to_string();
                        if !out.iter().any(|x| x == &name) {
                            out.push(name);
                        }
                        i = j + close + 1;
                        continue;
                    }
                }
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
