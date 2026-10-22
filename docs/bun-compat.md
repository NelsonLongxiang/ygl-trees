> **2026-10-22 注**：0.114.12 起主库改为 native better-sqlite3（与 ORM 同一驱动），本文记录的
> `node-sqlite3-wasm` VFS/Windows 建库受阻链路已不在当前运行时路径；Bun 兼容需按 native addon 面重评。

# Bun 运行时兼容方案（目标运行时）

日期：2026-10-16 ｜ 复探：2026-10-17 ｜ 状态：**Windows 上受阻（BLOCKED）** ｜ 决策：未来用 Bun 封装 CLI（用户指示 2026-10-16）

## 决策

CLI 未来以 [Bun](https://bun.sh) 作为运行时封装（`bun build --compile` 单文件可执行是远期形态）。当前支持面不变：`engines: node >= 18`。

## 现状：Windows 受阻（bun 1.3.0, win32 x64）

### 根因（0.41 复探后精确化，取代早前描述）

> **早前记录（已过时）**：`fs.openSync(path, O_RDWR|O_CREAT)` 对**不存在的文件**抛 ENOENT。
> **复探结论**：该形态在 1.3.0 下**已不复现**（裸 `openSync` 建文件通过）。真实边界更窄：

**在 bun 进程内创建的目录，其内文件 `fs.openSync(..., O_CREAT)` 抛 ENOENT**——尽管：

| 检查 | bun 结果 |
|---|---|
| `fs.mkdirSync(deep, {recursive:true})` | 正常返回，不抛 |
| `fs.existsSync(deep)` | **true** |
| `fs.statSync(deep).isDirectory()` | **true** |
| `fs.readdirSync(parent)` | 看得到该目录 |
| **bash 视角（另一进程）** | **目录真实存在** |
| `fs.openSync(deep + "/f.db", O_RDWR\|O_CREAT, 0o666)` | **✗ ENOENT** |

反证：目录由**进程外**预先建好时，bun 的开库/写库**全部正常**（探针实测：打开既有库 → 建表 → 写入 → 读回 n=1 ✓）。即
**问题不在 SQLite/WASM，而在 bun 对"本进程新建目录"的 open 解析**。

### 最小复现（可提上游）

```js
const fs = require("node:fs"), path = require("node:path");
const d = path.join(tmp, "a", "b");
fs.mkdirSync(d, { recursive: true });
console.log(fs.existsSync(d));                              // true
fs.openSync(path.join(d, "f.db"), fs.constants.O_RDWR | fs.constants.O_CREAT, 0o666);
// bun 1.3.0 win32 → ENOENT: no such file or directory   （node 24 → 正常）
```

### workaround 空间已穷尽（全部实测失败）

| 尝试 | bun 1.3.0 |
|---|---|
| `mkdirSync` 逐级（非 recursive） | ✗ ENOENT |
| mkdir 后做一次其它 IO（readdir）再开 | ✗ ENOENT |
| 失败后原参数重试 | ✗ ENOENT |
| `realpathSync(dir)` 后再开 | ✗ ENOENT |
| 目录由进程外预建（≠ 单进程 CLI 场景） | ✓ 可用 |

**传导链**：`db.ts` 用 `node-sqlite3-wasm` → Node VFS 的 `_nodejs_open` 调 `fs.openSync` 建/开库文件 → 返回 -1 → `SQLITE_CANTOPEN` →
`db init` 第一步即死（CLI 全命令面不可用）。而 CLI 正常路径必然"先 mkdir `$YGL_HOME` 再开库"，**与 bug 边界正面相撞**。

**完整命令面冒烟**：`bash scripts/bun-smoke.sh` → `pass=1 fail=10`（唯一通过项是裸 fs 探针，恰好绕开了目录边界）。
Linux/macOS 未在本机验证——Windows 是我们的开发机，必须先绿。

**相邻上游问题**（非同因，迁移时留意）：
- [oven-sh/bun#40001](https://github.com/oven-sh/bun/issues/40001) — Windows `node:sqlite` `DatabaseSync.close()` 不 finalize 未跑完的 prepared statement → 文件锁 EBUSY。若未来从 wasm 驱动迁 `bun:sqlite`/`node:sqlite`，此坑在前方。
- [oven-sh/bun#42819](https://github.com/oven-sh/bun/pull/42819) — Windows fs 层（libuv 移除）在重构期，行为面仍会动。

## 解锁条件

bun win32 上「进程内新建目录」后的 `fs.openSync` 恢复正常（或提供可用 workaround）：

```bash
bash scripts/bun-smoke.sh     # 全绿 = 解锁
```

判定脚本已就绪，无需改动；每次复探只需重跑它并对照本节边界。

## 迁移清单（解锁后执行）

1. `scripts/bun-smoke.sh` 全绿（命令面 + fs 探针）
2. TypeORM 读路径验证：`orm.ts` 用 `better-sqlite3` 原生驱动——bun 下 NAPI 加载待验证；不行则评估 TypeORM 其他 sqlite driver 或该路径降级
3. `webui serve`（node:http 服务器 + fetch）在 bun 下验证
4. bin 入口兼容检查：`process.exitCode` 语义、SIGINT/SIGTERM 处理
5. `bun build --compile` 单文件可执行试点（分发形态）
6. `engines`/README 运行时承诺面更新

## 相关

- [docs/pg-compat.md](pg-compat.md) — 同类兼容决策文档先例
- `scripts/bun-smoke.sh` — 探针脚本（不进 pnpm test，当前必红）
- `tmp/bunprobe/{fresh,mode,mkdir,workaround}.js` — 0.41 复探的四个探针（gitignored，重建成本低）
