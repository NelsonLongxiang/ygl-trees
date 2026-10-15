# Bun 运行时兼容方案（目标运行时）

日期：2026-10-16 ｜ 状态：**Windows 上受阻（BLOCKED）** ｜ 决策：未来用 Bun 封装 CLI（用户指示 2026-10-16）

## 决策

CLI 未来以 [Bun](https://bun.sh) 作为运行时封装（`bun build --compile` 单文件可执行是远期形态）。当前支持面不变：`engines: node >= 18`。

## 现状：Windows 受阻（bun 1.3.0, win32 x64）

**根因**：bun 在 Windows 上 `fs.openSync(path, O_RDWR|O_CREAT)` 对不存在的文件抛 `ENOENT`，**不创建文件**。Node 下同代码正常。

**传导链**：`db.ts` 用 `node-sqlite3-wasm`（WASM SQLite，运行时无关）→ 其 Node VFS 的 `_nodejs_open` 调 `fs.openSync` 建/开库文件 → 返回 -1 → `SQLITE_CANTOPEN` → `db init` 第一步即死（CLI 全命令面不可用）。

**证据**（本机 2026-10-16 实测，探针脚本 `tmp/bun-probe/fs-probe.cjs`）：

| 探针 | bun 1.3.0 (win32) | node 24 |
|---|---|---|
| `fs.openSync` 新文件 + O_CREAT | ✗ ENOENT | ✓ 创建 |
| `fs.openSync` 数值 mode (420) | ✗ ENOENT | ✓ |
| wasm 驱动绝对路径开库 | ✗ CANTOPEN | ✓ sqlite 3.53.4 |
| wasm 驱动相对路径开库 | ✗ CANTOPEN | ✓ |
| mkdir/rmdir 锁目录、randomFillSync、path.resolve | ✓ | ✓ |

完整命令面冒烟：`bash scripts/bun-smoke.sh`（10 项全红，第一项就是 fs 探针）。Linux/macOS 未在本机验证——Windows 是我们的开发机，必须先绿。

**相邻上游问题**（非同因，迁移时留意）：
- [oven-sh/bun#40001](https://github.com/oven-sh/bun/issues/40001) — Windows `node:sqlite` `DatabaseSync.close()` 不 finalize 未跑完的 prepared statement → 文件锁 EBUSY。若未来从 wasm 驱动迁 `bun:sqlite`/`node:sqlite`，此坑在前方。
- [oven-sh/bun#42819](https://github.com/oven-sh/bun/pull/42819) — Windows fs 层（libuv 移除）在重构期，行为面仍会动。

## 解锁条件

bun win32 的 `fs.openSync + O_CREAT` 行为修复后：`bash scripts/bun-smoke.sh` 全绿 = 解锁。

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
