# ygl-trees 开发计划

日期：2026-10-15 ｜ 规格：[spec.md](spec.md) ｜ 调研：[research.md](research.md) ｜ 规模标记：S ≤ 半会话 / M ≈ 一会话 / L > 一会话

> **评审记录 · 0.84.0（2026-10-17，current_project 全局选中态 v2：源码实证 + 行动计划）**：0.84.0（`3c943c7`）修掉 REVIEW 四 P1 后，评审转向跨会话选择态——用户 v2 复核把根因钉到「会话级概念、机器级实现」。**撤回一条**：kb 不是读侧漏洞（`kb_notes` 无 `project_id`，db.ts:161-173；`kbList/kbSearch` 不收项目参数），kb 是刻意跨项目知识池，上轮「`kb list --project` 被静默忽略」作废。**但顺挖出真缺陷**：`packages/core/text/src/flagcheck.ts:15-23` 的 `rejectBare` 只查裸旗标，未知旗标全仓仅 `packages/techtree/model/src/cmds.ts:832-836` 一处 allowlist；实测 `kb add --project foo` 与 `kb add --bogus x` 均 rc=0 落库，`tree new tA --project nosuch` rc=0 且 `project_id=null`（`techtree/model/src/cmds.ts:106-108` 的 `proj?.id || ""` 静默落空）。
>
> **机制实证**：选中态 = meta 两行 KV（`current_project`/`current_tree`），无 env 通道、无会话作用域（`YGL_SESSION` 只给事件打标）；解析链 `flag > name || metaGet(current_project)`（`research/pipeline/src/cmds.ts:44`、`research/produce/src/produce-cmds.ts:30`、`project-cmds.ts:95`、`reads.ts:32-38`）；`project new` 在写服务事务内两处 UPSERT `current_project`（`pipeline/src/writes.ts:553-579`，duplicate 分支同写），`tree new` 对称自动选中；旁路直读 meta 五处——`ops/tools/src/agent-cmds.ts:15`、`webui.ts:67`（dashboard）、`:93`（tree）、`:914-917`（`/api/artifact` 用当前项目做归属过滤，而 `artifacts.project_id` 是 NOT NULL，db.ts:147-158）、`rels.ts:30`。0.76/0.79/0.83 三代事故同根。
>
> **裁决与校准**：根因是「选择分辨率缺失 + 旁路直读」，不是共享可变本身；① env 只作最高优先级覆写——DSH 每次调用 fresh shell，开场 export 不跨调用，会话态主路用 meta 后缀键 `current_project@<sid>`（sid=`YGL_SESSION||DSH_SESSION_ID||"default"`，DSH 子进程自带该变量），零 schema 变更；② `project new` 去自动选中是破坏性变更，留 0.85，默认只写会话键、`--global` 写全局；③ kb 的 rc=2 文案必须点名「kb 无项目维度」；④ 树悬空不回填（现存三棵全 NULL，回填只能猜），改为非空才校验 + WARN；⑤ contract⑤ 抽公共 `rejectUnknown`（kb 只是第一个暴露点）；⑥ `agent brief` 的 10 分钟事件窗告警应改报 `selection_source`；⑦ **追加裁定（用户 2026-10-17，读写都 fail-closed）**：研究管线几乎全部命令都按 `project_id` 过滤（`pipeline/src/cmds.ts:195/210/419/562/566/625/650/677/703`），连按 id 寻址的 `claim link/resolve` 也是项目作用域——严格授权的覆盖面比预想大，且 `pipeline/src/cmds.ts:41-48`、`produce-cmds.ts:28-35` 的入口急切解析**不必惰性化**；规则 = 工作区项目数 > 1 且来源 ∈ {global, none} → rc=2 点名（JSON 单对象），豁免 = 单项目工作区、`--all`、工作区级命令（db/doctor/project list/kb/node/job/rel/config/agent log）；全局键只服务展示与迁移。规格草稿见 spec R16。
>
> **行动计划**：Batch 0（0.84.1，~1h）公共 `rejectUnknown` + kb 接入 + `tree new --project` 未知名 rc=2 + `contract:audit` 87→90 与 demo 断言；Batch 1（0.85.0）resolver 落 `packages/core/database/src/selection.ts`（策略模式 `project-scoped|workspace`，pipeline/produce 组入口用 strict、`--all` 豁免），优先级 `flag > env > session > global`，写侧会话键，收口 3 解析调用点 + 5 直读点，doctor `selection_scope`，`selection.test.ts`（含 fail-closed 三态）+ demo 4 条；Batch 2 webui `/api/artifact` 按 id 直查 + 面板标注来源；Batch 3 conventions/AGENTS/CHANGELOG/技能。**YAGNI**：不建 `session_selections` 表、不给 kb 加项目维度、不合并双指针、不回填 `project_id`、不在评审冻结窗内做行为变更。**待确认**：`ygl-core-workflow` 技能不在这台机器（`~/.dsh/skills` 与仓库 `skills/` 均无），需给位置或新建。取证全在 `tmp/` 临时 home（`kbflag-probe-*`/`treeproj-probe-*`）跑完即删，真实库零改动。


## 里程碑总览

| 里程碑 | 主题 | 版本 | 包含需求 | 出口条件 |
|---|---|---|---|---|
| M1 | 数据不丢 + 写入幂等 | 0.2.0 | R1、R2、R7.1 | demo 含幂等断言全绿；round-trip 备份实测通过 |
| M2 | 可移植 + 校验补全 | 0.3.0 | R3、R4、R5、R7.2 | export→import 等价性实测；错误出口全部非 0 退出 |
| M3 | 研究管线增强 | 0.4.0 | R6 | source fetch 对 3 类真实页面可用；brief 健康度生效 |

里程碑串行执行；每个里程碑收尾 = `pnpm test` 全绿 + git 提交 + 版本号推进 + README 同步。
> **历史执行记录归档**：M1–M10（0.2.0–0.95 时代）见 [plan-archive-2026-10-20.md](plan-archive-2026-10-20.md)；0.41–0.45 与 0.96–0.113.x 及逐版发布记录见 [plan-archive-2026-10-26.md](plan-archive-2026-10-26.md)（2026-10-26 体量拆分，归档按拆分日期命名）。本文件只保留现行里程碑（M11+ 框架）与 0.114.x+ 现行纪元及总览/DoD。

### M11 — 业务接线批（0.93，2026-10-19 立项 m10310；.157 ops-handbook + ygl-overlap 12 断言背书）

**产品论纲（kb 58faf8b271）**：三树主（业务科技树 / 仓库研究树 / 人类能力树）×一协议（研究→预测→测试→验证→校准元循环）。ygl 不造执行能力——.157 专家团已有执行文明；ygl 是其认知台账，产品机会=三根接线。

- **T1 遥测门（0.93.0 已落，cfb8407）**：`cond op=telemetry`，value 语法 `kind[:窗口 d| h| s]（>=|<=|==|!=|>|<）数量`；canUnlock 注入 `telemetry:<kind>[:<win>]` 计数袋（events 表 count）；求值失闭。教训：evalCond 分支必须放 `raw===undefined` 守卫**之前**（首版 unreachable 被 live 探针揭穿）。
- **T3 cmd.run 会话归因（0.93.0 已落）**：bin.ts 两处发射点 actor=`YGL_SESSION||DSH_SESSION_ID||"cli"` + payload.session；采纳遥测命令级→会话级（.157 手册盲区 #1 同款解药）。
- **T2 patrol 命令族（0.93.0 已落，schema v12）**：patrol_checks/patrol_findings；SQL 门（SELECT 前缀+分号拒绝+4000 上限）；三态生命周期（仍在违反→last_seen bump / 消失+open|ack→auto-fixed / resolved 后复发→reopen）；doctor patrol_queue（S1 open=fail）；契约 §9。零未处置铁律产品化。
- **T4 SOP 绑定 rel（设计裁定 2026-10-19，冻结窗侦察）**：`rels.ts` 的 rel 值本就自由串（默认 related）——`--rel executes` 今日可用；sources 表无 kind 列，**不加 schema**（v12 刚落，单字段消费者未成型）：约定 `source add --tags sop`（tags 可检索）+ `rel add node:<tree>/<key> source:<id> --rel executes` 构成 SOP 织物条目；skills/README 记入词汇表。若 T5 毕业通道需要结构化 kind 再开 v13（真实消费者驱动）。
- **T5 毕业通道接缝（设计，待实施）**：ygl claim（supported+证据齐）→（.157 intention_parser）→本体→sop-renderer→Odoo 上岗。ygl 侧交付面=协议文档+produce 侧 artifact kind=sop 落账（artifacts.kind 已自由）+ rel executes 织物；跨系统执行归 .157（replace-esm 抵制裁定保持：互补不替代）。
- **T6 skills 两件（0.93 剩余）**：repo-research 标准形（主推②：给开源项目建研究树——mp-skills 深读是首例，GLOSSARY/two-loads/tracer-bullet 票制可迁移）；ops-patterns（.157 ops-handbook 三机制提炼：采纳监测/预测回测/SOP 边界巡检→patrol/遥测门/结算日历映射）。human-capability 推 0.94（human-agent-eng 探针两周观察期后提炼）。
- **T7 scenarios.md 重构（0.93 剩余）**：「三树主×一协议」骨架重排六场景，每场景挂对应树主与协议环节。

### M12 — 硬化与收尾批（0.94.0 + 0.95.0，2026-10-19）

- **0.94.0 锁家族终章（1e66b90/42b9c52）**：open 阶段 `.ygllock` 活持有者有界等待（`YGL_LOCK_RETRY_MS` 默认 8000ms；0=旧行为）——busy_timeout 只护句柄建立后，0.83/0.85/0.90.1 反复现身的家族连根；holderAlive 判活（kill0/EPERM=活，ESRCH/自身=死）；锁重试 spec ×4（opt-in 教训：spec 直构必须传 {lock:true}）。预审 direct-e164d3dc 通过；两条 µs 级理论窗（TOCTOU/waitForLockDir）按评审裁定**不开事项**（advisory 层预存+句柄层兜底+单用户成本收益）。产品论纲落盘（scenarios.md 一协议×三树主×六场景 + graduation-protocol.md + skills×2）。
- **0.95.0 毕业三件套 demo + tags 读面（6ce4da2）**：demo §9g ×3（supported 断言→source --tags sop→rel executes）——0.94 P3 承诺兑现；顺带修真缺口：source list/search 投影漏 tags（毕业协议消费方式「按 tags=sop 拉源」CLI 读面不可能）——cmds.ts list 投影+reads.ts sourceList+sourceSearch 三处；tags 本就落库进 FTS。踩坑：source add 是纯旗标命令（位置 URL→rc=2）；tags 存逗号串非数组。

### M13 — spec-validator 验证规范驱动器（2026-10-19 立项 m11350，设计阶段）

**0.114.0 记录（2026-10-22，T1/T7a/T6/T8 收口）**：#32（T1 归档白名单投影 + meta v2 登记制 + R5a）merge
`856398f`；#33（T6 语义边界渲染）3-way 合并 `60f008e`；#31（#27 品味提取计划）merge `7bd2b2a` + 执行状态
注记 `659cd4f`；**T8 补裁落地**（charter §4.4 R3 范围：ignored 路径归 P2 证据规则、`.ts/.mts/.cts` 入闭集、
`source_roots[]` 具名子目录声明、未声明全扫；`META_VERSION` 1.2）。本仓 meta.json v2 声明
`["packages","apps","tests"]` + `vitest.config.ts` tooling。整合门禁见发布记录。
（发版席 fresh worktree + pack:repro clean；npm 下载实测同字节）。
**0.114.1 记录（2026-10-22，#34 子句覆盖）**：材料非空行=冻结子句；`anchor.locator` 子句式（#L/#S）
必须命中现存子句且含 quote；prepare 在 P4 前校验每条子句被 ≥1 个 P1 通过候选覆盖（否则 error +
diagnostics P1c，不冻 ready），lint-candidates --text 同源输出 coverage/COVERAGE；`--coverage-exempt`
具名豁免（locator+reason，缺一即拒）。契约 1.2 不变（构造面）；contract 15 新增 2 检查（138→140）；
unit 700→704。
（发版席 fresh worktree + pack:repro clean；npm 下载实测同字节；远端校验 ETIMEDOUT 时按 guard `--no-network`
本地锚定 + ls-remote 双远端复证，非绕过）。
**0.114.2 记录（2026-10-22，r32 催办：登记漂移）**：`meta-tooling` 显式化——`--check`/`--reregister`
（必须 `--reason`，事件 `meta.reregister`={path,old,new,reason,actor} 先落账再改索引，fail-closed）/`--add`；
删除 auto-rehash（bare run rc2）。本仓两条漂移（`scripts/contract-audit.sh` 0.114.1 改动、
`scripts/meta-tooling.mjs` 本版改动）已按流程重登记，`verify meta .` 恢复 PASS。contract 12c
（`meta-tooling --check` rc0）+1 → 141；unit 704→706。charter §4.4 R3 补记⑤（禁 auto-rehash）。
（发版席 fresh worktree + pack:repro clean；npm 下载实测同字节；远端校验 ETIMEDOUT 按 `--no-network` 本地锚定 +
ls-remote 双远端复证，非绕过）。
**0.114.3 记录（2026-10-22，#36/#37 双派单）**：#36 predict-cli 墙钟 fixture 改相对 today 滚动
（created=今天−11d、deadline=今天−4d、days_left 恒 −4），红门恢复稳定。**#37 重登记审计入仓**：审计记录
从操作员本地 DB 迁到 `verify/meta.json` `reregistrations[]`（path/old/new/reason/at，append-only，
随 commit 走；原子写、无 DB 依赖）；R2 校验形状；contract 12c 增链一致性（每条 last new_sha == 活 sha）；
本仓三笔历史重登记迁入。unit 706→707；contract 141（12c 加强）。
（发版席 fresh worktree + pack:repro clean；npm 下载实测同字节）。
**0.114.5 记录（2026-10-22，PR #38 合入；对齐审查席 #34 设计提案 a–d）**：证据链——0.114.1 把材料每个非空行当子句
（标题/散文全挂 COVERAGE）且把 `#S<n>`/`#L<n>` 读成行号（与舰队的子句 id 锚点冲突），舰队 spec 全部无法重冻，舰队引擎上限钉在 0.114.0。
裁定：**a** 子句按规则界定——默认舰队约定 `^([A-Z]+[0-9]+) `（捕获组=id），材料可 `submit --clause-pattern` 声明并冻进
`material.json`（参与 material_id；prepare 只认冻结值，不收临时旗标）；**SKIP≠OK**——声明的模式一行不中=错误，默认模式一行不中=
具名跳过（lint `coverage_skipped`、prepare `[P1c] no clause lines matched pattern`），不造子句（不选「整份材料逐行」模式：那正是
0.114.1 的回归形态）。**b** 豁免只认 id/原文 + 必填 reason（裸字符串 rc=2，行号拒）。**c** `#<id>` 先解析为子句，`#line=<n>` 为行，
诊断分开计数。**评审配对**：孤儿评审阻断 ready，lint `--reviews` 同源。**d** 4 仓 24 份真实 spec 冻结进
`packages/verify/core/tests/fixtures/fleet/`，contract 15 跑 lint+prepare（141→144），库面 + 发布产物两层单测（在 0.114.2 代码上 57/58 红）。
契约/语料版本不变（构造面加法字段 + 文档改写）；charter 不涉及；Rust 不镜像 prepare/lint。#37（重登记审计落点）不在本 PR——合并 0.114.3 后本 PR 的 contract-audit.sh 重登记已走 #37 的 `reregistrations[]`。
已知非本 PR：#36 `predict-cli.spec.ts` 日期炸弹。
审查席 COMMENT 评审（0c6e47c，两条 P3 + 一条 P4）收口：跳过时 lint `issues[]` 增 `level:"warning"` 的 COVERAGE 条目（`ok` 只计拒绝——lint 仍是
prepare 的投影；「必须有覆盖」的门禁判 `ok && !coverage_skipped`）；默认模式放宽为 `^([A-Z]+[0-9]+) `（已在 a5f655b）；prepare 记录增结构化
`clause_scope`。棘轮：本 PR 自行抬升 bundle 基线（head 757,602 B，master 上限 754,413 B，超 3,189 B），已把新增顶层 JSDoc 改为行注释省约 2.3 KB，
余量是真实逻辑与可操作诊断——需维护者显式认账。
整合（2026-10-22）：PR #38 merge master 0.114.4 后，unit **787/789**（2 skipped）、contract **144/144**（舰队 24/24）、
demo、ratchet held、readme 54/54；`verify meta .` PASS / `meta-tooling --check` 0 drift；维护者认账 bundle 基线
739,621→757,018（仅 bundle）。#37 重登记审计随仓库走（本 PR 合并后 contract-audit.sh 重登记走 `reregistrations[]`，
末条 dafc0240 = 活 sha）。
发版席侧 registry 不可达，授权开发席代发（tarball=发版席 clean-worktree 产出，字节核一致；publish
`2026-10-22T03:27:26Z`）。

**0.114.4 记录（2026-10-22，fdc 评审：job add 静默误注册）**：坏行 `0b88263172` 根因=尾拉回要求串尾
`--every`，`--json` 后缀击穿 → every=0 静默 manual。修复：F1+F3 绊线（残留 `--every/--at` → 人类 stderr +
JSON `diagnostics`，不硬拒）；F2 usage 改序（旗标在 `--` 前）；README/llms 示例同批改序。坏行已 disable、
v2 标题重建已在库（fdc 处置核验通过）。测试 `job-schedule-token.spec` 5 例；unit 707→712。
（发版席 fresh worktree + pack:repro clean；npm 下载实测同字节）。
**#39 记录（2026-10-22，验证席派单；未发布）**：`looks_sealed()` 去「窗口含 YGLVF1 字符串」启发式，
改为 footer 形态判定（对象四键 / 括号成对 + JCS 首键 `build_sha256`）；开构建尾窗仅含 MAGIC → 不判封包，
括号成对 + `build_sha256` → 仍判封包（不静默降级）。`cargo test` 全绿（含新增回归）；契约/语料不变。
**#40 记录（2026-10-22，属主令 10:01；未发布）**：CLI 版本漂移信息性 nag——缓存 `$YGL_HOME/update-check.json`
（latest/checked_at/last_notified；24h TTL），stderr 单行、同 latest 一次、local≥latest 静默；detached 子进程
查 `npm config get registry` + `/-/package/ygl-trees/dist-tags`（1.5s 硬顶，失败静默）；`--json` 零污染，
doctor 增 `update_hint` 检查（warn 不失败）；`YGL_NO_UPDATE_CHECK`/config `update_check=false` 关；
调度上下文（继承 YGL_RUN_ID / YGL_SERVE / job tick|run）跳过。与 R5b 分离（#29：nag≠审计时钟）。
**0.114.6 发布记录（2026-10-22）**：#39 Rust `looks_sealed` 去启发式 + #40 CLI 版本漂移信息性 nag。
commit **`3b78822`**；tag **`v0.114.6 = 0a560a9c… → ^{commit}=3b78822…`**（双远端，tag 严格锚 3b78822；
origin/master `78d5830` 含 0.114.5 发布记录 docs commit）；npm **latest=0.114.6**、shasum **`afd1a72d…`**；
风控注：#40 与 R5b 分离（nag 不 gate 任何东西；R5b 审计时钟仍只认能力表，见 #29）；#39 回归见
`rust/yglverify/src/sealed.rs` 单测。
**#25 ③ 修正记录（2026-10-22，未发布；fork PR）**：证据链——0.113.1 修了 `verify meta` 的子目录上溯（#25c），但 `metaGate` 硬分支仍
`const repo = explicitRepo ?? process.cwd()`，审查席在 0.113.2 / 0.114.0 两次复验仍复现（合规仓 `sub/` 里 meta PASS、submit rc=1
meta_unverified）。裁定：闸与 `verify meta` 共用一个解析 `judgedRepoOf`（= `metaRepoRootOf` 真实路径上溯 ?? 起点真实路径），旁路 provenance /
阶梯标记判定 / 硬分支三处同源；阶梯语义保持（显式 `--meta-repo` 优先、git 外跳过、无标记警告）。审查席观察（继承自 0.113.1 的 `verify meta` 上溯）同 PR 收口：git 内上溯只停在 meta 索引（`verify/meta.json` / `verify/specs/`）或 git 根，
嵌套 `AGENTS.md`（如本仓 `packages/AGENTS.md`）不再截断；git 外最近 AGENTS.md 仍算。`meta-gate-subdir.spec` 10 例（0.114.6 代码 8/10 红）。
**0.114.7 记录（2026-10-22，#44 选择桶三违例）**：F1 `project new/use --json` 增
selected/prior/session + 共享桶 `selection_warning`（人类面 stderr 同步）；F2 跨项目 `claim link` 未显式 `-p`
且选项目不拥有两端时增 `selection_note`；F3 `claim resolve/unresolve/unlink`、`evidence add <source>`、
`source show` 拒绝点名归属项目，`source show` 按 R16.3 改为作用域内读取。选择语义设计评审 #45 已入库
（D1–D5 未裁定待属主）；本版只补信号与拒绝文案，未改选择授权语义（D2/D3 不动）。
**0.114.7 记录（2026-10-22，#44 选择桶信号 + owner 点名）**：F1 `project new/use --json` 增
selected/prior/session + 共享 default 桶 `selection_warning`（人类面 stderr 同步）；F2 跨项目 `claim link`
未显式 `-p` 且选项目不拥有两端时增 `selection_note`；F3 `claim resolve/unresolve/unlink`、`evidence add <source>`、
`source show` 拒绝点名归属项目，`source show` 按 R16.3 改为作用域内读取。设计评审 #45 已入库（D1–D5 未裁定待属主；
本版只补信号与拒绝文案，未改选择授权语义）。门禁：unit 808（807 passed|1 skipped，108 files）、contract 144、
demo/ratchet/readme/rust/pack 全绿。发布：commit **`07c9523`**；tag **`v0.114.7 = 39d64cd0… → ^{commit}=07c9523…`**；
fileCount 177）。
**0.114.8 记录（2026-10-22，#46 JSON 契约）**：`produce export --json` 成功路径改单对象
`{artifact_id,path,chars,bytes}`（此前人类 ack 泄漏到机器通道）；错误路径单 `{error}` 不变；人类模式 ack 不变。
测试 `produce-export-json.spec` 3 例；unit 808→811；contract 144。
（publish `2026-10-22T07:51:00Z`，fileCount 177）。
**0.114.9 记录（2026-10-22，#47 selection 残面）**：按 #45 语义梳理做全 id 动词清单过堂——
`produce show/export`、`task done/doing/todo` 增项目作用域；`claim evaluate`、`evidence assess/rm`、
`source rm`、`query done`、`claim link --by-source` 的 source 缺失统一 owner 点名；`query done` 补作用域。
共享 `idNotFound/ownerProjectName`（core selection）单一规则；不改变选择授权语义（D1–D5 待属主）。
unit 811→812；contract 144。同批 #48：`produce show/export`、`kb show`、`research source show` 缺 id 前置
rc=2 单 usage 错误（不再泄驱动错误）；`usage-rc.spec` 四例；unit 812→813。棘轮：bundle 基线 757,018→772,395（维护者认账；PR42+#44/#46/#47/#48
真实逻辑；web dist/cold start 基线不动）。#48 与 #47 同批发布。
（publish `2026-10-22T08:41:19Z`，fileCount 177）。
**0.114.10 记录（2026-10-22，#49 缺参 sweep）**：`kb link`、`job run/enable/disable`、`tree use`、
`skill rm/enable/disable`、`skill refs add/show` 缺参统一 rc=2 单 usage 错误；合并 `skill refs` 双 case
（`refs add` 文档写法此前被列表分支截获）；`tree new/use` 前置校验；`db export` 按文档要求 `<file.sql>`；
`patrol run` help 纠正为 `[--name <check>]`。新增 `missing-args.spec` 机械 sweep（76 动词，逐行断言
rc=2+单 JSON error+stderr 干净），一次收全类。unit 813→889；contract 144。
（publish `2026-10-22T09:51:18Z`，fileCount 177）。
**0.114.11 记录（2026-10-22，批十六 kb FTS 漂移）**：`kb rm` 的 FTS/基表/links/事件改单事务写服务
（此前两条 autocommit 之间有崩溃/忙错窗口）；并发加固 busy_timeout 10s + runTx SQLITE_BUSY 退避重试 +
getOrm/boot 打开期锁重试。`kb-fts.spec` 2 例（rm 一致性 + 12 并发 add 后 base==fts）。unit 889→891。
验证席结论：用户库漂移发生于高并发导入场景；本版把写侧缝与并发失败面一起收掉。
（publish `2026-10-22T10:19:08Z`，fileCount 177）。
**0.114.12 记录（2026-10-22，#51 单驱动 + #50 sweep 残余）**：#51 P1——主库改为 better-sqlite3（与 ORM
同 native 驱动），消除 wasm 点锁 vs native fcntl 在 POSIX 互不可见导致的丢事件行/假 IOERR；适配层保留
all/get/run/finalize；`db sql` 非 SELECT 回退 run；12 并发 kb add 增「事件行不丢」断言。测试收尾补 native
句柄关闭（ops-service/verify-jobs/lock-retry）。#50——五 node 读动词缺 key rc=2（sweep 81 动词）；
六条 --json 成功路径单对象（kb link/promote、db export、webui export、skill refs add/show）。unit 891→899。
`node-sqlite3-wasm` 依赖清理列后续（已不在运行时路径）。
（publish `2026-10-22T11:39:11Z`，fileCount 177）。macOS POSIX 并发复跑仍待有 mac 环境的席位。
**0.114.13 记录（2026-10-22，#53 升级破坏面 + #52 测试污染）**：#53——native 驱动使 WAL 首次真实生效，
旧库（≤0.114.11 DELETE）首开会持久转 WAL；本版加迁移检测 + stderr 提示 + `YGL_LEGACY_JOURNAL=1` /
`YGL_JOURNAL_MODE` 开关，CHANGELOG 升级注记（含降级 sqlite3 步骤）。#52——verify-example/help-checker 两
spec 的 CLI spawn 补临时 YGL_HOME（真实 home 313 条 cmd.run 污染根因），并 seed 工作区。依赖清理：
root+core/database 移除 node-sqlite3-wasm，bundle externals 同步；bun-compat 标注旧结论过时。
journal-mode.spec 3 例；unit 899→902。
（publish `2026-10-22T12:40:52Z`，fileCount 177；deps 8 条，wasm 已移除）。
**0.114.14 记录（2026-10-22，#53 探针口径跟进）**：WAL→legacy 回切在其它连接打开时 SQLite 原样返回 wal，
0.114.13 无提示=看起来未回切。本版先 wal_checkpoint 再重试；仍失败打 `switch BLOCKED` stderr，不再静默。
明确升级提示只在「发生转换的那次打开」出现（旧库已被转过则后续无提示）。journal-mode.spec 4 例；unit 902→903。
同批 #54：better-sqlite3 依赖 ^13→**^12.11.1**（对齐 typeorm peer ^12，消除 npm 升级后 typeorm 无 driver 的
「SQLite package has not been found」）；doctor 增 `sqlite_driver` 检查，getOrm 错误带 npm dedupe 修复指引；
sqlite-driver.spec 2 例。unit 903→905。
（publish `2026-10-22T14:10:26Z`，fileCount 177）。
**0.114.15 记录（2026-10-22，#55 attach 边角 + #57 doctor 假阳）**：#55——`verify submit --attach` 同名不同
目录保留目录限定路径（绝对路径取末两段）、同文件重复只记一条、目录参数 rc=2 用法错；attach-paths.spec 3 例。
#57——doctor `sqlite_driver` 改从 typeorm 解析路径取版本并比较两侧 realpath：单副本 pass、split warn（点名
dedupe）、解析不到 fail；sqlite-driver.spec 细节断言。unit 905→908；contract 144。
（publish `2026-10-22T15:09:02Z`，fileCount 177）。验证席四探针 PASS。
**0.114.16 记录（2026-10-22，#58 文档漂移）**：`rel --help` 补 `task:id`（代码九类）；plugin-authoring
服务面改为真实 `ctx.database.db`/`ctx.research.store`/`ctx.ops`（删 ctx.techtree/ctx.webApp）；conventions §一
九触点路径改 monorepo 位置，第 4 触点改为写服务唯一写入面（Store 只剩读/配置/例外）。docs-only，unit 908 不变。
（publish `2026-10-22T16:17:56Z`，fileCount 177）。
**0.114.17 记录（2026-10-23，A1 第一刀）**：**relayed-order**——属主口头「开始」由主队席转发（无正式落章/签章；
按 fdc 处置 0.1 如实披露，实现不替裁定背书）。Q1–Q7 按两席建议通过、charter §4.7 增补草案定稿为**转达内容**。本版落 `verify tree prepare`：material JSON → 冻结期校验（leaf spec 存在/
组非空/算子封闭集/环/悬空/不可达/深度 16/pinned 形状）→ `verify/trees/ts_*.json`；错误单对象 rc=2。
verify-tree.spec 8 例；unit 908→916。run/report/trace/archive 与 V1–V19 运行时验收列下一刀。
（publish `2026-10-22T17:24:57Z`，fileCount 179）。
**0.114.18 记录（2026-10-23，A1 审阅订正）**：契约 v1.1（V7 digest 判定投影/ERROR 聚合矩阵/多快照绑定/
同主体查重 V20，V21）不改 Q1–Q7 裁定；#60 第一刀两洞——pinned 冻结走 archive registry + `verify archive verify`
验签，聚合解析器拒绝 quorum2/quorum(2/all_pass() 等畸形。verify-tree.spec 10 例；unit 916→918。
（publish `2026-10-22T19:49:30Z`，fileCount 182）。两席按 relayed-order 复核 v1.1——**非属主正式落章**；
契约按 fdc 0.1 标注待裁定，冻结线见 0.2。
**0.114.19 记录（2026-10-23，A1 运行时第一刀）**（实现=relayed-order，未落章；见 0.1/0.2）：`tree run/report/trace`——叶真实 run+默认 archive、
pinned 验签回读、四态聚合矩阵、多快照绑定；树报告 `verdict_digest` 只覆盖判定投影（V7），events 只增。
组独立 report+archive 列下一刀。verify-tree.spec 18 例；unit 918→926。棘轮：bundle 772,395→795,880
（维护者认账；web/cold 基线未动）。
（publish `2026-10-23T00:47:32Z`，fileCount 182）。
**0.114.20 记录（2026-10-23，A1 树层收口）**：组节点独立 report+archive（标准 VerifyReport + 合成 spec +
buildArchive skipMaterials + registry；tree 信封带树 verdict）；pinned 归档验签失败→叶 NEUTRALIZED。
`scripts/tree-fixture.mjs` 生成隔离夹具（两叶+snapshot+真实归档+pinned 树）供 V6。unit 926。
（publish `2026-10-23T02:18:04Z`，fileCount 182）。验证席 V6 三态对照复验 PASS。
**0.114.21 记录（2026-10-23，元验证 R6）**：META_VERSION 1.3；meta 索引 v3 增 `kind`（engine|consumer，
R2 校验，v1/v2 判定不变）。R6 engine——vendor workspace 依赖/bundle 顺序（timer 第4）/服务锚/上游基线+fork
后缀；R6 consumer——引擎钉版≥契约地板（1.2→0.107.0）、编排不得驱动 verify 动词、禁 vendor 引擎。
本仓 meta v3 kind engine + vendor/upstream.json；tree-fixture 登记 tooling。verify-meta 23 例；unit 926→931；
`verify meta .` 五规则全绿。
（publish `2026-10-23T03:48:27Z`，fileCount 182）。
**0.114.22 记录（2026-10-23，K3 选择观测三条）**：`tree use` 共享桶 selection_warning；
`query add`/`node add` 写时刻告警（shared=global 或 session/default；同维 90s 内 project.use/tree.use；
不做 actor 对比；90s 外静默）；doctor 增 `selection_hygiene_trees` warn。判定唯一实现
`selectionChangeWarning`；selection-signals +1 例；unit 931→932。
（publish `2026-10-23T04:36:47Z`，fileCount 182）。
**A1 契约落章（2026-10-23 14:01，属主直令经 fdc757f6）**：Q8=target 声明+全叶一致+失配 V 行（subject=repo+commit）；
Q9=D 引用失配（基准=冻结 spec_version，缺字段 fail-closed，stale 沿父链阻 PASS，进 digest）；Q10=B any ERROR→父至多
INFRA_BLOCKED；Q11 删 run 幂等；Q12=B（V17 移 run 期）；Q13=A 限本 workspace；G8=JCS；G9=附件 A 推荐。
新增树层第五 verdict STALE（叶 report 四值不变）、全序 NEUTRALIZED>STALE>FAIL>INFRA_BLOCKED>PASS、V15 5×5。
v1.2 定稿 + 裁定单 v2 + 矩阵重生成已交；Phase 2 两席会签后解冻，Q10 返工+九缺口补齐→0.115.0。
**0.114.23 记录（2026-10-23，发布门可靠性 + 元登记）**：#61 contract-audit `badref()` 改全 stderr 搜期望串
（选择观测注记不再抢 head -1；连跑两次 144/144）；R3 登记 `tree-contract-matrix.mjs`、`contract-audit.sh`
显式 --reregister（#37 lineage）；#47 `query attach` owner 点名。A1 v1.2 quorum 分母+V15 逐算子文档
（fdc/验证席 delta 双签，SHA ff8b245f）；unit 932，contract 144，clean tree `verify meta .` 五规则 PASS。
**Fast-follow 登记（2026-10-23，组合层 BirthRecord v1，裁定 dsh/74555a36）**：出生记录暂以 `kb add`
（tags 域隔离）落点；当笔记量/搜索噪声触发时，评估 events 公开 writer 面（结构化 append + 双键索引查询）。
BirthRecord 五字段：session_id/pack_id/member_name/manifest_sha256/declared_at。触发条件/优先级由开发线评估；
A1 V1–V19 夹具共作窗口开启时预告主队席。
（publish `2026-10-23T09:36:39Z`，fileCount 187）。
**0.114.24 记录（2026-10-23，Windows 空锁残留）**：品味席 direct-1af18e77/监督席转达——空 `.ygllock`
（无 pid/cmd）被旧实现误判活锁并写入自身 pid，形成自引用锁；`db unlock --force`/`doctor --fix` 同环。
修复：`clearLockDir()` 重试 + `takeoverLockDir()` 原子 rename 兜底；失败 fail-closed，绝不写 pid 进残留目录。
`lock-empty.spec` 2 例。同批 P2：`--reviews` 形状预校验（缺 findings 不再 TypeError，rc2+schema）、
`walk()` lstat 跳过悬空 symlink（evidence skipped_symlinks，不再整目录 ERROR）。同批 #63：p1/翻译层
`expected_from ?? anchor` 别名 + example 候选形状；#65 validator 1.2.0 快照隔离读检 + role gate + 重登记。
unit 932→939；contract 144；ratchet bundle 基线 813,623（认账）。
**0.114.24 发布（2026-10-23）**：commit **`6f7ecb3`**；tag **`v0.114.24 = ba47414b… → ^{commit}=6f7ecb3…`**（双远端）；
（publish `2026-10-23T12:03:37Z`，fileCount 189）。
**0.114.25 记录（2026-10-23，编码 fail-closed + command 边界）**：#62 `submit` 材料编码归一——UTF-8 BOM
剥除+记 text_encoding，UTF-16（BOM/NUL）与非法 UTF-8 → rc2 点名转码；#64 command 仅执行面文案 + 契约
「构造面边界」段（七型闭集 ≠ 构造面子集）。verify-encoding 3 例；unit 939→942；contract 144。
**0.114.25 发布（2026-10-23）**：commit **`61446db`**；tag **`v0.114.25 = e407f34d… → ^{commit}=61446db…`**（双远端）；
（publish `2026-10-23T12:43:15Z`，fileCount 189）。
**0.114.26 记录（2026-10-23，MCP 写面扩展·方案 D）**：属主两度纠偏（不独立仓/不进 apps）后裁定
「扩现有 MCP 桥」。`ygl-trees mcp` 8→11 工具（research_write/tree_write/verify 写面移植自已废定制插件）；
rc 保真（isError + 机器可读 {rc,error}）；DSH 集成=dsh-mcp-connector 配置（docs/mcp-dsh-connector.md），
零新包零双发。独立仓 D:/workspace/dsh-ygl-trees 废弃。mcp-write.spec 4 例；unit 942→946；contract 144。
**0.114.26 发布（2026-10-23）**：commit **`7e00fc7`**；tag **`v0.114.26 = c9f5490a… → ^{commit}=7e00fc7…`**（双远端）；
**0.114.27 记录（2026-10-24，fdc P1 边界实证 + 回归钉）**：P1 失败面=0.103 家族旧 ref（无 eol 约束）；
0.108 全仓 eol=lf 已修，HEAD autocrlf=true 克隆实测 PASS。`r3-eol-regression.spec` 钉住（克隆夹具双判据）；
pack-check 5b stderr 落盘+失败回显（reregister 入链）。unit 946→947；contract 144。
（publish `2026-10-23T17:19:42Z`，fileCount 190）。
**0.114.28 记录（2026-10-24，MCP 写面修复 + webui 状态机）**：#68 三处 mis-map（source-add --title 旗标/
verify submit title-text 分离/verify prepare --db 透传）；#66 服务端权威状态机（重读存储态+前进/幂等，
stale 拖回 409）。mcp-write 7 例 + task-status-machine 3 例；unit 947→953；contract 144。
（publish `2026-10-23T18:30:11Z`，fileCount 190）。
**0.114.29 记录（2026-10-24，lint 编码 + webui 幂等）**：#69 lint --text 走 decodeMaterialText（BOM 剥除
+UTF-16 拒收，S1 不再蒸发）；#70 幂等同状态零写零事件（todo→todo 不再推进 doing）。
verify-encoding +1 / task-status-machine +2；unit 953→956；contract 144。
（publish `2026-10-23T21:24:09Z`，fileCount 190；谱系 5014144=PR#67 合并在链）。
**0.114.30（发版席 P2 线首例，README 冲突标记收口）**：commit **`7d02b6f`**；tag **`845fccc6…`**（rebase 重锚）；
**0.114.31 记录（2026-10-24，收口版）**：MCP 11→4 收敛（read/write/verify/doctor domain×action）+ HTTP 传输
（StreamableHTTP stateless）+ 技能 MCP 对照 + #75 计数根除（readme:count 自动写）。reopen 8 单的 npm 复检版。
unit 984；contract 144；demo 5j2 预测 audit 有日历漂移已知问题（非回归）。
附带发现：pack-repro pnpm 定位器在 pnpm≥10（.mjs 而非 .cjs）环境下失败——发版席已解（npm_execpath 直指），
0.114.32 定位器候补加 .mjs 后缀。
**B' 历史改写记录（2026-10-24，#76 隐私事件）**：snapshot.json（内网 IP/会话 ID/知识图谱）随 v0.114.31 入公共仓历史。
属主裁定 B'：git filter-repo 改写+强推双远端。v0.114.31 `bb0fc44→2eec801`、master `4ff4c70→eab5dae`。
npm tarball 0 命中不受影响。验证席⑥验收 PASS（双远端 fresh clone 历史 0 命中+泄密串不可达+旧 SHA 不可达）。
四条缓解排下一版（gitignore 模式/卫生闸/生成路径根修/导出脱敏）。
**B1 读路径异步化记录（2026-10-25，PG 线 B1 批）**：四域 AsyncStore 委托层落位（AsyncTreeStore/AsyncResearchStore/
AsyncOpsReads/AsyncDbCmds，共 ~319 行 + AsyncDb 统一接口）+ 调用面全净（techtree 34/research 46/webui+db-cmds 5 处 await 切换，
`env.store` 同步消费 0）。#77 修复：5 处列名对照 schema v12（relations.src_id/jobs.title/patrol_findings.last_seen/
node_conditions JOIN nodes/runs 按 started）。#78 修复：sourceSearch await 链错位 + queryDone facade 补齐 + query done --json
单对象。行为漂移登记册 `docs/pg-compat-drift.md` 建册（B0 护栏②）。B1 面回归 `b1-facade.spec` 5 例。
**0.115.0 记录（2026-10-25，A1 v1.2 收口）**：依据=裁定单 v2 + fdc 2026-10-25 cap-on-PASS 补正 + r38 两席签注。
Q8 target/subject 冻结+canonical、Q9 引用失配（活叶/pinned/缺字段）、G8 版本 pin+prepare 校验、五值映射、
V15 5×5、Q11 删 run 幂等、Q12-B/Q13-A。矩阵 green 21/partial 1/planned 2（Q4/V21 后置）。B1 四域异步面 +
#77/#78 修复 + #37 执法四件。unit 1019 / contract 144 / demo rc0 / ratchet 绿 / readme 54 / rust 绿。
残余后置：G8 run 期可选加道、Q8 subject 声明不校验实况、#77 facade 覆盖面/方言函数登记。
**PG 单写后端 B0–B6 全链闭环（2026-10-25）**：属主令「帮我推进这一块的构建」→ B0 立项文档（charter/pg-compat/AGENTS/
方案 §B0 六件）→ B1 读路径异步化（四域 AsyncStore + 调用面全净）→ B2 schema parity 门禁（28v28 列集对账+自腐化防护）
→ B3 检索方言抽象（FTS5/tsvector 双后端+黄金查询集）→ B4 并发语义（upsert ON CONFLICT RETURNING+advisory lock+
READ COMMITTED 成文）→ B5 运维面（db snapshot 脱敏+全链验收）→ B6 双后端门禁矩阵（strict fail-closed 判定+PG 直连面原语）。
**真库终验（docker postgres:16.15）**：26 表/核心读面/upsert 幂等/advisory lock/tsvector 列/events.seq 全过；四条护栏全验。
已知边界：CLI boot PG 分支（booted.db 置空走 asyncStore）未动——doctor/stats 走 PG 为后续项，不阻塞 B6 判定。
**0.110.0 候选（待用户裁定范围，2026-10-21 分诊）**：
- **最小面（可发现性主题版）**：①`verify example --checker`（corpus/examples SSOT，含 null ops 展示）②`verify lint-candidates`（不耗 spec_version 的逐条 shape 报错）③prepare `rejected_detail: [{source_clause,stage,reason}]`（旧字段保留一版）④help 七型选型表（count=存在断言 / sql=违例扫描的 PASS 反向坑，`--help`/llms 双面同源）⑤F6 `predict audit [--due]` + `research predict list` 严格旗标（未知 rc=2）与 `--due` 真过滤。
- **0.110.x**：F1 `--project` 写输出放大目标 + cwd 绑定警告；F2 `evidence/claim show`（三 show 全字段）；F4 跨项目 link 一行提示。
- **立项评估**：F3 runs 一等公民（`run add --spec --verdict --report-path` + `evidence --run`，涉 schema 九触点与报告寻址）；F5 webui status 版本对账；scaffold `--domain/webui/--daemon/views`。
- **r29 Q1（job_target.updated_at）**：目标同字节时保持时间戳与字段不变；target 变化才刷新并回 `job_target_retargeted:true`。测试：同 target 两次 schedule 时间戳相等、换 db/every 才变。
- **r29 Q3（仲裁锁）**：`claimLink`/`recomputeClaimStatus` 按 events 最近 `claim.resolve`/`claim.unresolve` 判定；resolve 后增删链接保持状态并回 `recalculated:false`，`unresolve` 解锁；**无事件回退现行为**并在 spec-validator §9 写明（长期可选 `claims.arbitrated_at` 列 / schema v13）。测试矩阵：resolve→unlink 保持 / resolve→link 保持 / unresolve→unlink 重算 / legacy 无事件按现行为。
- **`db init` 冷启动**：本机实测 85-86s（0.105.1-0.109.1 均复现，逐技能独立事务 + 本机 fsync/AV）；候选改**单事务批量导入**（per-skill savepoint/catch 保留单条容错，FTS 影子失败不回滚整批），进度行显式 flush 以便 CI 可见；CHANGELOG 记录冷启动数字（用户第一公里体验）。

**0.109.1 记录（作者复审四连，2026-10-21）**：
- **#7 余项（P1）**：worker 父会话从 actor 兜底 `"cli"` 改为选择桶 `sessionId()`（缺省 `default`）；`job-plain-shell.spec` 在**无 YGL_SESSION** 环境跑 `job tick` 验证裸 shell 路径（此前只测有会话路径，0.108.1 复测漏检即此）。
- **#10（P2）**：contract-audit 补 contract 10 段覆盖 `node move` / `claim unlink` / `evidence rm` / `source rm` 四命令（重跑语义/用法 rc=2/坏引用点名/`--json` 单对象错误），100→122 项全绿。
- **#11（P3）**：plan 的 node.move payload 字段订正为 `from/to/key/state_rows/closure_rows`。
- **PR#13**：tokens.spec CRLF 归一化 + CRLF 回归用例、web README 措辞；干净 worktree 门禁 604/606 + pack:check 后合入（merge `7ab0ce7`）。
- 测试 unit 605→**608**。

**0.109.0 记录（前端 PR#4/#5 合流，2026-10-21）**：两项前端特性此前已合并但未进 release note（0.108.2/0.108.3 只带代码），本版统一记录并按 semver 用 feature 号。
- **PR#4（`dd8cd3e`）**：双主题 + hash-router 壳；`DESIGN.md` 调色板唯一事实源、`tokens.css`/`tokens.ts` 两面测试锁同步、首屏主题脚本、antd 映射与 KG 服务端色板同源。合并前干净 worktree 574/574 + pack:check。
- **PR#5（GitHub `e5f49fe` → 发布线 `313004a`）**：研究管线重建 + 概览驾驶舱/活动时间线（30 天窗口、UTC 标注、表格视图、复制反馈、空态）；只消费既有 `api/*`。作者 30 分钟未 rebase → 按预验（rebase 无冲突、自有 diff 14 文件、603/603 + pack:check）走 GitHub rebase-merge，再合回 Gitee 发布线；双远端对齐 `313004a`。
- 合并后主树实测 **605/605**（83 文件）、ratchet held（bundle 668220 / web 1434106）、pack:check PASS。
- 契约/语料零变更（1.2，digest 不变）。

**0.108.3 记录（GitHub issue #10/#11，2026-10-21）**：P3 收口。
- **#10 `pack-repro` pnpm 定位**：候选扩为「npm_execpath(仅 pnpm.cjs) → node-relative ×2 → `%APPDATA%/npm`、`/opt/homebrew/lib`、`/usr/local/lib` → PATH 各目录的 `node_modules/pnpm/bin/pnpm.cjs`」；仍然只跑 JS 入口（不 spawn `.cmd`），保持 Windows 无 shell 引号面。Homebrew 全局布局与 PATH sibling 都在候选内。
- **#11 文档名实**：`node_states`→`node_state`；毕业记录字段清单去掉 `materials_sha256`（spec 字段，记录里没有），改为 `spec_id/spec_version/run_ids/thresholds/history/span_days/data_source/created`。
- `.gitignore` 增 `{}` 根目录杂文件。
- 测试 unit 不变 **576**。

**0.108.2 记录（GitHub issue #8/#9，2026-10-21）**：外部报告 + 验证席数据级复现。
- **#8 `nodeMove` 假幂等**：重试分支补血统校验——`events` 中该节点的 `node.move`/`node.move.noop` 必须同时匹配 `from`/`to` 才算重试；否则 rc=1「no recorded move from tree 'x'」并指路 `node rm`。红测试先写（`node-move.spec` 幻影重试 vs 真重试对拉）。
- **#9① `--db` 空白**：flag `.trim()` 后空串 == 未传；`db_override:null`、`job_target.origin:"report"`（此前 blank 被记 override 但实际跑报告来源）。`verify-cli.spec` 回归。
- **#9② `cascaded` 类型统一**：`evidenceRemove` number / `sourceRemove` boolean → 一律 number（级联删除量）；`unlink.spec` 断言冻结。
- 测试 unit 549→**576**（含 PR#4 合并带入 27 例前端测试；本版 +2：node-move 幻影重试、verify-cli 空白 --db）。

**0.108.1 记录（GitHub issue #6 的 P2×2，2026-10-21）**：外部报告 + 验证席源码坐实。
- **① stuck-run reaper 时间格式**：`reads.ts jobReapStuck` 的 cutoff 是空格分隔本地时间，`runs.started` 是 `nowIso()`（UTC ISO-8601）——同日比较恒假、跨日叠加时区偏移，0.87.1 后静默失效。修法 cutoff 改 `toISOString()`；测试三例（同日 40min / 跨日 / 新鲜 1min）。教训：**任何「格式化时间字符串比较」都是回归温床，必须同源同时钟**。
- **② job tick/run 长持锁**：`execute()` 的 execSync（≤600s/作业）发生在进程级写锁内，其他 CLI 排队。修法 `bin.ts` 对 `job tick|run` 设 `YGL_SERVE=1`（同 `webui serve` 推理）：boot 无锁，互斥靠 fs `tick.lock` + SQLite WAL；回归测试在慢作业运行中跑 `db stats`，断言 <5s 返回。
- **#7 job worker 丢项目选择（P1，0.106.0 回归）**：`workerSessionId` 给子会话加 `<parent>/<job>` 段，但选择解析只读精确键 → 多项目工作区裸命令 job 全灭。修法 `sessionChain()`：项目/树选择沿会话链精确→祖先回退，子树自设优先；`selection.spec` +2。
- 测试 unit 541→**547**（job-reap +3、job-tick-lock +1、selection +2）。

**0.108.0 记录（语料冻结锚点强化，2026-10-21）**：fdc757f6 0.103 裁定的「blob 双检 + 属性保护」落地，无契约/语料语义变更。
- **身份锚**：`freeze.mjs` 改 `git hash-object -w --path=<repo 相对>`（按 `.gitattributes` 过滤）→ `git cat-file blob` → sha256；同一提交在任意 `core.autocrlf` 下同清单，未提交的新文件也可算（先写对象）。安装态无 git 时回退磁盘哈希（发布产物只读 manifest，不冻结）。
- **运行时锚**：`corpus-freeze.spec` 新增「盘上字节 sha256 == manifest 哈希」断言；属性/配置回归写 CRLF 时两道哈希分叉，本地门禁即红（0.103 的失败形态从 CI 提前到本地）。
- **属性保护**：manifest 增 `attributes_sha256`，`.gitattributes` 改动可见；同时把仓库级属性改为 `* text=auto eol=lf`
  （原 `text=auto` 在 Windows `core.eol=native` 下检出 CRLF，前端 PR 的 `tokens.spec` 在 fresh clone 上必红——
  0.103 同类问题的最后一个仓库级入口）。
- 等价性：两种锚法 digest 同为 `683766f1…`（173 文件），`corpus_version` 不升——纯观测锚强化。
- 测试：unit 539→**541**（corpus-freeze +2）。

**0.107.0 记录（契约 1.2 落地，2026-10-21）**：`contract_version` / `corpus_version` 1.1 → 1.2，Rust 同版。
- **形态一（同表列对列）**：`contract.ts` 的 `PredicateCondition.value` 收 `ColumnRef`；`engine.ts` 渲染为裸标识符，
  `columnRefOf`/`firstColRefPair` 把首个 `{col}` 叶投影进 findSql（`… AS __cmp_left, __cmp_right` + `ORDER BY rowid`），
  evidence 出 `compared_rows`（≤5）/`compared_total`（无条件）。跨表 → `cross_table_col`，`is null` 配 `{col}` →
  `null_rhs_for_null_op`，两者都以 `spec_error` 封闭码进 ERROR evidence。
- **形态二（count.against）**：`CountChecker` 新变体（`predicate + against`，`value?: never`）；渲染
  `(SELECT count(*) …) <op> (SELECT agg(col) FROM against.from)`；`agg` 必填（缺省 `missing_agg`）；
  右值 NULL → ERROR + `compared:{left,right:null}`；正常 → `compared:{left,right}`。
- **版本闸**：`runVerify` 接受 1.1 与 1.2；1.1 携带 1.2 形态 → `version_shape` 入口拒跑；报告
  `contract_version` 取 spec 声明（1.1 spec 的报告仍写 1.1，corpus 既有 33 例零改动）。
- **prepare 构造校验**：`{col}` 右值列存在性、`against` 表/列/agg 校验（schema 可判，不依赖数据）。
- **语料 33→44**：8 行为/构造例 + 3 红队例（清单见 CHANGELOG 0.107.0）；既有 33 例逐字节不变；LF 重冻
  digest `ee1a0a1d…` → `683766f1…`（173 文件），血统表进 `packages/verify/core/CHANGELOG.md`。
- **Rust mirror**：`contract.rs`（`AgainstSpec`、`CountChecker.value: Option<f64>`、`is_known_contract` 兼容 1.1）、
  `predicate.rs`（`column_ref`/`contains_col_ref`/`first_col_ref_pair`/渲染同表规则/`ident_public`）、
  `engine.rs`（against 渲染、NULL 右值、`compared`、版本闸、报告版本取 spec、`err_code`）。
  `cargo test` 31 例全绿；`rust-parity.spec.ts` 44 例整份报告逐字节 parity 全绿。
- **门禁**：unit 539、demo 128、contract 100/100、readme 54/54、Rust 31、`pack:check`/`pack:repro`（handoff 给值）。

**0.107.0 实施清单（契约 1.2，设计已双审通过，地面工程已在库）**：
- 设计方案：`docs/verify-contract-v1.2.md`（fdc757f6 四问裁定 + K3 批准 + 两个实现期冻结：`compared_total` 无条件、`ORDER BY rowid` 采样确定性、`count` 唯一不产 NULL 的 agg）。
- 已在库（commit `fee4a37`）：`contract.ts` 类型（`ColumnRef`/`AgainstSpec`/`SpecErrorCode`/CountChecker against 变体）、`engine.ts` 的 `{col}` 同表渲染与 `count.against`（`missing_agg`/NULL 右值 ERROR/`evidence.compared`）、`version_shape` 入口拒跑、`prepare.ts` 构造校验、7 例地面测试。**行为仍是 1.1（惰性）**。
- 剩余步骤（按序，同一 release 内完成）：
  1. `CONTRACT_VERSION`/`CORPUS_VERSION` 升 `"1.2"`（runVerify 版本闸已支持 1.1 spec 兼容）；
  2. 语料 +8：`count-against-pass/fail`、`col-ref-pass/fail`、`against-null`（count-over-empty=0 vs max-over-empty=NULL 同例）、`type-mixed`（存储类语义 parity 高价值）、`agg-variants`（含 NULL 列冻 `count(col)` vs `count(*)`）、`count-against-missing-agg`（ERROR 报告）；另加三个红队 throw 例（`red-cross-table-col`、`red-null-rhs-for-null-op`、`red-version-shape`），构造负例共用一目录的旧方案改为逐例 `expect_throw`（corpus-runner 的 throw 判定是整次 run，不能按 VU）；
  3. `compared_rows`/`compared_total`：形态一在 sql 检查器 evidence 层实现（采样 ≤5、`ORDER BY rowid`），witness 四字段不变；
  4. Rust mirror：`rust/yglverify/src/contract.rs`（两个新结构 + CountChecker 变体）、`predicate.rs`（`{col}` 渲染/跨表拒绝）、`engine.rs`（against 渲染/NULL 右值/`compared`）、`tests/parity.rs` 与 `corpus_parity.rs` 全绿；
  5. 语言重冻：`node corpus/freeze.mjs --write --version=1.2`（LF 重冻；manifest 记 blob 内容哈希 + 门禁断言盘上字节==manifest，digest 血统写 CHANGELOG 旧→新）；
  6. 门禁（`pnpm test`/`test:rust`/`readme:verify`/`pack:check`）→ handoff（K3 + fdc757f6 + 验证席复核清单）。
- 注意：主树存在 `rust/yglverify/target`，`rust-parity.spec` 会跑 Rust 侧——因此 **Rust mirror 与语料必须在同一 commit 落地**，否则新 1.2 语料会让 Rust parity 红。

**0.106.0 记录（选择归属与 worker 隔离）**：K3 情报把「8 verifier 节点落错树」拆成两个残余洞——`"default"` 桶（无 `YGL_SESSION` 的裸进程共享一个选择命名空间）与 sid 粒度不到 worker（同一 DSH 会话派 N 个 worker 共享 `DSH_SESSION_ID`）。本版各补一半，另加审计归因。
- **worker 级 sid**：`job-cmds.ts` 的 `execute()` 给子进程注入 `YGL_SESSION=<parent>/<job-id>` 与 `YGL_JOB_ID`；`workerSessionId()` 导出并单测（`sess/job_1`、`sess/job_1/job_2`、`env-sid/job_3`）。作业之间、同作业并发运行之间不再共享 session 选择；父链仍可回指。
- **选择归因**：`selection.ts` 增 `recordSelectionVia()`/`currentSelectionVia()`/`eventActor()`；`resolveProject`/`resolveTree` 解析后把 source 记入 `YGL_SELECTION_VIA`。事务写路径（research/pipeline 与 techtree/model 的 `logEvent`）`actor` 改 `eventActor()`；树域对象 payload 合并 `via`。**研究域 payload 不改字符串形态**——emit-postcommit 等既有断言把 payload 当冻结文本，形状漂移会破坏审计消费者；因此研究域只归因 actor，树域（payload 本就是对象）才带 via。测试固定这条边界。
- **doctor 警告**：`session_identity`（sid=default 且多项目）与 `tree_selection_hygiene`（仅全局 `current_tree` 且多树）；均 warn 不 fail——并行共享是合法用法，doctor 只负责让风险可见。
- **契约 1.2 拆到 0.107.0**：1.2 要动 contract types / prepare / engine / Rust mirror / 语料重冻 / corpus_version，跨实现且需设计评审先行；先出 `docs/verify-contract-v1.2.md` 草案给 K3 与 fdc757f6 过目再实现，不塞进本补丁版。
- 测试 unit 528→**531**（job-at +1、unlink 归因 +1、doctor +1）；README 计数同步 522→531（此前两版漏更新，非门禁项）。

**0.105.3 记录（issue #2 剩余项 + K3 五条 NIT）**：0.105.2 发布后清尾，无契约形状变更。
- **#3 原子写**：`verify-cmds.ts writeJson()` 改临时文件 + `renameSync`（同目录），冻结记录要么旧要么新，不存在截断；`graduate --schedule` 的就地重写走这条。测试：graduate 22 例复绿 + 0.105.2 的 verify-cli before-image 断言。
- **#7 `source rm` 级联**：新增 `writes.sourceRemove(ds, id, force)`——有证据时拒绝并列证据 id；`--force` 事务内逐条解链→重算 claim→删 `evidence_fts`→删证据→删来源→删 `sources_fts`，事件 `source.rm` 带 `cascaded: N evidence, M claim(s)`；CLI 补 project_id 前置校验（旧实现只按 id 查，跨项目可删）。
- **#8 `ratchet` seeded 提示**：基线缺失时打印「N 项无基线，`--write` 建基线」（旧实现测完即丢、静默空转）。
- **#9 `job_target_error` 人类面**：graduate 人类输出补黄字「记录仍是上次排期意图，作业已登记」。
- **K3① relations 孤儿**：`rels.ts` 新增 `relationEndExists()`/`orphanRelations()` 与 `rel prune [--dry-run]`（落 `rel.prune` 事件）；`doctor` 增 `relation_orphans` warn；删除路径不静默连坐——检测与治理分离（doctor 计数、prune 显式清）。首版测试：rel prune dry-run 不删、真删后 orphan=0 且事件 pruned:1。
- **K3②** `evidence not found` 补 `-p` 指引；**K3③** `evidenceRemove` 返回 `forced`（入参）+ `cascaded`（实际链接数），CLI JSON 同步；**K3④** `nodeMove` 只迁 `node_closure` depth=0 自环行、docstring 同步（透传行由 `node index` 重建，测试用真实 shadow 节点造 stale 行验证不随迁）；**K3⑤** `node_edges` 检查补 `tree_id`。
- 测试 unit 523→**528**（unlink +3、rels +1、doctor +1、node-move 断言增强）。

**0.105.2 记录（issue #2 的 P1 修复批）**：外部复核 GitHub issue #2（zhujun200409-cloud）对本仓 14396eb 提 9+ 条；本版修三条 P1（验证席代码级坐实 #1/#6，另 #2 为测试缺陷）。#4/#5 已并入 0.105.1 的 pack:repro 重写，#3/#7/#8/#9 排 0.106.0。
- **#1 `node move` 重试不幂等**：`nodeMove()` 的源树查行按 `fromTreeId` 作用域，首移成功后同一命令重试必然空集 → `node not found` rc=1（契约违约：幂等操作报错）。修法：查行落空时再查目标树，若同名节点已在那里 → `{moved:false, duplicate:true}` rc=0 + `node.move.noop` 事件（payload 带 from/to/key）。**不合并语义**：`moved:false` 仍是「本来就在」，`duplicate:true` 是「这次是重试」，两者都 rc=0。
- **#6 `evidence rm` 留下 `evidence_fts` 孤儿**：删基表与 `claim_evidence` 时漏删 FTS 影子行，破坏写路径铁律 1（幂等/基表/FTS/events 同事务）——被删证据仍可被全文检索命中，指向不存在的基表行。修法：同事务 `DELETE FROM evidence_fts WHERE id=?`；`unlink.spec` 加影子行断言。
- **#2 同义反复断言**：`verify-cli.spec.ts` 的 r28 Q2 `created` 不变量比较写成 `afterMove.created === afterMove.created`（两分支相同，永远绿）。修法：在 `--db` 重排前读冻结记录做 before-image，再断言 `created`/`data_source`/`run_ids` 与重排后逐字节相等——测试现在能真的抓到「重排改写了审计事实」。
- 测试：node-move 6→7（重试幂等）、unlink 7（+FTS 影子）；verify-cli 32 例复绿。

**0.105.1 记录（打包修复 P0，无源码改动）**：0.105.0 的发布 tarball 由 `pack:repro` 手工组装，直接读仓库原始 `package.json`，绕过 pnpm 的 `workspace:` 重写 → 四个 `@deepseek-ai/*` 依赖以 `workspace:~` 进入 npm 清单，全新 `npm install ygl-trees@0.105.0` 必 `EUNSUPPORTEDPROTOCOL`；`pack:check` 5b 只比哈希与条目清单（字节稳定性），没验可安装性，故未拦住。修复：`pack:repro` 改为**以 `pnpm pack` 产物为内容源**再确定性重打包（条目排序/mtime 0/uid-gid 0/0644/ustar/gzip 9），重打包前硬闸拒绝任何 `workspace:` 残留；gzip 头 OS 字节固定 `0xFF`（修外部复核 #5 的跨主机哈希不一致）；`pack:check` 5b 新增空目录 `npm i <repro tarball>` + 跑装出来的 `bin --version`（外部复核 #4；只比哈希不比可安装性正是本次漏网原因）。事后处置：Gitea 0.105.0 unpublish、npmjs dist-tag `latest` 回拨 0.104.0（granular token 不能物理删 0.105.0，已隔离危害）。

**0.105.0 记录（批九增补单 + r28 收口）**：验证席批九增补（task direct-1d11bff7，用户误挂 4 条证据只能用 `db sql` 裸删）与 302cb119 r28（P3 `$` 展开、Q2 `job_target`）合并本版；无契约形状变更。
- **claim unlink / evidence rm（P2-1）**：`packages/research/pipeline/src/writes.ts` 新增 `claimUnlink()`（点名三类 not-found、删链接、`recomputeClaimStatus()`、`claim.unlink` 事件）与 `evidenceRemove()`（有链接时拒绝并列出 claim 与解绑命令；`--force` 逐条解绑 + 重算 + 删行 + `evidence.rm` 事件含 `(cascaded: N link(s))`）。`recomputeClaimStatus()` 对 `[预测·` 前缀断言**保持原状态并回 `recalculated:false`**——预测状态由 `claim resolve` 仲裁，证据增删不改变裁决；这是「证据是材料，仲裁是动作」的直接后果。不做成 `source rm` 那种只删不级联的形式：证据的链接面比来源大，静默丢链接会让断言状态说谎。
- **node move（P2-2）**：`packages/techtree/model/src/writes.ts` `nodeMove()` + `cmds.ts:1130` case：整节点跨树迁移，先拒绝「本树内还有边」（先改边，不替用户猜哪些边该跟走）与「目标树已有同名 key」，成功后迁 `node_state` 行、双树 `markDirty`、落 `node.move` 事件（payload 实为 `from/to/key/state_rows/closure_rows`）。树内改 parent 不塞进本命令（语义是 unlink+link 的组合）。
- **可发现性（P2-3）**：顶层 help 与 llms 补 `node rm <key>`（处理器早已存在，缺行等于没有），并写「删除连带边/条件/状态」；`docs/scenarios.md` 与 techtree 技能补并行会话纪律（各自 `use` 或全程 `-t/--project`，session selection 已存在，不新增机制）。
- **r28 P3 `$` 进 denylist**：POSIX sh 双引号内仍展开 `$VAR` → `--db /data/${HOME}/x.sqlite` 被判 usable 后跑成另一个库；`SHELL_METACHARS` 加 `$`。`{` `}` 在双引号内是字面量，**不拒**——0.104.0 文档误写、源码本没拒，本版订正文档并加测试（`/data/{a}/x.sqlite` usable）。
- **r28 Q2 `job_target`**：`graduate.ts` 新增 `attachJobTarget()`，`--schedule` 成功后写入 `job_target {db, origin, usable, job_id, every_minutes, updated_at}`；**只更新这一个字段**，`spec_id/spec_version/run_ids/thresholds/history/span_days/data_source/created` 逐字节不变（毕业记录里没有 `materials_sha256` 字段——它是 spec 字段）（`duplicate` 路径同样只动它；不带 `--schedule` 的重复毕业保留旧值）。理由：冻结记录的审计事实不能随排期漂移，但「最后排期意图」需要可审计（`job.retarget` 事件 + `updated_at`）；该字段不进 identity/重复判定/资格/patrol，旧记录缺失容忍。
- **可复现打包**：新增 `scripts/pack-repro.mjs` + `pnpm pack:repro`（清单取 `npm pack --dry-run --json`；条目排序、mtime=0、uid/gid=0、uname/gname 空、mode 0644、ustar 无 pax、gzip level 9 无文件名/时间戳；Node 实现不经 shell）。实测连打两次同 sha256（1,344,800 B / 162 条目，具体值见 handoff——tarball 含本文件，把自身指纹写进来会自指），且条目清单与 `npm pack` 逐项一致（`pack:check` 5b 断言）。`pack:check` 仍负责「能装能跑」，两者分工写进 `docs/release.md`。
- **contract-audit 并发口径更正（回应发版席）**：`scripts/contract-audit.sh:19-20` 本就是 `mktemp` + `export YGL_HOME="$WS"` + `trap rm`，从不写共享工作区；发版席观察到的 99/100 归「重负载并行 flake」家族（同轮 `webui.test.ts` P1-1 ECONNRESET 同源），修法是门禁串行化而非快照模式——把审计改成快照副本修的是不存在的缺陷，故不改代码，只在本记录留证。
- 测试 unit **522**（76 文件，+25，其中 `graduate.spec` 18→22：`job_target` 两条 + 空心记录守卫 + `{}` 路径放行）。
- 门禁（主树，0.105.0）：`pnpm test` → unit 522 / demo 128 / contract 100/100；ratchet 首跑 `bundle 635074 → 648067 [regressed]`（超容差 292B）→ 作者席 `node scripts/ratchet.mjs --write` 认账（bundle 648067、web 1369836、cold 按 min-of-7 重建），复跑三项全部 held；`pnpm test:rust` 31/31；`pnpm readme:verify` 54/54；`pnpm pack:check` PASS（含新 5b 确定性断言：连打两次同 sha256、162 条目与 `npm pack` 条目清单逐项一致）。
- **闸门不再弄脏工作树（发版席发布坑②的修法）**：`scripts/ratchet.mjs` 原来在指标变好时自动写回 `ratchet-baseline.json`，于是 `pnpm test`（以及任何跑它的发布钩子）会在发布过程中修改被跟踪文件，`pnpm publish` 随即 `ERR_PNPM_GIT_UNCLEAN`。改为只认显式 `--write`，变好仅提示「N 项比基线更紧」。理由：度量工具不得改变被测对象；否则「闸门通过」与「工作树干净」在发布路径上互斥。
- 门禁脚本自检两处（本版顺手修，否则 5b 恒挂）：`scripts/pack-repro.mjs` 不再盲信 `npm_execpath`（`pnpm run` 下它指向 pnpm CLI，`pack --dry-run --json` 不被支持 → 只在 `npm-cli.js` 时才用，否则回落到 node 同级的 npm）；`scripts/pack-check.sh` 第二个哈希误用 `process.argv[2]`（`node -e` 只有一个脚本参数位 → `readFileSync(undefined)` 抛 ERR_INVALID_ARG_TYPE，而 `|| fail` 只记不退出，表面症状是「两次哈希不同」）。

**执行记录 · 0.99.1（首签 + r16 修复，2026-10-20）**：生产 key #1 首签实证（Cordis 封包 `spec_efb9a6a40450` v3，signature rc=0 → register → sealed run `run_first_signed` PASS 5/5 → import → archive `arc_8b717422ca3a` --with binary → archive verify ok）；修 `verify prepare` 的 `corpus_version` 硬编码（新增 `CORPUS_VERSION`）；`seal --key` 容忍种子文件尾随换行（Rust 用例 +1）；按 r16 复核修三项：legacy 0.98.0 非规范 footer 豁免规范形断言、import/archive 校验工作区二进制内容身份、密钥表载入自检 `key_id === sha256(public_key)`。文档 §4.1（`sig_alg`/`key_id`/`sig` 字段名；`run` 只验完整性不验签名）与 §5（import 需可信表、`--no-copy` 后果）。

**0.98.0 进行中**：验证席三席合并结论 ① 落地——`pnpm verify:run`（submit → prepare → run 串接，rc 只表达过程错误、`--json` 单对象，readme:verify 54/54）；归档 `created` 改为 fail-closed（报告缺 `finished` 时不回退 now()，评审 302cb119 残留 nit）；M13-1b Rust crate 补 `contract.rs`（契约镜像）+ `compare.rs`（八模式逐条对齐）+ `tests/parity.rs`（33 份冻结语料 spec 全部可解析、八模式语义断言），cargo test 12/12。
M13-1b 执行面补齐：`engine.rs`（七型 fact 检查器 + witness + 拓扑 + 折叠）与 `sqlite.rs`（只读 runner）落地，**33 例语料 parity 通过**（30 例报告投影逐项一致 + 3 例构造期拒绝），`yglverify run --spec --db --json` / `self-check` / `--version` 三命令可用（rc 只表达过程：FAIL 仍 rc=0）。**封包形态同日落地**：`seal --spec --out` 把 spec 内嵌进二进制（`[engine][spec][footer json][u32]`，YGLVF1），`run` 在封包上拒绝 `--spec`（改规范必须重打二进制）、报告 `verifier.mode="sealed"` 且记 `binary_sha256`，spec/build 双哈希篡改 fail-closed（`looks_sealed` 区分"开放构建"与"封包被改"），`self-check` 多打 `sealed-spec` 行；Rust 测试 25/25。**封包实测（真实试炼场）**：`cordis-scan` 重新扫描 → `yglverify-cordis.exe run --db scan.sqlite` → `overall PASS (pass=5)`、V1–V5 witness 与 TS 侧逐项一致（V1 150/0、V2 23/23、V3 3/0、V4 3/0、V5 13/13），报告 `verifier.mode="sealed"` 且 `binary_sha256` 记齐——交付形态「单二进制 + 内嵌规范」端到端跑通（release 产物 4.5MiB，含 bundled sqlite）。**登记链**（同日）：`verify register <sealed>` 解析 footer 复算双哈希，写 `registrations/<key>.json`（spec/engine/corpus/platform/size）与 `binaries/<key>.bin`；`verify report import` 命中登记后若 `specs/` 缺 spec，从封包恢复内嵌 spec —— 报告 + 二进制成为自描述包，`verify archive --with binary` 在干净工作区也能收齐并重算全链（实测：Rust 封包报告 import 进 TS 工作区 payload_sha256 重算一致，R7「登记无写入方」由此闭环）。

**r13 P1×4 与整份报告 parity（同日）**：评审 302cb119 的四条 P1 全部闭合——①count/exists 空范围装配期降 NEEDS-MATERIAL（`zero rows scanned — cannot assert PASS (vacuous prevention)`，与 TS 逐字同）；②报告形状补 `guard.leniency_checks`、`artifacts.attachment_sha256`、`exceptions`（FAIL/NM 的 `{vu,severity,row_count}`）、`reason` 折叠文案（`V1(S1) FAIL` / `need material` / `errored`）与 `evidence.rows`/`rendered`/`schema_drift`；③CLI 报告接 `data_source{kind:"sqlite-snapshot",sha256,source,captured_at}`（`--db` 字节哈希）；④`verify register` 写入方与 import 侧恢复内嵌 spec（见上）。同时采纳 fdc757f6 ⑤：`started/finished` 取真实时刻或 `--now`（缺省不再 1970），`run --now` 可钉重放。新增**双实现 parity 机械门** `packages/verify/core/tests/rust-parity.spec.ts`（Rust 无 release 产物时 skip）：33 例逐例跑 TS `runVerify` 与 Rust `run`，剥 `data_source`（环境锚）后 `canonicalStringify` **整份报告逐字节比**，并把 Rust 的 `data_source` 注入 TS 报告后各自重算 `payload_sha256` 断言三方相等 —— 不是投影比对，是整份报告。修出的差异：错误文案里浮点显示（Rust `120.0` vs TS `120`，`json_scalar` 改 TS 口径）、fact 型 ERROR 路径缺 witness（补零值兜底）。

剩余（显式挂账，非阻塞）：ed25519 签名（可选锚，真正信任锚是带外 `binary_sha256` 登记；签名字段进 parity 目标）。
③ `--draft` 干跑、④ walk ignore globs 进池；② command 型判据按裁定排 M13-1b parity 冻结之后（契约先行、runner 钩子不放开封包 allowlist）。

后续项（fdc757f6 ①，不阻断）：Cordis 试炼场加 V6 `count(白名单对无 package.json 依赖背书)==0`——白名单与 `package.json` 依赖目前是两个真相源。

**执行记录 · 0.96.0（M13-1 收口，2026-10-20）**：verify 命令面落地（submit/prepare/run/list/report/trace/export/report import）——`run` 只碰 sqlite 快照副本并在报告记 `data_source`，rc 只表达过程；prepare 只有 `ready` 才 rc=0。契约钉 `CONTRACT_VERSION="1.0"`（引擎入口版本守卫）+ 语料钉 `corpus_version="1.0"`（129 文件 digest `38860423…f0`，差异表进 `packages/verify/core/CHANGELOG.md`）；新增 `Predicate.scan` 扫描域（where 只进 find、scan 进 find+scope，witness=域内行数），修掉「干净表 find 零命中 → scope 零行 → PASS 被空洞守卫打成 NEEDS-MATERIAL」的假阳性。评审 r10 F1-F6、r11 R1-R9 全部闭环（302cb119 r11 PASS 并接受 scan 为 1.0 定稿；fdc757f6 钉版复核通过、0.96.0 无阻断）。配套：度量棘轮 `pnpm ratchet`（bundle/前端体积/冷启动只降不升，基线 `ratchet-baseline.json`）+ 契约形状守卫 `shape.spec.ts`（快照首行钉 contract_version，升版必须重铸）+ `docs/measurement-ratchet.md` 方法论。测试 347 / demo 128 / contract 100 / readme 53。下一步 M13-1b：Rust 二进制 `yglverify`，双实现 parity 以 freeze digest + shapes 快照为唯一真值。

## 明确推迟（不进本计划）

- ~~claim 仲裁工作流、query↔source 关联、markdown 批量导入、调度并发锁~~（0.5.0 已交付）
- ~~单测框架~~（0.17.0 已交付：vitest 37 用例）
- npm 实际发布（外部动作需用户确认 registry）、choice/score 题型接入

## 完成定义（DoD，每里程碑通用）

1. `pnpm build` 零报错；`pnpm test`（build + demo 含新断言）全绿
2. 新行为有 demo 断言或可复现验证记录（命令 + 输出贴进提交说明）
3. README / usage 与实际命令面一致
4. 版本号推进 + git 提交（一个里程碑一个合并点，任务可多提交）
