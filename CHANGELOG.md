# Changelog

## 0.18.0（2026-10-16）架构重构：Cordis + packages/apps/vendor 分层
- **目录重构**：`src/` → `packages/`（core/research/techtree/knowledge/ops 五域，每域 index.ts 显式导出面）+ `apps/cli/`（应用入口，与域解耦）+ `vendor/`（上游 cordis/cosmokit，pnpm workspace 管理）
- **Cordis 框架集成**：vendor `cordis@4.0.0-rc.11` + `cosmokit@1.8.1` 从 cordiverse/cordis 上游获取（非 DSH fork）；`packages/context.ts` 定义 DatabaseService/ResearchService（Service 子类）+ createApp() 组合；为运行时服务发现、多服务生命周期、事件驱动组合、动态插件加载、时空可组合性奠定基础
- **AGENTS.md**：Agent 常驻守则（仓库布局图、命令面板、Agent API 契约冻结表、Cordis 架构、七条开发规则、决策链链接）
- **docs/layout.md**：目录层级规划（当前结构 + 依赖方向单向图 + 未来扩展位 + 与 DSH 对齐差异表）
- **docs/webui-design.md**：WebUI 零依赖方案（三视图设计稿，待实施）
- **Dogfood 验证**：以「AI Agent 开发中的架构决策模式」为题完成 query→source→evidence→claim→report→kb→skill 全闭环；agent match 双查询 top1 命中
- **文档全面更新**：README（文档地图 + Skills 表 + config/env vars）、AGENTS.md、layout.md、webui-design.md

## 0.17.0（2026-10-16）巩固批
- vitest 单测落地（37 用例：ngram CJK 切分、contentHash 幂等/加盐、resolveEndpoint 归一化、mapOutcome 三态边界、config 注册表不变量与校验）；`pnpm test` 升级为 unit + build + demo 三段
- 死代码清理：写迁移后被 `src/writes.ts`/`src/treeWrites.ts` 替代的 Store 13 个、TreeStore 7 个死写方法删除（逐方法 grep 使用证据；`rebuildClosure`/`buildIndex` 因 validate 依赖保留）；store.ts 617→427 行、tree.ts 910→741 行
- CHANGELOG.md 建立

## 0.16.0（2026-10-16）批量门槛裁决
- `node ready --eval`：仅被 eval 门槛阻塞的节点逐节点一次多题请求（协议原生批量），全过提升进 ready（`eval_verified`），其余 `eval_pending` 逐题带 P；离线全 pending rc=0；留痕 `eval.ready`
- `evalBooleanMany` 多题单请求；skillMatch 接 boostExpr（名称命中优先）

## 0.15.x（2026-10-16）配置层
- **0.15.1**：决策模型配置键 `decision_model_llm_token` / `decision_model_llm_api_base`——**config 优先**于环境变量/文件/默认网关；api_base 归一化（裸主机名自动补 `/v4/ai/evaluation-model`）
- **0.15.0**：config 命令组（list/get/set/reset）+ schema v6 `config` 表 + 8 键注册表（全部真实接线：eval 阈值/离线、fetch 超时/UA、search.limit、default_confidence、job.stale_minutes）

## 0.14.x（2026-10-16）决策模型门槛 + Skills
- **0.14.1**：专属 Skills 五枚（quickstart/research/knowledge/techtree/eval-gates），junction 至 `.agents/skills/`；dogfood 验证 agent match 五发全中
- **0.14.0**：Gate 决策模型布尔评估（spec R8）——`--op eval` 条件 + `node can --eval`，上下文包（关联+闭包索引+条件+解锁集+state 袋）交 TypeSafe jev 判 P(true)，三态映射（≥0.7 通过 / ≤0.4 未通过 / 灰带 pending 禁终态）；真实网关三带全谱验证（0.97/0.39/0.45）；离线安全；demo.sh 改独立 `YGL_DEMO_HOME`（修复 pnpm test 清空继承工作区的隐患）

## 0.13.0（2026-10-16）真实试用反馈落地
- `kbImportBulk` 单事务批量导入：2189 条 44s→0.72s（61×）
- 检索 title 加权（`boostExpr`）：unicode61 把整段 CJK 标题索引为单 token，FTS5 列过滤对中文失效——改 `lower(title) LIKE` 子串匹配；排序 = 命中数 → 标题命中 → bm25

## 0.12.x（2026-10-16）写迁移收官 + 真实数据试用
- **0.12.1**：obelisk 真实语料试用（154 记忆 + 2189 摘要 = 2333 notes）；修复 PG 镜像 tsv 复合 token 漏召回（`docker/mongo` 类斜杠串被 PG 解析为 url/host 复合 token——生成列先 `regexp_replace` 标点归一化再 tsvector）；tmp/ 规范立法
- **0.12.0**：tree/node 域写迁移（`src/treeWrites.ts` 九方法全事务化，BFS 闭包/Kahn 拓扑/环守卫逐字移植）；写迁移全域收官（26 服务方法）

## 0.11.0（2026-10-15）写迁移第二批
- produce/skill/project 域（artifactAdd 版本事务内自增、skillUpsert FTS 同事务、projectCreate 含 meta 翻转同事务）；produce 三命令补 JSON 纯净

## 0.10.0（2026-10-15）写迁移第一批 + async 裁决
- `src/writes.ts` 事务化写服务（research/kb/job 十方法）；裁决=事务化写服务+渐进迁移（否决全栈异步）；副作用三件套（幂等/FTS/events）同事务——修复 Store 时代基表+FTS 分离语句可留孤儿行的缺陷

## 0.9.0（2026-10-15）读面扩大 + 规范立法
- research 四 list 迁移 TypeORM（黄金对账全匹配）；docs/conventions.md——加表九触点清单、幂等决策树、FTS 纪律、迁移模板、TypeORM 边界、输出契约

## 0.8.0（2026-10-15）TypeORM 接入
- 用户裁定采用（typeorm@1.1.2 + better-sqlite3@13）；驱动闸门实测（Node 24 prebuild 3s 免编译）；`synchronize` 永久 false，实体= schema v5 快照；试点 `project show` 逐字段兼容

## 0.7.0（2026-10-15）PG 迁移 + L2 取消
- `db migrate pg`（一次性完整保真：24 表手写全约束 DDL + 单事务原子 + 列集漂移守卫 + 非空拒绝）；架构裁定：不做双后端同写（用户裁决 + sync/async 阻抗失配再评估）；修复 query_sources 漏出 export/sync/stats、skill refs 唯一索引缺失（v5）

## 0.6.0（2026-10-15）PG 镜像
- `db sync pg`（table_info 驱动镜像 + ngram 同分词器重算 + tsvector/GIN 中文等价召回）；docker postgres:16 实测 18 表计数严格对齐

## 0.5.x（2026-10-15）研究闭环 + JSON 对齐
- **0.5.1**：tree/node/skill/project 写命令 --json 对齐（README 承诺兑现）；project list 不再污染 name
- **0.5.0**：query↔source 关联（schema v4）、claim resolve 仲裁出口、kb import 批量 markdown、job tick 并发锁 + 悬空 run 回收；写命令 JSON 纯净纪律（duplicate:true）

## 0.4.0（2026-10-15）管线增强
- `source fetch`（零依赖抓取、失败零副作用）；`kb promote` L1 提炼；`agent brief` 健康度

## 0.3.0（2026-10-15）可移植 + 真实退出码
- `node import` 严格校验事务导入；validate 门控全集环检测；404 语义；**bin 退出码修复**（曾恒 0，Agent 全误判）；负数 flag 值；files 白名单

## 0.2.0（2026-10-15）数据不丢 + 幂等
- `db export` 补全七张树表 + `--lean`；schema v3（content_hash + 唯一索引 + v2 自动迁移）；六写命令幂等 + `--force`；`db dups`

## 0.1.0（2026-10-15）初始调查基线
- 两缺陷修复起步（node path 顺序、agent brief 描述缺失）；调研报告 + spec + plan 立项
