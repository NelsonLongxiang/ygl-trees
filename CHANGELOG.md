# Changelog

## 0.24.0（2026-10-16）WebUI 三视图交互 + WAL+NORMAL + fts boost 限候选集
- **WebUI 交互收尾（设计稿三视图齐了）**：科技树节点可点击 → 右侧详情面板（`/api/node?tree=&key=` 端点：node/parents/children/conditions/can 确定性判定，eval 门槛以问题文本呈现在 missing_required）；claims 按状态分组、点击展开证据链接与原文摘录（/api/data 扩展 claim_evidence + evidence 索引）；节点面板独立于轮询重渲染（选中/展开状态跨 10s 刷新保持）
- **UI 规范**（ui-ux-pro-max 技能指导）：键盘可达（tabindex + Enter/Space + :focus-visible 焦点环）、aria-expanded/aria-live、加载/静态导出双态反馈、prefers-reduced-motion 降级、HTML 转义防注入（esc() 全覆盖用户文本）
- **fts() boost 限候选集**：`lower(title) LIKE` 从全表扫描改为仅扫 MATCH 候选 id 集（计数语义逐位一致——boost 本来只落给候选行）
- **WAL + synchronous=NORMAL**（sqlite.org 推荐组合，双连接设置）：commit 免逐事务 fsync；claim-write 39.9→28.1ms/op（−29%）；持久性语义=断电回滚末几笔、不损坏（docs/conventions.md §五连接策略）
- **kb-search 25ms 剖析定案**：per-token MATCH ~3ms + reuse 回写 ~10ms（VFS 锁目录 mkdir/rmdir + WAL 追加）为地板；"读路径去写"记为已知机会（需 Store 生命周期改造，超出便宜优化范围）
- 单测 22→56 例（webui 12 新例：脚本语法编译护栏/注入转义/三路由/404/400）；ops/tools 声明 @ygl/techtree-model 依赖

## 0.23.0（2026-10-16）dogfood 深化批 + benchmarks + Bun 决策 + kbSearch 修复
- **benchmarks/ 基准套件**：零依赖七席（startup 子进程 / claim-write / claim-dedupe / kb-import-batch / kb-search / node-index median-of-3 / node-search），`pnpm bench`，结果落 tmp/bench-results.json（含 node/平台/git 哈希）；README 记方法论与 Windows Defender 方差注意
- **kbSearch 写放大修复（基准首跑战果）**：top-20 逐行 `UPDATE reuse=reuse+1`（20 次隐式事务 = 20 次 VFS fsync）→ 单语句 `IN (...)` 批更新；500 行语料 p50 326ms→25.6ms、p95 2039ms→49.9ms（12.7×/40×）
- **Bun 运行时决策**：未来以 Bun 封装 CLI（用户指示）。本机实测 bun 1.3.0 (win32) `fs.openSync(path, O_CREAT)` 抛 ENOENT 不建文件 → node-sqlite3-wasm VFS 无法建库 → **Windows 上受阻**。docs/bun-compat.md 记录证据链与迁移清单；scripts/bun-smoke.sh 探针（pnpm smoke:bun，当前必红，不进 test）
- **dogfood #2**：cordis-lifecycle 真实代码证据研究项目全闭环（3 检索式 → 6 源 → 6 证据 → 5 断言全 supported → 7 链接 → 大纲+章节+报告 → kb ingest → promote `cordis-lifecycle-cli`）；agent match 双查询 top-1 命中；doctor 7/7 护航
- 报告 `_generated` 标记补 UTC 标注（原裸 UTC 时间在 UTC+8 环境易误读为前一天；demo 组 4 加断言锁定）
- 修正 0.21.0/0.22.0 CHANGELOG 与 plan.md 执行记录日期（10-17 → 10-16，对齐 git 提交真实日期）

## 0.22.0（2026-10-16）WebUI 动态版：live dashboard
- `ygl-trees webui serve [--port N]`：零依赖 `node:http` 活数据仪表盘——`/` 实时渲染、`/api/data` 每请求现取、10s 轮询自动刷新；Ctrl+C 优雅停机（db 在 CLI finally 关闭）
- 重构：`gatherData()`/`generateHTML(data, live)`/`createDashboardServer()` 三出口；export 路径行为不变（单文件 + 内嵌快照兜底）
- 安全：内嵌 JSON `<` 转 `\u003c`，杜绝 `</script>` 注入
- 测试：webui 7 例（gatherData 形状 / HTML live 引导 / 注入转义 / 三路由端到端）；demo 断言组 8（export 单文件校验）

## 0.21.0（2026-10-16）doctor 健康检查 + 检索全域统一
- `ygl-trees doctor`：7 项健康检查（schema 版本 / 索引新鲜度 / FTS 同步 / 重复内容 / 孤儿数据 / config 有效性 / 残留锁），`--json` 纯净输出
- 检索排序全域统一：kb（title 加权）、skill match（name 加权）、source search（title 加权）、node search（key/name 加权）——hits desc → boost desc → bm25 asc

## 0.20.0（2026-10-16）DSH 合规收官
- 测试归位：全局 `tests/` → 各包 `tests/`（text→core/text、eval→techtree/eval、config→ops/tools）；vitest `packages/*/*/tests/**/*.test.ts`
- 包依赖声明：8 包各声明 dependencies（workspace `@ygl/` + npm cordis/typeorm）；core/text 和 techtree/eval 零依赖（纯函数）
- 跨包 import 审计：全部来自 `core/*` 共享层，零域间交叉引用

## 0.19.0（2026-10-16）Cordis 迁移收官
- CLI `main.ts` 创建 Cordis Context，加载 DatabasePlugin；Store 同步构造保证命令速度（Cordis rc 异步时序在 CLI 场景不可控，务实回退）
- `apps/webui/` 重命名为 `apps/web/`（DSH 惯例）
- WebUI：`ygl-trees webui [--out <file>]` 导出单文件 dashboard.html（9/9 HTML 结构检查通过）
- 包结构 gate 检查：8 包 × 5 必存文件（package.json + tsconfig.json + README.md + src/index.ts + tests/）

## 0.18.0（2026-10-16）架构重构：Cordis + packages/apps/vendor 分层
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
