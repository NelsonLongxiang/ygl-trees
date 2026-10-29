# ygl-trees PostgreSQL 兼容方案

日期：2026-10-15 ｜ 状态：**L1 同步 + L1.5 迁移已交付（0.6.0/0.7.0）；L2 双后端 2026-10-15 取消；2026-10-25 属主重新立项单写后端（D1=是，SQLite 默认/PG 可选，永不双写）** ｜ 关联：[research.md](research.md) · [spec.md](spec.md) · [plan.md](plan.md)

## 0. 决策上下文

项目身份是"单一 SQLite 文件就是全部状态、零运行时依赖"。PG 兼容有三种层级，代价差一个数量级。本文档是 L0（方案层）：盘点真实依赖面、给出分层路线与设计，**不动代码**；批准后按 L1 → L2 逐层实施。

| 层级 | 内容 | 工作量 | 零依赖哲学 |
|---|---|---|---|
| **L1 同步目标** | SQLite 仍是唯一事实源；新增 `db sync pg <url>` 单向全量镜像，供 SQL 工具/团队分析 | M（一会话） | 保持（pg 驱动为可选依赖，按需引入） |
| **L2 双后端** | `--db pg://…` 可作为唯一事实源；FTS/迁移/内省/锁全部双轨 | L（多会话） | 放弃（用 pg:// 时 pg 驱动必选） |
| L3 双向同步/多主 | — | 不做（明确非目标） | — |

## 1. 目标与非目标

**目标**：让 ygl-trees 的数据能被 PG 生态消费（L1），并在需要协作/集中管理时能整体切换到 PG 而不丢失任何现有命令语义（L2）。

**非目标**：不改默认体验（无 PG 时一切如旧）；不做双向同步；不引入 ORM（保持手写 SQL + 薄适配层）；不追求 SQLite 与 PG 逐字节一致的 dump。

## 2. SQLite 依赖面盘点（全部触点，含代码位置）

| # | 触点 | 位置 | 现状 | PG 对应 | 代价 |
|---|---|---|---|---|---|
| 1 | FTS5 虚表 ×5（skills/sources/evidence/kb/nodes_fts） | db.ts SCHEMA_SQL | 写入路径维护影子表 | **不迁移结构**：ngram 已是预分词文本列，PG 侧用 `tsvector` 生成列 + GIN 索引（`to_tsvector('simple', ngram)`） | S |
| 2 | `MATCH` + `bm25()` 逐 token 循环 | store.ts fts()、tree.ts nodeSearch | 逐 token OR + hits 计数排序，LIKE 兜底 | 同算法换谓词：`ngram_tsv @@ to_tsquery('simple', $t)`；hits 计数仍在 JS 聚合，**排序语义完全保留** | M |
| 3 | `PRAGMA user_version` 迁移版本 | db.ts migrate() | 整数版本号触发升级 | `schema_migrations(version, applied_at)` 表 | S |
| 4 | `PRAGMA table_info` 列存在检查 | db.ts upgrade2to3 | ALTER 前探测 | `information_schema.columns` | S |
| 5 | `sqlite_master` DDL 提取 | cmds/db.ts export、db.ts tablesPreExist | dump 自带建表语句 | `pg_catalog`/`information_schema`；L2 下 dump 改为方言中立 INSERT 格式（两边一致） | M |
| 6 | `INSERT OR REPLACE`（dump） | cmds/db.ts | 重放幂等 | `ON CONFLICT DO UPDATE`（PG 语法） | S |
| 7 | `rowid` ×2 | events 排序（store.ts:28）、迁移回填（db.ts:386） | 隐式行号 | events 加显式 `seq INTEGER GENERATED ALWAYS AS IDENTITY`（排序改 seq）；回填改 PK 定位 | S |
| 8 | `PRAGMA journal_mode=WAL` / `foreign_keys` | db.ts 构造器 | 每次打开设置 | no-op（PG 服务端自管；FK 声明即可） | S |
| 9 | WASM VFS mkdir 锁（tick.lock、`<db>.lock`） | job.ts、cli.ts | 进程互斥 | L2 用 `pg_try_advisory_lock()`；并发本身由 MVCC 解决 | S |
| 10 | 类型 | 全部 schema | TEXT/INTEGER/REAL | text/integer/double precision，**逐一同形**（布尔语义保持 integer 不转 boolean，避免翻译层） | S |
| 11 | 驱动 | package.json | node-sqlite3-wasm（唯一依赖） | `pg`（node-postgres）作 optionalDependencies + 动态 require，缺失时给出安装提示 | S |
| 12 | 多语句 exec | db.ts exec（SCHEMA_SQL 整段） | sqlite3_exec 天然支持 | node-postgres 简单查询协议同样支持多语句（无参数占位时） | S |
| 13 | `--db <file>` 参数 | cli.ts | 文件路径 | 前缀 `pg://`/`postgres://` 时切 PgBackend | S |

**关键结论**：最硬的 CJK 检索问题已被现有架构化解——ngram 列在**写入时**完成分词，PG 侧用 `simple` 词典的 tsvector 即可获得等价召回，**不依赖 zhparser/pg_jieba 等中文扩展**（多数托管 PG 装不了）。排序语义（hits 优先）由查询算法而非数据库特性决定，跨方言可复用。

## 3. L1 设计与实现：`db sync pg <url>`（已交付，0.6.0）

```
ygl-trees db sync pg <url> [--tables a,b] [--json]
  url 也可来自环境变量 YGL_PG_URL（避免凭证进 shell 历史）
```

**实现与原设计的两处偏差（更优）**：

- **镜像 DDL 不再手写**，改为运行时由 `PRAGMA table_info` 驱动生成（类型映射 + PK），源 schema 演进自动跟随——原方案"双 DDL 漂移"风险在 L1 层面直接消失。镜像表仅保留 PK，不带 FK/UNIQUE（约束活在事实源 SQLite 侧，镜像是分析面）
- **中文检索**：5 张可检索基表（skills/sources/evidence/kb_notes/nodes）在镜像侧用**同一份 ngram 分词器**（text.ts）重算 ngram 列 + `tsvector GENERATED ... ('simple')` + GIN 索引（PG ≥ 12；更低版本退化为 ngram-only 列表，LIKE 可查）

**同步算法**：全量刷新——逐表 DELETE（子表先）+ 批量 INSERT 500/批（父表先），事务内；FTS 虚表不同步。幂等，重复执行结果一致。

**实测验收（docker postgres:16-alpine @ 127.0.0.1:15432）**：

- demo 库 23 表同步成功；`db stats`（已补齐树表口径）与 PG `count(*)` 逐表严格一致（18 张统计表全对齐）
- 中文检索等价：SQLite `kb search "科技树"` 与 PG `ngram_tsv @@ to_tsquery('simple','科技')` 命中同一行；英文 token 同验
- 幂等重跑 ✓、`--tables` 白名单 + 未知表 rc=1 ✓、坏 URL rc=1 ✓、`--json` 纯净 ✓
- `pg` 为 optionalDependencies（8.23.1），无 PG 场景零影响；驱动缺失时给出安装提示

**测试容器**（本机已建，可复用）：`docker run -d --name ygl-pg-test -e POSTGRES_USER=ygl -e POSTGRES_PASSWORD=ygl -e POSTGRES_DB=ygltest -p 15432:5432 postgres:16-alpine`，连接串 `postgres://ygl:ygl@127.0.0.1:15432/ygltest`。

## 4. L1.5：`db migrate pg <url>`（已交付，0.7.0）

**与 sync 的分工**：sync 是可刷新的 PK-only 镜像（SQLite 始终是事实源）；migrate 是**一次性完整保真毕业**——目标库自带全部 FK / UNIQUE / 索引约束，是自描述、可独立持有的 PG 数据库，迁移完成后 ygl-trees 不再写它（无双后端同写）。

- **原子性**：DDL + 数据 + 逐表计数校验在**单事务**内，任何一步失败整体回滚
- **安全门**：目标非空（我们的表里有数据）默认拒绝并提示 `--fresh`（drop 重建）或改用 `db sync pg`
- **防漂移守卫**：手写全量 DDL 与源库 `PRAGMA table_info` 列集逐一比对，不一致即中止——手写 DDL 腐化在迁移期暴露而不是静默错库
- **检索就绪**：5 张可检索基表同样带 ngram + tsvector('simple') + GIN
- **实测**（docker postgres:16）：demo 库 24 表迁移，FK 25 / UNIQUE 60 约束落库且**活体验证**（插入重复 content_hash → 23505；孤儿 FK → 23503）；20 张统计表计数严格对齐；中文 tsv 检索命中与 SQLite 一致

## 5. L2 双后端：已取消（2026-10-15 决策）

原方案的 L2（`--db pg://` 作唯一事实源）取消，两个独立理由：

1. **架构决策（用户裁定）**：避免双后端同写。单事实源 + 单向导出（sync/migrate）覆盖了全部实际场景，双写只会引入分裂脑与一致性税
2. **技术发现（成本再评估）**：Store/TreeStore 全栈同步架构 vs pg 驱动纯异步。实现 PG 写后端要么全栈 async 化（60+ 方法、所有命令层），要么 worker+Atomics 同步桥（脆弱）。原方案文档低估了这层阻抗失配——它才是 L2 的主导成本，比方言分叉大得多

后续若真出现"必须以 PG 为唯一事实源"的场景，应作为**独立工具**重新立项（复用本项目的 schema 设计与 ngram 检索策略），而不是给 ygl-trees 加第二写入面。

## 6. 风险表（更新后）

| 风险 | 等级 | 缓解 |
|---|---|---|
| 生成列 STORED 在旧 PG（<12）不可用 | 低 | 运行时探测 server_version_num，旧版自动降级为 ngram-only（LIKE 仍可查） |
| tsvector 与 ngram 的召回差异（simple 词典停用词） | 中 | simple 词典基本不停用 CJK bigram；实测中英文 token 命中一致；如现差异可改手工 tsvector 拼接 |
| 全量同步/迁移在数据增长后变慢 | 低 | 已预留增量方案（updated 游标）；量级触发再实施 |
| 手写 MIGRATE_DDL 与源 schema 漂移 | 中 | 迁移期列集守卫强制中止（已实测拦截路径存在）；每次 schema 版本变更须跑一次迁移验证 |
| optionalDependencies 在 pnpm install 默认装上 pg | 低 | 接受（体积小、无传递依赖） |

## 7. 建议与下一步

1. ~~批准 L1~~（已交付）——sync（可刷新镜像）与 migrate（一次性毕业）覆盖单向导出全部场景
2. 定时镜像一行即达：`job add pg-mirror -- "ygl-trees db sync pg \$YGL_PG_URL" --every 60`（tick 锁已防双跑）
3. L2 已取消（§5）；若未来需要"PG 为唯一事实源"，作为独立工具重新立项

## B8 单一 PG 业务后端

业务入口使用 `YGL_DB_URL`，目标须已用官方 `db migrate pg` 显式迁移；`YGL_PG_URL` 是 `db sync pg` / `db migrate pg` 的出口 URL，不会启用 PG 业务模式，也不自动作为 `YGL_DB_URL` 别名。凭证由用户配置环境变量，不放 `--db` 或命令历史。使用独立 `YGL_HOME`；存在 SQLite 文件或已有 PG 绑定目标不一致时拒绝并点名本地冲突文件，不回落、不双写。`db init` 仅用于 SQLite；设置 PG `YGL_DB_URL` 时在工作区写入前 rc2 拒绝，不支持 `--backend pg`（或任何 `--backend`），未知 init 参数也拒绝。PG 需从独立 SQLite 源工作区执行显式 `db migrate pg`，再选中迁移后的 PG 目标；本修复不实现 PG init，不改写或删除已有文件。

可用面：`kb add/list/show`、`project new/use/list/show`、`research source/evidence/claim add/list/show`（包括各类型已支持的 file/batch 入口）。批量全部行先校验、单事务写入，中段失败整批回滚；`source add --query` 对既有 query 的挂接同 PG 事务。批3补充 `research query add/attach/list`、`claim link/unlink/resolve/unresolve`、`source/evidence rm` 和 `kb link/import`。其他未列命令（含 query done、eval、fetch、新搜索、project archive/restore/rm/global、其他域、verify-on-PG）仍拒绝。

项目解析只读优先级：显式 `-p/--project` → `YGL_PROJECT` → 当前 session 选择 → 唯一项目；多项目无选择 rc2，指定不存在项目 rc1。不会读取全局最近项目作 fallback。读命令不写选择或文件；`project use` 仅更新本 session 并发事件，返回替换前 prior，archived 拒选，`--global` 拒绝。

检索范围以官方迁移为准：sources/evidence 有 ngram + GENERATED ALWAYS ngram_tsv + GIN，输入与基表/events 同事务。claims 原来在两个后端都没有全文检索，只提供基表/events/list/show；不声称检索 PASS、不新加检索 schema。doctor 的 claims_fulltext 与 verify_on_pg 明确 skip 并给原因；verify 仍走 SQLite 快照链。

### 研究闭环状态与删除边界

claim 状态复用完整 SQLite 规则：预测挂证不自动结算；人工仲裁锁保留 status/updated；unlink 返回 recalculated；unresolve 事件保留。既有边界也镜像：resolve 为 unverified 后再 unresolve 返回 duplicate 且不发解除事件，后续挂证仍受人工锁约束。命令可用不构成授权 agent 仲裁现库断言或结算预测。单条 link 可跨项目（workspace-wide，并给 cross_project 提示），unlink/resolve/unresolve/删除各按原项目边界，不统一收窄。duplicate 表示关系已存在，不保证 stance 改写为 no-op。

PG 关系变更先持有 evidence 读锁，再持有 claim 写锁至事务提交。删除先封锁 source/evidence，受影响 claims 按稳定 id 排序取锁，再做精确删除锥、检索清理、状态重算和事件；默认保护不变。kb import 先排序/预检/解析文件，再整批单事务；>1MB 默认跳过、force 允许尺寸但不取消内容去重。

事件同 ts 使用 PG 单调 seq，而非 rowid。官方迁移历史事件 seq 可能 NULL；若最大 ts 仲裁组有无法确定总序的 NULL/重复 seq，明确报“历史仲裁事件顺序不可确定”并回滚，不猜随机 id、不自动补 seq。单条历史事件无序歧义；原生有序事件正常。

实际命令所需缺列会在写入前以表名.列名提示，SQL/凭据/参数不回显；不自动 ALTER 或扩大迁移。旧 PG 镜像不是升级后的业务库，先备份并核对能力；**不可用 --fresh 覆盖现库当升级**。

`query attach --json` 在 SQLite 与 PG 均返回单对象 `{query, source}`，重复附加 `duplicate:true`，保持 rc0；不带 --json 的人类文本不变。#114 修复的两条 SQLite 成功/重复输出是明确的黄金变更：旧基线人类文本保留作精确对照，新输出单独断言为完整 JSON，其余命令不做字段归一化。

## B4 并发语义（2026-10-25 成文）

| 面 | 规则 |
|---|---|
| 事务隔离级别 | **READ COMMITTED**（SQLite 默认行为等价；PG 显式声明）——不声称可串行化，跨事务读写以「写服务事务内幂等判定」为准 |
| 幂等写 | `INSERT ... ON CONFLICT(...) DO NOTHING RETURNING *`（`packages/core/database/src/upsert.ts`）——判重+写入单条原子语句；RETURNING 有行=本次创建，无行=已存在（duplicate:true）。双端同 SQL（差异仅占位符） |
| job tick 单执行 | PG：`pg_try_advisory_lock(hashtext('ygl:job-tick'))` 会话级非阻塞锁（`advisory-lock.ts`）；SQLite：单机文件写锁串行化，无跨机面 |
| 会话选择 | PG 业务命令必须带 `YGL_SESSION` 或 `DSH_SESSION_ID`；缺失即 rc2，不落全局键。`project use` 仅更新 `current_project@<session>` 并返回 prior；`--global` 明确拒绝 |
| 并发验收 | N 进程同内容并发写 → 恰好一行 + 其余 duplicate:true rc0（`b4-upsert.spec` 8 进程实证）；双机 tick → 只有一个执行（advisory lock，B6 真库矩阵验证） |
