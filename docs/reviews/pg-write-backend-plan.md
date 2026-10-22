---
name: pg-write-backend-plan
description: 允许单一 PostgreSQL 作为工作区唯一写库、SQLite 降为可选——对 pg-compat.md §5「L2 取消」的重新立项评审：现状、边界、依赖面量化、风险与分期日程
kind: 评审
---

# 单一 PG 写库：现状评审与日程（方案）

> 评审席 Claude-OPS-5.5 · 2026-10-22 · 基线：ygl-trees `5919127`（npm 0.114.6）。
> 依据：用户 2026-10-22 指示「允许单一 pg 数据库写入，可以提上日程了，sqlite 不再是唯一选择，而是可选」。
> 本文重新立项 [pg-compat.md](../pg-compat.md) §5 已取消的 L2。本文只做现状判定与日程建议，不改代码；结论须属主裁定。

## 0. 结论

1. **边界：每个工作区恰好一个写库，二选一，永不双写。** SQLite 仍是默认值（零服务、零配置），PG 是可选的唯一写库。这与 2026-10-15 的「不做双后端同写」裁定**不冲突**：被否决的是同时写两个库，本方案不做。被取代的只是「SQLite 是唯一选择」这一条（pg-compat.md §5、AGENTS.md「SQLite 唯一事实源」）。
2. **当年取消 L2 的主导理由已大半消失。** 0.7.0 判的是「Store 全栈同步 vs pg 驱动纯异步的阻抗失配」。此后的进展：
   - 0.10.0–0.12.0 已把全部写命令迁到 TypeORM 异步事务服务（`writes.ts` / `treeWrites.ts`）；
   - 0.89.0 铺好了 PG-A 地基：`getPgOrm` 方言接缝、FTS5 影子表方言门控、`schema_migrations(backend,version)` 双端账表、PG 原生单调的 `events.seq`。

   剩下的主要成本在**读路径**：约 195 处同步裸 SQL，见 §2。
3. **verify 引擎不迁 PG。** 判定只在冻结的 SQLite 快照上跑（`snapshotCopy` 只认 SQLite 文件，报告 `data_source.sha256` 绑快照字节），这是 charter P5 证据链的基础。PG 工作区要验证时，先导出一份 SQLite 快照，再 `verify run`。验证器契约零改动。
4. **分 7 期**（§5）：
   - PG-B0 裁定与契约；
   - B1 读路径异步化，最大的一期；
   - B2 schema 单一权威；
   - B3 检索；
   - B4 并发语义；
   - B5 运维面；
   - B6 门禁矩阵。

   B0 之后，B2 / B3 / B4 可以和 B1 并行。

## 1. 输入与方法

- 读了 `docs/pg-compat.md`（L1/L1.5 已交付、L2 取消的依据）、`docs/conventions.md` §五（TypeORM 边界、写路径裁决）、`plan.md` 0.7.0 / 0.8.0 / 0.10.0 / 0.12.0 执行记录、0.89.0 PG-A CHANGELOG。
- 在 `5919127` 源码上逐项计数（非测试代码；命令可复跑：`grep -rn --include='*.ts' <模式> packages apps | grep -v spec`）。
- 未连真实 PG 实测：本文是 L0 方案层。各期验收都要求 docker `postgres:16` 实测，沿用 pg-compat.md §3 的测试容器。

## 2. 现状评审

### 2.1 已就绪（不需要重做）

| 面 | 现状 | 来源 |
|---|---|---|
| 写路径 | 全部写命令经 TypeORM 异步事务服务：幂等 hash、基表写入、FTS 双写、events 同一事务 | 0.10.0–0.12.0 |
| 方言接缝 | `getPgOrm(url)` 与 `getOrm(file)` 共用同一实体注册表；`ormDialect()` 判方言 | 0.89.0 ① |
| FTS 写门控 | 7 处 `*_fts` 影子表写入收进 `ftsShadow()`：SQLite 执行、PG 跳过 | 0.89.0 ② |
| 迁移账 | `schema_migrations(backend, version)` 双端账表 | 0.89.0 ③ |
| 事件序 | `events.seq`：PG 侧 `nextval` 单调 | 0.89.0 ④ |
| PG 表结构 | `MIGRATE_DDL` 手写全约束（FK / UNIQUE / 索引）+ 列集漂移守卫；检索列 ngram + tsvector('simple') + GIN | 0.7.0、0.12.1 |
| 表集合一致 | SQLite `SCHEMA_SQL` 与 `MIGRATE_DDL` 的表集合逐一相同（本次核对） | — |
| 会话级选择 | 当前项目 / 树按会话分键 `current_project@<sid>` | selection.ts |

**[E] 一个现状事实：`getPgOrm` 在生产代码里没有任何调用方。** 接缝铺好了，但从 0.89 起一直闲置，PG 写路径从未被端到端跑过。

### 2.2 未就绪（本方案的工作量所在）

| # | 依赖面 | 数量（非测试） | 主要位置 | PG 对应 | 代价 |
|---|---|---|---|---|---|
| 1 | **同步裸 SQL 读**（DB 类 `.all/.get/.run`） | ≈195 处 | techtree `reads.ts` 47、research `cmds.ts` 38 / `reads.ts` 35、`doctor.ts` 22、`db-cmds.ts` 21、`webui.ts` 20、`agent-cmds.ts` 14、`rels.ts` 13 | 异步化：迁 ORM，或用方言中立的异步查询助手（占位符 `?`→`$n`） | **L** |
| 2 | 裸 SQL 写（例外清单） | 19 处 | `project use` / `tree use` 的 metaSet、`node validate` 的 buildIndex、produce export 事件 | 迁入写服务，或改由 DB 抽象路由 | S |
| 3 | `PRAGMA` / `user_version` / `sqlite_master` | 26 / 13 / 10 | db.ts 迁移轨、db-cmds export、doctor | PG 走 `schema_migrations` + `information_schema` | M |
| 4 | FTS5 `MATCH` / `bm25()` 查询 | 5 / 2 | `fts()` 助手、`nodeSearch`、skill match | `ngram_tsv @@ to_tsquery('simple', …)`；hits 计数与排序仍在 JS，语义不变 | M |
| 5 | `rowid` | 24 | events 排序、迁移回填等 | 改 `seq` / 主键 | S |
| 6 | `LIKE` | 32（仅 2 处显式大小写处理） | 检索兜底、筛选 | **语义差**：SQLite 的 LIKE 对 ASCII 不区分大小写，PG 区分。逐处决定 `ILIKE` 还是 `lower()` | M |
| 7 | `INSERT OR IGNORE / REPLACE`、`datetime(` | 3 / 4 | — | `ON CONFLICT DO NOTHING / UPDATE`、`now()` | S |
| 8 | 调度锁 | 1 | `job tick`：`$YGL_HOME/tick.lock` mkdir 锁 | 多机共用一个 PG 时文件锁无效 → `pg_try_advisory_lock()` | S |
| 9 | 双 DDL 权威 | 30 表 | `SCHEMA_SQL` + `MIGRATE_DDL` 两份手写 + 守卫 | 单一来源生成两种方言，或把守卫升为双向 CI 门禁 | M |

**结论：** 方言差都是 S / M 级的机械活。真正的 L 级工作是第 1 项读路径异步化，而它有 0.10–0.12 写路径迁移的现成打法：逐域推进、黄金对账、输出契约逐字不变。

## 3. 边界（建议条文，待裁定）

1. **单写库**：工作区绑定一个后端（`YGL_DB_URL=postgres://…`，或 `db init --backend pg`），绑定记录写进库本身。绑定 PG 的工作区遇到 SQLite 写入一律拒绝（rc=1 点名），反之亦然。永不双写，也没有「双写期」。
2. **SQLite 仍是默认**：不设任何变量时行为与今天逐字节一致，`pg` 仍是 optionalDependencies。
3. **切换只走显式命令**：
   - SQLite → PG：现有 `db migrate pg`（一次性毕业）。迁移后把源 SQLite 标记为只读归档，防止误写回。
   - PG → SQLite：`db export` 到 SQLite 文件，可携带、可离线。
4. **验证面不变**：verify 只读 SQLite 快照。PG 工作区新增 `db snapshot <out.sqlite> [--as-of]`，产出快照文件 + sha256 + 来源（url 脱敏、server 版本、取数时间），再 `verify run --db <out.sqlite>`。检查器永不直连活 PG：活库上的判定不可重放，违背 charter P5。
5. **凭证**：只经 `YGL_DB_URL` / `YGL_PG_URL` 环境变量，不进 argv、日志、events、报告、归档。快照来源里的 url 去掉凭证。

## 4. 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| 读路径异步化传染面大（命令层、webui、agent brief） | 高 | 按域分批（同 0.10–0.12）；每批黄金对账 + demo / contract-audit 不变；先迁读最多的 techtree / research |
| **后端行为漂移**：LIKE 大小写、NULL 排序、整数除法、时间文本格式、空串与 NULL | 高 | B6 双后端矩阵：同一 demo / contract-audit / 黄金输出在两个后端上逐字节比对；发现差异先登记再统一口径 |
| **并发幂等竞态**：SQLite 串行写掩盖了「先查后插」窗口；PG 多写者下同内容并发写可能撞唯一约束 | 中 | 写服务统一为 `INSERT … ON CONFLICT (content_hash) DO NOTHING RETURNING` + 回查；补并发写测试（N 进程同内容） |
| 会话选择退回全局键：无会话 id 的写者互相覆盖当前项目（2026-10-21 已有一次他席 FAIL 实例） | 中 | PG 模式下要求会话 id，或把全局选择改为只读默认值 |
| 中文检索召回 / 排序与 SQLite 不等价 | 中 | ngram 写入时分词，已在 sync / migrate 实测等价；B3 用黄金查询集（含斜杠复合 token 一类，0.12.1 先例）双后端比对 |
| 依赖面：better-sqlite3（原生）+ node-sqlite3-wasm + pg 三个驱动 | 低 | 维持现状；PG 只在绑定时加载 |
| 评审验证器与舰队：评审验证器探针直接用 `DatabaseSync` 读工作区 SQLite（台账叶子） | 低 | 改走 `research … --json` CLI 读（charter P1 本就要求），在 B1 期内完成，与后端无关 |

## 5. 分期日程

| 期 | 内容 | 验收（docker postgres:16 + SQLite 双跑） | 依赖 |
|---|---|---|---|
| **PG-B0 裁定与契约** | 属主裁定 §3 五条；pg-compat.md §5、AGENTS.md「SQLite 唯一事实源」改为「默认 SQLite、可选单一 PG」；定工作区绑定记录格式与 `YGL_DB_URL` 语义 | 文档 PR 合入；charter 是否另加一条由持闸席定 | — |
| **PG-B1 读路径异步化** | ≈195 处同步读按域迁 ORM 或异步查询助手：techtree → research → ops（doctor / agent / rels / webui）→ db-cmds；SQLite 路径行为不变 | 每批：unit / demo / contract-audit / readme-verify 全绿；输出逐字节不变（黄金）；`getPgOrm` 首次被生产代码调用 | B0 |
| **PG-B2 schema 单一权威** | `SCHEMA_SQL` 与 `MIGRATE_DDL` 合为单一来源，两种方言由生成器产出，或升级守卫为双向 CI 门禁；PG 走 `schema_migrations` 升级轨 | 新增一列只改一处；PG 侧从 v1 升到当前版的回放测试 | B0（可与 B1 并行） |
| **PG-B3 检索** | `fts()` / `nodeSearch` / skill match 增 PG 分支（tsvector 谓词），hits 排序共用 JS | 黄金查询集（中英文、复合 token）双后端 top-k 一致 | B0（可并行） |
| **PG-B4 并发语义** | 写服务统一 `ON CONFLICT … RETURNING`；`job tick` 改 advisory lock；会话选择规则；事务隔离级别定为 READ COMMITTED 并成文 | N 进程同内容并发写：只有一行、其余 `duplicate:true`、rc=0；两台机器同时 tick 只有一个执行 | B1 的写服务部分 |
| **PG-B5 运维面** | `db init --backend pg`、`db stats` / `doctor` / `export` / `import` / `snapshot`；`webui serve` 读 PG；源 SQLite 只读归档标记；凭证脱敏审计 | `db snapshot` 产物经 `verify run` + `archive verify` 全链 PASS；argv / events / 报告 / 归档 grep 不到凭证 | B1、B3 |
| **PG-B6 门禁矩阵** | CI 双后端矩阵：unit + demo + contract-audit + readme-verify 都跑 SQLite 与 PG；bench 加 PG 列；ratchet 只管 SQLite（默认路径） | 两个后端全绿才能发版；行为漂移清单为空，或每条已登记 | B1–B5 |

B0 之后，B2、B3 可以和 B1 并行，改动面基本不重叠：B2 在 db.ts / pgsync.ts，B3 在检索助手，B1 在各域读层。B4 要等 B1 的写服务部分。B5、B6 收尾。

## 6. 需要裁定的事项（属主）

| # | 事项 | 本席建议 |
|---|---|---|
| D1 | 是否正式取代 2026-10-15「SQLite 唯一事实源」裁定（保留「不双写」） | 是。用户 2026-10-22 指示即是方向，需写入 pg-compat.md 与 AGENTS.md |
| D2 | 工作区绑定方式：环境变量、`db init --backend`，还是两者兼有 | 两者兼有，绑定记录以库内为准；不一致时拒绝 |
| D3 | 读路径异步化的方式：全部迁 ORM，还是保留一个方言中立的异步裸 SQL 助手 | 后者为主（检索、统计等复杂 SQL 不适合 ORM），ORM 用于实体读 |
| D4 | PG 工作区是否要求会话 id | 要求（多写者下全局选择会互相覆盖） |
| D5 | 本方案的实现由谁承担（单独会话、上游开发席，还是 fork PR） | 由属主安排；评审席只复核、登记 |

## 7. 评审席的复核方式

- 每期交付后，从已发布的 npm 包复跑该期验收，在 docker `postgres:16` 与 SQLite 上各一遍，结果进对应 issue 与台账。
- 重点盯：①后端行为漂移（同一输入两个后端输出逐字节比对）；②并发幂等；③凭证零泄漏；④verify 只认快照、快照来源可审计。
- 评审验证器在 B1 期内把台账探针从直读 SQLite 改为 CLI 读，与后端无关，属自身编排的改动，不改判据。
