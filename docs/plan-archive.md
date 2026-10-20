# ygl-trees 历史里程碑执行记录（M1–M10）

> 2026-10-20 发版席文档治理：由 docs/plan.md 归档拆分，内容未改动仅移动。现行里程碑（M11+）见 [plan.md](plan.md)。

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

## M6 — 会话选择分辨率 R16（0.85.0，spec R16，2026-10-18 立项，A2A 工作单 direct-ceb27322）

背景：多项目工作区里并行 Agent 会话互踩共享 `current_project` 全局指针（0.83 用 `--project` 钉住治标）；spec R16 定根治方案——选择会话化 + 多项目未选择 fail-closed。

| # | 任务 | 涉及 | 验收 |
|---|---|---|---|
| M6-1 | selection.ts 解析器：flag > env(YGL_PROJECT/YGL_TREE) > 会话键(`current_project@<sid>`) > 全局；selection_source 六态 | core/database/src/selection.ts | 单测 selection.spec ×11 spawn 端到端（含 calibration --all 工作区豁免） |
| M6-2 | research/produce/task/agent brief/project show 严格门禁（rc=2 单错误对象）+ 工作区级豁免 + 单项目 only | research/pipeline、research/produce、ops/tools | demo 5m ×4；契约 +6（93 项） |
| M6-3 | webui 未选择态（不回退全局）+ /api/artifact id 直查归属 + 树面板选择来源 | ops/webui.ts | webui.test 17/17 |
| M6-4 | tree new --project 未知 rc=2 点名；tree use 跨项目 WARN；tree show 新子命令；doctor selection_hygiene | techtree/model、ops/doctor | spec 断言 + doctor 全绿 |

**升级注意**：跨会话不再自动继承选择；旧全局指针仅展示/迁移兜底（doctor 提示）。

## M7 — Cordis 应用深化（0.86 批次，2026-10-18 立项，评审 tmp/review-cordis.md / A2A direct-46df5155 + direct-92887873）

| # | 任务 | 验收 |
|---|---|---|
| M7-1 (P0-1) | evalClaim 服务化经 ctx.ops.evalClaim：填实 OpsService 空壳，解 research→ops 跨域 require（REVIEW-0.84.0 F3） | grep 无跨域 require；ctx.ops.evalClaim 有单测；demo 5l 四断言照绿 |
| M7-2 (P0-2) | TechTreeService 用或删——裁定**删**（cmds.ts:33 直构 TreeStore 是事实真相）；同步收 ygl.bundle.json techtree 条目 + PLUGINS 注册表；同口径核查 WebAppService（web/app/src/index.ts:78，webui 若直调 openStatic 则同删） | 行为零变化；死门面清零；bundle/注册表一致 |
| M7-3 (P0-3) | webui SSE 改 ctx.on("ygl")——事件桥进自测路径（桥坏了测试能发现） | webui SSE 用例经桥跑绿 |
| M7-4 (P1/P2) | fork 补 ctx.dispose()（或上游提需求）；settle loop 收敛或 ADR；knownKinds 11 种硬编码收敛到 eventbus 真相源；域间事件化试点（node unlock → research 提醒） | 各带验收回执 |

决策记录：P0 归 0.86 而非挤 0.85.0（0.85 已在发布门禁上）——评审席 dsh/fdc757f6 认可（direct-92887873）。

### M7 执行记录（0.86.0，2026-10-18）

- **M7-1 ✓**：OpsService 填实（evalClaim/assessEvidence/semanticRank，静态 import 委托）；bin.ts PLUGINS + ygl.bundle.json → database/ops/research/timer；research cmds.ts 三处 + knowledge kb search --eval 改 `env.cordis?.ops` + 离线形 fallback；grep 验收：research/knowledge 无 eval-enhance require。遗留（域间下沉，M7-4 域）：config.ts configGet（research cmds:13 + knowledge cmds:12）、rels.ts relAdd（produce-cmds:12）。
- **M7-2 ✓**：删 techtree/model/plugin.ts + WebAppService；web/app 保留 openStatic/resolveDistRoot；bin.spec 断言新组合（4 插件）。
- **M7-3 ✓**：SSE 主路 `ctx.on("ygl")`，非 Cordis 宿主回退 eventbus，fingerprint tick 降级保留。
- **根因修复（计划外，本批最重要）**：桥 require() 在 ESM 宿主静默死亡（ReferenceError 被 try/catch 吞）→ 改静态 import；桥链单测（apply 后 ctx.on("ygl") 收到 emitEvent）转绿。
- **M7-4 部分**：knownKinds 硬编码清单 → `ygl:<kind>` 动态桥接。**未做**（0.87 候选）：ctx.dispose() fork、settle loop、域间事件化试点。
- **flake 决策记录（评审残项 direct-2faf60bb）**：lifecycle.spec「DB.close() closes handle (lock cleanup on process exit)」在并行负载下 64904ms 超时（npm publish prepublishOnly 406s 失败与 0.85 pre-push 失败同一根因）；隔离重跑 3/3 绿（3.31s）。属已知并行负载家族，非代码回归；硬化方向（锁用例串行化/锁获取快败）记 0.87 候选。

### 0.87.0 执行记录（2026-10-18）

- 评审证据引用：M7 批次评审报告 `tmp/review-cordis.md`（评审席 dsh/fdc757f6，回执 direct-80e781dc 实读代码逐项核验）。
- plugin stop() `require("./orm")` 同款 ESM 修复（评审 0.87 候选补充）：ormState.opened 标志（db.ts）+ dynamic import——保懒加载（typeorm 不进冷启动）且 ESM/CJS 双兼容。
- `project use` 裸 shell 提示（用户裁定 m07308：环境变量不保险，显式指定最重要）：sid=default 且多项目时非阻断 hint，第一推荐显式 `--project` 钉住，`export YGL_SESSION` 降为次选。

### M8 — 监督席 6 工单批次（0.88.0–0.89.x，2026-10-18，canonical 订单 direct-e487e737）

| # | 单 | 版本 | 状态 |
|---|---|---|---|
| 1 | cond add (node_id,name) 幂等（P1） | 0.88.0 | ✓ 已发布+监督核验 PASS |
| 2 | unlink rel 不匹配诚实化（P1） | 0.88.0 | ✓ 已发布+监督核验 PASS |
| 3 | WebUI 纯 HTML 退役（P1，用户亲裁） | 0.88.0 | ✓ 已发布+监督核验 PASS |
| 4 | --help ANSI 泄漏（P2） | 0.88.0 | ✓ 已发布+监督核验 PASS |
| 5 | PG-A 地基四件（P2，kb 05485b25b5） | 0.89.0 | ✓ |
| 6 | bizplan eval-choice 门禁 + 定价/履约 ADR（P3） | 工作区数据 | ✓（见下） |

### 0.89.0 执行记录（2026-10-18）

- 单5 PG-A：方言接缝（getPgOrm/ormDialect）+ FTS5 shadow 方言门控（ftsShadow 助手 7 处）+ schema_migrations 双端账表（backend,version 主键）+ events.seq（SQLite 可空/PG nextval 单调）；schema v9→v10 升级路径。docker ygl-pg-test 全链实测（fresh migrate 26 表 + 账表双行 + RETURNING seq=1）。
- 三次返工教训（记入单5 回执）：bigserial 隐含 NOT NULL 拒绝镜像 NULL；SEQUENCE 必须先于引用列建；drift guard 拦截 MIGRATE_DDL v9 列漂移（guard 按设计工作）。
- 单6 bizplan（工作区数据侧，无 repo 改动）：platform-position/tta-target 挂 eval-choice 决策门（定位=service_first P=1、TTA 纪律=baseline_ratio P=1）+ 定价/履约 ADR（artifact 5f9858d538/aabfc2951a）decided-by 入织物。**人审推翻一例**：tta-target 的 TTA实测门 eval P=0.86 pass，但业务文档（定价框架.md:68）明确 TTA=岔路口⑤待首周期实测——文档证据优先于模型概率，裁定不解锁（kb ae1c1377e1）。教训：eval 门过≠解锁，解锁是人的决定。

### 0.89.1 执行记录（2026-10-18）

- 预测席上报（direct-b1de0e86）：`node cond <key> --op eval --value q` 缺 --name → 旧行为落 list 模式「(empty)」rc=0 零落账（成功形回执掩盖 no-op，与单2 unlink 同族）。修复：add 形 flags 任一存在而缺 --name → usage rc=2；裸 list 不受影响。cond-usage.spec.ts ×4。
- 0.90 候选登记：node 组 `<tree>/<key>` 限定形式统一（rel 认、node 组不认的不一致）；M7-4 残项（ctx.dispose/settle loop/域间事件化/跨包 config+rel 下沉，task a2dae0151a）。

### M9 — 结算投影 + WebUI 评审修复（0.90.0–0.90.1，2026-10-18，direct-ce7e561b / direct-ce9eaf7a / direct-a35d58ae）

| 项 | 版本 | 状态 |
|---|---|---|
| predict list 结算投影（outcome/channel/brier/settler）+ claims.channel v11 | 0.90.0 | ✓（tag 已推） |
| node: 限定形式统一（跨树解析/覆盖 -t/拒绝跨树 link） | 0.90.0 | ✓ |
| WebUI P1×3：/api/task 归属校验 / tick 异常隔离+busy_timeout / React 未选择态 | 0.90.1 | ✓ |
| WebUI P2×4：brief.project 剥除 / KG 授权+项目过滤（R19 立档）/ 管线视图诚实降级 0.91 / 测试 17 | 0.90.1 | ✓ |

- **R19 决策（webui-design.md）**：知识图谱为工作区级视图，端点标签携带断言/证据原文——未选择态不渲染、授权态按项目过滤（claim/evidence/artifact），node/kb 工作区级保留。
- **node-sqlite3-wasm 锁家族立档（评审建议）**：0.83 DB.close 65s flake、0.85 终审 65s 超时、0.90.1 P1-2 serve 击毙同族——自定义 VFS mkdir 目录锁在跨进程 WAL 竞争下语义脆弱；0.90.1 起全连接 `PRAGMA busy_timeout=2000`（读等待替代瞬败）。系统性硬化（锁获取快败/读写分离连接）列 0.91 候选。
- 0.90.0 不单独上 registry：0.90.1 同船发布（工作树已含 P1 修复，单独打 0.90.0 包会泄修复面口径混乱；0.84.1→0.85.0 先例）。两节 CHANGELOG 齐备。

### M10 — 事件族合修（0.91a，2026-10-18 立项，三方批次裁定：评审线 direct-23f13a7d / Cordis 席 direct-032bf3b4 / 监督席 direct-7389f32f）

**ADR：事件发射的提交后语义（post-commit emission）**

- **背景（Cordis 席实地证据）**：research/pipeline/src/writes.ts 与 techtree/model/src/writes.ts 的 logEvent 满足两个缺陷——①发射用 `require("…/eventbus")` 包 try/catch，ESM 宿主（vitest）下 ReferenceError 被静默吞，桥链单测实际测不到 writes 路径（M7-3 在 database/plugin.ts 修过的同一病灶）；②发射在 `ds.transaction` 回调内部即事务提交**前**——回滚后订阅者已见幽灵事件而库无记录（0.84 demo ghost 事件同族风险面）。
- **决策**：①静态 `import { emitEvent }`（core→core 无环，零加载代价）；②新增 `runTx(ds, fn)` 包装器——events 表 INSERT 留在事务内（审计行随写回滚），总线发射移到 `ds.transaction` 成功 resolve（TypeORM 仅在 commit 后 resolve）之后；`fn` 抛出→事务回滚→pending 袋整体丢弃，零幽灵事件按构造保证；③载荷在 logEvent 调用点快照（防调用方后改对象），字段与 0.76–0.90 格式逐字节一致（`String(payload)` 原语义保留，含 research 路径对象载荷的既有 `"[object Object]"` 形态——冻结不动，避免 SSE/校准消费面漂移）；④两域 cmds.ts 的 5 处裸 INSERT（claim.eval ×2 / tree.use·project.use / eval.gate / eval.ready）统一获得总线发射——autocommit INSERT 返回即已提交，紧跟发射天然满足提交后语义；rels/config/knowledge/produce 的裸 INSERT 归 0.91b 跨包下沉批。
- **验收三条（direct-032bf3b4 照录）**：①回滚零泄漏（abort→订阅者 0 条+库 0 行，双向断言）；②静态 import 后 vitest 下 writes 路径发射可见（桥链覆盖从 plugin 扩到两处 writes）；③已提交事务的发射内容与现状逐字节一致。
- **约束**：0.91 全批禁止重放/清洗/回填 events 表（首份校准曲线数据源完整性）；分支 `0.91a-event-family`（worktree D:\workspace\ygl-trees-091a）冻结窗口外开发，**合并/发布压到 10-19 15:00 基线快照之后**（监督席结算 14:00×5 支 + 校准曲线 14:30 + predict list 快照 15:00）。
- 测试：packages/research/pipeline/tests/emit-postcommit.spec.ts ×4（回滚零泄漏 / research 路径 ESM 可见+字段形状 / techtree 路径同 / 重复写不发（dup 早退语义冻结））。
