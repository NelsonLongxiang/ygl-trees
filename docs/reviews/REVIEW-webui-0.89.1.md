# REVIEW — WebUI 专项评审（0.89.1，React 唯一前端时代）

- 评审线：ygl-trees 评审会话（DSH session-302cb119）｜评审模型 longxiang/glm-5.3
- 日期：2026-10-18 ｜ 对象：commit ca2b401（0.89.1）已提交面；工作区另有 PG-A 在途未提交改动（db.ts/pgsync.ts/entities/writes/cmds/demo.sh/contract-audit.sh，不属本轮对象）
- 范围：packages/ops/tools/src/webui.ts（529 行）、packages/web/app/src/index.ts、apps/web/src 全部（App/TreeFlow/Artifacts/KnowledgeGraph/main/api/tokens.css）、packages/ops/tools/tests/webui.test.ts、docs/webui-design.md、DESIGN.md token 面板
- 方法：全量读码 + 隔离 home（tmp/webui-rev-55860）双项目动态探针（真实 HTTP，服务进程与 CLI 并发）
- 结论：**不可直接收口——2 P1（1 安全/契约 + 1 稳定性）+ 1 P1（R16.4 客户端验收未达），P2×4，P3×7**。R16 读侧数据面门禁、/api/artifact 归属、SSE 停机清理、XSS 面（无 dangerouslySetInnerHTML、react-markdown 默认安全）复核通过。

## P1（必须修）

### P1-1 `/api/task` 写端点无归属校验——R16.3「写 fail-closed」被旁路
`webui.ts:416-436`：POST `/api/task` 解析 `{id,status}` 后直接 `taskSetStatus(ds, id, next)`，全链路无 project 授权/归属校验（`writes.ts:486` 的 taskSetStatus 也不含项目概念）。同表同一行，读端点 `/api/artifact`（webui.ts:399-411）有 authorized+owned 双检 404，写端点裸奔。
**实测**（tmp 探针，双项目 alpha/beta）：
- 未选择态 POST beta 任务 id → **rc 200，`{"from":"todo","to":"doing"}`**
- 会话授权=alpha 下 POST beta 任务 id → **rc 200**（doing→doing）
- 对照 /api/artifact 同 id → 404 `belongs to beta` ✓
`--host 0.0.0.0`（webui.ts:496 明示开放 LAN）时任意局域网客户端可推进任意项目任务。该端点：无客户端调用方（App.tsx 任务表无推进交互）、webui-design.md 未记载（serve --help 却列出）、无测试。
**修法**：复用 /api/artifact 的 psel 检查（authorized 且 row.project_id 匹配），不匹配 404；非法 status 400；补 webui.test.ts 覆盖（跨项目/unselected/合法推进三条）。

### P1-2 fingerprint tick 无异常隔离——并发 CLI 写可击毙 serve 进程
`webui.ts:288-295`：`tick()` → `push("data", gatherData(env))` 无 try/catch（:312-318 `onYglEvent` 同构）。gatherData → buildBrief → resolveProject → `metaGet` 走 `db.get`，跨进程写锁竞争时抛 `SQLite3Error: database is locked`，uncaught 于 timer → **进程退出**。
**实测崩溃栈**（隔离 home，serve + SSE 客户端 + 另一进程 `task add`）：
```
SQLite3Error: database is locked
    at DB.get (db.js:750) ← DB.metaGet (db.js:789) ← resolveProject (selection.js:39)
    ← buildBrief (agent-cmds.js:13) ← gatherData (webui.js:77) ← Timeout.tick (webui.js:298)
[exit code: 1]  ← serve 进程死亡
```
serve 的存在意义就是「别的进程在写、面板活着刷新」——这恰是击毙条件。node-sqlite3-wasm 自定义 VFS 用 `mkdir ${path}.lock` 目录锁（EEXIST→SQLITE_BUSY），跨进程 WAL 竞争语义脆弱；与 0.83 `DB.close` 锁 flake、0.85 终审 65s 超时同族。
**修法**：tick 与 onYglEvent 整体 try/catch（推送失败降级为「本拍放弃」）；读连接设 `PRAGMA busy_timeout`；建议 0.90 给锁家族立档（plan.md）并评估 busy_timeout 全局默认。

### P1-3 R16.4「未选择态」未在 React 客户端实现——验收未达
`webui.ts:23-25` 注释承诺 "the panel renders the 未选择 state with a picker"；服务端载荷正确（`data.unselected` 实测在）。但 `apps/web/src/api.ts:20-33` DashboardData 类型无 unselected/knowledge_graph/tree_selection_source 字段，**App.tsx 全文不读 unselected**——未选择态用户看到的是：全局工作区计数卡 + 空面板，无说明、无项目选择入口。（0.85 终审只验了载荷面，未验客户端渲染——评审线自认漏项。）
**修法**：App.tsx 增未选择面板（列出 `unselected.projects` + 指引 `project use`）；api.ts 类型补齐。

## P2

- **P2-1 brief.project 把全局指针项目泄漏进未选择态**：`webui.ts:74` 无条件 `buildBrief(env)`，`agent-cmds.ts:35` 只要解析出项目（含 global 来源）就填 `brief.project`。实测未选择态 `/api/data` 返回 `brief.project.name:"alpha"`，App.tsx:80-84 头部 Tag 与 :119-131 进度卡照渲——R16.4 "never a silent fallback onto the global pointer's content" 在首页两处被破。修法：gatherData 在 `!projAuthorized` 时剥除 brief.project（或 buildBrief 加 authorized 参）。
- **P2-2 knowledge_graph 跨项目内容泄漏 + R19 无档**：`webui.ts:185-213` 无条件全库 `relations LIMIT 200`（无 ORDER BY、无项目过滤），label 携 claim 文本/证据摘录/工件标题。实测未选择态 KG 暴露 beta 项目断言原文「断言乙：跨项目目标」。且 "R19" 仅存在于 webui.ts:185 注释——spec/plan/CHANGELOG/webui-design.md 全无记载（决策链违约）。修法：按授权过滤（或至少项目过滤+文档明示工作区级）；R19 立档或撤注。
- **P2-3 研究管线视图在唯一前端上缺失**：webui-design.md:19-35「三个视图」之研究管线视图（claim 卡片/状态分组/证据展开，标注 ✅ 0.24.0）——App.tsx 无任何 claims/sources/evidence 渲染组件；claims/sources/evidence/claim_evidence 每帧照收集照推送（payload 白载）。0.88 单3 退役了具备该视图的 HTML 面板，能力随之下线而文档未更。修法：React 补管线视图，或裁决降级并同步 webui-design.md + 瘦身 gatherData。
- **P2-4 webui.test.ts 覆盖面**：0 条覆盖 /api/task、unselected 载荷、knowledge_graph、静态缓存头、并发写存活。P1-1/P1-2 修复合入时必须带回归用例（P1-2 可用「serve + 子进程写 + 断言进程仍活」）。

## P3

1. token 双源冲突：tokens.css `--color-primary:#58a6ff`（DESIGN.md:9 同值）vs App.tsx:30 antd `colorPrimary:#7c9885` 注释自称镜像 DESIGN.md——客户端两套主色（TreeFlow 用 CSS 变量=蓝，antd 组件=绿）。
2. api.ts DashboardData 陈旧导致 App.tsx:161-168 `(data as any)` 逃逸类型。
3. 静态资源无 cache-control（index.html 启发式缓存→升级后旧 hash 引用风险；hash 资产宜 immutable）。
4. `openStatic` 前缀守卫 `file.startsWith(root)`（packages/web/app/src/index.ts:59）应为 `root + path.sep`——dist-* 兄弟目录可读；当前经 URL 规范化不可达，属潜伏加固。
5. /api/task body 无上限累积（webui.ts:419）。
6. /api/* 错误通道不一致：node/artifact 文本 404/400 vs task JSON 400。
7. `emitEvent` 在事务内持久化后、提交前触发（writes.ts:56）——事件驱动帧可能携带提交前快照（tick 1.5s 后自愈）；且 eventbus 进程内单例，跨进程 CLI 写只走 tick——CHANGELOG「事件驱动+轮询兜底」宜注明作用域。

## 复核通过项（正向）

- R16 读侧：会话选择后 claims/tasks 严格 alpha 域（实测 D2）；unselected 载荷正确（A1）。
- /api/artifact 归属 404（B2）；/api/node 400/404 分流；未知 /api 404。
- SSE 停机链 closeLive→closeAllConnections→close（webui.ts:519-525）；SSE 客户端断连清理（:341-344）。
- XSS 面：无 dangerouslySetInnerHTML/innerHTML；react-markdown 未挂 rehype-raw。
- dist 缺失诚实拒启（webui.ts:473-480）；503 带修复指引。
- WAL 开启（db.ts:484）；export 原子写（webui.ts:58）。

## 证据与复现

- 探针脚本：`tmp/webui-probe1.cjs`（未选择态/跨项目写/归属对照）、`tmp/webui-probe2.cjs`（会话态/SSE）、`tmp/webui-probe3.cjs`（SSE 复核，触发 P1-2 崩溃）；隔离 home：`tmp/webui-rev-55860`（双项目 alpha/beta，global=alpha，会话 revweb=alpha）。
- P1-2 复现：`YGL_HOME=<home> YGL_SESSION=s node bin.js webui serve --port P` + curl SSE 连接 + 另一进程 `task add -p alpha x` → serve 进程 exit 1（栈见上）。
- 本轮未跑 pnpm test 全量门禁：工作区有开发线 PG-A 在途未提交改动，跑门禁会混淆归属；本轮证据全部来自隔离 home 动态探针与读码。
