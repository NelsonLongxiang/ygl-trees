# WebUI 可视化方案

日期：2026-10-16 ｜ 状态：**已实施（0.19.0 export / 0.22.0 serve / 0.24.0 三视图交互 / 0.88.0 React 唯一前端）** ｜ **设计系统：[DESIGN.md](../DESIGN.md)（0.30.1 起 token 单一事实源，@google/design.md lint）**

## 路线（0.88.0 起的现状）

**React 客户端 = 唯一前端（用户裁定 0.88 单3）**：`apps/web`（Vite + @xyflow/react + antd + react-markdown）。
npm 包自带 `dist/apps/web/dist`（build 尾自动拷贝，`scripts/stage-web-dist.mjs`），隔离安装开箱即用。

**服务形态快照导出**：`ygl-trees webui export [--out <file>]` 落 `snapshot.json`——与 `/api/data`
同一载荷（meta.generated + brief + claims/sources/evidence/tree/timeline/...），原子写。可视化在
`webui serve`，数据在这。原「单文件 dashboard.html」与内嵌零依赖仪表盘、`/classic` 路由已退役。

**活数据仪表盘（0.22.0）**：`ygl-trees webui serve [--port N]`（默认 8642）：
- `/` — React 客户端（dist 缺失时**拒绝启动** rc=1，诚实报错，不静默回落）
- `/api/data` `/api/events`（SSE 表指纹推送）`/api/node` `/api/artifact`
- Ctrl+C / SIGTERM 优雅停机；CLI `finally` 在 server 关闭后才关 db

## 三个视图

### 0. 未选择态（R16.4，0.90.1 P1-3）
- 无授权项目选择时（多项目工作区 + 无会话/环境/旗标选择）：不展示任何项目内容，渲染「未选择项目」面板——可选项目清单 + `project use` 指引；不回退全局指针（brief.project 服务端剥除）。
- 知识图谱同规则：未选择态为空；授权态按项目过滤 claim/evidence/artifact 端点（node/kb 工作区级保留）——**R19 决策（0.90.1 P2-2）**：知识图谱为工作区级视图，其端点标签携带断言/证据原文，故授权与项目过滤是内容边界，非可选装饰。
- **知识图谱可读性（apps/web/src/KnowledgeGraph.tsx + graph.ts）**：载荷是 R9 关联织物（每条边都从科技树节点指向研究资产），所以按簇排：每个树节点一簇，关联资产按「断言 → 证据 → 知识 → 产出 → 来源 → 任务」列在其下，长簇换列，簇按宽约为高两倍成行（原环形布局 100 张卡互相压住）。任务、来源显示标题而不是 id（来源取 title，无则 url）；其他项目的任务只有 id（R16.4 不下发标题），卡片标「其他项目」；本页列表之外的来源（其他项目，或超出服务端按相关度前 20 条的上限）标「未列出」。已完成任务默认隐藏（开关显示数量）。图例兼作类型筛选（按钮 aria-pressed，显示 已显示/总数；树节点不可隐藏），边按关系着色并在图例说明，不再画边标签。搜索按标题匹配、其余变暗，回车定位；点实体聚焦到它和一跳邻居，右侧面板列出每条关联（关系词 + 对端，可点击跳转）。节点设 ariaLabel，窄屏面板落到画布下方。

### 1. Agent Brief 仪表盘（首页）
- 数据源：`agent brief --json` 输出
- 显示：当前项目、counts（sources/evidence/claims/artifacts/kb/skills）、next_actions、健康度提示
- 布局：卡片网格
- **任务清单勾销（R12.2）**：apps/web/src/Tasks.tsx——进行中 / 待办 / 已完成分组（组内保留服务端新→旧），每行只有一个前进按钮：待办「开始」、进行中「完成」（完成先确认：总览只前进，退回走 CLI `task todo|doing`；写入与 `task doing|done` 同一路径 `POST /api/task`，请求体 `status` 是目标状态，服务端重读当前状态只放行下一步，过期页面得 409 并原文提示（#66 / #70）；回执 `idempotent:true` 或 from = to 时提示「没有改动」而不是成功，按服务端状态显示；`apps/web/tests/task-bundle.spec.ts` 用页面自己的请求体打真实 bundle 的 `webui serve`；每步落 task.status 事件）。写回后本行先显示新状态，直到下一帧推送或轮询数据到达——之后一律以服务端为准，含 CLI 退回（#66）；失败原文提示。这是概览唯一的写入面——「下一步操作」仍只复制命令、不执行。

### 2. 科技树可视化
- 数据源：`node export --json` 输出
- 渲染：SVG DAG（节点=矩形 tier 分层，边=箭头 rel 着色：prereq 黑/unlock 蓝/excludes 红/enables 绿，虚线=可选）
- 交互：点击节点展开 can/conditions 面板 ✅（0.24.0：`/api/node` 端点 + 右侧详情面板，确定性 can 判定）
- 布局：Kahn 拓扑序已存 node_index，直接映射 Y 轴
- **可读性（React 版，apps/web/src/TreeFlow.tsx）**：节点卡先写节点名（业务专家的叫法），键名等宽小字在下，名称过长截断、悬停看全名；状态用图标 + 文字（✓ 已解锁 / 🔒 未解锁，aria-label 同步），不只靠颜色。标题栏写「树名 · 已解锁 n / m 节点」，画布下方图例说明两种状态和两种边（实线必检、虚线可选）。小地图缩到 128×84，按状态着色，可拖可缩。详情面板标题用节点名，键名在下。画布与详情面板可换行：窄屏（手机）上画布占满一行、面板落到下方（原先固定 300px 面板把画布挤成零宽）。

### 3. 研究管线视图
- 数据源：`research claim list --json` + `research evidence list --json`（载荷已按 R16 授权域收集）
- 渲染：claim 卡片（状态色：supported 绿/refuted 红/contested 黄/unverified 灰），点击展开证据链接列表
- 布局：按状态分组的水流式
- **状态（0.92 单A React 重建完成，direct-0f20e882 队列工单）**：apps/web/src/Pipeline.tsx——按状态四列水流（已证实/有争议/未验证/已反驳），claim 卡 3px 状态色左沿 + 支持/反驳计数 + 证据折叠列表（stance 着色 + 引文摘录）；状态色全部走 DESIGN.md token（tokens.ts，单B 纪律）；渲染验证 apps/web/tests/pipeline.spec.tsx ×6（renderToStaticMarkup，不引 jsdom）；R19 同口径——claims/claim_evidence/evidence 三键由服务端授权域收集，未选择态不填、组件不挂载（双重不渲染）。0.88 退役的 HTML 实现由本组件正式接替。
- **专家 ↔ agent 协同（apps/web/src/Pipeline.tsx）**：顶部状态条——按状态比例的细条（状态 token，2px 间隔，纯装饰）+ 每个状态一个带数量与占比的按钮（aria-pressed，点即只看该状态）；「无证据 / 仅一条证据」两个筛选把证据薄弱的断言一键筛出；筛选与文本框叠加，显示「剩余 / 总数」与「清除筛选」。未验证与有争议的断言带「裁决」：展开后三个按钮各复制一条 `ygl-trees research claim resolve '<id>' --as supported|refuted|contested --project='<项目>'`（人工仲裁是专家的事，写入仍走 CLI，页面不执行；标签只在剪贴板真收下时说已复制）。**复制的命令里每个自由文本参数（断言 id、项目名）一律经 `apps/web/src/shell.ts` 的 POSIX 单引号转义（`'` → `'\''`，不设「看着安全就不加引号」的捷径——zsh 会展开行首 `=`）；项目名以 `--project=<值>` 附着传递，避免 `-p --global` 被 CLI 当成旗标。粘贴进 sh / zsh / bash 都不得执行其中任何部分（#101、G13）**。证据行按来源标题显示（本页带本项目按相关度前 20 条来源的标题），否则回落 locator / 来源 id；无证据的断言直接写「无证据」；有置信度时显示「置信 X」。

### 4. 验证器三视图（M13-2，0.100.0 → 附件 0.101.0 → 作业面 0.102.0）
- 数据源：`/api/verify/*`（读 `$YGL_HOME/verify/*` 文件工件，不碰工作区库）；同源组件 `apps/web/src/Verify.tsx`。
- 视图一**材料提交**：标题 + 一段话（模糊输入是常态）+ 附件。附件先以原始字节 `PUT /api/verify/blob` 入内容寻址仓（服务端算 sha256、全局去重），提交只带 `{sha256,name}` 引用——客户端不报哈希、不传路径。上传门在端点（非回环绑定默认关，`YGL_VERIFY_ALLOW_UPLOAD=1` 开）。
- **体积（web_dist 棘轮）**：验证器视图不用 antd Form / Upload / Tabs——两字段草稿用受控 Input + 同文必填提示（label for 关联、aria-invalid、role=alert），附件用隐藏的原生 `<input type=file multiple>` 逐个上传并逐个回执，三个视图用手写 ARIA tabs（tablist/tab/tabpanel、方向键循环、roving tabindex）。三者连同 rc-form / async-validator / rc-upload / rc-tabs 共省约 60KB（web dist 1450936 → 1390693）。
- 视图二**构造追溯**（只读审计面）：左侧规范清单 → 右侧材料原文 + 构造结论（verdict/轮次/被拒）+ 「判据 ↔ 检查器」表（类型/比较模式/判据原文/锚点）。**没有 ✓/✗ 按钮**：判定链上没有人工确认，这里是事后复核入口。
- **规模与分页（#125）**：规范清单保持数组与运行次数/最近结论；报告和归档清单改为 `{items,total,next_cursor}`，`limit` 默认200、范围1–500，`cursor` 是绑定端点/spec/筛选的 opaque keyset，时间相同用稳定ID排序。报告看板每次30条，从服务端加载更多；“只看未通过”在服务端筛选，显示已载/总数，汇总明确只指已载记录，换规范/筛选重置游标。列表错误可重试，不显示假空结果。历史规范折叠、最新报告优先与详情滚动保持。列表摘要截断长文本，完整正文仍在详情端点。
- **持久摘要索引（#125 后续）**：`verify/.list-index.sqlite` 是可重建派生数据，不是业务库，不进入报告封包或业务schema。服务启动在报告列表就绪前对旧文件做一次异步导入/时间戳对账；已有未变文件不重parse。就绪后的报告/归档请求只读持久索引，按spec、时间和ID索引查页，不因超过5秒触发目录parse/stat。规范计数/最近运行来自索引SQL聚合。官方report写入与归档侧车追加同步更新摘要；外部增删/替换/原位写通过文件名watch增量刷新；读取前后时间戳一致且JSON/记录结构有效才落有效摘要，半写/变化中的文件有界重读。持续变化者保留上次有效行并标未完成；连续六次内容和时间戳均一致但仍无效者写入派生索引的 `excluded(kind,id,stamp,reason)`，排除该条而不拖垮服务或其他列表。后续有效重写清除排除项。真实watch测试先观察非报告哨兵事件确认平台watch流就绪，不假设watch调用返回即能收到文件事件；无文件名/监听错误时明确报列表不可用，重启做对账，不静默每请求全扫。服务器关闭等待初始化与watch队列/句柄退出。报告JSON仍是事实源，摘要截断字段不影响详情；缺/损坏索引须准备或重建后才可读，不回落隐式全扫。`firstReportPage/firstArchivePage` 明确只取前200行；完整翻页用page接口。万条回归覆盖新请求环境、>5秒间隔、冷首spec读零源文件IO、稳定游标和并发API。
- 视图三**报告看板**：报告详情把 FAIL/NEEDS-MATERIAL 例外项**置顶为处置清单**（带 severity 与行数），四态统计退居摘要；附引擎模式/签名身份/快照 sha/归档数。**语义边界首屏透出**（#27 Q3 / 方案 T6）：运行记录每行与报告头各带一个「边界」标签（`semantic_scope` ∈ structural「仅结构」/ factual「事实」/ semantic「语义」）；契约 ≤1.2 的报告没有该字段 → 按最保守的 structural 显示并标「缺省」，报告头另给**一行**说明「父 PASS 不代表子结论为真」（不在 Descriptions 里重复）；闭集之外的值（拼错 / 大小写 / 未来新值）同样回落 structural 并标「未知值」，可见面不失败开放；VU 表只在报告真带 `semantic_scope`（契约 1.3 起）时才加「边界」列，缺省不逐行重复。标签的说明走 Tooltip + 可聚焦 span + 标签内视觉隐藏文本（键盘 / 触屏 / 读屏可达；不给无 role 的 span 挂 `aria-label`，ARIA 1.2 禁止命名 generic 元素）；缺省提示只说「怎么读」、不描述检查器实际做了什么，声明值的提示才描述该层断言了什么。服务端列表投影原样透传（无字段为 null），不替报告发明值。报告详情是可用夹具静态渲染的 `ReportDetail`——种子库没有报告，运行时的视图验证器画不到它，新 UI 的证据是单测。
- 作业面（0.102.0，API-only）：`POST /api/verify/prepare|run` 由 `webui serve --enable-verify-jobs` 打开，默认 403。**UI 暂不调**——前端要长任务进度与取消语义（SSE 还没做），先给 agent/脚本用，免得把半成品按钮放出去。
- 渲染验证：`apps/web/tests/verify.spec.tsx`（静态渲染，断言三视图入口、附件入仓形态、无放行类按钮文案；规范现行/取代与工作清单排序、结论汇总、加载态不谎称为空、最近一次报告标题）；服务面契约 `packages/ops/tools/tests/verify-web.spec.ts` ×14（投影/幂等/405/404/穿越探针/415/413/上传门/archives/reports?spec/坏报告跳过）；blob 仓单测 `blob-store.spec.ts` ×8（含并发收尾）；作业面 `verify-jobs.spec.ts` ×16（门/方法/JSON/体上限/prepare 三件套/draft/缺 blob/非法 sha/缺材料/缺 candidates/run+归档/no_archive/archive_error/submission_dir/白名单）。

### 5. 产出工件（apps/web/src/Artifacts.tsx）
- 数据源：`/api/data` 的 `artifacts`（id/kind/title/version/created），正文按需 `GET /api/artifact?id=`。
- **一行一份文档**：`produce report` 随断言变化重生成同名报告（真实数据里 v1…v5），旧清单列成五行一模一样的标题、没有日期。现在同 kind + 同标题算一份文档，只显示最新版本（`vN · 日期`，UTC 日，与活动时间线同口径），旧版本收在「另有 N 个旧版本」后面；分组顺序报告 → 设计 → 规格 → 大纲 → 章节 → 笔记，组内按最新版本时间倒序。区块标题报「N 份文档 · M 个版本」（在 pages.tsx 里算，不从懒加载的 Artifacts 引入——它带着 react-markdown）。
- **阅读排版（.yt-doc）**：正文用正常字号、行高 1.7、单栏最宽 76ch（中文约 38 字一行），h1–h4 有层级，列表缩进在框内，表格与代码块横向滚动不撑破版面；旧版是 0.85em 铺满整页宽、标题与正文几乎同大、列表符号悬在框外。
- 点开正文：最后一次点击为准（慢请求不会把上一份正文落到下一行下面），读不到正文时明说并可再点重试；行与「旧版本」开关都可键盘操作并带 `aria-expanded`。
- 渲染验证：`apps/web/tests/artifacts.spec.tsx`（分组 / 版本折叠 / 日期 / 标题计数）。

## 技术约束

| 约束 | 理由 |
|---|---|
| 零 npm 依赖 | 保持运行时面最小 |
| 单 HTML 文件 | 可直接分享/离线打开 |
| 内嵌 CSS/JS | 不需要静态资源服务器 |
| 纯 SVG/CSS 渲染 | 不引入图表库 |
| `<script>` JSON 数据 | CLI 侧拼好嵌入，前端只做渲染 |

## 实施路径

```
src/webui/
  dashboard.ts    HTML 模板 + 数据注入
  views/
    brief.ts      仪表盘渲染函数
    tree.ts       SVG DAG 渲染函数
    research.ts   管线渲染函数
```

CLI 侧：`ops/tools/src/webui.ts` → `gatherData()` 单一收集器 → serve 各 /api 端点与 export 快照共用。

验证：demo §8 断言 `webui export` 落 snapshot.json 且 meta/brief/claims 载荷可解析（0.88 起）。

---

## 0.39 增补：事件驱动实时通道（SSE）

**问题**：0.33–0.38 的 React 客户端每 10s 轮询 `/api/data`——数据变更最长 10s 后才可见，且每次轮询都要全量重算 dashboard 载荷。

**方案**：服务端推送（Server-Sent Events），客户端零轮询。

```
GET /api/events   →  text/event-stream
  retry: 3000
  event: data
  data: {<完整 dashboard 载荷>}      ← 连接即发首帧（客户端无需另发 /api/data）
  …变更时再推同形帧…
```

**变更检测（服务端）**：1.5s 一次的**表指纹**——对 dashboard 渲染涉及的表取 `COUNT(*)`
拼成串（`FP_TABLES` 常量清单），指纹变化才 `gatherData` 并推送。要点：

- **按表容错**：某表缺失时该项记为 `?` 而不是整串抛错。**教训**：最初用
  `SELECT COUNT(*) FROM tasks` 取指纹，但任务不是独立表（是 `artifacts` kind='task' +
  meta 状态信封），查询每 tick 抛错 → 指纹恒为 `""` → 永不推送。容错式清单修掉。
- **代价常数**：18 张表 18 次 COUNT，无论客户端数量；推送前才做重载荷计算。

**生命周期**：指纹 tick 挂在 `ctx.timer.setInterval`（vendor 弹药 `cordis-plugin-timer`）
——ctx 释放即自动清理；插件缺失时回退裸 `setInterval().unref()`。

**停机**：SSE 客户端会永久占住 socket，`server.close()` 单独调用会等它们而永不回调。
`serve` 的 shutdown 先 `closeLive()`（结束所有 SSE 响应）再 `closeAllConnections()`
再 `close()`。**实测**：挂着 SSE 客户端时 SIGTERM → 324ms 退出。

**降级路径**：客户端 `subscribeDashboard()` 保留 10s 轮询，但**仅在 SSE 未接管时执行**
（`live` 标志）——老服务端、剥离 event-stream 的代理、EventSource 不可用时仍可用。

**验证**：
- 单测（`webui.test.ts`）：连接 → 首帧含 `tasks` 数组 → 写入新任务 → 1.5s 内收到变更帧且携带新标题
- 端到端（真实二进制）：首帧任务数 4 → 变更帧 5，帧内标题匹配
