# ygl-trees 开发计划

日期：2026-10-15 ｜ 规格：[spec.md](spec.md) ｜ 调研：[research.md](research.md) ｜ 规模标记：S ≤ 半会话 / M ≈ 一会话 / L > 一会话

> **执行记录 · 0.38.0（2026-10-17，技能面同步 + bundle 默认化 + vendor 弹药启用）**：(1) **quickstart 技能重写**（0.14 → 0.38）——补 doctor/task/rel/plugin/webui/benchmarks/build:bundle 全部新命令面 + 触发词扩展 + 入口路径改正；`agent match` 三查询全命中（技能是 agent 发现能力的唯一通道，命令面变了不同步就是能力黑洞）。(2) **bundle 默认化**——`pnpm build` 一条命令双产物（tsc 树 + tsdown 单文件，tsdown 仅 58ms）；根 bin → `dist/bundle/bin.cjs`；**受控对比实测 bundle 更快**（p50 560ms vs 树 607ms，8 轮交替）——基准里出现的 1032ms 是负载噪声，已用交替测量证伪；demo 与 bench 改测发布产物（对准用户真实入口）。(3) **vendor 弹药首启**——cordis-plugin-timer 接入 base bundle（第 5 插件），webui serve 60s 心跳走 `ctx.timer.setInterval`（生命周期托管，dispose 自动清理）；踩坑：vendor 相对路径在 dist 下解析失败（dist 无 vendor/）→ 改 workspace 包名导入 + 根/apps/cli 声明依赖；timer 的 default 导出是 TimerService 类（Cordis 接受类插件），PLUGINS 类型放宽为 any。(4) 单测断言更新（4→5 插件），108 全绿；vendor/README + AGENTS + CHANGELOG 同步。

> **执行记录 · 0.37.2（2026-10-17，benchmarks 目录规范对齐 DSH）**：用户指出 benchmarks "未对齐开发标准与目录规范"——考察 DSH benchmarks（AGENTS.md 纪律 + workspace 包 + 按用户路径一目录 + support/ 共享 + *.bench.ts 命名）。落地：bench.js 平铺拆四路径（startup/research-write/knowledge-search/techtree-index，各目录自含 bench 文件+fixtures）；benchmarks/AGENTS.md（合成输入/进程级采样/预算不可环境覆盖/跑生产入口）；@ygl/benchmarks workspace 包；support/helpers.js 共享（suite/stats/artifact/freshWorkspace/EPERM 安全清理）；bench.js 减薄为调度器。全量 7 席跑通 + fork 4.0.5 新基线记录。

> **执行记录 · 0.37.1（2026-10-17，bundle 完全可用——DOMAIN_ROUTES 静态 barrel 化）**：0.37.0 遗留的 bundle 已知限制（动态 require 不被 bundler 追踪）解决——新建 apps/cli/src/domain-barrel.ts 静态 import 全部 13 个领域命令模块 + 映射表（group→module）；bin.ts 删 DOMAIN_ROUTES 字符串映射改用 barrel。实测：323KB bin.cjs 全命令面通过（brief/db stats/rel list/demo hello/plugin list），启动 559ms vs tsc 621ms（~10%）。vendor/AGENTS.md 落地（DSH 典范）。build:bundle 脚本 CLI 直传（config-loader bug 绕过）。记忆 v6 更新 + A2A 备案 report-261b2aaa。

> **执行记录 · 0.37.0（2026-10-17，vendor DSH 全家桶对齐 + tsdown bundle 脚手架——用户两项裁定）**：(1) **用户裁定一**：vendor 全九件都是需要的，确保框架级一致性——推翻此前"七否"裁决；同步方式=从 DSH vendor 源码复制（非 npm tarball 非 git clone——读 DSH vendor/README 确认真模式：fork 仓库源码 git 跟踪 + workspace:~ 链接 + 第三方依赖留 npm）；import 面 rescope：`from "cordis"` → `"@deepseek-ai/cordis"` 六文件 + `declare module` 五文件 + package.json 依赖声明根/apps/cli/四包。(2) **fork 4.0.5 修复 rc.11 时序**——探针实测单 yield 后 database/named/inject 链 needsDb 全就绪（rc.11 时 needsDb 十 yield 不可达）；0.19 教训的"直构回退"从"必须保留"降为"防御性保留"。(3) **用户裁定二**：bundle 化分发确认需要（单文件可执行/启动提速）——tsdown 脚手架：CLI 直传参数可用（config-loader 有 Node 24.12 已知 bug，config 文件暂绕过）；bundle 产出 101KB bin.cjs，`demo hello` 插件命令可达但 DOMAIN_ROUTES 动态 require 不被 bundler 静态分析——已知限制：需后续改静态 barrel 导入。tsdown.worker.ts 不引入（零 Worker，用户确认"Worker 横幅仅在有 Worker 时需要"）。(4) 规则 7 重写（根 AGENTS）+ vendor/README 重写（manifest 九件对齐表 + fork 理由 + 同步纪律）。

> **执行记录 · 0.36.4（2026-10-17，vendor 逐项裁决 + tsdown.worker 裁决 + vendor README）**：用户两问——"需要 DSH 的 tsdown.worker.ts 吗？""DSH vendor 里还有哪些我们需要？"逐项裁决入库：**tsdown.worker.ts 否**（属 bundle 化+Worker+VFS 形态，我们 tsc 树+零 Worker；触发条件=采 bundle 分发或引 Worker）；**vendor 九件套七否一有一挂账**——loader（R14 已裁不引 fork）/include（恰两层手工叠加够用）/group（扁平清单够）/hmr（一命令一进程无意义）/timer（单 interval 有界清理够）/logger-console（零 Cordis 事件消费）皆否；schemastery 挂账（现 npm 消费正常，vendoring 属一致性收益，下次动 bundle 校验时评估）。照出缺口：DSH vendor 带 AGENTS/README 而我们零文档——补 vendor/README.md（来源纪律/npm tarball 非 clone/升级先跑 rc.11 探针/fork 漂移与 T2 禁引/候选挂账）。

> **执行记录 · 0.36.3（2026-10-17，包领域 AGENTS.md + 插件目录 README）**：用户指示对齐 DSH 的 packages/AGENTS.md 与插件目录 README。三件：① packages/AGENTS.md——DSH 形状（精炼规则清单补位根 AGENTS，29 行 vs 我们 ~50 行）：包形状/Cordis 导出契约（同步构造 0.19 教训）/写路径三铁律（事务化/九触点/读不写 0.23 教训）/遥测（树域 0.12 例外已推翻）/测试纪律（scratch 三步自清理 + demo 字段名 0.32 教训）/README 纪律/DSH 角色词表——每条规则都锚定本仓真实教训而非泛泛而谈；根 AGENTS 核心铁律挂链（主机已识别生效）。② examples/plugin-demo/README.md——frontmatter kind:参考，试跑四命令/契约表/已知限制。③ initProfile 生成 profile README（幂等）——用户工作区自带结构说明+信任模型警告。

> **执行记录 · 0.36.2（2026-10-17，apps/cli 成 workspace 包 + packages 接入 workspace）**：用户问"apps/cli 为什么没有包管理器？他不是一个插件吗？"——查证两层真相：① apps/cli 无 package.json；② **更深**：pnpm-workspace.yaml 只有 vendor/* + apps/*，packages/*/* 九包从未是 workspace 成员，0.20 的依赖声明是纸面的（从未链接）。对齐 DSH（其 apps/cli 即发布包 `@deepseek-ai/dsh`，deps/bin 完整）：新建 apps/cli/package.json（@ygl/cli：6 workspace 包 + cordis + schemastery）；workspace 增 `packages/*/*`——install 后各包 node_modules 实链。**发布面教训**：根是发布单元，dist 运行时从根 node_modules 解析——把 atomic-write 移到 ops-tools 后 dist 立即 MODULE_NOT_FOUND；根须保留 dist 用到的运行时依赖（包内=依赖图真相，根=发布面需求，并存正确）。peer 警告记录不修（vitest/@types/node、typeorm/better-sqlite3 版本代差）。遗留（后续版本）：包间相对路径 import 迁移为包名 import（workspace 链已就绪，import 面未迁）。

> **执行记录 · 0.36.1（2026-10-17，bin/ 并入 src/bin.ts——DSH 形态收尾）**：用户问"bin/ 目录怎么处理"——考察 DSH：`apps/cli/package.json` 声明 `"bin": {"dsh": "lib/bin.js"}`，可执行入口就是编译后的 src/bin.ts（shebang 自执行），无独立 wrapper。落地：bin.ts 加 shebang + `require.main === module` 自执行守卫（rc 契约 0/1/2 移入本文件）；根 package.json bin 指向 `dist/apps/cli/src/bin.js`（DSH 同构）；**bin/ 目录删除**（三层入口 wrapper→index→main 收敛为单文件）；引用面全改（demo.sh/bench.js/bun-smoke.sh/README/scripts）。**根治 vitest 捡 dist 编译测试**：tsc exclude `apps/*/tests`（测试不进 dist——发布面也更干净；此前 vitest exclude dist 未能拦截默认 include 对 dist/**/*.spec.js 的匹配）。验证：unknown→rc2 / ok→rc0 / demo 插件命令可达 / 108 单测全绿。

> **执行记录 · 0.36.0（2026-10-17，R14 L3 用户层插件分发 + DSH apps/cli 应用典范对齐）**：(0) **用户裁定两轮**：L3"非常需要，可用于生产和实践的业务域"；随后指出"目录规范与源码文件规范未对齐（DSH apps/cli）"——先深读典范再动手。(1) **典范深读**（bin.ts/profile-boot.ts/process-shutdown.ts/startup-diagnostics.ts/plugin.ts/composition.md）：薄入口按 mode 分发、profile 组合 + fail-loud、有界停机（幂等合并/信号升级/5s 宽限）、诊断终端简洁+落盘（UUID 命名/凭证警告）、插件包管理 withFileLock + 版本审批 + 包管理器 installation-owned。(2) **L3 落地**——plugins.ts（profile/bundle/install/remove/load）：install/remove 走 withFileLock（dsh-atomic-write 同原语）；名字=pnpm 前后依赖键差集精确解析（废启发式）；YGL_PACKAGE_MANAGER 注入 + Windows .cmd shim 走 shell（字符串形式消 DEP0190）；逐插件隔离加载（issues 汇总不炸工作台）；yglTrees 兼容声明主版本不符仅警告；契约 apply+commands（commands 贡献 CLI 命令组，dispatch 插件优先于 unknown）；doctor 第 9 项 plugin_profile。(3) **apps/cli 分层对齐**——src/ 目录化 + DSH 同名文件（bin.ts 入口/profile-boot.ts/startup-diagnostics.ts/process-shutdown.ts）；index.ts 保 dist 入口路径稳定；vitest include 扩 apps/*/tests；apps/cli/README.md 记对齐与分歧（显式 .ts 扩展名受 CJS 根配置限制为记录分歧）。(4) **踩坑**：dist 下 `require("../../package.json")` 不存在且异常在 try 外被 bin wrapper 静默吞（VERSION 改 repoRoot 探测）；execFileSync 不认 Windows .cmd shim；table() 列映射只收字符串（ok 预计算进行）。(5) 验证：插件全链路冒烟（init→install link:→demo hello→demo env 五插件→list→remove）+ 单测 9 例（plugins 6 + bin 3）+ demo 组 12 离线回归。

> **执行记录 · 0.35.0（2026-10-17，产出工件渲染进 WebUI）**：资源清单 react-markdown 位兑现。服务端 /api/artifact 全文端点（当前项目 scope，404）+ /api/data artifacts 清单（kind<>'task'，创建倒序）；React Artifacts 组件——类型分组（报告/规格/设计/大纲/章节/笔记中文映射）+ 点击展开 react-markdown 全文（components 映射走 DESIGN.md token：h1→h2 降级/链接 primary/代码块 neutral 底/引用左边框/表格细线）；内嵌 dashboard 最小清单区（零依赖不渲染正文）。锁定：单测（清单形状/全文内容含项目名/404）+ tsc --noEmit + vite build（457KB）。serve PID 42304 供检阅。

> **执行记录 · 0.34.2（2026-10-17，树视图水平展开）**：用户裁定 tier 布局横排。内嵌 dashboard tierSvg 轴交换（tier→X 列距 180/兄弟→Y 行距 70，edges 父右缘→子左缘水平连线，SVG 尺寸列数×兄弟数自适应）；React TreeFlow 同步（position x=row·COL / handles Left/Right）。时间轴布局保持水平不动。锁定：源码级几何断言 + apps/web tsc --noEmit（新纪律：vite 构建不做类型校验，React 面改动必跑）。serve PID 70100 供检阅。

> **执行记录 · 0.34.1（2026-10-17，WebUI 中文友好化）**：用户裁定 WebUI 中文友好化。双客户端面同改——内嵌 dashboard（webui.ts 模板）：统计卡/区头/进度行/下一步操作/断言状态四词/节点面板六列条件表头+父节点子节点关联/任务三态+按钮/时间线图例+title/布局切换/空态加载态页脚全中文；React 客户端（App/TreeFlow）：统计卡/进度/科技树副标题/任务分组/条件/关联/加载中。锁法：generateHTML 单测断言 13 组中文标签 + 导出实测 8 命中 + React 重建。serve 重启 PID 39776。

> **执行记录 · 0.34.0（2026-10-17，插件化补完 R14 L1/L2 + T1 套件）**：(1) **盘点起步**——回答"插件化是否完成"：Cordis 五大能力对账（服务发现 2/5+、事件 0、动态加载=静态 2、时空 0），发现 TechTreePlugin 死导入、ResearchService 写了没接、compose.ts 死代码；**发现一个比一个深挖**（0.32.2 才发现 ResearchService 本体）；考察 DSH apps/cli（声明式 bundle patch + profile boot + 独立 loader）后得出 T1-T4 分级。(2) **rc.11 时序探针四连**（tmp/svc-probe*.js）——named-apply 服务注册 ✓（arrow 与命名等价）；inject 链 wall-time 500ms 沉降 ✓；**setImmediate 泵不可靠**（10 次 yield 后 research/techtree 仍未就绪）——CLI 直构回退保留、长驻进程自然沉降；上游冻结 rc.11 无解，fork 4.0.5 已分叉（T2 引 fork 即双运行时，规则 7 精神禁止）。(3) **L1 接线**——main.ts 组合段重排：app.plugin 循环（loadBundle 顺序）+ 一次 yield + 三重回退（db→DB 直构；store→ctx.research.store||new Store；webApp 走纯解析器不赌时序）。(4) **L2 声明式组合**——`ygl.bundle.json`（四插件：database→research→techtree→web-app，发布面 files 增补）+ main.ts PLUGINS 注册表（id→apply/config）+ schemastery BundleSchema 校验（未知 id/缺 plugins 报错）；loader 向上 6 级探测 + cwd 兜底（src/dist 双深度差异）。(5) **T1 套件**——`@deepseek-ai/dsh-atomic-write` 0.0.1-rc.1 与 `@deepseek-ai/schemastery` 3.18.4 落地根依赖（零运行时耦合实证：四服务组合探针共存无碍）；writeFileAtomic 接入 webui export（dashboard.html 39.9KB 实测）+ db export（截断 SQL 备份=数据损失，原子写必要性最大面）。(6) compose.ts 删除（YAGNI；DSH 无独立 compose 文件——组合在 bundle patch）。(7) **验证**——CLI 冒烟全通（brief/node list/webui export）、loadBundle 返回四插件、serve 组合四服务在位、demo 全绿。

> **执行记录 · 0.33.0（2026-10-17，真实规模树 + 方法论 skills spec R13 收官）**：(1) **dogfood #4 evolution 树**——32 节点/7 层/39 边：t0 地基（sqlite-core/cli-frame）→ t1 架构（cordis/packages/research/knowledge/idempotency/json-contract 六干）→ t2 模型层（typeorm/techtree/fts5/pg-export/produce/config）→ t3 能力（eval 三级/telemetry/benchmarks/doctor）→ t4 Web 与织物（webui 三代/relations/time-axis/eng-artifacts）→ t5 客户端（design-md/react-client/webapp-plugin）→ t6 **锁定的未来**（npm-publish 挂 registry_pick choice= npmjs + green_closed 布尔；bun-runtime 挂上游就绪度 score min=2 [受阻/可试/就绪]；real-users 挂 readiness score min=1 [原型/可用/成熟]——0.28 发布门三幕弧的树化重演）；29 已完成里程碑 unlock（时间轴可见解锁弧）；可选边 ~18%（--optional）；关联织物四类挂接（npm-publish←claim decided-by + task tracked-by；webapp-plugin←kb evidenced-by；react-client←design decided-by）；doctor 8/8（信封全有效）。脚本陷阱：set -u 下函数 $3 未定义（${3:-} 默认）；tree 重跑撞名（db sql DELETE 级联清理）。(2) **方法论 skills ×3**——tree-building（反模式立靶：三节点演示链；分解四步：能力域/tier 语义/边三问/未来节点真实条件锁定；节点粒度判据"完成日期可唯一回答"；自检清单 ≥30 节点 ≥5 层 ≥4 干 ≥15% 可选）、relating（rel 词汇表五条：evidenced-by/decided-by/tracked-by/derived-from/related；何时挂决策树；防平行流水线反模式）、design-capture（三型三法：ui-ux=DESIGN.md 格式细则+lint 规则+仓库纪律；arch/decision=ADR 三段含推迟项判据；每条 design 应 decided-by 挂树）。junction + skill import；agent match 三查询（领域分解/关联挂接/设计沉淀）各自 top-1 命中。(3) **R13.4 验收**——React 客户端 32 节点 pan/zoom（serve PID 69668）；/api/node npm-publish 详情：2 条件（choice+boolean）+ 2 关联 + can.ok=false——锁定门在面板可读。R13 全条目闭环（13.1 树/13.2 skills/13.3 pan-zoom 0.32.1/13.4 验收）。

> **执行记录 · 0.32.2（2026-10-17，web-app Cordis 插件 DSH 模式落地）**：(1) **考察**——用户指向 DSH apps/web（"dist/ served by apps/cli's dsh web"）+ packages/bundle/web-app（运行时胶水插件：解析 dist/注册 ctx.webApp/经 webServer 挂静态面）+ 四份参考文档（adding-a-package cookbook 包不变式与角色命名、core/scope/invariants 类型模式）。(2) **新包 packages/web/app**（第 9 包，新 web 组）——插件形状沿本仓 DatabasePlugin 先例（Service 子类 + declare module "cordis" 声明合并）；出口双轨：ctx.webApp 服务（长驻进程用）+ openStatic/resolveDistRoot 纯函数（短命 CLI 直调不赌 rc 版插件时序）；SPA 回落 index.html、遍历防护（resolve 后必须仍在 dist 内）、MIME 表。(3) **webui serve 分流**——hasWebApp（启动时探测）：React 挂 / + /classic 承接内嵌 dashboard + /api/* 永不拦截；未构建 → 原状（离线契约不动）。(4) **陷阱**——resolveDistRoot 层级数首版算错（dist 出发需 5 层）：实测 / 返回内嵌页而非 React 定位修复；gate 要求 tests/*.spec.ts 命名（test.ts 改名）。(5) **验证**——单测 3 例、gate 9 包、全路由 pwsh 实测（/→React shell #root、/assets/*.js→200 js、/classic→embedded、api/data 完好）；serve PID 73892 供检阅。

> **执行记录 · 0.32.1（2026-10-17，React 富客户端骨架 spec R13.5）**：(1) **裁定**——用户给出 React 资源清单（xyflow/ahooks/react-router/pro-components/remix/grid-layout/react-pdf/react-markdown）按需取用；spec R13.5 固化：xyflow 为树/DAG 交互核心（R13.3 pan/zoom 主力），apps/web 为 React 家园，CLI 零依赖内嵌 dashboard 保留（离线单文件面）。(2) **apps/web 骨架**——Vite + React 18 + @xyflow/react：TreeFlow（tier 布局 + pan/zoom/drag + MiniMap + 点击节点详情面板 conditions/can/related）、App（统计卡/项目进度/next_actions 等宽/Tasks 分组/10s 轮询）；tokens.css 镜像 DESIGN.md（CSS 变量）；api.ts 类型对齐 gatherData；dev 期 /api 代理 8642。(3) **构建边界**——根 tsconfig exclude apps/web（CJS CLI 构建不受 ESM/JSX 污染，root build 验证 ✓）；vite build ✓ 334KB js/108KB gzip。(4) 会话治理：obelisk 记忆 v4→v5（R9-R12 + DESIGN.md/React 两裁定 + 陷阱清单）；a2a 备案 report-fe2c6647；AGENTS.md 口径修 v8/demo 15 组/严格退出码教训。

> **执行记录 · 0.32.0（2026-10-17，工程产出形态 spec R12）**：(1) **schema v8**——artifacts + meta（JSON 信封，循 eval choice 零语义滥用先例；task 存 {"status"}、design 存 {"design_type"}）；触点：SCHEMA_SQL/upgrade7to8（表存在守卫）/pgsync MIGRATE_DDL（无 Artifact 实体，少一触点）；doctor 读 SCHEMA_VERSION 常量自动跟随。(2) **命令面**——produce spec / produce design --design-type（ui-ux|arch|decision，R12.1a 裁定接线：ui-ux 对齐 DESIGN.md、arch/decision ADR）；task 组骑 produce 路由（入口翻译层 add/list/doing/done → task-* case，状态动词作 rest[1]）；taskSetStatus 校验状态机 + task.status 事件留痕（from→to）。(3) **WebUI**——Tasks 区状态分组（DESIGN.md token：todo=secondary/doing=warning/done=success+删除线）、点击勾销经 POST /api/task（node:http 首个写端点：todo→doing→done 推进 + live 即时重取数据；静态导出诚实提示需 serve）；键盘可达 keyTask。(4) **验收**——单测 5 例（含 projects.name 唯一约束踩坑：测试内重复 projectCreate 撞车，提到 beforeAll）；demo 组 11（状态机全程/spec-design 入库/tracked-by 挂节点）；POST E2E 实测 todo→doing 回显。

> **执行记录 · 0.31.0（2026-10-17，时间维度 spec R11）**：(1) **数据面**——tree 节点 LEFT JOIN node_state（default 上下文 unlocked 行）带 created/unlocked_at/state；timeline = events 按日四桶聚合（research=source/evidence/claim/query/kb/artifact 前缀、tree=node/tree、eval=eval、other 兜底，substr(ts,1,10) 分组，近 30 天）——0.30 树域留痕的直接消费。(2) **树时间轴布局**（treeTimeSvg）——每节点一条泳道按 created 排序；created 圆点（locked=#484f58/unlocked=#58a6ff）+ 解锁弧（实线 #3fb950 + 箭头 + 终点圆 title 带时刻）或未解锁虚线延伸至今；日刻度竖线（月初或跨度≤3 天逐日）；layout chip 切换持久于 uiState 跨刷新；节点点击/键盘仍走 nodeClick 面板。(3) **Timeline 区**——逐日堆叠条（四桶 DESIGN.md token 色）+ 图例 chips + rect title 逐桶明细；空态提示。(4) **dogfood 三幕验收**：release-gate dev/rc 实线弧（created=unlocked 同分钟，短弧但绿点在）+ release/probe 灰虚线——三幕弧数据面成立，检阅页 layout: time 可回放（serve 已重启 PID 75304）。(5) 验证：单测 13 例（节点 created/unlocked 字段 + timeline 日形状）、/api/data 实测（unlocked_at 节点 2、timeline 今日 research=53/tree=1）。

> **执行记录 · 0.30.1（2026-10-17，DESIGN.md 前端设计系统固化）**：用户裁定——前端 design 用 google-labs-code/design.md 格式，其他类型 Agent 定义；落 spec R12.1a。仓库根 DESIGN.md 把 0.22–0.25 事实演进的 dashboard 身份固化：GitHub-dark 双层画布（neutral/surface）、单一交互色 primary、等宽+tertiary 标记"可执行"、状态词色配对（禁色独证）、边框优先分层（唯一阴影是浮动面板）、150ms 过渡+reduced-motion 降级、file:// 离线可开（禁 webfont）。lint 三轮：fontWeight 需数字（bold→700）、surface-hover 接线 claim-row 组件、border 色留 2 个 orphan 警告（格式 alpha 无 borderColor 属性，记录不改）。Windows CLI 踩坑记录：`design.md` bin 名与文件关联冲突，须用 `designmd` 别名（`npx -p @google/design.md designmd lint`）。DESIGN.md 是 R11/R12/R13 前端面的 token 单一事实源。

> **执行记录 · 0.30.0（2026-10-17，遥测地基 spec R10）**：(1) **schema v7**——events.level（info|warn|error 默认 info）；upgrade6to7（表存在守卫：老库无 events 表则跳过 ALTER 交给 SCHEMA_SQL）；触点走齐：SCHEMA_SQL/迁移/实体快照（core entities Event.level）/pgsync MIGRATE_DDL（L1 镜像运行时推导自动跟随）/doctor——**漏网触点教训：doctor schema 检查硬编码 6**，迁移后立刻误报"latest is v6"；修复为 import SCHEMA_VERSION 单一事实源（九触点清单应加第 10 项：doctor 口径）。(2) **树域留痕**（推翻 0.12 例外）——treeWrites 本地 logEvent（raw SQL 风格 + run 注入）覆盖 node.add/link/unlink/cond/delete（delete 记 warn）/unlock/lock（R11 时间轴锚点）。(3) **run 关联**——main.ts dispatch 计时 + YGL_RUN_ID 注入 + cmd.run 账本行（rc→level 映射：0=info/2=warn/1=error；telemetry best-effort 不 fail 命令）；research logEvent 对象 payload 自动携带 run。(4) **eval usage**（R10.4）——postEval 透传 j.usage → 四题型 + evalMixed 返回值 → cmds 累计 → eval.gate/eval.ready payload {inputTokens,outputTokens}；**真实网关实测 1 call 2764/70 tok 落账**，`agent log --usage` 可查。(5) **agent log 升级**——--level/--run（payload LIKE）/--usage 汇总。(6) 验证：单测 11 例 + demo 组 10（树域留痕/cmd.run error/level 列三断言）；dogfood 工作区 v6→v7 自动迁移实测。

> **执行记录 · 0.29.0（2026-10-17，关联织物通电 spec R9）**：(1) **spec/plan 大修先行**——两轮 WebUI 检阅结论（六项意见 + 遥测对照 DSH session-telemetry）固化为 R9–R13 + 里程碑表；共同诊断=研究域过度发育/工程域未发育/两域零缝合；记录推翻 0.12 "树域不写 events" 例外（R10 补）。(2) **rels.ts**——引用解析器八类（node 树内/跨树 key、kb/artifact id 或 title、skill name、其余按 id）；relAdd 事务化（UNIQUE 四元组幂等 + rel.add events 留痕）；relRm **先查存在再删**（初版先删后查在删除成功后误报 not found——TypeORM 原生 DELETE 返回形状不可靠，单测抓获）；rel list 双向过滤 + resolveId 显示名（悬空关联回落裸 id 不炸）。(3) **WebUI**——/api/node related（UNION 双向 + 方向标记 in/out），面板 related 区 rel 加粗 + 对端摘要 40 字截断。(4) **dogfood**：release 节点挂 evidenced-by（kb: cordis-lifecycle report）+ decided-by（claim: 插件三形态）——检阅页刷新即可见。(5) 验证：单测 8 例、demo 组 9（幂等/双向显示名/rc 语义三断言）、CLI 冒烟（含 404/坏类型）、/api/node 实测。Web 服务重启至新 dist（PID 66136）。


> **里程碑路线（2026-10-17 WebUI 检阅后制定，spec R9–R13）**：两轮检阅（六项意见 + 遥测对照 DSH session-telemetry）的共同诊断=**研究域过度发育、工程域未发育、两域零缝合**。地基优先于视图：
>
> | 版本 | 主题 | spec |
> |---|---|---|
> | 0.29 | 关联织物通电（rel add/list + webui 关系叠加） | R9 |
> | 0.30 | 遥测地基（树域留痕/severity v7/run 关联/eval usage） | R10 |
> | 0.31 | 时间维度（树时间轴 + 研究管线时间线） | R11 |
> | 0.32 | 工程产出形态（spec/design/task artifacts + 任务清单） | R12 |
> | 0.33 | 真实规模树 dogfood #4 + 方法论 skills + pan/zoom | R13 |
>
> **已识别的历史裁决推翻**：0.12.0 "tree 域不写 events" 例外 → R10.1 补齐（时间维度前置）。


> **执行记录 · 0.28.0（2026-10-16，dogfood #3 发布门自评 + doctor eval 信封检查）**：(1) **dogfood #3——工具审判自己的发布**——release-gate 树（dev→rc→release）；release 挂三题型真实条件（boolean "测试绿+文档收口"、choice "registry 选哪个" options npmjs/tea answer=npmjs、score "发布就绪度" levels 原型/可用/成熟 min=1）；**真实网关活评估**（未收口时点）：registry_pick P=1.0 **pass**（模型完全背书 npmjs）、green_and_closed P=0.4 **fail**（CHANGELOG/plan 未写——门诚实拦截未收口版本，判定语义正确性活证）、readiness score=0.98 **灰带**（文档未收口压低均值）；结果存回研究管线（project release-028：1 源 3 证据 2 断言 supported + 3 链接）；收口后重评（无 state）：boolean 仍 P=0.4——**外部事实不进上下文包，模型正确拒绝脑补**（R8.2 纪律活证）；带 `--state "tests_green=76_pass, changelog_written=0.28.0, ..."` 重评：boolean **P=0.81 翻转 pass**、readiness score=0.99 仍灰带（差 0.01 过"可用"——模型坚持"未经真实用户验证"保留原型权重）→ **发布门停在 pending，离发布差一次真实用户验证**（dogfood 核心教训：外部事实必须进 --state 袋，判定器不脑补）。(2) **doctor 第 8 项 eval_envelopes**——坏信封（choice answer∉options / score 级数越界 / min 越界）会让 evalChoice/evalScore 拿空 options/levels → **门永远 pending 的静默退化**；doctor 现在逐条点名报 fail；CLI cond 入口已校验，此检查防 db sql 直写与导入数据漂移；单测 3 好 + 3 坏负路径。(3) README 健康面（决策模型章节三题型+混批版、doctor 8 项、skills 表）+ techtree skill 补 eval-gates 指针。

> **执行记录 · 0.27.0（2026-10-16，ready --eval 混合题型批量 + npm 发布预检）**：(1) **evalMixed**——单请求混三题型（协议原生：boolean/choice/score 同 state 一请求）；返回形状与单题函数一致 → mapOutcome/mapChoiceOutcome/mapScoreOutcome 直用；单测断言请求体含三种 question 定义且只发 1 个请求。(2) **接线**——evalCandidates 过滤扩 /^eval(-choice|-score)?$/ 并携带 op+解析信封（name/op/question/options/answer/levels/min）；ready --eval 每节点一次 evalMixed，聚合按各自映射器判三态；pending 显示带 score。CLI stub 冒烟：choice+score 单节点 1 请求双 pass → promoted ✓。(3) **npm 发布预检**（不碰 registry）——npm pack tarball 面 57 文件健康；**关键裁决：必须 pnpm publish**——实测 pnpm pack 把 dependencies 里 `cordis: workspace:~`/`cosmokit: workspace:~` 重写为 `~4.0.0-rc.11`/`~1.8.1`（tarball 内 package.json 验证），npm publish 不重写 → 消费者 npm install 直接失败；0.23.0 发布清单第 ② 步更新为"pnpm publish（禁 npm publish——workspace 协议不重写）"。(4) 验证：单测 27→30、demo 6a2 扩 ready 级三题型聚合断言。(5) 会话治理：obelisk 记忆 v3→v4（mem-69218cab 归档 → mem-ff6b2eb8，英文 summary 覆盖 0.19–0.26 裁决）；本批非重大裁决经 a2a_report 备案至 team-god-system（report-e600799b）。

> **执行记录 · 0.26.0（2026-10-16，决策模型 choice/score 题型）**：(1) **设计**——R8 原非目标翻案；协议依据材料 §3：choice=1-255 选项全概率分布、score=2-10 级概率加权均值；**零 schema 变更裁决**：op 家族扩 eval/eval-choice/eval-score，问题+选项+期望打包 value 内 JSON 信封，parseEvalSpec 对 plain 向后兼容——避免 v7 九触点，显示层只出措辞。(2) **CLI**——`node cond --op eval-choice --options "k=desc,..." --answer k`（answer ∈ keys 校验 rc=2）；`--op eval-score --levels --min-score`（2-10 级、min 范围校验）；cmds 层打包信封，condAdd 签名不变。(3) **三态**——choice 判 P(期望答案)（阈值同源 config，灰带哲学与布尔一致）；score 判均值 ±1 灰带。(4) **eval.ts 重构**——postEval 共享传输层，四函数同源；导出面 +8。(5) **接线**——can --eval 按op 分派，evaluated[] 带 type（加法兼容）；validate 排除三 op。(6) **验证**——单测 27（含本地 stub 网关断言请求体 criteria 形状、无 token 不出网）；CLI 冒烟（离线双 pending、措辞显示、stub 端点双 pass → can.ok=true 真解锁）；demo 组 6a2；eval-gates skill 三题型版（题面价值排序纪律）。(7) **已知边界**——ready --eval 批量仍仅布尔（spec 非目标更新：混合批量留后续）。

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
> **执行记录 · 0.18.0（2026-10-16，AGENTS.md + 目录规范 + WebUI 设计 + 实际启用）**：(1) AGENTS.md——参考 deepseek-harness 文档分层税制（一个事实一个家）与根 AGENTS.md 理念（常驻守则+短+链接），完全为本项目定制：仓库布局图、命令面板、Agent API 契约（冻结）、数据模型决策链、六条开发规则、eval gate 指南、Skills 入口；(2) docs/layout.md——目录层级规划（当前结构+未来扩展位+文档分层税制+与 deepseek-harness 的对齐与差异表）；README 文档地图补全（AGENTS/CHANGELOG/layout/webui-design 四链接、编号修正）；(3) docs/webui-design.md——零依赖静态 HTML 导出方案（三视图：brief 仪表盘/SVG DAG 科技树/研究管线视图），后续批次实施；(4) **实际启用（dogfood）**——以「AI Agent 开发中的架构决策模式」为题建真实研究项目：4 检索式 → 6 来源（含 plan.md/pg-compat.md/conventions.md/git log/obelisk 记忆）→ 6 证据摘录 → 5 断言（3 supported / 2 unverified）→ 3 章节 + 报告 → kb ingest → promote 为 skill `arch-decision-patterns` → `agent match "架构决策怎么做"` 和 `"ORM 选型还是手写 SQL"` **均命中 top1**——闭环验证完成。
>
> **执行记录 · 0.25.0（2026-10-16，读路径写放大清剿 + dashboard 接 agent brief）**：(1) **skillMatch 批量化**——0.24.0 剖析只盯 kbSearch，遗漏同类：skillMatch 逐行 `UPDATE skills SET hits=hits+1`（N 结果=N 隐式事务=N VFS fsync；50 技能语料下即 ~500ms 级损耗）→ 单语句 `IN (...)`（0.23.0 kbSearch 同款修法）；功能验证：agent match 命中后 hits 递增正常（3/2）。至此读路径写放大全部清剿：kbSearch（0.23 批量）+ skillMatch（0.25 批量），nodeSearch/sourceSearch 本就纯读。(2) **dashboard 接 buildBrief**——agent-cmds.ts 内联 payload 构建抽为 `export buildBrief(env)`（`agent brief` 命令与 webui gatherData 双端复用，单一事实源）；webui Overview 区新增：项目进度行（name/question/sources/evidence/claims verified/artifacts）、next_actions 可执行命令列表（等宽字体、→ 前缀）、top_skills 徽章——dashboard 从"看数"升级为"知道下一步做什么"。(3) **deferred usage 裁决：不做**——CLI 单命令场景：延迟到 close 前刷盘仍是 1 次写事务（零收益）；serve 场景：10s 轮询节奏下单次 ~10ms 写负载可忽略；代价：Store 生命周期钩子 + main/serve 双处 flush 接线 + 计数器崩溃丢失窗口。结论：kbSearch/skillMatch 的单语句批量已是最优形态，读路径去写到此为止。(4) 验证：单测 56→57（brief 富载荷）、/api/data E2E（next_actions 3 条真实命令 + project 进度 + top_skills 双技能）、agent match hits 递增正常。
>
> **执行记录 · 0.24.0（2026-10-16，WebUI 三视图交互 + WAL+NORMAL + fts boost 限候选集）**：(1) **三视图交互收官**（按 webui-design.md 设计稿）——科技树 SVG 节点 `<g role=button tabindex=0>` 可点击/键盘触发 → 右侧 `#node-panel` 详情（新端点 `/api/node?tree=&key=`：nodeGet/parents/children/condList/canUnlock 确定性判定；eval 门槛以问题文本进 missing_required，与 `node can` 无 --eval 语义一致；404/400 分支）；claims 按 supported/contested/refuted/unverified 分组 + 点击展开证据（gatherData 扩展 claim_evidence 关联 + evidence 索引 {quote,locator,source_id}）；面板 DOM 独立于 render() 重渲染容器 → 选中/展开状态跨 10s 轮询保持；静态导出模式下 /api/node fetch 失败 → 显示"需 webui serve"提示。(2) **UI 规范**（用户指示加载 ui-ux-pro-max 技能；定向查询渐进披露/加载反馈/对比度）——esc() HTML 转义全覆盖用户文本、:focus-visible 焦点环 + tabindex/Enter/Space 键盘可达、aria-expanded（claim 展开）/aria-live（面板）/aria-label（关闭钮）、加载态→内容态→失败态三反馈、hover/selected 状态、prefers-reduced-motion 降级、✕ 关闭钮 escape 口。(3) **fts() boost 限候选集**——原 `lower(title) LIKE` 每 token 全表扫；改为 MATCH 聚合后单条 prepared 语句扫候选 id 集（boost 本只落候选行，计数语义逐位一致；500 行语料上收益被写路径地板掩盖，大语料下消除 O(N) 扫描）。(4) **WAL+NORMAL**（kb-search 剖析成果：单行 UPDATE 13.7ms = fsync 地板；WAL 已有、synchronous 默认 FULL）——db.ts 构造器 + getOrm() initialize 后双连接设置（synchronous 逐连接、journal_mode 持久于文件）；claim-write 39.9→28.1ms/op（−29%）；持久性=断电回滚末几笔不损坏（本地单用户教科书取舍，conventions §五"连接策略"沉淀）。(5) **kb-search 剖析定案**（tmp/kb-profile*.js 探针）：ngram≈0 / MATCH-only 0.6-1.5ms / full 17-30ms → 地板=per-token MATCH ~3ms + reuse 回写 ~10ms（wasm VFS 锁目录 mkdir/rmdir + WAL 追加）；"读路径去写（reuse 计数延批）"记为已知机会，需 Store 生命周期改造非便宜优化，不动。(6) 测试：webui 12 新例（内嵌 script `new Function` 编译护栏——模板转义回归锁、注入转义、三路由 E2E、/api/node 命中/404/400）；单测 45→56；ops/tools 声明 @ygl/techtree-model 跨域依赖（静态 import 取代运行时 require——vitest 不解析后者）；真实 serve E2E：demo 工作区 steel 节点 3 条件/can.ok=false/missing 含 eval 问题文本/parents=bronze 全对。
>
> **执行记录 · 0.23.0（2026-10-16，dogfood 深化批 + benchmarks + Bun 决策 + kbSearch 修复 + 时间戳修复）**：(1) **benchmarks/**——用户指出缺 benchmarks；零依赖七席套件（bench.js：startup 子进程完整 CLI / claim-write 事务化写 / claim-dedupe 幂等命中 / kb-import-batch 单事务批导 / kb-search FTS5+加权 / node-index 闭包+拓扑 median-of-3 / node-search），`pnpm bench`，产物 tmp/bench-results.json（node/平台/git 哈希留档）；README 记方法论（子进程 vs in-process 的理由、p50/p95、Windows Defender 方差注意、语料混合共享/专属 token 的用意）与 0.23.0 基线。(2) **kbSearch 写放大修复（基准首跑战果）**——top-20 逐行 `UPDATE reuse=reuse+1` 是 20 次隐式事务×wasm VFS fsync；改单语句 `IN (...)` 批更新后 500 行语料 p50 326ms→25.6ms、p95 2039ms→49.9ms（12.7×/40×）。(3) **Bun 运行时决策**——用户指示未来用 Bun 封装 CLI；本机 bun 1.3.0 (win32) 实测 `fs.openSync(path, O_CREAT)` 对不存在文件抛 ENOENT（node 全绿），node-sqlite3-wasm VFS 建库即死 → Windows 受阻；docs/bun-compat.md 沉淀证据链（探针矩阵）、相邻上游问题（bun#40001 node:sqlite close EBUSY、bun#42819 Windows fs 重构）、解锁条件（bun-smoke 全绿）与六步迁移清单；scripts/bun-smoke.sh 探针 + `pnpm smoke:bun`（不进 pnpm test，当前必红）。(4) **dogfood #2**——cordis-lifecycle 真实代码证据研究项目：3 检索式 → 6 源（registry.d.ts/index.js Fiber/service.d.ts/context.d.ts/git log/main.ts）→ 6 证据（源码逐行摘录）→ 5 断言全 supported（插件三形态注册/LIFO 清理+inertia 排空/Service 按名+inject 拦截/CLI 同步折中/rc 无顶层 dispose）→ 7 链接 → 大纲+章节+报告 → kb ingest → promote `cordis-lifecycle-cli` → agent match 双查询 top-1 → doctor 7/7；旧 tmp/research-dogfood 已被清空（gitignored scratch 波动，非缺陷），本轮从 db init 重建。(5) 报告 `_generated` 标记补 UTC 标注 + demo 组 4 断言。(6) 修正 0.21.0/0.22.0 的 CHANGELOG/plan.md 日期 10-17→10-16（git 提交真实日期）。(7) **npm 发布准备清单（实际发布待用户确认 registry）**——①确认目标 registry（公网 npmjs `--access public` vs 自建 Gitea tea 私仓，scoped 包需 scope 路由）；②`prepublishOnly` 已挂全量 `pnpm test`；③tarball 面 = package.json `files`（bin/dist/README/docs/CHANGELOG）——发布前 `npm pack --dry-run` 核对无 vendor/ 未打包泄漏；④发布后 `npm view` 验证版本可见 + `npx ygl-trees --help` 冒烟。
>
> **执行记录 · 0.22.0（2026-10-16，WebUI 动态版）**：`ygl-trees webui serve [--port N]`（默认 8642）——零依赖 `node:http` 活数据仪表盘：`/`/`/index.html` 实时 HTML（内嵌快照立即渲染 + `fetch('api/data')` 升级 + 10s 轮询）、`/api/data` 每请求现取 `gatherData()`；SIGINT/SIGTERM 优雅停机，Promise 解析后 CLI `finally` 才关 db（serve 期间 db 保持打开）。webui.ts 重构三出口：`gatherData()`/`generateHTML(data, live)`/`createDashboardServer()`；export 路径行为不变。安全：内嵌 JSON `<`→`\u003c` 防 `</script>` 注入。验证：单测 7 例（形状/live 引导/注入转义/三路由端到端 ephemeral port）、demo 断言组 8（export 单文件校验）、真实 serve E2E（api/data 活数据 + 404）。文档：CHANGELOG 补 0.21.0 缺口条目 + 0.22.0、webui-design.md 状态翻已实施、AGENTS.md 修 demo 组数（7→8）与 apps/web 命名、README 文档地图同步。
>
> **执行记录 · 0.18.0（2026-10-16，架构重构：Cordis + packages/apps/vendor 分层 + AGENTS.md + 目录规范 + WebUI 设计 + dogfood）**：
> **(1) AGENTS.md**——参考 DSH 文档分层税制（一个事实一个家）与根 AGENTS.md 理念，完全为本项目定制：仓库布局图、命令面板、Agent API 契约（冻结）、Cordis 架构说明、六条开发规则、决策链链接。
> **(2) 目录重构**——src/ → packages/（领域分层：core/research/techtree/knowledge/ops，每域 index.ts 显式导出面）+ apps/（CLI 应用入口）+ vendor/（上游 cordis/cosmokit 从 cordiverse/cordis npm tarball 落盘，pnpm workspace `workspace:~` 引用）。依赖方向：vendor → core → 域模块 → apps（单向无循环）。docs/layout.md 详述。
> **(3) Cordis 集成**——`packages/context.ts` 定义 DatabaseService/ResearchService（`Service` 子类）+ `createApp()` 组合函数；用户明确需要框架能力：运行时服务发现、多服务生命周期、事件驱动组合、动态插件加载、时空可组合性。vendor 从上游 cordiverse/cordis 4.0.0-rc.11（非 DSH fork），cosmokit 1.8.1。
> **(4) WebUI 设计**——docs/webui-design.md：零依赖静态 HTML 导出方案（三视图：brief 仪表盘/SVG DAG 科技树/研究管线视图），后续批次实施。
> **(5) Dogfood**——以「AI Agent 开发中的架构决策模式」为题建真实研究项目：4 检索式 → 6 来源 → 6 证据 → 5 断言（3 supported）→ 3 章节 + 报告 → kb ingest → promote 为 skill `arch-decision-patterns` → `agent match` 双查询均命中 top1。
> **(6) 文档全面更新**——AGENTS.md、layout.md（含依赖方向图）、README（文档地图+Skills 表+config/env vars）、webui-design.md。
>
> **执行记录 · 0.17.0（2026-10-16，巩固批：单测 + 死代码清理 + CHANGELOG）**：vitest 落地（37 用例：ngram CJK/拉丁/混合切分、contentHash 幂等与加盐、resolveEndpoint 四态归一化、mapOutcome 三态含 0.7/0.4 边界与自定义阈值、config 注册表不变量/五类校验/覆盖-重置/events 留痕）；`pnpm test` = unit + build + demo 三段。死代码清理（写迁移收官后的孤儿写路径，conventions 执行）：Store 13 方法（claimAdd/claimResolve/claimLink/queryAdd/queryAttach/sourceAdd/evidenceAdd/artifactAdd/skillUpsert/skillImport/skillDel/skillEnabled/skillRefAdd/kbAdd/kbIngestArtifact/kbPromote/projectCreate/jobAdd——逐方法 grep external=0 证据）、TreeStore 7 方法（treeCreate/nodeAdd/link/unlink/condAdd/stateSet/nodeDel/importTree）；**保留** rebuildClosure/buildIndex（validate 依赖）与全部读方法。store.ts 617→427 行、tree.ts 910→741 行。CHANGELOG.md 建立（0.1.0→0.17.0 逐版本聚合）。
>
> **执行记录 · 0.16.0（2026-10-16，ready --eval 批量判定 + 检索一致性）**：`node ready --eval`——`TreeStore.evalCandidates` 找出仅被 eval 条件阻塞的节点（排除非 eval 阻塞与被排斥者），每节点**一次多题请求**（`evalBooleanMany`，协议原生批量：同一 state 多 question 单请求同延迟）；全过 → 提升进 ready（`eval_verified` 标记），其余 → `eval_pending` 逐题带 P；凭证/端点/阈值沿用 config 优先级链；离线全 pending rc=0；留痕 `eval.ready`。skillMatch 接 boostExpr（s.name，与 kb search 同语义）。验证：离线 2 候选 pending 且每节点题数 1/2 正确、blocked 不入候选；本地 stub 证实 2 节点=2 请求、一次载 2 题、上下文按节点区分；P 映射（单题 0.95→promoted、混合 0.95/0.2→pending）。demo 6a 增 ready --eval 离线断言。
>
> **执行记录 · 0.15.1（2026-10-16，决策模型配置键）**：新增 `decision_model_llm_token` 与 `decision_model_llm_api_base`（用户裁定**配置项优先**）。优先级=config > env/文件回落 > 默认 Vercel 网关；api_base 归一化（bare host 自动补 /v4/ai/evaluation-model，完整端点直用——代理/自托管可整体接管）。eval.ts 保持纯净（token/endpoint 作参数 + resolveEndpoint 导出），优先级编排在命令层。四级验证：①注册表 10 键；②config 垃圾 token → 真网关 401 不重试 pending（证明覆盖本机文件 token）；③本地 stub 端点接管——四协议头/boolean 题型/上下文包（state.node.key）逐项核对，P=0.95→pass；④config 清空 → 文件 token 回落真网关 P=0.44 灰带。README/eval-gates skill 同步。
>
> **执行记录 · 0.15.0（2026-10-16，config 配置层）**：schema v6 新增 `config` 表（key/value/note/updated），与 `meta` 分工——meta=工具自写运行态，config=用户可调偏好。src/config.ts 注册表（8 键：eval.pass/fail_threshold、eval.offline、fetch.timeout_ms/user_agent、search.limit、default_confidence、job.stale_minutes，含类型/范围校验与中文说明）；`config list/get/set/reset` 命令组（unknown/违规 rc=2，set 留痕 events config.set）；解析序=环境变量>config>默认。**全部键真实接线**（eval 三态阈值与离线、fetch 超时/UA、检索默认条数、写入默认置信度、悬空 run 回收分钟）。九触点走齐：SCHEMA_SQL/export dataTables/MIRROR_TABLES/MIGRATE_DDL（沿 meta 先例不入 stats、不建实体）。验证：v5 库自动升级 v6、8 键全默认、越界/未知键 rc=2、eval.offline 经 config 生效、default_confidence B→A 生效、PG 同步 25 表携带 config 值、demo 加 config round-trip 断言全绿。
>
> **执行记录 · 0.14.1（2026-10-16，专属 Skills 赋能）**：新增 `skills/<name>/SKILL.md` 五枚——quickstart（全局契约/备份/PG/调度/tmp 规范）、research（证据管线）、knowledge（复用闭环）、techtree（节点模型）、eval-gates（决策模型门槛）；frontmatter L1（中文触发词）+ 正文 L2。junction 到 `.agents/skills/`（Node fs.symlinkSync junction 型；cmd mklink 在 Git Bash 引号转换下不可用——踩坑记录）。**验证**：宿主 Agent 技能目录实时发现五技能；dogfood——`skill import` 五枚入测试库后 `agent match` 五个中文任务查询全部命中正确技能（top1 各归其位）；junction 回读通过。README §七 技能表 + 新机器一行重建命令；.agents/ 入 gitignore。
>
> **执行记录 · 0.14.0（2026-10-16，M5/R8：Gate 决策模型布尔评估）**：src/eval.ts（v4 网关协议四头、token 双源 + YGL_EVAL_OFFLINE 强制离线、429/529 退避≤3、400/401 不重试、60s 超时）；`--op eval` 条件 + validate/importTree 放开空 value（R8.7）；evalContext 上下文包（node 元数据+直接父+closure 祖先链+条件组+解锁集+state 袋）；`node can --eval` 三态接线（pass 从 missing_required 移除、fail 保留标注 P、pending 单列非终态、ok 重算、events 记 eval.gate、离线 pending rc=0）。**真实冒烟（TypeSafe jev）**：三带全谱验证——可证事实 P=0.97 pass、未满足前提 P=0.39 fail、歧义上下文 P=0.45 灰带 pending（与材料"证据不足塌缩灰带"纪律一致，1.5s/次）。demo 6a 断言离线 pending 路径。**顺手修复**：demo.sh 此前继承 YGL_HOME 且惯例 rm -rf——`pnpm test` 在自定义 YGL_HOME 下会清空该工作区（本次实踩）；改为独立 YGL_DEMO_HOME（默认 /tmp/ygl-demo），继承工作区不再被碰。
>
> **执行记录 · 0.13.0（2026-10-16，真实试用反馈落地：批量导入 + title 加权）**：(1) `writes.kbImportBulk`——kb import 全批次单事务（幂等判定/events 在事务内，行操作内存态直到唯一 COMMIT）；真实语料 2189 条 **44s → 0.72s（61×）**，幂等重放语义不变。(2) 检索 title 加权——`fts()` 新增 `boostExpr`：同 hits 时标题含 token 者优先（额外字段 `title_matched`，加法非破坏）。**实现教训**：FTS5 列过滤 `title:监督` 对 CJK 标题永远空——unicode61 把整段中文标题索引为单 token，二元组只在 ngram 列；改用 `lower(title) LIKE` 子串匹配（绕过分词器，中英通吃，零 schema 变更）。真实语料验证：单 token 查询 boost 行严格前置、多 token 查询排名改善（"监督席 运行协议" top 全相关）。排序语义：hits desc → title 命中 desc → bm25 asc。demo 全绿。
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

## M5 — Gate 决策模型布尔评估（0.14.0，spec R8，2026-10-16 立项）

背景：必检条件的 quest/expr 类语义门槛现静默 false；引入评估模型 boolean 模式（TypeSafe jev via Vercel AI Gateway，材料 `F:\Users\Administrator\Downloads\vercel-ai-gateway-eval-api.md`）补上下文判定能力。

| # | 任务 | 涉及 | 规模 | 验收 |
|---|---|---|---|---|
| M5-1 | src/eval.ts 评估客户端（v4 协议四头、token 双源解析、429/529 退避 ≤3、400/401 不重试、60s 超时、全局 fetch） | src/eval.ts | S | 无 token → 明确 pending 错误态；协议错误不重试 |
| M5-2 | `--op eval` 条件：cond 命令放开该 op 的 value 校验（回落 name）；validate 对 eval 必检不要求 value | cmds/tree.ts, treeWrites/tree.ts | S | R8.7 校验路径 |
| M5-3 | 上下文包组装器：node 元数据 + 直接父 + 祖先链（closure）+ 条件组 + 解锁集 + state 袋 | tree.ts（canUnlock 扩展） | M | state JSON 含全部供料源，问题措辞与 state 字面对齐 |
| M5-4 | `node can --eval` 三态映射（≥0.7 通过 / ≤0.4 未通过 / 灰带 pending）+ evaluated 输出字段 + eval.gate 留痕 + offline pending | cmds/tree.ts, tree.ts | M | 离线 pending 断言进 demo；rc=0 |
| M5-5 | README gate 章节补决策模型段（含灰带纪律与 token 配置） | README.md | S | 命令面一致 |

**依赖**：M5-1 → M5-4；M5-2/M5-3 并行。
**风险**：① 评估延迟 1-2s/条件——批量树评估不做（非目标）；② 灰带语义与现有 tri-state 输出的组合展示需在 M5-4 定稿（pending 不进 missing_required）；③ token 无则全部 pending——demo 必须断言 offline 路径而非依赖网络。

## 明确推迟（不进本计划）

- ~~claim 仲裁工作流、query↔source 关联、markdown 批量导入、调度并发锁~~（0.5.0 已交付）
- ~~单测框架~~（0.17.0 已交付：vitest 37 用例）
- npm 实际发布（外部动作需用户确认 registry）、choice/score 题型接入

## 完成定义（DoD，每里程碑通用）

1. `pnpm build` 零报错；`pnpm test`（build + demo 含新断言）全绿
2. 新行为有 demo 断言或可复现验证记录（命令 + 输出贴进提交说明）
3. README / usage 与实际命令面一致
4. 版本号推进 + git 提交（一个里程碑一个合并点，任务可多提交）
