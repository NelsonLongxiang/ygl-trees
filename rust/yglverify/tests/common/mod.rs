//! 集成测试共用的临时目录：离开作用域（含 panic 展开）即整个删掉。
//! #227：验证器一天重跑多轮 `cargo test`，测完不删的目录会堆进系统临时目录。

use std::fs;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct TempDir(PathBuf);

impl TempDir {
    /// 在系统临时目录下新建 `<prefix>-<tag>-<pid>-<nanos>`。
    pub fn new(prefix: &str, tag: &str) -> Self {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("{prefix}-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).expect("temp dir");
        TempDir(dir)
    }
}

impl Deref for TempDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
