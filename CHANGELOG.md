# Changelog

## 0.54.0（2026-10-17）全命令面 flag 校验审计——14 个缺口一次关死
- **背景**：0.51 修了 P1-1/P1-2 两个 flag 校验缺口，但审计发现同类问题成片存在——**全命令面扫描**暴露 **14 个缺口**（9 个裸 flag 静默落库 + 5 个枚举未校验）
- **新增 `flagcheck.ts`**：`rejectBare(ctx, flags, names)` 裸 flag 检测 + `validateEnum(ctx, flags, name, allowed)` 枚举校验——一处定义，各命令复用
- **修复的 14 个缺口**：
  - 裸 flag（`--flag` 无值 → parser 返回 boolean `true` → 落库为 `"true"` 字符串）：
    `source --abstract/--confidence/--tags` · `claim --confidence/--text` · `kb --body/--tags` · `node --name/--kind/--tier/--cost/--tags` · `cond --name/--value/--op/--effect/--weight` · `task --note`
  - 枚举未校验（非法值静默落库）：
    `node --kind`（只收 tech|skill|quest|milestone|resource|flag）· `cond --op`（只收 >=|==|<=|!=|has|eval|eval-choice|eval-score）· `cond --effect`（只收 gate|cost_mul）· `claim/source --confidence`（只收 A|B|C）
- **效果**：任何 `--flag` 缺值或枚举非法值 → **rc=2 + 明确错误消息**（`--X needs a value` / `--X must be one of ...`），不再有 `"true"` 或 `"nonsense"` 落库

## 0.53.0（2026-10-17）React 客户端构建链缺口修复——冷用户反馈三件
- **来源**：用户在 :8322 部署后发现 `/` 显示内嵌 dashboard 而非 React 客户端（React dist 缺席 + 静默回落）
- **P1 根因修复**：`pnpm build` 现在包含 React 客户端构建（`tsc → tsdown → vite build`），新 clone 不再默认落后一态
- **P2 静默回落消除**：`webui serve` 启动时检测 React dist 是否存在，缺席则输出醒目 warn `⚠ React 客户端未构建 — 当前为内嵌 dashboard 回落态` + 构建命令——违背「显式契约」哲学的静默行为已消除
- **P3 `/classic` 永远 200**：回落态下 `/classic` 原先 404 但首页是同一内容——语义混乱；现在无论 React 是否构建，`/classic` 始终返回内嵌 dashboard（兑现「零依赖版永远可达」承诺）
- 事故链：`apps/web/dist` 缺席 → `resolveDistRoot()` 返回 null → `hasWebApp=false` → 内嵌版占 `/` → 用户看到的是简化版但**没有任何提示**

## 0.52.0（2026-10-17）真实使用反馈修复——数据安全三件 + 仓库卫生
- **来源**：用户在 :8322 部署运行后的实测反馈（含 DEV-LEDGER 483MB 事故复盘）
- **P0-1 kb import 文件大小护栏**：>1MB 的 .md 默认跳过并在 summary 列出（`--force` 覆盖）——防止 483MB 单文件把库撑到 472MB 并损坏的事故重演
- **P0-2 写库互斥（单写者锁）**：DB 构造时检测 `.db.lock` 目录，第二个进程 fail-fast 并提示（15 分钟过期自清，同 job tick 策略）；`process.on("exit")` 兜底释放——node-sqlite3-wasm 无并发写保护，两个 CLI 同时写 = malformed
- **P1 malformed 报错附带自愈指引**：`database disk image is malformed` 时输出三步恢复路径（备份→db reset→kb import 重灌），不再让用户自己悟「库可从源文件重建」
- **P2 vendor/cordis/bin.js 移出 git 追踪**：本地 `pnpm install` 会改写该文件导致每次 pull 冲突；加入 .gitignore
- **P4 --version 打印版本号**：parser 把 `--version` 吞成 flag 而非 positional——修在 flags 检查处（0.51 遗留的错位修复）

## 0.51.0（2026-10-17）冷用户验证修复——2 处数据完整性 + 2 处环境级 + 体验
- **来源**：外部冷用户验证报告（干净 clone + 全门禁 + 手工全链演练），发现 2 处校验缺口 + 4 类工程问题
- **P1-1 修复**：`research source add --title`（无值）原先**静默写入 `{"title":"true"}` 垃圾行**（rc=0 违反契约）→ 现在检测 boolean `true` 值并拒绝 `rc=2`；另增 `--url` 格式校验（须 http(s):// 或 file://）
- **P1-2 修复**：`claim link --stance nonsense` 原先**静默接受并把 supported 断言降级为 unverified** → 现在只收 `supports|refutes`，其余 `rc=2` 且**不触发任何写入**
- **P2-1 修复**：vite 升到 ^6.4（vitest 5.0.5 的 peer 要求 ^6.4||^7||^8）→ `pnpm test:unit` 在干净 clone 可跑（此前 ERR_PACKAGE_PATH_NOT_EXPORTED 启动即崩）
- **P2-2 修复**：锁文件重生成 → `pnpm install --frozen-lockfile` 通过（此前 OUTDATED_LOCKFILE）
- **P3-1**：`pnpm.neverBuiltDependencies` 豁免 better-sqlite3（自带 prebuilds，node-gyp rebuild 多余且失败）
- **P4 修复**：`--version` 现在打印实际版本号（如 `0.50.0`）而非整个 usage 文本（parser 把 `--version` 吞成 flag 而非 positional，修在 flags 检查而非 group）
- contract:audit 新增两项护栏可加入：flag 缺值 rc=2 / stance 枚举 rc=2（当前由代码修复保障，待加门禁）

## 0.50.0（2026-10-17）R15 深度集成——模型评估从手动命令变为自动行为
- **`claim link` 自动触发置信度评估**（R15 深度集成）：链接证据后静默调用决策模型，评估结果写 events 表（`claim.eval`）+ 终端提示一行 `[模型] 置信度 B (3.5/5)`；best-effort（模型失败不阻塞链接动作）
- **`produce report` 自动附带模型置信度**：报告输出各断言时，从 events 表读取最近的 `claim.eval` 记录，有则追加 `_模型置信度 B（3.5/5）_` 行——人工置信度与模型置信度并排可见
- **spec.md 补 R15 条目**（R15.1 语义重排 / R15.2 置信度评估含自动触发 / R15.3 证据质量），与 R1-R14 同格式
- **skills 更新**：ygl-trees-research 补 evaluate/assess、ygl-trees-knowledge 补 --eval
- **eval-enhance 单测 3 例**（离线安全路径：空 token → null/uncertain/不炸）；修 token 默认值逻辑（显式空串=离线，未传参=环境变量）
- 单测 120 → **123**

## 0.49.0（2026-10-17）R15：决策模型增强——语义检索重排 + 断言置信度评估 + 证据质量评估
- **R15.1 `kb search --eval`**：FTS5 召回后由决策模型逐条评估语义相关性 P(relevant) 并重排——实测：搜"插件系统"命中 drift 教程（P=0.05），模型正确判定低相关
- **R15.2 `research claim evaluate <id>`**：收集关联证据 → 决策模型综合评估置信度（0-5 分 → A/B/C/D 映射）——实测：人工标 A 的断言，模型基于证据评为 **3.5/5 → B**（比人工更保守，有依据）
- **R15.3 `research evidence assess <id>`**：决策模型评估证据来源可靠性 + 引文质量——实测：源码引文评 **2.9/5 → 中等**
- **复用 R8 基础设施**：同一模型连接（AI_GATEWAY_API_KEY / TypeSafe jev）、同一三态映射、同一离线安全（无凭证 → 显示"离线"并回退，不炸）
- **新增模块 `eval-enhance.ts`**：semanticReRank / evaluateClaimConfidence / assessEvidenceQuality 三个可复用函数，任何搜索/评估场景可调用
- 中文输出（断言/当前状态/模型评分/可靠性 全中文标签）

## 0.48.0（2026-10-17）冷启动技能自动导入——修产品入口的最后一道缝
- **问题**（冷启动实战发现）：`db init` 后的全新工作区 `agent match` 返回空——技能需手动 `skill import`，冷用户会以为工具没有能力
- **修复**：`db init` 自动导入内置 9 个技能（向上探测包内 skills/ 目录，逐技能隔离导入），全新工作区的 `agent match` **立即可用**；三种不同查询实测全命中（"插件系统设计"→quickstart / "怎么建一棵科技树"→techtree / "做调研收集证据"→research）
- **效果**：冷启动体验从「db init → 什么都搜不到 → 困惑」变为「db init → 9 技能就绪 → match 即可用」——产品入口不再有缝

## 0.47.0（2026-10-17）冷启动实战 + 完整研究闭环——产品承诺的终极验证
- **冷启动验证**：全新工作区，零上下文 Agent 仅靠 `agent brief`（给出 next_actions）+ `agent match`（命中 ygl-trees-research 技能）即上手——产品入口有效
- **真实研究（非功能测试）**：「AI Agent 插件系统设计模式对比（Cordis vs DSH vs VSCode）」——4 检索式 → 4 来源（1 网页抓取 + 3 本地第一手源码知识）→ 6 条证据摘录 → 5 条断言（全部链接证据 + 仲裁为 supported）→ outline + 对比章节 + **61 行报告**（含四维对比表与四条核心发现）
- **知识复用闭环全通**：报告 `kb ingest` → `kb promote` → 技能 `plugin-design-patterns` 生成 → **跨进程 `agent match` 命中**（换两种完全不同的问法均命中）——下次任何 Agent 问插件框架选型，L1 描述自动浮现
- **核心发现**（报告摘要）：① 粒度决定架构（VSCode 面向功能面、Cordis 面向服务、DSH 面向组合）② declare module 是 Cordis 杀手锏 ③ 有界停机 + 诊断落盘是 CLI 层必备 ④ 采纳能力 ≠ 采纳机械（loader 裁定范例）
- **产品验证结论**：冷启动→研究→产出→知识复用→下次命中，完整闭环在真实数据上走通——**工具是好用的，不只是好测的**

## 0.46.0（2026-10-17）WebUI 端到端验证 + 基准刷新（用户确认不发布 npm）
- **WebUI 全量验证**（维护后数据）：37 节点树（React 客户端水平布局）+ 34 解锁/3 锁定态可见 + 45 条边；SSE 实时推送实测（首帧 + 变更帧携带新任务标题）；`/classic` 内嵌回退 200；中文标签 8/8 命中（科技树/任务清单/产出工件/下一步操作/技能/知识笔记/断言/证据）
- **基准刷新**（0.45.0 构建，bundle 入口）：startup p50 571ms / claim-write 21.6ms/op / kb-import 2672 rows/s / kb-search p50 24ms / node-index 577ms / node-search p50 2.8ms——各席均在正常区间，含 RSS 内存端点
- **npm 发布决策**：用户明确选择「先不发布」——不再追问，待后续再定
- **用户洞察**（记录）：「你自己就是用户」——ygl-trees 面向 AI Agent，本会话中的 Agent 即目标用户，`real-users` 门槛的四个条件（非作者/真实用户/日常使用/受益）在字面上均满足；保留：热用户（知内部实现）≠ 冷用户（首次接触仅靠 brief/match 上手），后者才是生产级工具的终极验证

## 0.45.0（2026-10-17）应用 lifecycle 技能做了一次真实维护回合——挖出三处缺陷并修
- **背景**：用户要求「使用技能 ygl-trees-lifecycle」。按其 §3 节奏对真实工作区（tmp/research-dogfood）执行：`agent brief` → 对账 → 动作 → 收口 `doctor`
- **对账发现的漂移（技能 §5 反模式 #1/#6 大规模发生）**：evolution 树 **32 节点全部未解锁**，而实际已交付 0.1.0–0.44.0；且交付期间新增能力（用户插件/bundle 产物/SSE/契约门禁/JSON 错误契约）**在树上根本没有节点**（§1「未建模子能力」）
- **维护动作**：新增 5 个能力节点并挂接（`packages→user-plugins`、`packages→bundle-dist`、`webui-serve→sse-live`、`json-contract→json-errors`、`idempotency+json-contract→contract-gates`）→ **同轮** `node index`（268 闭包行）+ `node validate`（无 issue）→ 建证据链（1 源 + 6 条 CHANGELOG 原文摘录 + 6 条交付簇断言，链→resolve）→ **34 节点解锁且每个同轮 `rel … --rel decided-by` 挂依据** → 既有 report/spec/design 工件挂到相关节点 → `kb ingest` 报告 + 2 条方法论笔记 → 清理自己的临时任务 → 收口 `doctor`（all checks passed）。终态：**34 unlocked / 3 locked**（bun-runtime、npm-publish、real-users 的门槛实测仍生效）
- **顺带修的三处真缺陷**：
  1. **假状态（比缺状态更坏）**：任务「发布到 npmjs」显示 done 但从未发布——events 显示它创建后 2 秒被状态机演练走完（演练用了真实标题）。已回退为 `doing`
  2. **未宣传的能力**：`task todo` 可逆生效（实现与另一处 usage 都支持），但**顶层 usage 只写 doing|done** → 补齐；demo 增回退护栏（done→todo→done）
  3. **投影盲区**：`node_state` 权威表有解锁行，而 CLI 的 `node list/show` **不返回 state/unlocked_at**（只有 WebUI 与裸 SQL 看得到）→ **节奏纪律要求「解锁后对账」而 CLI 无从对账**；已补 `state`/`unlocked_at`（`nodeStateOf` 独立方法，**不碰写路径复用的 `nodeGet`**——多 context join 会让行数放大、`db.get` 静默取错行），`node list` 增「状态」列，demo 增 3 条断言（含锁回可逆）
- 契约兼容：JSON 只增字段（`node.list[].state`/`node.show.node.state`），不改名不删——符合「只增字段」承诺

## 0.44.0（2026-10-17）JSON 通道契约：失败也必须机器可读（+31 读/6 错误路径机械断言）
- **侦察（读侧对称体检）**：常用 21 条读命令**全绿**（纯 JSON + 零 camelCase 泄漏）；但角落与错误路径抓到两处真问题
- **修复 1：`--json db path` 输出裸路径文本**（成功路径的纯净性违规，agent 侧 `JSON.parse` 直接崩）→ 改 `{"path": ...}`
- **修复 2：所有错误写到 stdout 污染机器通道**（`--json` 下 `✗ parent not found: …`）→ `bad()` 单点修（129 个调用方受益）：json 模式输出单对象 `{"error": "<msg>"}`，rc 仍 1/2 承载类别；非 json 模式人类文本不变。另修 bin.ts 两处 `out(ctx, usage())` 在 json 模式泄漏用法转储
- **契约措辞落文档**：spec「兼容性承诺」明确 `--json` 成功与失败同样可整体 parse、`error` 非空字符串、snake_case 硬约束、人类文本只在非 json 模式；AGENTS 契约表增两行
- **门禁扩展**：`contract:audit` 增 **contract 5: JSON 通道**——31 条读命令（含角落：parents/children/ancestors/descendants/path/ready/export/validate/search）断言 stdout 可**整体** parse + 无 camelCase；6 条错误路径断言 `{error}` 形状 + rc（1 运行 / 2 用法）。门禁 37 → **73 项**，四段制全绿
- **工具化**：内联 node 校验器改为独立 `scripts/json-check.mjs`（消除 bash 内嵌引号地狱，单测与门禁共用同一判定）
- **根治推送摩擦（0.43 记录的交互）**：2 分钟钩子期间与远端零流量 → SSH 会话被远端回收 → 传输 `rc=141`。已配置 `core.sshCommand` 带 `ServerAliveInterval=20`（空闲心跳），并**用带钩子的真实推送验证**不再需要旁路；docs/release.md 记根治方案，旁路降为兜底

## 0.43.0（2026-10-17）写路径契约体检 + 常驻审计门禁（同类违规不能再悄悄回归）
- **背景**：0.42 发现 `node link` 幂等崩溃，是"写技能时顺手实测"撞出来的——说明冻结契约需要**机械化体检**而非靠人记得。先做侦察 sweep（16 条写命令 × 2 + 11 条坏引用），确认缺陷边界
- **修复 1：`project new` / `tree new` 同名幂等**——原先 rc=1 `SqliteError: UNIQUE constraint failed` 崩溃，违反「同内容重跑 rc=0 + duplicate:true」；改为**选中既有行**并回执 `duplicate: true`（`new` 同时也是切换动词），仍更新 `current_project`/`current_tree`；文本回执区分 `created and selected` / `exists, selected`
- **修复 2：`research claim link` 坏引用裸异常**——传不存在或类型错的 evidence id 抛 `FOREIGN KEY constraint failed`；改为两端预解析、点名实体（`claim not found: X` / `evidence not found: Y`）。审计确认**其余 10 条引用命令本就干净**（evidence add / claim resolve / query attach / kb ingest / kb link / rel add / task doing / node link…），纪律已在、仅漏这一处
- **新增 `pnpm contract:audit`（scripts/contract-audit.sh，37 项）**——把四类冻结契约变成可执行断言：① **幂等**（16 条写命令各跑两次，均须 rc=0）② **duplicate 回执**（project new / tree new / node link 重复须 `duplicate:true`）③ **坏引用点名**（11 条引用命令遇坏 id 须 rc=1 且消息点名实体，**断言不出现 SqliteError/constraint/TypeError 裸异常**）④ **用法 rc=2**（5 条）
- **门禁自证有效**：临时还原 claimLink 缺陷 → 门禁 34/37 红、rc=1；恢复后 37/37 绿（不是空跑）
- `pnpm test` 升为**四段制**（unit + build + demo + contract:audit），pre-push 钩子因此自动把关该项；README/AGENTS/release.md 同步
- **实测到并记录一个运维交互**：钩子跑完整门禁约 2 分钟、期间与远端零流量，Gitee 的 SSH 会话会在此期间空闲断开 → 钩子通过后的传输立刻失败（`unexpected disconnect while reading sideband packet` / `closed by remote host` / rc=141 SIGPIPE），**而门禁是绿的**。处置：以门禁输出为证据，`YGL_SKIP_HOOKS=1 git push` 重推；钩子现会主动打印这条提示，docs/release.md 记入「已知交互」

## 0.42.0（2026-10-17）新增 lifecycle 技能（更新时机）+ 修复 node link 幂等契约违规
- **新技能 `ygl-trees-lifecycle`（用户指出缺口）**：现有 9 个技能全在讲「**怎么动**」（机制）与「动成什么样」（方法论），**没有一个讲「什么时候动」**——「时机/维护/节点更新/cadence」类词汇全库零命中，agent 机制全会却在该动的时刻不动，树与研究两条流水线各自漂移。新技能补上：**事件→动作触发表**（树侧 9 行：达成→unlock+挂证据、发现子能力→add+link、路线互斥→excludes、语义门槛→eval、方向变更→先加边再索引再 unlink、重新拆解→先建后删、重复 link→幂等语义…；研究资产侧 10 行：何时 source/evidence/claim/link/resolve/kb/promote/task/produce/rel）、**节奏纪律**（改结构后同轮必 `node index`+`validate`、解锁后必挂证据、会话收口前 `brief`+`doctor`、批量改写前 `db export`）、**五个自问**判定口诀、**漂移六反模式**、与专职技能的分工表。已 junction 进 `.agents/skills`，`agent match` 四类时机查询全部命中；README 技能表 8→9，quickstart/techtree/research 加交叉引用（讲机制时指向时机）
- **修复冻结契约违规：`node link` 不幂等**（写新技能时实测暴露）——重复 link 同一 (父,子,rel) 不再报 `duplicate:true`，而是 **TypeError 崩溃 rc=1**。根因：upsert 冲突后既有行保留**原 id**，而回读用**新算出的 id** → 查不到 → 返回 undefined → 调用方读 `row.rel` 崩。修：按自然键 (parent,child,rel) 预查 + 回读，重复时回执 `duplicate:true`（rc=0，原地更新 `--mode/--optional` 即改属性）；demo 加护栏（复用已有边命中重复路径）
- 顺带修正新技能里写错的命令名（`link --rm` → 真实子命令 `node unlink`）——技能命令面也经实测核对

## 0.41.0（2026-10-17）README 前门刷新 + 客户端测试覆盖 + Bun 根因精确化
- **README 全面刷新**（265 → 350 行；规则 5「README 健康」此前跳过 0.37–0.40）：入口改为**发布产物** `dist/bundle/bin.cjs`（附开发树对照）、依赖面补 vendored cordis 家族、schema v5→**v8**；
  **新增四节**——`rel` 关联织物（八类引用 + 双向浏览）、`task` 状态机（并澄清**没有 tasks 表**，是 artifacts kind='task'、+meta 状态信封）、`produce spec/design`（design_type 信封 + DESIGN.md 格式）、**`plugin` 用户层插件**（install/config/enable/disable/list + 契约 + 隔离与诊断）；
  **新增 WebUI 节**（React 客户端 `/` vs 零依赖 `/classic` 回退、SSE 实时通道、中文友好、DESIGN.md 单一事实源）；工具节计数修正（112 单测 / 61 断言 / doctor **9** 项）+ 补 `pack:check`、`bench --quick` 与 RSS 端点、**pre-push 提交门禁**；环境变量补 `YGL_PACKAGE_MANAGER` / `YGL_SKIP_HOOKS`；技能数 5→**8**；文档地图补 packages/AGENTS、benchmarks/AGENTS、plugin-authoring、release，spec 范围 R1–R8→**R1–R14**
- **`pnpm readme:verify`**（scripts/readme-verify.sh）：README 命令示例的**文档真值门禁**——在 scratch 工作区逐条跑并断言退出码（含冻结契约 rc=2）。首跑 **34 项**即挖出两处真实顺序缺陷：① §一 的 node 示例缺 `tree new` 前置（新工作区照抄报 `no tree selected`）② `node cond steel` 用了**后面才创建**的节点（报 `node not found: steel`）——两处已修，现 **34/34 通过**
- **React 客户端测试覆盖从 0 → 8 例**（apps/web/tests/api.test.ts）：SSE 订阅建立与首帧立即拉取、帧解析投递、**接管后轮询静默**、未接管时 10s 降级仍工作、断线回落、坏帧只报错不炸、EventSource 构造失败仍可轮询、disposer 关闭连接、非 2xx 抛错
- **Bun 根因精确化（复探，取代早前描述）**：早前记录的「`fs.openSync` + O_CREAT 对不存在文件 ENOENT」在 1.3.0 下**已不复现**；真实边界更窄——**bun 进程内新建的目录，其内文件 openSync(O_CREAT) 报 ENOENT**（`existsSync`/`statSync`/`readdirSync` 与**其他进程**都说目录存在），而目录由进程外预建时**开库/建表/写入全部正常**。四个 workaround（逐级 mkdir / 中间插 IO / 原参数重试 / realpath）**实测全败**。已给最小复现 + 边界表 + 穷尽的 workaround 否定结果，判定脚本不变（`bun-smoke` pass=1/fail=10）

## 0.40.0（2026-10-17）CI 门禁（Gitee Go 不可用的等效方案）+ 发布链路 + loader 裁决
- **`.githooks/pre-push`**：无 CI 环境下的仓库级门禁——分支 push 跑 `pnpm test`，**tag push 追加 `pnpm pack:check`**（产物级）；旁路只能显式 `YGL_SKIP_HOOKS=1`（打印跳过原因，不静默）；安装 `git config core.hooksPath .githooks`
- **Gitee Go 阻塞留证**：`gitee pipeline` 全部命令返回 `giteego: HTTP 403 您无此操作权限`（两测一致）——账户无该服务权限，非配置问题；docs/release.md 记录日后接入法（`pipeline example` 取官方 YAML 基线，不手写字段）
- **发布链路打通**：`v0.39.1` tag 推送（经钩子全流程验证：`pnpm test` + `pack-check: PASS`）+ Gitee Release `id 1210127`（说明取自 CHANGELOG）；docs/release.md 补「标签与 Release」章
- **loader 架构裁决（探针实证 no-go，能力采纳）**：四轮探针证明 loader 与我们的插件模块**完全兼容**（四种形态全通、config 透传、`update()` 重配），但 ① 编译产物不暴露 `moduleNamespace`（源码有/lib 无）→ 拿不到 `commands`；② 按 specifier 运行时导入 → tsdown 不可追踪 → 用于基础插件会**破坏自包含单文件产物**。裁决记录于 vendor/README（含三项重审触发条件）
- **能力采纳（不引入 loader 机制）**：用户层 bundle 支持 `config` 与 `enabled`——`plugin config <name> '<json>'` / `--clear`、`plugin enable|disable <name>`（停用保留安装）、`plugin list` 增 state/cfg 两列；`apply(ctx, config)` 实收配置
- **修复 0.37.1 引入的契约回归**：`unknown group → rc 2` 守卫被误删，未知组改为 TypeError 崩溃（违反冻结退出码契约）——修复并加 demo 断言防复发
- demo 断言 +4（未知组 rc=2 / config 往返 / disable 后仍干净 rc=2 / enable 恢复）；单测 109 → **112**

## 0.39.1（2026-10-17）仓库级 commit 门禁（Gitee Go 不可用的等效方案）+ 发布/标签流程入档
- **`.githooks/pre-push`**：push 时自动跑仓库级门禁——分支 push 跑 `pnpm test`（单测+构建+demo），**tag push 追加 `pnpm pack:check`**（产物级验证，防未验证产物出门）；安装 `git config core.hooksPath .githooks`；旁路只能显式 `YGL_SKIP_HOOKS=1`（钩子打印跳过原因，不静默）
- **Gitee Go 阻塞留证**：`gitee pipeline` 全部命令（含最轻的服务状态检查）返回 `giteego: HTTP 403 {"msg":"您无此操作权限！"}`，两次复测一致——**账户无该服务权限**，非配置问题、无 API 可自助开通；已记录开通路径与日后接法（`pipeline example` 取官方 YAML 基线，不手写字段）
- **docs/release.md 补两章**：门禁章（现状/等效方案/旁路纪律/日后接 Gitee Go 的步骤）+ 标签与 Release 章（`git tag -a` → `push` 经钩子验证 → `gitee release create --body "$(sed -n ...)"` 从 CHANGELOG 取说明，单一事实源）
- 实测：钩子旁路 rc=0、真实门禁路径跑通（109 单测 + demo 12 组 → gates passed）

## 0.39.0（2026-10-17）WebUI 事件驱动实时化 + 基准维度补齐 + 发布决策上报
- **SSE 实时通道**：`webui serve` 新增 `/api/events`（text/event-stream）——连接即发首帧完整载荷，之后仅在数据变更时推送；服务端 1.5s 一次**表指纹**（18 张表 `COUNT(*)` 容错拼串，某表缺失记 `?` 不抛错），指纹变化才重算并广播；指纹 tick 挂 `ctx.timer`（vendor 弹药生命周期托管），插件缺失回退裸 interval
- **客户端零轮询**：React 客户端改 `EventSource` 订阅（`subscribeDashboard`），10s 轮询降级为**仅在 SSE 未接管时**执行；`tsc --noEmit` 零错 + vite 构建通过
- **修停机挂起**：SSE 客户端永久占 socket，`server.close()` 会永不回调——shutdown 先 `closeLive()` + `closeAllConnections()` 再 close；实测挂着 SSE 客户端时 SIGTERM **324ms** 退出
- **修 bundle 化回归**：`resolveDistRoot` 原按 `__dirname` 固定层数上探，打包成单文件后 `__dirname` 塌缩到 `dist/bundle` → React 客户端不再被识别（`/` 回落内嵌）。改为**按仓库标记（ygl.bundle.json）逐层上探**——tsc 树 / bundle / 源码直跑三种布局通吃；实测 `/` 恢复服务 React 客户端、`/classic` 回退 200
- **基准两项限制关闭**：`--quick` 接线到四条路径（startup n=10→4、写入 200→50、kb 500→150 行 / 100→30 检索、树 300→100 节点）；**内存端点**——每席报告 whole-process RSS（after + delta），artifact 随之携带
- **发现并记录真实 schema 事实**：**没有 tasks 表**——任务是 `artifacts` kind='task' + meta 状态信封（原 SSE 指纹代码按 `tasks` 表查，每 tick 抛错导致永不推送；容错清单修掉并留教训）
- 单测 108 → **109**（新增 SSE 端到端用例：首帧快照 + 变更帧携带新任务标题）；SSE 设计记入 docs/webui-design.md
- **发布决策上报 A2A**（report-234c1c3b）：pack:check 全绿、fork 依赖在 npm 有源，待拍板 registry 与放行

## 0.38.1（2026-10-17）发布就绪门禁 pack:check + 发布流程文档
- **`pnpm pack:check`**（scripts/pack-check.sh）：打包 → 依赖协议重写检查 → **隔离消费目录真实 npm install** → 驱动发布产物跑 9 条命令面 + doctor + `--json` 整体可解析；拦的是源码树测试拦不住的一类 bug（workspace 协议残留 / 产物未进 files / 依赖闭包不可解 / bin 路径错）
- **实测发布包可用**（0.38.0 tarball）：52 包闭包，`@deepseek-ai/cordis@~4.0.5-alpha.2` 等 fork 版本在 npm 均有源（DSH 自发布），`workspace:~` 重写后可解；隔离安装后 db init / project / query / tree / node / brief / plugin / doctor 全通过
- **发现并定性 Windows `.cmd` shim 污染**：主机级 cmd 启动钩子（`HKCU\...\Command Processor\Autorun`）让**每个** npm 包的 .cmd shim 先吐 `Active code page: 65001`（实测 `cordis.cmd` 同样），破坏经 shim 的 `--json` 整体解析；**非本包缺陷**——直接 `node` 与 `.ps1` shim 实测输出纯净
- **docs/release.md**：发布流程（门禁 / `pnpm publish` 必须而 npm 不可的原因 / shim 陷阱与干净调用路径 / 发布面构成 / 根 deps=发布面 vs 包内 deps=依赖图真相 的双处维护纪律）
- `prepublishOnly` 升为 `pnpm test && pnpm pack:check`——发布前强制产物级验证

## 0.38.0（2026-10-17）技能面同步 + bundle 默认化 + vendor 弹药启用
- **quickstart 技能全面重写**（v0.14 → v0.38.0）：覆盖新增命令面——doctor（9 项健康检查）、task 状态机、rel 关联织物（8 类引用）、plugin 用户插件、webui serve/export、benchmarks、build:bundle；触发词扩到 doctor/task/rel/plugin/webui/bench/bundle；入口路径改正（bin/ → dist）。`agent match` 三查询（插件/健康检查/webui）全部命中
- **bundle 默认化**：`pnpm build` = tsc 树 + tsdown bundle（一条命令两个产物，tsdown 仅 58ms）；根 package.json `bin` 指向 `dist/bundle/bin.cjs`（单文件发布产物）；`prepublishOnly` 保留 test 门禁
- **发布产物实测更快**：受控对比 bundle p50 560ms vs tsc 树 607ms（**~8% 启动提速**，8 轮交替测量）
- **demo + benchmarks 改测发布产物**：demo.sh 与 bench.js 优先用 `dist/bundle/bin.cjs`（缺失回退树）——回归与基准对准用户真实入口
- **vendor 弹药首启**：`@deepseek-ai/cordis-plugin-timer` 接入 base bundle（第五插件）——webui serve 的 60s 心跳（行数统计）走 `ctx.timer.setInterval`，生命周期托管（ctx dispose 自动清理，无需手工 clearInterval）；实测组合后 `ctx.timer` 就位（4 tick/150ms）
- 单测断言更新（bundle 4 → 5 插件）；vendor/README 弹药状态更新（1 用 6 待）

## 0.37.2（2026-10-17）benchmarks 目录规范对齐 DSH（用户指出"未对齐开发标准与目录规范"）
- **per-user-path 重组**：bench.js 平铺单文件拆成四条用户路径目录——`startup/`（CLI 进程 spawn）、`research-write/`（事务化写入+幂等）、`knowledge-search/`（kb 批导+FTS5 bm25）、`techtree-index/`（闭包+拓扑+节点检索）；不镜像包树（DSH 典范）
- **benchmarks/AGENTS.md**：基准纪律——合成固定输入/进程级采样/预算不可环境覆盖/跑生产入口/support 移入需两处复用
- **@ygl/benchmarks workspace 包**：package.json 声明（benchmark 专用依赖不污染根）
- **support/helpers.js**：共享 runner 基础设施——suite()/stats()/writeArtifact()/freshWorkspace()；EPERM 安全清理（Windows 句柄残留）
- **bench.js 减薄为调度器**：按路径加载子模块→收集→统一清理→写 artifact
- **README 重写**：结构图 + 用法 + fork 4.0.5 新基线 + 已知限制
- 全量跑通（7 席全绿）：startup p50 570ms / claim-write 20.3ms/op / kb-search p50 22.5ms / node-index 619ms

## 0.37.1（2026-10-17）bundle 完全可用——DOMAIN_ROUTES 静态 barrel 化
- **domain-barrel.ts**：所有领域命令模块从动态 `require(route)` 改为静态 import barrel——bundler（tsdown/rolldown）可追踪，bundle 产出完整功能（全命令面实测通过：agent brief / db stats / rel list / demo hello / plugin list）
- **bundle 对比**：323KB 单文件 bin.cjs，启动 559ms vs tsc 树 621ms（~10% 提速）；外部保留 native/opt 依赖（better-sqlite3/node-sqlite3-wasm/typeorm/pg/reflect-metadata/atomic-write）
- `build:bundle` 脚本固定 CLI 直传参数（tsdown.config.ts 有 Node 24.12 config-loader bug，暂绕过）
- vendor/AGENTS.md 补充（DSH 典范——src 编辑禁令 + 同步程序 + 我们的补充纪律）

## 0.37.0（2026-10-17）vendor DSH 全家桶对齐 + tsdown bundle 脚手架（用户两项裁定）
- **vendor 九件套对齐 DSH**（用户裁定：框架级一致性）：从 DSH vendor 源码同步（非 npm 安非 git clone——DSH 模式：fork 仓库源码 git 跟踪 + workspace:~ 链接）；cordis 升级到 fork 4.0.5-α（**修复 rc.11 setImmediate 时序**——fork 探针实测单 yield 后 database+named+inject 链 needsDb 全就绪 ✓）；cosmokit 1.8.6-α、schemastery 3.18.5-α、loader/include/group/hmr/timer/logger-console 七件 cordis-plugin 首次入库（可用弹药，等需求接入）
- **import 面 rescope**：`from "cordis"` → `from "@deepseek-ai/cordis"`（6 文件）；`declare module "cordis"` → `"@deepseek-ai/cordis"`（5 文件）；package.json 依赖声明更新（根 + apps/cli + 4 包）
- **vendor README 重写**：manifest 表（九件版本对齐）+ fork 理由（上游停在 rc.11，DSH fork 4.0.5 修时序）+ 同步纪律
- **tsdown bundle 脚手架**：`pnpm build:bundle` = tsc + tsdown（rolldown bundler）；入口 apps/cli/src/bin.ts → dist/bundle/bin.cjs（101KB 单文件）；**已知限制**：DOMAIN_ROUTES 动态 require(route) 被 bundler 静态分析不了——需后续改静态 barrel 导入（tsdown.config 暂移除——Node 24.12 tsdown config-loader 已知 bug，CLI 直传参数可用）
- 规则 7 重写（根 AGENTS）：从 DSH vendor 源码同步（用户裁定框架级一致性）

## 0.36.4（2026-10-17）vendor 逐项裁决 + vendor README（用户两问驱动）
- **裁决入库**：tsdown.worker.ts **否**（属 DSH 的 bundle 化+Worker+VFS 构建形态；触发条件：采 bundle 分发或引 Worker 线程）；DSH vendor 九件套**七否一有一挂账**——loader（R14 已裁不引 fork）/include/group/hmr/timer/logger-console 逐项否（各有本仓等价或场景不存在）；schemastery 挂账（npm 消费正常，vendoring 属一致性收益）
- **vendor/README.md**：补齐 DSH 有的 vendor 树纪律文档——来源纪律（npm tarball 非 clone 非 fork）/升级路径（先跑 rc.11 时序探针）/fork 漂移与 T2 禁引/候选挂账

## 0.36.3（2026-10-17）包领域 AGENTS.md + 插件目录 README（用户指示，DSH packages/AGENTS.md 对齐）
- **`packages/AGENTS.md`**：包级开发纪律（补位根 AGENTS，DSH 同构）——包形状五件套/零散禁区、Cordis 插件导出契约（Service+apply+declare module、构造必须同步）、写路径三铁律（事务化服务/九触点/读不写）、遥测纪律（树域已推翻 0.12 例外）、测试纪律（scratch 自清理三步/demo 字段名教训）、README frontmatter 与内容序、DSH 角色词表命名；根 AGENTS 核心铁律挂链
- **`examples/plugin-demo/README.md`**：示例插件 README（试跑四命令/契约表/写自己的插件三步/已知限制）
- **profile README**：`plugin init` 现在在 `$YGL_HOME/plugins/` 生成 README.md（结构说明+命令速查+信任模型警告，幂等）

## 0.36.2（2026-10-17）apps/cli 成为 workspace 包 + packages/*/* 接入 workspace（用户指出"没有包管理器"）
- **发现**：`pnpm-workspace.yaml` 只含 `vendor/* + apps/*`——**packages/*/* 九个包从未是 workspace 成员**，0.20 的"各包声明依赖"一直是装饰品（从未链接）；apps/cli 则完全没有 package.json
- **对齐 DSH**（其 apps/cli 即发布包 `@deepseek-ai/dsh`，含完整 deps/bin）：`apps/cli/package.json` 新建（`@ygl/cli`，声明真实依赖图：6 个 workspace 包 + cordis + schemastery）；`packages/*/*` 接入 workspace——九包 + apps/cli 各自获得 node_modules 链接，依赖图从"纸面声明"变为 pnpm 实链
- **依赖归位与发布面并存**：`@deepseek-ai/schemastery`→apps/cli、`@deepseek-ai/dsh-atomic-write`→ops-tools（各自真实消费者）；**根 package.json 同时保留两者**——根是发布单元，dist/ 运行时从根 node_modules 解析（实测移除即 MODULE_NOT_FOUND；包内声明=依赖图真相，根声明=发布面需求，两者并存是正确形态）
- 已知 peer 警告（记录不修）：vitest 要 @types/node≥22（root 20.x）；typeorm peer better-sqlite3@12（用 13）

## 0.36.1（2026-10-17）bin/ 目录并入 src/bin.ts（DSH 形态收尾）
- **可执行入口 = `apps/cli/src/bin.ts`**（DSH bin.ts 同形）：shebang + 自执行守卫（rc 契约 0/1/2 由本文件保管）；根 package.json `"bin"` 指向 `dist/apps/cli/src/bin.js`（DSH `"dsh": "lib/bin.js"` 同构）；**bin/ wrapper 目录删除**——三层入口（wrapper→index→main）收敛为单文件
- 引用面全改（demo.sh / benchmarks/bench.js / scripts/bun-smoke.sh / README / package.json scripts）
- 根治 vitest 捡 dist 编译测试：tsc exclude `apps/*/tests`（测试不再进 dist，发布面更干净）；实测 unknown→rc2 / ok→rc0 / demo 插件命令可达

## 0.36.0（2026-10-17）用户层插件分发（spec R14 L3——DSH apps/cli 应用典范落地）
- **`ygl-trees plugin` 命令组**：init（幂等建 profile）/install（npm 包、git 地址、本地目录自动 link:）/remove/list（版本+spec+可解析态）
- **工作区级插件仓**：`$YGL_HOME/plugins/`（pnpm 管理）+ 用户层声明 `ygl.user.bundle.json`——叠加在 base bundle 之上（DSH user-layer 对应物）；业务域随工作区走
- **插件契约**：`apply(ctx, config)` + 可选 `commands` 贡献 CLI 命令组（dispatch：插件命令 → 内建路由 → unknown）；可用 ctx 服务：database/research/techtree/webApp
- **DSH 典范五件套**：withFileLock 安装锁（dsh-atomic-write 同原语）/ 名字=依赖键差集精确解析 / YGL_PACKAGE_MANAGER 包管理器注入（Windows .cmd shim 走 shell）/ StartupError 诊断落盘 `$YGL_HOME/logs/startup-<uuid>.log`（凭证泄漏警告）/ createProcessShutdown 有界停机（5s 宽限·信号升级）
- **逐插件隔离**：单插件失败不炸工作台，issues 汇总进启动诊断；`yglTrees` 兼容声明主版本不符仅警告
- **apps/cli 分层**：main.ts 减薄（bin 薄入口），组合进 boot.ts、诊断进 diagnostics.ts、停机进 shutdown.ts
- doctor 第 9 项 plugin_profile；示例 examples/plugin-demo（demo 组 12 离线 link: 全链路回归）；docs/plugin-authoring.md 插件编写指南；单测 6 例（profile/init/install/load/隔离/remove）

## 0.35.0（2026-10-17）产出工件渲染进 WebUI
- **服务端**：`/api/artifact?id=<id>` 全文端点（当前项目工件：kind/title/content/version，404 语义）；`/api/data` 增 artifacts 清单（非 task 工件按创建倒序）
- **React 客户端**：Artifacts 区——按类型分组（报告/规格/设计/大纲/章节/笔记）+ 点击展开 **react-markdown 全文渲染**（DESIGN.md token 定制组件：标题/链接/代码/引用/表格）；键盘可达
- **内嵌 dashboard**：📦 产出工件最小清单区（类型徽章 + 标题 + 版本）
- 单测锁定（清单形状 + 全文端点 + 404）+ tsc/vite 双构建（bundle 457KB/146KB gzip）；serve 重启 PID 42304；react-markdown 兑现资源清单"报告/规格渲染"位

## 0.34.2（2026-10-17）树视图水平展开（用户裁定）
- **tier 布局横排**：tier 沿 X 轴左→右推进（每层 180px 列距），同层兄弟纵向扇开（70px 行距）——经典科技树横版；React xyflow 同步（Handles Left/Right）；时间轴布局本就是水平（时间轴语义不改）
- 内嵌 dashboard：edges 横向连线（父右缘→子左缘）；SVG 尺寸按列数×兄弟数自适应
- 锁定：源码级几何断言（colGap/tierKeys×colGap/行距公式）+ apps/web tsc --noEmit 类型检查（vite 构建不做类型校验，0.34.2 起收口必跑）+ serve 重启（PID 70100）

## 0.34.1（2026-10-17）WebUI 中文友好化（双客户端面）
- **内嵌 dashboard**（webui export/serve）：统计卡（技能/知识笔记/来源/证据/断言/产出/科技树/节点）、区头（📊 总览/🌳 科技树/🔬 研究断言/📚 来源/✅ 任务清单）、项目进度行（项目/来源/证据/断言 x/y 已证实/产出）、下一步操作/常用技能、断言状态分组（已证实/存争议/已推翻/待验证）、节点面板（解锁状态/必检未满足/可选未满足/被排斥/条件表头六列中文化/父节点/子节点/关联/(可选)）、任务（待办/进行中/已完成 ✓ + ▶ 开始/✓ 完成）、时间线图例（研究/科技树/评估/其他）+ title 明细、布局切换（布局：分层/时间轴）、全部空态/加载态/页脚中文化
- **React 客户端**：统计卡、项目进度、下一步操作、科技树副标题、任务分组（待办/进行中/已完成）、错误/加载态、详情面板（条件/关联/加载中）同步中文化
- 单测锁定：generateHTML 中文文案断言（13 组标签）；导出实测 8 处中文命中；React 重建 + serve 重启（PID 39776）

## 0.34.0（2026-10-17）插件化补完 R14（L1 接线 + L2 声明式组合 + T1 套件）
- **L1 接线**：`ctx.research`（ResearchService，0.18 欠账——发现早已写好未接）与 `ctx.techtree`（死导入复活）全部接到组合面；compose.ts 死代码删除
- **L2 声明式组合**：`ygl.bundle.json` 声明四插件（database→research→techtree→web-app；数据说 WHAT），main.ts `PLUGINS` 注册表管模块解析（代码说 WHERE），schemastery 校验；loader 向上探测解析（src/dist 双深度）；profile 概念暂缓（两态当前等价不硬造）
- **rc.11 时序探针**（tmp/svc-probe*.js）：named-apply 服务注册 ✓；inject 链 wall-time 500ms 沉降 ✓；setImmediate 泵不可靠——CLI 保留直构回退，长驻进程走服务层
- **T1 套件**：`@deepseek-ai/dsh-atomic-write`（零运行时耦合实证）接入 webui export + db export 原子写——截断导出=数据损失；`@deepseek-ai/schemastery` 校验 bundle 声明；T2（timer/frontend-static/webserver）按 DSH 对比裁不引（自研等价 + 不拖 fork）
- 四服务实证（serve 组合）：ctx.database/research/techtree/webApp 就位；CLI 冒烟全通；bundle 入 files 发布面

## 0.33.0（2026-10-17）真实规模树 + 方法论 skills（spec R13 收官）
- **dogfood #4——evolution 树**：ygl-trees 自身演进建成 **32 节点 / 7 层 / 39 边**真实规模树——六大生长干（架构/研究管线/知识/模型层/能力/Web 客户端），29 已解锁里程碑 + **3 个锁定未来节点带真实门**（npm-publish：registry_pick choice= npmjs + green_closed 布尔；bun-runtime：上游就绪度 score min=2；real-users：readiness score min=1）；R9 关联织物跨四类实体挂接（claim decided-by / kb evidenced-by / task tracked-by / design decided-by）；doctor 8/8
- **三个方法论 skills**（R13.2）：`ygl-trees-tree-building`（领域分解四步/反模式立靶/tier 语义/自检清单）、`ygl-trees-relating`（rel 词汇表/决策树/消费面）、`ygl-trees-design-capture`（ui-ux=DESIGN.md 格式/arch+decision=ADR 三段/挂接纪律）——junction + import，**agent match 三查询各自 top-1 命中**（R13.4）
- **R13.4 验收**：React 客户端（pan/zoom/MiniMap）承载 32 节点树，npm-publish 详情面板 2 条件 + 2 关联 + can.ok=false（锁定门可见可读）
- R13 全条目闭环：pan/zoom（0.32.1 xyflow）、真实规模树 + 方法论（本版）

## 0.32.2（2026-10-17）web-app Cordis 插件（DSH 模式落地）
- **新包 `packages/web/app`（@ygl/web-app）**：运行时胶水插件（模式取自 DSH packages/bundle/web-app + adding-a-package cookbook）——`ctx.webApp` 服务（available/open）+ 纯函数 `resolveDistRoot()/openStatic()`（短命 CLI 不赌异步插件时序，0.19 教训）；dist 路径=workspace 知识非用户配置；SPA 回落 + 路径遍历防护
- **webui serve 分流**：构建产物存在 → React 客户端挂 `/`（xyflow pan/zoom 树视图），内嵌零依赖 dashboard 移驻 `/classic`；未构建检出 → 内嵌保持 `/`（离线单文件契约不变）；`/api/*` 永不拦截
- CLI 组合面加载 WebAppPlugin（第二个真实 Cordis 插件）；gate 9 包
- 修 0.32.1 遗留：resolveDistRoot 相对层级数错（dist 出发 5 层/src 出发 4 层才到仓库根——实测 / 404 定位）
- 全路由实测：`/`→React shell、`/assets/*.js`→200、`/classic`→embedded、`/api/data` 完好

## 0.32.1（2026-10-17）React 富客户端骨架（spec R13.5 裁定落地）
- **React 技术栈裁定（用户）**：WebUI 富客户端按需取用 xyflow/ahooks/react-router/pro-components/remix/grid-layout/react-pdf/react-markdown；`apps/web` 为 React 家园，CLI 零依赖内嵌 dashboard 保留（离线单文件导出不受构建链拖累）
- **apps/web 骨架**：Vite + React 18 + @xyflow/react——**树视图 pan/zoom/drag + MiniMap**（R13.3 核心，tier 布局，点击节点出详情面板：conditions/确定性 can/R9 related）、next_actions/tasks/统计卡、10s 轮询；`src/tokens.css` 镜像 DESIGN.md（token 单一事实源不变）；开发期 /api 代理到 `webui serve:8642`
- 构建验证：`pnpm --filter @ygl/web build` ✓（334KB js / 108KB gzip）；根 tsconfig 排除 apps/web（CJS CLI 构建不受 ESM/JSX 影响）
- obelisk 记忆更新至 v5（R9-R12 + 两项裁定 + 陷阱清单）；决策备案 a2a team-god-system（report-fe2c6647）

## 0.32.0（2026-10-17）工程产出形态（spec R12）
- **schema v8**：artifacts 加 `meta TEXT NOT NULL DEFAULT ''`（JSON 信封，循 eval choice 先例）；kind 扩 `spec|design|task`
- **`produce spec`**（需求规格文档）、**`produce design --design-type ui-ux|arch|decision`**（R12.1a：ui-ux 对齐 DESIGN.md 格式，arch/decision 用 ADR 风格；design_type 存 meta 信封）
- **`task` 命令组**：`add "<title>" [--note]`（todo 起步）、`list [--status]`、`doing|done <id>` 状态机推进——每次流转留痕 `task.status` 事件（from → to）
- **WebUI 任务清单**：状态分组（todo 灰/doing 黄/done 绿+删除线）+ 点击勾销（`▶ start`/`✓ finish`）经 **POST /api/task** 写回并即时刷新；静态导出提示需 serve；键盘可达
- **R9 互联验收**：task/spec/design 均可 `rel add node:… artifact:…` 挂节点（demo 断言 tracked-by）
- 单测 5 例（v8 迁移/状态机全程+留痕/非法状态/meta 信封）+ demo 断言组 11 + POST 端点 E2E（todo→doing 实时回显）

## 0.31.0（2026-10-17）时间维度（spec R11）
- **树视图时间轴模式**：`layout: tier` ⇄ `layout: time` 切换（chip 按钮）——时间布局每节点一条泳道（按 created 排序），created 圆点 + 解锁弧（created→unlocked_at 实线绿箭头 + 终点圆）或未解锁灰虚线延伸至今；日刻度竖线；节点仍可点击出详情面板
- **研究管线时间线**：`/api/data` 增 `timeline`（近 30 天 events 按日聚合，research/tree/eval/other 四桶），前端逐日堆叠条（DESIGN.md token：primary/tertiary/warning/secondary）+ 图例 + title 提示
- 数据面：tree 节点带 `created/unlocked_at/state`（LEFT JOIN node_state default 上下文解锁行）——0.30 树域留痕的直接消费
- **dogfood 三幕验收**：release-gate 树 dev/rc 实线解锁弧 + release/probe-node 灰虚线待解锁——检阅页 http://127.0.0.1:8642 切 layout: time 可回放
- 单测 13 例（+R11 数据面断言）；DESIGN.md token 纪律（零新增色）

## 0.30.1（2026-10-17）DESIGN.md 落地（前端 design 方法论裁定）
- **用户裁定固化（spec R12.1a）**：前端/UI design 采用 [DESIGN.md 格式](https://github.com/google-labs-code/design.md)（google-labs-code：YAML tokens + rationale 固定节序 + lint/diff/export 工具链）；arch/decision 类 design 由 Agent 定义（ADR 风格）
- **仓库根 `DESIGN.md`**：现有 dashboard 视觉身份（GitHub-dark 双层画布/单一 primary 交互色/等宽可执行文本/状态词色配对/边框优先分层）固化为 13 色 + 5 字阶 + 9 组件 token——webui 设计系统单一事实源，R11 时间轴与 R13 pan/zoom 以它为 token 来源
- lint 实测 0 error（`designmd` Windows 别名）；2 个 border 色 orphan 警告为格式 alpha 限制（组件属性面无 borderColor），已记录

## 0.30.0（2026-10-17）遥测地基（spec R10）
- **树域留痕**（推翻 0.12"不写 events"例外）：node.add/link/unlink/cond/delete/unlock/lock 同事务写 events——解锁时刻进账本，R11 时间轴的地基
- **schema v7**：events 加 `level`（info|warn|error，默认 info）；迁移 v6→v7（ALTER + 表存在守卫）；实体快照/PG MIGRATE_DDL/doctor 同步——并修复 doctor schema 检查硬编码 v6 的漏网触点（改读 SCHEMA_VERSION 单一事实源）
- **run 关联**：每条 CLI 命令一条 `cmd.run` 事件（group/action/rc/duration_ms；rc 映射 level：0→info/2→warn/else→error）；YGL_RUN_ID 注入同进程事件 payload.run——`agent log --run` 可重建单次调用
- **eval usage 捕获**（R10.4）：postEval 透传 gateway usage → 四题型返回值 → eval.gate/eval.ready 事件 {inputTokens, outputTokens}；**真实网关验证：1 call · 2764 in / 70 out tok 落账**
- **agent log 升级**：--level 过滤、--run 聚合、--usage 汇总（`agent log --usage` → calls/input/output tokens）
- 单测 11 例（v7 迁移/level 默认与显式/树域四操作留痕+run 注入）+ demo 断言组 10；AGENTS.md 口径 v6→v7、R1-R8→R1-R13

## 0.29.0（2026-10-17）关联织物通电（spec R9）
- **`rel` 命令组**：万向关联表 `relations` 从 kb↔kb 孤岛通电为八类实体（node/claim/evidence/source/query/kb/artifact/skill）任意两端挂接——引用语法 `<type>:<ref>`（`node:<tree>/<key>` 或当前树裸 key；kb/artifact 支持 id 或 title；skill 按 name）；`rel add [--rel t]` 幂等（同四元组 duplicate rc=0）、`rel rm`、`rel list [--src/--dst/--rel]` 双向过滤 + 对端显示名解析；404→rc1、坏类型→rc2
- **WebUI 关系叠加**：`/api/node` 返回 `related[]`（双向命中 + 类型/显示名/方向），节点详情面板新增 related 区（rel 类型加粗 + 对端摘要）——"这个节点依据什么证据、关联什么知识"面板直达
- **spec/plan 大修**：WebUI 检阅两轮结论固化为 R9–R13 五条新需求 + 0.29–0.33 里程碑路线（关联织物→遥测地基→时间维度→工程产出→真实规模树）；记录历史裁决推翻（0.12 树域不写 events 例外将由 R10 补齐）
- dogfood：release-gate/release 节点挂上 evidenced-by kb + decided-by claim（webui 可见）
- 单测 8 例（引用解析/幂等/跨域/rm 语义/events 留痕）+ demo 断言组 9；修复 relRm 先删后查的误报 bug（改先查存在再删）

## 0.28.0（2026-10-16）dogfood #3（发布门自评）+ doctor eval 信封检查
- **dogfood #3：工具审判自己的发布**——release-gate 树（dev→rc→release，release 挂三题型真实条件）真实网关活评估：**registry_pick (choice) P=1.0 pass**（npmjs）、**green_and_closed (boolean) P=0.4 fail**（未收口时点诚实拦截）、**readiness (score) 0.98 灰带**（原型↔可用徘徊）；结果存回研究管线（1 源 3 证据 2 断言 supported）；收口后重评见 plan.md
- **doctor 第 8 项 `eval_envelopes`**：eval 族条件信封有效性（choice answer∈options、score 级数 2-10 且 min 界内）——坏信封会让门永远 pending（静默退化），现在报 fail 点名；单测负路径（3 好 + 3 坏）
- README 健康面：决策模型章节更新为三题型+混批、doctor 8 项、skills 表描述；techtree skill 补 eval-gates 指针

## 0.27.0（2026-10-16）ready --eval 混合题型批量 + npm 发布预检
- **`node ready --eval` 三题型混批**：evalMixed 单请求携带 boolean/choice/score（协议原生多题型）——evalCandidates 返回带 op+信封的条件，聚合按各自映射器判三态；CLI stub 冒烟：choice+score 单节点 **1 个请求**双 pass → promoted
- **npm 发布预检**（不碰 registry）：tarball 面 57 文件健康（bin/dist/docs/README/CHANGELOG，vendor/tmp 无泄漏）；**关键裁决：必须 `pnpm publish`**——实测 pnpm pack 把 `workspace:~` 重写为 `~4.0.0-rc.11`/`~1.8.1`，npm publish 不重写（消费者装不上）
- 单测 30 例（+3：混批单请求形状/三映射器直用/离线整批 pending）；demo 组 6a2 扩 ready 级断言（三题型单节点聚合 pending）
- obelisk 记忆更新至 v4（mem-ff6b2eb8，英文 summary 含 0.19–0.26 全部裁决）

## 0.26.0（2026-10-16）决策模型 choice/score 题型
- **`--op eval-choice`（多选一）**：`--options "k=desc,..."` + `--answer k`；判 **P(期望答案)**，阈值与布尔同源（eval.pass/fail_threshold），全概率分布返回
- **`--op eval-score`（等级评分）**：`--levels "级0,..."`（2-10 级，描述须编码价值排序）+ `--min-score n`；score∈[0,N-1] 概率加权均值，三态 = ≥min pass / ≤min−1 fail / [min−1,min) 灰带
- **零 schema 变更**：问题与选项打包为 value 内 JSON 信封（`parseEvalSpec` 对 plain 字符串向后兼容）；missing_required 显示问题措辞而非 JSON
- eval.ts 重构：共享 `postEval` 传输层（四个题型函数同源重试/超时/协议头）；包导出面扩 8 个符号
- 验证：单测 27 例（信封往返/三态边界/本地 stub 网关协议形状/离线安全）；CLI 全链路冒烟（离线双 pending + stub 端点 choice P=0.9/score 2.31 双 pass → can.ok=true）；demo 组 6a2；eval-gates skill 更新为三题型版
- 已知边界：`node ready --eval` 批量聚合仍仅布尔 op（choice/score 经 `node can --eval` 逐节点判，混合批量留后续——spec R8 非目标更新）

## 0.25.0（2026-10-16）读路径写放大清剿 + dashboard 接 agent brief
- **skillMatch 批量化**：逐行 `UPDATE hits=hits+1`（N 结果 = N 次隐式事务 = N 次 VFS fsync，与 0.23.0 kbSearch 同类缺陷）→ 单语句 `IN (...)`；功能验证 hits 递增正常
- **dashboard 接 buildBrief**：`agent brief` 的 payload 构建抽为 `buildBrief()` 双端复用——webui Overview 区新增项目进度行（sources/evidence/claims verified/artifacts）、**next_actions 可执行命令列表**（原来硬编码 []）、top_skills 徽章
- **deferred usage 裁决：不做**（0.24.0 已知机会的结论）——CLI 单命令场景关闭时仍需 1 次刷盘（无收益）、serve 10s 轮询负载可忽略，代价是 Store 生命周期改造 + 计数崩溃丢失窗口；kbSearch 单语句批量已是最优形态
- 单测 56→57 例（brief 富载荷断言：next_actions 非空/project 进度/top_skills）

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
