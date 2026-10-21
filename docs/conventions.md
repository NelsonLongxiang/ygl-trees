# ygl-trees 数据模型应用规范

日期：2026-10-15 ｜ 适用：≥0.9.0 ｜ 关联：[plan.md](plan.md) · [pg-compat.md](pg-compat.md)

本规范回答两件事：**怎么加一张表/一列不出事**，以及**哪些代码走 TypeORM、哪些保持裸 SQL**。两条历史事故是它的立法依据：`query_sources` 漏出备份/镜像/统计（0.7.0 修），`skill refs add` 缺唯一索引自 v1 起一用即错（0.7.0 修）。

## 一、加表九触点清单（缺一即事故）

新增一张表时，以下每一处都必须过一遍。以 `query_sources`（v4）为参照样例：

| # | 触点 | 文件 | 说明 |
|---|---|---|---|
| 1 | SCHEMA_SQL | src/db.ts | 建表 + 索引；FK 全部 `ON DELETE CASCADE`；命名 snake_case |
| 2 | 可检索？ | src/db.ts + src/store.ts | 若需全文检索：建 FTS5 虚表 + 写路径同步 ngram（见 §三） |
| 3 | 幂等？ | src/db.ts + src/store.ts | 若写命令可重复执行：content_hash 列 + 唯一索引 + store 判重 + `--force`（见 §二） |
| 4 | Store 方法 | src/store.ts | **唯一写入面**。裸 SQL、参数化、事件留痕（`this.log`） |
| 5 | db export dataTables | src/cmds/db.ts | 漏了 = 备份静默丢数据（`query_sources` 事故） |
| 6 | MIRROR_TABLES | src/pgsync.ts | 漏了 = PG 镜像丢数据；可检索表还要加 NGRAM_INPUT 映射 |
| 7 | stats() | src/store.ts | `db stats` / `agent brief` 的口径；漏了 = 计数审计失真 |
| 8 | MIGRATE_DDL | src/pgsync.ts | 手写全保真 DDL（FK/UNIQUE/索引）；**漂移守卫**会在迁移期拦截漏改，但别依赖它兜底 |
| 9 | TypeORM 实体 | src/entities/research.ts | schema v5 的类型化快照，**与 SCHEMA_SQL 同 commit 改**；`synchronize` 永久 false |
| ✓ | 验收面 | examples/demo.sh | 新行为要有断言；跨库操作加计数审计（对照 `db stats --json`） |

## 二、幂等判重决策树

```
写命令会被 Agent 重试吗？
├─ 否（如 events 审计流）→ 直接裸插
└─ 是 → 判重键是什么？
   ├─ 有天然业务键（source 的 url）→ UNIQUE(project_id, url_hash)，应用层查后插
   ├─ 内容即身份（claim/query/evidence/kb）→ content_hash 列 + 唯一索引；
   │     store 先查 hash 命中即返回 {row, dup:true}；命令层打 "! duplicate"，rc=0
   │     --force = hash 加随机盐显式保留重复；可查（db dups）
   └─ 标题即身份（job）→ 应用层按 title 判重（存量撞名建不了唯一索引）；
         --force = title 加序号后缀
```

铁律：重复不是错误（rc=0 + duplicate 标记）；`--json` 下 stdout 必须是**单个 JSON 对象**（`writeResult`/`ack` 助手保证）。

## 三、FTS 同步纪律

1. 每个 FTS5 虚表对应一个**基表**；写入路径必须双写（基表 + 虚表），删除路径双删（`sourceDel`/`skillDel` 是样例）
2. ngram 输入函数**唯一来源**：store/tree 写入用一份，`pgsync.NGRAM_INPUT` 用同一份口径——改一边必须改另一边，否则 PG 侧召回漂移
3. 查询侧：逐 token MATCH + JS 端 hits 计数排序（`fts()` 助手），LIKE 兜底——**不进 TypeORM**（ORM 无 FTS5 概念）
4. 镜像/迁移侧：PG 用 `to_tsvector('simple', ngram)` 生成列 + GIN，**禁止依赖 zhparser 等中文扩展**

## 四、迁移模板（user_version 轨道）

1. `SCHEMA_VERSION` +1；新 DDL 全部 `IF NOT EXISTS` 追加进 SCHEMA_SQL（对老库幂等）
2. 需要改存量数据时写升级函数（参照 `upgrade2to3`：先探测列存在 → 事务内 ALTER + 回填 + 加索引；重复行**加盐保命**，绝不静默合并）
3. **dump 重放陷阱**：`user_version=0` 不等于空库——迁移判定必须叠加 `sqlite_master` 表存在检查（`tablesPreExist`）
4. 老 schema 的 dump 重放是验收必测项（`db export` → 删库 → 重放 → `db stats` 对账）

## 五、TypeORM 边界（0.8.0 起；写路径裁决 0.10.0）

| 走 TypeORM | 保持裸 SQL（DB 类） |
|---|---|
| **读命令**：`project show`、`research query/source/evidence/claim list`（异步命令 + relations 取派生计数） | FTS5 检索（source/kb/node search、skill match）——ORM 无 FTS5 概念 |
| **写命令**（0.10.0 起）：research 组 add/link/resolve/attach、source add/fetch、kb add/ingest、job add —— 全部经 **src/writes.ts 事务化写服务**：幂等判定 + 基表写入 + FTS 双写 + events 留痕在**同一个 ds.transaction** 内（Store 时代是分离语句，FTS 失败会留孤儿行——事务关闭了该缺陷） | PRAGMA、schema 迁移（user_version 轨道） |
| | PG sync/migrate（pgclient 直连） |
| | Store/TreeStore 的**读方法**与未迁移写方法（produce、skill、tree 域）——渐进迁移中 |

**async 裁决（2026-10-15）**：否决"全栈异步一步到位"——main() 已支持异步命令，传染面收敛在命令层 await + 写服务层，无需改造 Store 读方法。写命令统一经 `runWrite` 助手（6 行/命令），返回**显式 snake_case 映射对象**（输出契约冻结：实体 camelCase 属性绝不直接外泄）。事件 kind 字符串与 Store 时代逐字一致（`agent log` 历史同质）。

**迁移读命令的固定动作**：`getOrm(env.db.path)` → repo.find（relations 取派生计数）→ 显式映射输出形状（含历史 clip 怪癖）→ catch 返回 rc=1 → demo 即回归。

**写迁移状态（0.12.0 收官）**：全域完成——research/kb/job（0.10.0）、produce/skill/project（0.11.0）、tree/node（0.12.0，src/treeWrites.ts）。**例外清单**：`project use` / `tree use` 留 Store.metaSet（配置面）；`node validate` 保留 TreeStore（诊断面，buildIndex 副作用随读发生）；tree 域沿袭 TreeStore 传统**不写 events**（历史行为，保持）；produce export 的 artifact.export 事件仍经 Store.log。迁移规则不变：副作用进事务 + 黄金对账。produce 三命令（outline/section/report）自 0.11.0 起 JSON 纯净。

**连接策略（0.24.0 起）**：WAL + `synchronous=NORMAL`（sqlite.org 官方推荐组合）——commit 不再逐事务 fsync（Windows 实测 ~14ms/次），同步由 WAL checkpoint 承担。**持久性语义**：断电可能回滚最后几笔事务，数据库不会损坏；本地单用户研究工作台的教科书取舍。两条连接都要设（wasm DB 构造器 + `getOrm()` initialize 后）——journal_mode 持久于文件，synchronous 是**逐连接**的。基准：claim-write 39.9→28.1ms/op（−29%）。

## 六、输出契约（Agent API）

- 退出码：`0` 成功（含重复已存在）· `1` 运行错误/404 · `2` 用法错误
- `--json` 纯净：写命令单个 JSON 对象；读命令单个 JSON 数组/对象；禁止人类文本混入
- 输出形状是**冻结契约**：改字段名 = 破坏性变更，需在 plan.md 记录并评估 demo 断言影响

## 七、临时文件规范（2026-10-15 用户裁定）

**一切临时测试脚本、调试脚本、临时数据（语料暂存、测试工作区、dump）一律放 `<repo>/tmp/`**，禁止写入系统临时目录（Git Bash 的 `/tmp` 即系统 TEMP，例如 Windows 的 `%LOCALAPPDATA%\Temp`）。

理由：系统 temp 随轮次/清理丢失、跨机器不可移植、埋在用户配置目录里不可巡视；repo 内 `tmp/` 让调试现场可回溯、可直接重跑、且 `.gitignore` 已排除不入库。

细则：
- 调试脚本（`dbg*.js` 等）与测试工作区（`tmp/ygl-*`）放 `tmp/` 下运行；`require("pg")` 等模块解析直接可用（在 repo 内）
- 从外部系统导出的临时语料（如 obelisk 记忆/摘要暂存）同样落 `tmp/`
- `tmp/` 永不提交；失控膨胀时整目录删除重建即可
- 教训来源：调试脚本落在系统 temp 时出现过 require 解析失败、stale lock 残留难发现、跨轮不可复用三类摩擦
