# ygl-trees v0.2–v0.4 规格（spec）

日期：2026-10-15 ｜ 依据：[research.md](research.md) ｜ 状态：已评审定稿（与用户对齐范围：项目整体下一阶段）

## 0. 目标与非目标

**目标**：把 ygl-trees 修到"AI Agent 敢把唯一事实源托付给它"的程度——数据不丢、重复写入安全、数据可搬，然后在干净地基上补最小能力增强。

**非目标**（明确不做）：

- 不做服务端/常驻进程/多用户
- 不做 GUI
- 不引入新的运行时依赖（保持 `node-sqlite3-wasm` 唯一依赖；`fetch` 用 Node 18+ 内置）
- 不做并发安全的调度器（单进程 `job tick` 语义不变，只加悬空 run 检测）
- 不做 claim 仲裁的完整决策流程（只补状态出口，见 R6）

## 1. 需求与验收标准

### R1 备份完整性（修 P0-1）

`db export` 必须覆盖 schema 中全部**非虚拟**表的数据行，包括七张树表。

- **R1.1** export 输出含 `trees/nodes/node_edges/node_closure/node_conditions/node_state/node_index` 的 INSERT 行
- **R1.2** FTS5 虚表不导出数据（重建时由写入路径维护）；`node_closure/node_index` 属可重建派生数据，默认导出，`--lean` 可跳过
- **R1.3** 验收：对含树的库执行 export → 删库 → 逐行执行 dump → `db stats` 各表计数与原库一致；`node validate` 无 issue
- **R1.4** `db export` 末尾输出导出表清单与行数摘要（不再是静默操作）

### R2 写入幂等（修 P0-2）

同内容重复写入必须收敛到已存在行，且默认行为可被 `--force` 覆盖。

- **R2.1** 覆盖命令：`claim add`、`evidence add`、`query add`、`kb add`、`kb ingest`、`job add`
- **R2.2** 判重键：claim 按 `(project_id, sha1(text))`；evidence 按 `(source_id, sha1(quote))`；query 按 `(project_id, sha1(text))`；kb note 按 `sha1(title+body)`；job 按 `(title)`。实现方式：各表加 `content_hash` 列 + 唯一索引（schema v3 迁移，老库自动升级，存量行回填 hash）
- **R2.3** 重复时输出 `! duplicate, kept existing: <id>`（与 `source add` 现有格式一致），退出码 0
- **R2.4** `--force` 强制新建重复行（保留"同一引用录两条不同 locator 证据"类场景的逃生口）
- **R2.5** 验收：demo 中每条写命令连跑两遍，第二遍全部 `! duplicate`，各表计数不翻倍

### R3 树可移植闭环（修 P1-1）

- **R3.1** 新增 `node import --file <tree.json> [--tree <name>] [--merge]`：解析 `node export` 格式，重建树
- **R3.2** 默认语义：同名树已存在则报错退出（防覆盖）；`--merge` 按 `(tree, key)` upsert 节点、按 `(parent, child, rel)` upsert 边；导入后自动 `node index`
- **R3.3** 导入侧校验：节点引用的 parent/child 不存在、rel/mode 枚举非法、必检条件缺阈值 → 逐条报错拒绝，不部分导入
- **R3.4** 验收：`node export --out a.json` → 新库 `node import --file a.json` → 两个库分别 `node export` 输出 JSON 语义等价（忽略 id/时间戳/index 派生字段）

### R4 校验与错误出口补全（修 P1-3 / P2-5）

- **R4.1** `query done <id>` 对不存在的 id 报错退出 1；同规则适用于 `job enable/disable`、`research source rm`
- **R4.2** `node validate` 增加可选边（prereq|unlock 且 required=0）成环检测：对门控边全集跑环检查，报 `cycle(optional edges): ...`
- **R4.3** 验收：构造 a→b→a（可选边，经 `db sql` 直写）后 `node validate` 报 issue；不存在的 id 执行 `query done` 退出码非 0

### R5 CLI 一致性（修 P2-1 / P2-3）

- **R5.1** `--flag -1` 形式的负数值不再被吃掉：解析器对"下一参数是负数字面量"且 flag 非布尔时接受为值
- **R5.2** usage 文档补 `db sql "<sql>"`、`job enable <id>`；`--json` 全局说明保持准确
- **R5.3** `stateInit` 接线或删除（择一，倾向删除：`unlock/lock` 的 upsert 语义已覆盖；若保留则 `node unlock --init-tree` 调用）

### R6 研究管线最小增强（能力项，见 research §4）

- **R6.1** `source fetch <url>`：内置 fetch 抓取 → 提取 `<title>` / meta description / 去标签正文（纯文本截断存储）→ 走 `sourceAdd` 现有去重；失败（非 2xx / 超时 15s / 非 html）退出 1 不落库。**不做** JS 渲染站点
- **R6.2** `kb promote` L1 生成改进：优先取首部列表项/首个有效行（跳过标题与 generated 戳），剥离 ✓/[n] 等装饰符，附来源标注；无法提取时回落标题。验收（按实测修正）：对 demo 报告 promote 的 skill 在 `agent match "科技树 建模"` 命中且进入前二——修复前 L1 是 generated 时间戳，完全不可能命中
- **R6.3** `agent brief` 健康度：next_actions 增加两类感知——存在重复内容行（R2 之后理论上不再新增，存量仍可报）、`node_index` 脏（提示先 `node index`）

### R7 质量门禁

- **R7.1** `pnpm test` = `pnpm build` + demo 全量（`YGL_HOME` 指向临时目录）；demo 内新增断言：R2 幂等（§2.5 场景）、R3 round-trip、R4 错误退出码
- **R7.2** package.json 补 `files` 白名单（bin/dist/README/docs）与 `prepublishOnly: pnpm test`；不实际发布，只把面准备好
- **R7.3** 单元测试框架**本阶段不引入**（CLI 快照式回归已覆盖主路径；引入 vitest 等留待规模再判断）

### R8 Gate 决策模型布尔评估（2026-10-16 立项，0.14.0；依据 vercel-ai-gateway-eval-api.md 调查）

**动机**：必检条件中 `quest`/`expr` 类语义门槛（"任务完成了吗"）无法用状态袋数值比较判定——现 `evalCond` 在状态袋无对应键时**静默判 false**。评估模型（TypeSafe jev，经 Vercel AI Gateway）提供**确定性布尔判定 P(true)**（同题方差≈0、1-2s/次、中文原生、证据不足时概率塌缩而非硬答），恰好补上这块，且与 ygl-trees 三态输出天然契合。

- **R8.1 新 op**：`node cond <key> --name <c> --op eval --value "<判定问题>"`——value 为问题措辞（材料 §5 纪律：**问题与 state 字面对齐**，不脑补）
- **R8.2 上下文包**（关联+索引供料）：`node can <key> --eval` 组装 state = 节点元数据（key/name/kind/tier/cost）+ 直接父（node_edges 关联）+ 祖先链（node_closure 索引）+ 该节点全部条件 + 已解锁集 + `--state` 袋——**state 必带上下文包**（裸消息判路由 6/8 落灰带的教训）
- **R8.3 评估客户端**（src/eval.ts）：Gateway v4 协议四头缺一不可；token 解析 `AI_GATEWAY_API_KEY` → 回退 `~/.vercel.ai-gateway.env`（`token=...`）；429/529 指数退避 ≤3 次、400/401 不重试；超时 60s；零新依赖（全局 fetch，与 source fetch 同模式）
- **R8.4 三态映射**：P≥0.7 → 通过；P≤0.4 → 未通过；**0.4<P<0.7 → pending 灰带**（过程态禁作终态）；必检聚合中 pending 单列（既非通过也非 missing_required）
- **R8.5 Offline-safe**：无 token / 网络失败 → 该条件 `pending (no evaluator)`，rc=0——评估器是增强不是依赖；确定性 op（>=/==/has…）行为不变
- **R8.6 留痕与输出**：events 记 `eval.gate`（条件名/P/outcome）；`node can --json` 新增 `evaluated: [{name, question, p, outcome}]`（加法字段，契约兼容）
- **R8.7 验收**：离线（无 token）`node can` 对 op=eval 条件输出 pending、demo 断言此路径（demo 保持离线可跑）；有 token 环境手动冒烟结果记入提交说明；`node validate` 对 op=eval 的必检条件不再要求 value 非空（value 是问题措辞，缺省回落用 name）

- **R8.8 choice/score 题型（2026-10-16 立项，0.26.0）**：op 家族扩为 `eval`（布尔 P(true)）/ `eval-choice`（多选一，`--options "k=desc,..."` + `--answer k`）/ `eval-score`（等级评分，`--levels "级0,..."` 2-10 级 + `--min-score n`）；**零 schema 变更**——问题与选项打包为 value 内 JSON 信封 `{"q", "options"/"levels", "answer"/"min"}`（parseEvalSpec 对 plain 字符串向后兼容）；三态映射：choice 判 **P(期望答案)**（阈值与布尔同源 eval.pass/fail_threshold）、score 判 **score∈[0,N-1]**（≥min pass / ≤min−1 fail / [min−1,min) 灰带）；missing_required 显示问题措辞而非 JSON；离线安全与凭证优先级链同 R8.5；题面纪律：选项/等级描述必须编码业务价值排序（材料 ρ=0.25 教训）

**非目标**：评估结果不写回数据库（每次 `can` 现评，保持无状态）。~~`node ready --eval` 批量评估留后续批次~~（0.16.0 落地；0.27.0 扩为三题型混批）。

### R9 关联织物通电（2026-10-17 立项，0.29；依据 WebUI 检阅意见 4）

**动机**：`relations` 表（类型无关万向关联，schema 早期埋线）唯一入口是 `kb link`（kb↔kb），nodes/claims/evidence/artifacts/skills 全接不进来——研究域与科技树域是两条平行流水线，科技树成数据孤岛，可视化无从展示"节点 ↔ 证据 ↔ 报告"的关系。

- **R9.1 引用语法**：`<type>:<ref>`——`node:<tree>/<key>`（裸 `node:<key>` 在当前树解析）、`claim:<id>`、`evidence:<id>`、`source:<id>`、`query:<id>`、`kb:<id>`、`artifact:<id>`、`skill:<name>`
- **R9.2 命令**：`rel add <src> <dst> [--rel <type>]`（默认 related；幂等：同四元组重跑 rc=0 报 duplicate）、`rel list [--src <ref>] [--dst <ref>] [--rel <type>]`、`rel rm <src> <dst> [--rel <type>]`
- **R9.3 解析校验**：两端引用必须指向真实行（404 → rc=1）；类型与 id 分离存储（src_type/src_id 沿用 relations 现有列，src_id 存实体 id——node 存 node.id，skill 存 name）
- **R9.4 WebUI 关系叠加**：`/api/node` 返回 related 数组（双向：src 或 dst 命中该节点），带对端类型+显示名（claim 取 text 摘要、kb 取 title、artifact 取 title）；节点详情面板新增 related 区（可点击跳 kb/claim 详情）
- **R9.5 验收**：demo 断言 rel add/list/幂等/404；dogfood release-gate 树的节点挂上 claim/kb 后面板可见；单测覆盖引用解析与双向查询

### R10 遥测地基（2026-10-17 立项，0.30；依据 WebUI 检阅意见 5 + DSH session-telemetry 概念对照）

**动机**：events 是事务性审计账本（事件与数据变更原子——强于 best-effort 镜像），但半盲：树域 0 事件（0.12.0 "不写 events" 例外成盲区）、命令失败不可见、无 severity、无 run 关联、**eval gateway 返回的 usage tokens 被丢弃**。

- **R10.1 树域留痕**：node.add/link/unlock/lock/cond.add 写 events（推翻 0.12 例外）；tree 域其余（index/export）保持不留（纯派生操作）
- **R10.2 severity**：events 加 `level TEXT NOT NULL DEFAULT 'info'`（info|warn|error）——schema v7，九触点走齐；error 级=命令 rc=1 的运行信号
- **R10.3 run 关联**：每条 CLI 命令一条 `cmd.run` 事件（group/action/rc/duration_ms）——回答"这次会话做了什么"；同进程内事件带同 run id（events payload.run）
- **R10.4 eval usage 捕获**：eval.gate payload 增 usage（gateway 返回的 inputTokens/outputTokens；postEval 透传 usage 字段）
- **R10.5 agent log 升级**：`--level` 过滤、`--run <id>` 聚合、usage 汇总（eval 花费可见）
- **R10.6 验收**：树操作后 `agent log` 可见留痕；失败命令留 error 级 cmd.run；eval 后 usage 累计可查

### R11 时间维度（2026-10-17 立项，0.31；检阅意见 5）

- **R11.1**：树视图时间轴模式——tier 布局 ↔ 时间布局切换；X 轴=时间（node.created / node_state.updated 解锁时刻），解锁前的节点灰显
- **R11.2**：研究管线时间线——sources/evidence/claims/artifacts 按日聚合的推进视图（消费 events）
- **R11.3 验收**：dogfood release-gate 三幕解锁弧在时间轴可回放

### R12 工程产出形态（2026-10-17 立项，0.32；检阅意见 1/2/3）

- **R12.1**：artifacts kind 扩 `spec`（需求规格）、`design`（多类型：ui-ux/arch/decision，payload 元数据带 design_type）、`task`（todo|doing|done 状态机）
- **R12.1a design 方法论裁定（用户 2026-10-17）**：**前端/UI design 采用 [DESIGN.md 格式](https://github.com/google-labs-code/design.md)**（YAML tokens + rationale 固定节序 + `@google/design.md` lint/diff/export 工具链）——仓库根 `DESIGN.md` 即 webui 的设计系统单一事实源，后续前端视图（R11 时间轴、R13 pan/zoom）以它为 token 来源；**其他 design 类型（arch/decision）由 Agent 定义**（ADR 风格：上下文/决策/后果三段）
- **R12.2**：`produce spec/design` 命令；`task` 独立命令组（add/list/done）；webui 任务清单视图（status 分组 + 勾销）
- **R12.3 验收**：spec/design/task 均可 R9 关联到树节点；任务清单勾销全程留痕；DESIGN.md lint 0 error

### R13 真实规模树与方法论（2026-10-17 立项，0.33；检阅意见 6/7）

- **R13.1**：dogfood #4——把 ygl-trees 自身演进（0.1→当前）建成 30+ 节点分叉树（含 R9 关联与 R12 产出）
- **R13.2**：方法论 skills——树构建法（领域分解/衍生）、关联方法论（研究资产挂节点）、design 捕获法
- **R13.3**：viz pan/zoom（SVG viewBox 拖拽缩放）支撑真实规模
- **R13.4 验收**：30+ 节点树在 webui 可浏览可缩放；三个新 skill 可被 agent match 命中

**R13.5 React 技术栈裁定（用户 2026-10-17，0.32.1 起）**：WebUI 的富客户端按需取用以下 React 资源——[xyflow](https://github.com/xyflow/xyflow)（**树/DAG 交互视图核心**：pan/zoom/拖拽/小地图，R13.3 主力）、[ahooks](https://github.com/alibaba/hooks)、[react-router](https://github.com/remix-run/react-router)、[pro-components](https://github.com/ant-design/pro-components)、[remix](https://github.com/remix-run/remix)、[react-grid-layout](https://github.com/react-grid-layout/react-grid-layout)（仪表盘面板）、[react-pdf](https://github.com/diegomura/react-pdf)、[react-markdown](https://github.com/remarkjs/react-markdown)（报告/规格渲染）。**架构分工**：`apps/web` 为 React 家园（Vite 构建，开发期 proxy /api → CLI serve）；CLI 内嵌零依赖 dashboard（webui export/serve）**保留**——离线单文件导出与轻量检阅不受构建链拖累。DESIGN.md 仍是 token 单一事实源（React 组件消费同一套 token）。

### R14 插件化补完（2026-10-17 立项，0.34.0 L1/L2；0.36.0 L3 落地——用户裁定"非常需要，可用于生产和实践的业务域"）

- **R14.1 L1 接线**：`ctx.research`/`ctx.techtree` 全部接上；compose.ts 死代码删除；rc.11 时序探针记录（named-apply 服务可注册、inject 链 wall-time 沉降但 setImmediate 泵不可靠——CLI 保留直构回退、长驻进程走服务）
- **R14.2 L2 声明式组合**：`ygl.bundle.json` 声明插件清单（数据说 WHAT），`main.ts PLUGINS` 注册表管模块解析（代码说 WHERE），schemastery 校验声明；**不引 DSH fork loader**（规则 7 精神：不拖 fork 运行时）
- **R14.3 T1 套件引入**：`@deepseek-ai/dsh-atomic-write`（webui export / db export 原子写）+ `@deepseek-ai/schemastery`（组合声明校验）；T2 裁不引（已自研等价 + fork 拖拽风险）
- **R14.4 L3 用户层插件分发（0.36.0，DSH apps/cli 应用典范）**：工作区级 profile `$YGL_HOME/plugins/`（pnpm 管理）+ 用户层声明 `ygl.user.bundle.json`（叠在 base bundle 上）；`ygl-trees plugin init/install/remove/list`（本地目录自动 link:；install/remove 走 withFileLock；名字=依赖键差集精确解析；YGL_PACKAGE_MANAGER 注入包管理器）；插件契约 `apply(ctx,config)` + 可选 `commands` 贡献 CLI 命令组（dispatch：插件命令优先于 unknown）；逐插件隔离加载，失败汇总 StartupError → 终端摘要 + 报告落盘 `$YGL_HOME/logs/startup-<uuid>.log`；`yglTrees` 兼容声明主版本不符仅警告；doctor 第 9 项 plugin_profile；bounded shutdown（createProcessShutdown 5s 宽限/信号升级）；apps/cli 分层典范（bin 薄入口 / boot 组合 / diagnostics 诊断落盘 / shutdown 停机）；示例 examples/plugin-demo + docs/plugin-authoring.md

## 2. 数据模型变更（schema v2 → v3）

| 表 | 变更 | 迁移 |
|---|---|---|
| claims | + `content_hash TEXT NOT NULL DEFAULT ''` + `UNIQUE(project_id, content_hash)` | 存量回填 `sha1(text)` |
| evidence | + `content_hash TEXT` + `UNIQUE(source_id, content_hash)` | 回填 `sha1(quote)` |
| queries | + `content_hash TEXT` + `UNIQUE(project_id, content_hash)` | 回填 `sha1(text)` |
| kb_notes | + `content_hash TEXT` + `UNIQUE(content_hash)` | 回填 `sha1(title || '\|' || body)` |
| jobs | 无 schema 变更；应用层按 title 判重（存量撞名无法安全建唯一索引，故不加约束） | 撞名存量行不合并；`job add --force` 的重复语义 = title 自动加序号后缀（如 `nightly-2`），不走 hash 加盐 |

- 迁移规则：`db.ts` migrate() 读 `user_version`，v<3 逐版执行 ALTER + 回填 + 索引 + 版本号推进；失败整体回滚
- `--force` 语义实现取舍：不绕唯一索引（那是数据损坏入口），而是 `--force` 时 hash 加盐后插入——重复行显式可查（`--dups` 列出同 hash 行），不做静默分叉

## 3. CLI 面变更清单

```
新增：node import --file <json> [--tree name] [--merge]
新增：source fetch <url> [--tags ..] [--confidence A|B|C]
新增：db export --lean（跳过派生表数据）
修改：claim/evidence/query/kb/job 写命令 → 幂等 + --force
修改：query done / job enable|disable / source rm → 404 语义
修改：db export → 全表 + 摘要
修改：agent brief → 健康度 next_actions
文档：usage 补 db sql / job enable
```

### R15 决策模型增强（2026-10-17，0.49–0.50）

- **R15.1 语义检索重排**：`kb search "<q>" --eval` — FTS5 召回后由决策模型逐条评估 P(语义相关) 并重排；离线安全（无凭证显示"离线"并保持原序）
- **R15.2 断言置信度评估**：`research claim evaluate <id>` — 收集关联证据，决策模型综合评估 0-5 分并映射 A/B/C/D；**`claim link` 自动触发**（评估结果写 events 表 `claim.eval`，报告输出自动附带）
- **R15.3 证据质量评估**：`research evidence assess <id>` — 决策模型评估来源可靠性 + 引文质量（0-5 分 → 高/中/低）
- 复用 R8 基础设施（AI_GATEWAY_API_KEY / TypeSafe jev / 三态映射 / 离线安全）；新增 `eval-enhance.ts` 模块（semanticReRank / evaluateClaimConfidence / assessEvidenceQuality）
- 验收：三种查询全命中（模型在线）/ 离线安全（无凭证不炸、显示"离线"）/ `claim link` 自动评估并写遥测 / `produce report` 附带模型置信度

## 4. 兼容性承诺

- v2 老库首次被 v3 CLI 打开时自动迁移，无损、无需人工介入；迁移在事务内
- JSON 输出结构只增字段不改字段名；退出码语义：0 成功（含"重复已存在"）、1 运行错误、2 用法错误
- **flag 校验是冻结契约**（0.54 定契）：裸 flag（`--flag` 无值）→ rc=2 `needs a value`，**绝不落库为 `"true"` 字符串**；枚举型 flag（`--kind`/`--op`/`--effect`/`--confidence`/`--stance`/`--rel`/`--mode`）非法值 → rc=2 `must be one of ...`，**不触发任何写入**。回归护栏：`pnpm contract:audit` contract 6（11 项）机械断言
- **`--json` 是机器通道，成功与失败同样可整体 `JSON.parse`**（0.44 定契）：成功按命令语义输出对象/数组；
  失败输出单对象 `{"error": "<msg>"}`（`error` 为非空字符串），失败类别仍由退出码承载（1 运行 / 2 用法）；
  字段一律 snake_case（camelCase 泄漏视为违约）；人类用法/提示文本只在**非 json 模式**输出。
  回归护栏：`pnpm contract:audit` 的 contract 5（31 条读命令 + 6 条错误路径）机械断言本承诺
- `node export` 格式不变；`node import` 按 R3.3 严格校验，坏文件零副作用
