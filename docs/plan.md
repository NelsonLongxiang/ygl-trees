# ygl-trees 开发计划

日期：2026-10-15 ｜ 规格：[spec.md](spec.md) ｜ 调研：[research.md](research.md) ｜ 规模标记：S ≤ 半会话 / M ≈ 一会话 / L > 一会话

> **执行记录（2026-10-15）**：M1/M2/M3 全部完成——`5622835`（0.2.0）、`84cc285`（0.3.0）、见 git log（0.4.0）。
> 实施中的偏差与计划外收获：
> - spec R2 jobs 行改为应用层判重（存量撞名无法安全建唯一索引）
> - spec R6.2 验收按实测修正为"命中且进前二"（原'排第一'对人工编写的 skill 不成立）
> - 计划外修复：`bin/ygl-trees.js` 曾把退出码吞成 0（Agent 按 rc 判断会全部误判）；export 的 FTS5 影子表 DDL 会破坏 dump 重放；`DB.tx` 改可重入；CLI 对异步命令（source fetch）保持 db 打开直至完成
> - `source fetch` 的三类页面行为（静态 html / 404 / 非 html）以本地 http 服务实测验证，demo 保持离线可跑
>
> **执行记录 · 0.5.0（2026-10-15，推迟项首批）**：job tick 并发锁（mkdir 锁 + 陈旧抢占）+ 悬空 run 回收（>30min → rc=126）；schema v4 `query_sources`（纯增量，无需特殊迁移）+ `query attach` / `source add --query` / query list 召回数；`claim resolve` 人工仲裁出口（事件留痕，新证据重新推导）；`kb import` 批量 markdown（frontmatter，内容 hash 幂等）。
> 计划外：发现并修复 README"全部命令支持 --json"的承诺缺口——写命令（add/ingest/import/fetch）在 `--json` 下现在只输出单个 JSON 对象（重复带 `duplicate: true`），此前会混入人类文本污染 Agent 解析。
> 仍推迟：node 组写命令的 --json 对齐（0.5.1 已补齐）、npm 实际发布（外部动作，需用户确认）、单测框架。
>
> **执行记录 · 0.5.1 / 0.6.0（2026-10-15）**：0.5.1 = tree/node/skill/project 组写命令 --json 对齐（README"全部命令支持 --json"承诺兑现；project list 不再污染 name 字段；skill enable/disable 补 404）。0.6.0 = PG 兼容 L1 落地（docs/pg-compat.md 方案 → `db sync pg` 实现）：镜像 DDL 由 PRAGMA table_info 运行时推导（双 DDL 漂移风险在 L1 消失）、ngram 同分词器重算 + tsvector/GIN 中文等价召回、pg 作 optionalDependencies；docker postgres:16 容器实测 18 表计数严格对齐 + 中英文检索等价。顺手修正 `db stats` 从不统计树表的历史口径缺陷。
>
> **执行记录 · 0.12.1（2026-10-16，真实数据试用 + 修复）**：以 obelisk 真实数据试用——154 个记忆 markdown（含 8 组同名碰撞、5 组内容重复被 content_hash 去重）+ 2189 条会话摘要入库（2333 notes）。发现并修复：**PG 镜像 tsv 复合 token 漏召回**（`docker/mongo` 类斜杠连写拉丁串被 PG 默认解析器归为 url/host 复合 token，不拆分匹配，docker token 27→24；修复=生成列先 `regexp_replace` 标点归一化再 tsvector，sync 侧 DROP+ADD 自愈存量镜像；修后五 token 全对等 8/42/31/798/27）。性能记录：kb import 每笔记独立事务+WAL fsync ≈20ms/条（2189 条 44s，批量化空间一个量级）；sync 真水体量 1.1s；检索 0.33s/2333 条。检索质量观察（待办）：长 body 稀释 bm25 且 title 无加权、无标题源数据显示为 untitled。**新规范（用户裁定）**：临时脚本与临时数据一律落 `<repo>/tmp/`（conventions.md §七，.gitignore 排除）。
>
> **执行记录 · 0.12.0（2026-10-15，写路径 TypeORM 化 · 第三批收官：tree/node 域）**：src/treeWrites.ts（treeCreate/nodeAdd/link/unlink/condAdd/stateSet/nodeDel/rebuildIndex/importTree + 移植 reaches/rebuildClosure(BFS)/buildIndex(Kahn 环抛错)/gatingCycle/markDirty）全事务化；cmds/tree.ts 九写命令异步化（runTreeWrite 助手）。契约修复：index ack 曾泄漏 camelCase（closureRows→closure_rows）。tree 域沿袭不写 events 的历史行为（提交注明）；tree use 留 metaSet、validate 留 TreeStore（诊断面，例外清单入 conventions）。回归：dup node/环拒绝 rc=1/index 重建/import round-trip + existing 拒绝 + merge/rm 404/demo 全绿。**写迁移全域收官**（三批 26 写方法）。
>
> **执行记录 · 0.11.0（2026-10-15，写路径 TypeORM 化 · 第二批：produce/skill/project）**：writes.ts 增六方法（artifactAdd 版本号事务内自增、skillUpsert FTS delete+reinsert 同事务、skillDel/skillEnabled 404 语义、skillRefAdd upsert、projectCreate 含 current_project meta 同事务）；命令迁移：produce outline/section/report、skill add/import/rm/enable/disable/refs add、project new、kb promote（deriveL1 导出复用）。produce 三命令补 JSON 纯净纪律（此前 ok 文本污染 --json——契约改进）。project use 有意留 Store（配置面）。回归：skill 重导入 upsert 不重复 + FTS 同步、rm/enable 404 rc=1、refs upsert v2 生效、section 版本 1→2 递增、demo 全绿。剩余写面：仅 tree/node 域。
>
> **执行记录 · 0.10.0（2026-10-15，写路径 TypeORM 化 · 第一批）**：async 裁决=事务化写服务+渐进迁移（否决全栈异步：传染面已被命令层 await 收敛）。新增 src/writes.ts（十写方法：queryAdd/sourceAdd/evidenceAdd/claimAdd/claimLink/claimResolve/queryAttach/kbAdd/kbIngest/jobAdd），副作用三件套（幂等 hash/FTS 双写/events）同事务——**修复 Store 时代基表+FTS 分离语句可留孤儿行的缺陷**；contentHash 迁 text.ts 单源；新增 Event 实体；返回显式 snake_case 映射保输出契约；事件 kind 与 Store 时代逐字一致。十个写命令经 runWrite 助手异步化。回归：dup/force 矩阵、404 rc、link/resolve 状态机、agent log 事件流同质、FTS 事务双写后检索命中、demo 全绿、四 list 黄金兼容。遗留：produce/skill/tree 域写命令后续批次；job --force 须置于 `--` 之前（解析器既有语义，文档化）。
>
> **执行记录 · 0.9.0（2026-10-15，TypeORM 读面扩大 + 数据模型规范）**：research 组四个读命令（query/source/evidence/claim list）迁移 TypeORM（MoreThanOrEqual 过滤、relation 取派生计数、显式映射输出形状含 clip 历史怪癖）；实体补 Evidence.claimEvidence（used_by）。**黄金对账**：同数据集迁移前后四命令行数/键集/稳定字段全匹配（随机 id 与时间戳剔除）。落盘 docs/conventions.md：加表九触点清单、幂等判重决策树、FTS 同步纪律、迁移模板、TypeORM 边界、输出契约。source search 依 FTS 纪律保持裸 SQL。
>
> **执行记录 · 0.8.0（2026-10-15，TypeORM 接入）**：用户裁定采用 TypeORM（typeorm@1.1.2 + better-sqlite3@13 + reflect-metadata；驱动闸门实测通过——Node 24/Windows prebuild 3s 免编译）。**边界约定**：synchronize 永久 false，迁移权威仍在 SCHEMA_SQL + user_version 轨道；实体是 schema v5 的类型化快照（改 SCHEMA_SQL 必须同 commit 改实体）；FTS5 MATCH/bm25、PRAGMA、PG sync/migrate 保持裸 SQL。试点 `project show` 全走 TypeORM（异步命令，输出形状与裸 SQL 时代逐字段一致，demo 1 段断言守护）。**我方保留意见（记录在案）**：TypeORM 属第二梯队选项（需 native 驱动、装饰器栈），零依赖哲学就此放宽为"运行时依赖 4 个"；缓解=synchronize 锁死、实体仅作查询层、better-sqlite3 prebuild 依赖 Node ABI（升级 Node 大版本时闸门测试必须重跑）。
>
> **执行记录 · 0.7.0（2026-10-15，PG 兼容收口）**：架构裁定——不做双后端同写，L2 取消（依据：用户决策 + 技术再评估——Store 全同步架构 vs pg 驱动纯异步的阻抗失配是 L2 主导成本）。新增 `db migrate pg [--fresh]`：一次性完整保真迁移（24 表 DDL 手写全约束 + 单事务原子 + 列集漂移守卫 + 非空目标拒绝）。修复：query_sources 表自 schema v4 起漏出 `db export` dataTables / sync MIRROR_TABLES / stats()（备份与镜像静默丢 query↔source 关联）；`skill refs add` 的 ON CONFLICT(skill_id,path) 自 v1 起缺唯一索引（一用即错），schema v5 补 uq_skill_refs。docker postgres:16 实测：24 表迁移计数严格对齐、约束活体（23505/23503）、中文 tsv 检索等价。

## 里程碑总览

| 里程碑 | 主题 | 版本 | 包含需求 | 出口条件 |
|---|---|---|---|---|
| M1 | 数据不丢 + 写入幂等 | 0.2.0 | R1、R2、R7.1 | demo 含幂等断言全绿；round-trip 备份实测通过 |
| M2 | 可移植 + 校验补全 | 0.3.0 | R3、R4、R5、R7.2 | export→import 等价性实测；错误出口全部非 0 退出 |
| M3 | 研究管线增强 | 0.4.0 | R6 | source fetch 对 3 类真实页面可用；brief 健康度生效 |

里程碑串行执行；每个里程碑收尾 = `pnpm test` 全绿 + git 提交 + 版本号推进 + README 同步。

## M1 — 数据不丢 + 写入幂等（0.2.0）

| # | 任务 | 涉及 | 规模 | 验收 |
|---|---|---|---|---|
| M1-1 | `db export` 表清单补全七张树表；`--lean` 跳过 closure/index 数据；导出摘要行 | cmds/db.ts | S | spec R1.1–R1.4 |
| M1-2 | 备份恢复演练：export → 删库 → 重放 → `db stats` 计数一致 + `node validate` 干净 | 手工脚本（临时，不入库） | S | 记录在提交说明 |
| M1-3 | schema v3：五表 content_hash 列 + 唯一索引 + 存量回填，事务内迁移 | db.ts | M | 老库（demo 旧数据）打开即迁移，行为不变 |
| M1-4 | 六个写命令幂等化 + `--force`（加盐 hash）+ `! duplicate` 输出 | store.ts + cmds/research.ts, kb.ts, job.ts | M | 同命令连跑两遍计数不翻倍（spec R2.5） |
| M1-5 | demo.sh 增幂等断言段（写命令×2 断言 duplicate 提示与计数） | examples/demo.sh | S | `pnpm test` 内生效 |
| M1-6 | `pnpm test` 改为 build + demo（临时 YGL_HOME） | package.json | S | `pnpm test` 一条命令可跑完 |

**依赖**：M1-3 → M1-4 → M1-5；M1-1 独立可先行。
**风险**：存量库回填 hash 时若已有重复行，唯一索引创建失败 → 迁移先检测重复，重复行加盐后建索引并在迁移日志中报告数量（不静默改数据）。

## M2 — 可移植 + 校验补全（0.3.0）

| # | 任务 | 涉及 | 规模 | 验收 |
|---|---|---|---|---|
| M2-1 | `node import --file [--tree][--merge]`：解析 + 严格校验 + 事务导入 + 自动 index | tree.ts（importTree）+ cmds/tree.ts | M | spec R3.4 round-trip 等价 |
| M2-2 | `validate` 门控边全集环检测（含可选边） | tree.ts validate | S | `db sql` 直写可选环 → validate 报 issue |
| M2-3 | 404 语义：`query done` / `job enable|disable` / `source rm` 命中 0 行报错退出 1 | cmds/research.ts, job.ts | S | spec R4.1 |
| M2-4 | CLI 负数 flag 值修复（`--relevance -1`） | cli.ts parse | S | `source list --min -1` 与现状等价 + 新负值用例 |
| M2-5 | usage 补 `db sql` / `job enable`；`stateInit` 决策执行（倾向删除） | cli.ts, tree.ts | S | `--help` 与实现一致 |
| M2-6 | package.json `files` 白名单 + `prepublishOnly` | package.json | S | `npm pack --dry-run` 仅含白名单内容 |
| M2-7 | demo.sh 增 round-trip 断言（export→import→再 export 语义等价，node 脚本比对） | examples/demo.sh | S | `pnpm test` 内生效 |

**依赖**：M2-1 → M2-7；其余并行。
**风险**：export 格式里 index 派生字段（topo_order 等）在 import 时必须忽略重建，比对脚本要排除 `id/created/built_at`——M2-1 实现时以白名单字段比对。

## M3 — 研究管线增强（0.4.0）

| # | 任务 | 涉及 | 规模 | 验收 |
|---|---|---|---|---|
| M3-1 | `source fetch <url>`：内置 fetch + title/meta/正文提取 + 走 sourceAdd 去重 + 失败不落库 | cmds/research.ts | M | 3 类页面（静态 html / 404 / 非 html）行为正确 |
| M3-2 | `kb promote` L1 生成改进（标题段/列表项优先，回落现状） | store.ts kbPromote | S | spec R6.2 验收（match 排第一） |
| M3-3 | `agent brief` 健康度 next_actions（存量重复行、脏索引） | cmds/agent.ts | S | 人工构造两类状态，brief 各给出对应提示 |
| M3-4 | README 更新至 0.4.0 命令面 | README.md | S | 新命令全部有文档 |

**依赖**：M3 全部依赖 M1/M2 完成；M3-1 独立于 M3-2/3。
**风险**：真实网页正文提取无依赖条件下质量有限——spec 已限定"非 JS 渲染站点"，提取失败时保存原始前 N KB 并标记 `needs_review` tag，不假装成功。

## 明确推迟（不进本计划）

- claim 仲裁工作流、query↔source 关联、markdown 批量导入、调度并发锁、npm 实际发布、单测框架——待 0.4.0 复盘再立项

## 完成定义（DoD，每里程碑通用）

1. `pnpm build` 零报错；`pnpm test`（build + demo 含新断言）全绿
2. 新行为有 demo 断言或可复现验证记录（命令 + 输出贴进提交说明）
3. README / usage 与实际命令面一致
4. 版本号推进 + git 提交（一个里程碑一个合并点，任务可多提交）
