# ygl-trees PostgreSQL 兼容方案

日期：2026-10-15 ｜ 状态：**L1 同步 + L1.5 迁移已交付（0.6.0/0.7.0）；L2 双后端已取消（架构决策：不做双后端同写）** ｜ 关联：[research.md](research.md) · [spec.md](spec.md) · [plan.md](plan.md)

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
