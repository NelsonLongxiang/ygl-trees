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
> **#158–#171 的「在途」记录**（0.119.0 / 0.120.0 前后）见 [plan-archive-2026-11-09.md](plan-archive-2026-11-09.md)。
>
> **历史执行记录归档**：M1–M10（0.2.0–0.95 时代）见 [plan-archive-2026-10-20.md](plan-archive-2026-10-20.md)；0.41–0.45 与 0.96–0.113.x 及逐版发布记录见 [plan-archive-2026-10-26.md](plan-archive-2026-10-26.md)（2026-10-26 体量拆分，归档按拆分日期命名）。本文件只保留现行里程碑（M11+ 框架）与 0.114.x+ 现行纪元及总览/DoD。

### M13 — spec-validator 验证规范驱动器（2026-10-19 立项 m11350，设计阶段）

> **执行记录已归档**：0.96–0.116 全部子批（七型检查器/封包签名/自校验/契约 1.0→1.2/验证器包规划）→ [plan-archive-2026-10-28.md](plan-archive-2026-10-28.md)。
> 现行工作见 GitHub issues（#80 谓词 1.3 提案 / #94 A 簇）与 docs/reviews/contract-1.3-proposal.md。


## 0.129.0 发布候选

发布范围为 `v0.128.0` 到 `master` `6af8b2f880ebb278d96d0fedd5225045b35dec75`，包括 #322 的 `kb rm` 帮助、#325 的笔记取代及作废语义和 #326 的离线 stdio 测试支持。#321 已结单，#326 已经非作者最终复核并合入，落地树 `4a47c7b223a29328661b85971ea71b5a009a95c1` 与受验树一致。 [#321 结单回执](https://github.com/NelsonLongxiang/ygl-trees/issues/321#issuecomment-7226106916) · [#326 最终复核](https://github.com/NelsonLongxiang/ygl-trees/pull/326#issuecomment-7228709777)

发布候选按 [发布流程](release.md) 执行 G1、完整 `pnpm test`、封包校验、提交声明核对及 G7。G7 由获准的非作者席在同一候选上执行真 PostgreSQL、固定 SQLite 黄金和 strict 双后端。验收检查点为 2026-11-30 12:00 UTC，拟发为 18:00 UTC。候选经独立验收及属主批准合入后，才进入实际标签、npm 和 G8 回读。

## 0.128.0 发布候选（未 tag／publish）

按属主 2026-11-25 决策（评估票 1bc731c9 推荐 A）从主干 `a5e9c4fd15d4f17575c48b48881f70109952819d` 建 `chore/release-0.128.0`。只改根版本、[变更记录](../CHANGELOG.md)、正式 CLI 生成的[能力清单](../llms.txt)及本计划；不带新产品、测试、依赖或基线变化。范围 PR311–316，各有绑定精确头的非作者 PASS：311 `210a0ebd`、312 `69480922`、313 `faaec1ec`、314 `5d82ffa9`、315 `e6ea67ed`、316 `df599396`。#306 另开独立 PR，不混入本版；Windows #307／#202 不在本版修复，0.127.0 的一次重跑特许不继承。

门禁：完整 pnpm test、tmp-diff 新增 0、pack:check 在本机跑；G7 真 PG 矩阵需 docker（pinned postgres:16.4-alpine），本机没有容器运行时，记 NOT_RUN，须在具备 docker 的机器上对准确头补跑并贴记录，不以本机结果代替。发布由 .156 核 `origin/master` 等于合入提交后独立打包发布，不传 tgz；G8 发布后另行复跑。

## 0.127.0 发布候选 R4（未 tag／publish）

按监督原单 `direct-d572f99df362` 从已验收主干 `5587f6f62a105562cb71eb29e93f15dd5a383065` 建立 `release/0.127.0-r4`。只改根版本、[变更记录](../CHANGELOG.md)、正式 CLI 生成的[能力清单](../llms.txt)及本计划；不带新产品、测试、依赖或基线变化。前置 [PR308](https://github.com/NelsonLongxiang/ygl-trees/pull/308) 准确头 `47023b9` 经监督 macOS 全链 rc0（2316＋84＝2400）及恢复 split 预算使两项 response-settled 判红后合入。所有 phase 现为 20 秒，elapsed 保留、test/hook 仍 60 秒，原 ownership 用例和 fixture 不变；验收不外推为历史超时根因已查明。

#295 Items 1–3 已分别经 PR299／301／303 准确头验收合入 `fe1aa5c`／`2ae9851`／`0f55a77`，开发通过不等于发版复核；#295 仍待正式 npm 包和准确 tag 复查后由监督关闭。PR302 仅诊断；#202 根因另行研究。原候选及原始日志、快照、封包均保全，不将前一任务 PASS 拼成 R4 通过。

R1 `6fb6811` 的真实 G7 中，PG 82／0 加 3 离线及 SQLite 黄金通过，strict SQLite 腿因继承 PG URL 出现 8 个 handler 红与 demo 红；同头环境对照 8 红／8 绿，独立 PR304 在监督验收后合入 `d71ba79`。R2 原 full02 在 README 内嵌串行单测的 selector 初始化子进程 `project use alpha` 遇 30 秒 spawn ETIMEDOUT，原 full-rerun04 又遇 dashboard list-ready 三秒超时，两个 rc1 及原四文件快照保留。PR305 仅就绪阶段 20 秒及计时修订合入 `9c6ce53`，不是 watcher 根因修复。

R3 `767403e` 原真实 G7 的 research evidence-add rc1：81／82 真 PG 通过、0 skip，加 3 离线通过；泛化错误未取到底层原因。监督准许的新隔离 PG 单文件诊断 21／21 rc0 未复现，临时 compiled 插桩逐字恢复后，唯一完整 G7 重验 rc0（PG 82／0、黄金 1／0、strict SQLite／PG 通过）；原红不被后绿覆盖。之后正常 pre-push 在 response-settled 原三秒阶段实测 3036ms 超时 rc1，真 list-ready 在 G7 strict 曾以 4706ms 完成。原 R3 两封包逐字相同：2005151B／272 条目，SHA256 `cfe5a0ad4e935b3082132f3121ca25868afcc29002cd246fdbad656c702cc110`，仍保留为旧候选，不用作 R4 包身份。

独立 PR308 线路的 full03 原红来自未改的串行 watcher create 等待，#202 原快照显示 settled-start 后未记录 settled-end，但 catch 时已有新投影，根因仍未知。获准同输入重跑中断且无终态，保留 UNKNOWN 与 partial SHA；本人 PowerShell 探针产生的字面缓存目录经明确裁定 MOVE 隔离、未删除。替代独立进程全链 rc0 后提交 `47023b9`，首轮正常钩子因原锁测试 3100ms 未满足 <3000ms 而 rc1；[原红记录](https://github.com/NelsonLongxiang/ygl-trees/issues/307#issuecomment-7067368469)及后续唯一正常钩子重推 rc0 均留在 PR308，监督已按准确头复验。

R4 依次运行：完整 pnpm test → meta check／audit against-git → G4 → pack:check → 原真实 G7（pinned PG、固定 SQLite 黄金、strict 双后端）→ clean tree／dist → 两次 pack:repro 字节／SHA256／条目校验 → 正常钩子推送与候选 PR。每步记录 UTC、原 rc／signal／error及日志；真实 list-ready 与所有 phase 计时按主单测、内嵌串行、strict 矩阵来源逐项保留。嵌套串行不另算独立完整运行。仅 #202／#298／#307 已跟踪用例可在同一冻结输入、同一门禁原红保留并记 issue／PR 后重跑一次；同门禁第二红或其他红停止。#298／#307 关单与发布复核条件仍独立，本段不预填 R4 门禁 PASS。

G4 仅用裁定 `direct-0faa1934cf2d` 及本次续准的唯一 `--allow docs/reviews`：历史提交 `5e08738` 的否定未改说明触发路径 token 检查；原红与语境保留，不重写历史、不改门禁或扩其他路径例外。

Windows G8/#178 仅提案、当前 NOT_RUN：正式发布与独占窗口另准后，WORK 使用项目 `tmp/release-0.127.0/g8/<UTC-attempt>`；最小私有 npm-install 清单、隔离 YGL_HOME／session、后端 URL 清空、调用方 home 哨兵。tag 源码只用现有真实 Git 检出，准确核对远端 tag／批准提交／主干祖先；不 clone／worktree／stash，不把无历史导出冒充完整 tag 验证。切换前后核对 clean/index/保护引用，无他席在途才能执行；意外变化停报，不强制恢复。逐步保存完整双通道、UTC、rc／signal／error、源码／包／dist 身份。正式 [post-release-check](../scripts/post-release-check.mjs) 当前含 clone，兼容执行方式需另准，手工替代链不冒正式 G8 PASS。候选与合并不授 tag／publish，本轮在这些动作前停止。

## 0.126.0 已发布（发布后验证分立）

精确候选/tag `ee0e66b` 由监督席合入主干 `2a03f4b`。属主批准后，发布席在本机 remote/tag/ancestor guard rc0 后只发布原始 tgz 一次，`npm publish` rc0；公网 0.126.0 与 latest、shasum、integrity 均核对一致，详见 [#90 发布记录](https://github.com/NelsonLongxiang/ygl-trees/issues/90#issuecomment-6894396367)。未重打包或部署。Windows G8 在本席 NOT_RUN：正式入口包含与上级纪律冲突的独立 clone；发布成功不代替 G8。#178 保持开放，监督席 macOS G8 的测试时钟失败另由 #283/#284 修复。

## #276 scope v15（已随 0.126.0 发布）

scope v15 随 #279 合入并进入 0.126.0；监督席已在发布包/tag 复核后关闭 #258/#275/#276。本席不以本地候选测试替代其发布复核；旧 SQLite/PG 只加默认空列、不回填，读过滤先于排序/分页、JSON 字节例外及授权变更行为仍沿用各项冻结契约。

## Windows 诊断待办（#202 / #203 / #209）

从 `1c05e15` 另开测试修复线，不改已审 `release/0.126.0@ee0e66b`。#203 补子进程错误类别/耗时与脱敏命令形状；#209 用 `git archive` 源码快照隔离构建，保留字节比较与诱饵/minify 反例，并保全失败日志/trace；#202 仅补事件、读取和索引投影的失败快照，不改 watcher 产品逻辑，不延长 3 秒等待。首轮定向验证发现诊断 mock 自递归及 tar 盘符解析错误，原红保留；修正后 26/26 通过。提交与交付仍须完整门禁和非作者复核；不以隔离绿灯关闭原间歇故障。

监督席裁定 [#282 合入路径](https://github.com/NelsonLongxiang/ygl-trees/pull/282#issuecomment-6896891194)：开发席将已接受主干 `0186fb9` merge 入诊断分支，变更记录按并集合并且保留已发布 `0.126.0` 节字节，重新完整门禁后正常 push；监督席按新精确头和 macOS 全链复核后决定合并，旧 PASS 不外推。本次迁入已在 `da45a28` 全链验证的必要项目内临时根／仓库边界／无 clone 夹具，不带 #234 配置下沉、声明或源码图门，也不带额外日历回归。新增五项临时根反例、六项隔离定位测试并迁出一条物理仓库外断言，预期主单测 `1959+5+6-1=1969`，仍以实测和 README 二次计数为准。正式 G1/G8、产品 meta 准入与原失败断言不变；本地整合不冒称独立 master 复验。

新基线首轮完整运行 rc1：1844 过/124 跳/1 败，共 1969；唯一失败为八进程同内容 query-add 中一个进程返回 `SqliteError: database is locked`，已建 [#286](https://github.com/NelsonLongxiang/ygl-trees/issues/286)，原红保留。三波各八进程的定额取证捕获两次事务 INSERT 的 SQLITE_BUSY，现有重试恢复；这不证明原失败根因。测试补齐所有子进程 stderr/status/signal/耗时及失败留证，仍保持八进程、300 秒及原 all-rc0/单行断言；B4/诊断定向 9/9 过，产品锁和重试策略未改。后续完整门禁不得据碰巧通过关闭 #286。

## #286 SQLite 写锁候选（独立分支，未交付）

#282 的冻结本地头 `25bbff5` 完整门禁 rc0，但正常 push 的 README 二次单测中，十二进程 KB 写入出现 `database is locked`；只停止本席 push 子树，远端分支仍 `598dd0f`，未跳钩子或重推碰绿，原红保留。另开 `fix/sqlite-writer-reservation-286`，不移动 #282 分支。

确定性双连接交错证明一种失败机制：事务去重读取后，另一连接提交会导致 `SQLITE_BUSY_SNAPSHOT`，原五次尝试可被连续耗尽；原未取完整栈的失败进程是否同一原因仍不冒认。候选仅在 SQLite 事务内、回调前执行零行 `UPDATE meta SET value=value WHERE 0` 预留写槽，原等待／重试预算、事务原子性和 PG 路径不变。新增六例中旧代码三绿三红，修正去重拦截范围后与提交后事件测试共 10/10；相同断言移除预留语句再次三红，源码逐字恢复。构建后的原八进程去重、十二进程 KB 双写、事件及新回归共 16/16 通过，无跳过。

预期完整计数 `1969+6=1975`，以本轮全链及 README 二次实测为准。非作者 WIP 评审 `direct-90bee82d` 与监督席交付顺序请求 `direct-9a4407d6` 尚未终态；不把定向绿灯当作完整验收，不将产品修复擅自混入诊断 PR，不关闭 #286、不冒称独立 master／G8 通过。 首轮全链主单测 1849 过/124 跳/2 败，共 1975，唯一失败文件为 quote-mismatch-error 的两个旧 manager mock 缺少 query 方法；没有改变产品错误语义。mock 现严格断言唯一预留 SQL 与调用次数，原 QuoteMismatchError、非 PgCapabilityError、source id 与批次物理行号断言均保留；修正后定向 12/12 通过，原红留存。第二轮完整验证以新冻结输入为准。

## #282 属主授权的阻断修复整合（待新头验收）

属主于 2026-11-16 明确同意：将独立提交 `b016da7` 作为 #286 阻断修复纳入 #282，保留其提交身份；merge 最新 master 后重新验证并正常钩子推送，PR 合并仍须监督席复核批准。本轮诊断分支先快进到 `b016da7`，再 merge 已核实最新主干 `734e20f`，仅变更记录发生冲突，按未发布段并集解决，已发布 `0.126.0` 起的历史字节与两个父提交一致。

相对 `734e20f`，产品写路径仅新增已独立复核的五行 SQLite 写槽预留；#234 配置下沉／依赖图门及 #288 报告路径修复均不纳入此 PR。保留原推送失败、确定性机制反例及原预算／并发强度，不把旧分支 PASS 转移成新整合头 PASS。预期主单测 1975、契约 156，须经本轮完整门禁和 README 二次计数核验；后续精确提交复核、打包、OPS 与实际正常钩子推送分别留证。此次不授权 PR 合并、tag、发布、部署、调度或 clone。

## #234 workspace 配置环（本地集成验证）

`e4cb30a`（R3 无 clone 夹具）与 `eb53ef9`（#234 配置下沉和声明图门）已在本地冻结，完整 1976 例链、干净提交 pack、精确 SHA 代码复核和运维本地准备验收通过；原红保留，#234 尚未推送/关闭。新本地分支 `fix/workspace-234-clock-integration` 整合已合入主干 `0186fb9`（含 #284 时钟修复），原分支和发布 tag 均保留；只发生变更记录标题冲突，按并集解决，未执行远端主干合并。

本轮补 #283 子进程时钟 0/60 天平移，恢复旧种子的负对照两例均红，恢复后生命周期 28/28 通过；声明图/源码图定向 49/49、临时根正反例 5/5 通过。项目内 tmp 暴露旧夹具向上命中主仓的问题，首轮全链因此停止并保留原红；测试侧改用核验过的中性 cwd 与真实合成仓库边界，未改产品 meta 准入、未加 --no-meta。22 组受影响测试 195 过/1 条既有条件跳过，外部链接配置等 7 项快照反例全过；Windows tar 使用原生 symlink 语义，不把外部链接伪装成普通文件。移出一条依赖物理仓库外目录的 CLI 拓扑断言并补六项隔离拓扑单测，预期完整计数 1976+2+10+5-1+6=1998，须由主测试和 README 二次计数核验。源码严格扫描仍如实报告 ORM→研究域实体循环，例外待裁定；不改产品实体装配或启动顺序。完整链、冻结提交、pack 与非作者复验尚待收口，不冒称 master 复验或 Windows G8 通过。

## #234 源码图评审修正（本地，未远端交付）

`da45a28` 的工程链和 pack 通过，但非作者代码复核发现 R1/P2：扫描器遗漏 `ImportTypeNode` 与 import-equals 外部模块引用。旧扫描器已以单向／双向四场景复现漏边，原红保留。修正原型已取得独立静态可采纳结论，并按监督席 [精确 ORM 例外裁定](https://github.com/NelsonLongxiang/ygl-trees/issues/234#issuecomment-6896891438) 加入唯一源文件／目标文件／导入符号约束；解耦后续 #285 已建。修正后真实源码为 10 包／100 文件／209 引用，明确报告一条装配例外；声明图仍 21 包／41 边无环。

本地 `fix/workspace-234-source-r1` 从保全的 `da45a28` 处理窄差异，不含 #286 产品写锁改动。新增两类 AST 正反例四项、精确例外正例与七突变八项、实际源码图一项，共增 13 例，预期主单测 `1998+13=2011`；源码门接入后契约预期 158 项，均以实跑为准。旧 full/pack/代码评审不自动迁移到新头；须刷新登记、正式回归与新 SHA 复核。#282 仍须先按正常钩子交付并落地主干，再基于届时 master 合入 #234、独立开 PR；本地工作不改变该顺序。

## #234 整合实际落地主干（交付分支，待新头验证）

属主明确批准本次 #282 精确头 `feb7cab` 以指定本地验收席的 Windows 全链 PASS 为落地依据，macOS 仍记 NOT_RUN、不作该 PR 的合并前置；#282 已用普通 merge commit 合入 `d3b7b88`，未压缩、变基或绕过保护，#283 仍开放。此单次验收调整不自动覆盖后继 PR，未发布或部署。

保全已验收的 `fix/workspace-234-source-r1@5e64739`，从该头建立 `fix/workspace-234-delivery`，merge 实际落地主干 `d3b7b88`。配置下沉、声明图与精确 ORM 例外沿用原修复，主干 SQLite 写锁、失败取证、Web 代理及中性措辞一并保留；不混入 #288。三处文档冲突按双方记录并集合并，已发布变更记录保持原字节。预期完整主单测 `2011+6=2017`、契约 158，须由新候选完整门禁及 README fresh 计数核验；原 #234 与 #282 的 PASS 不自动迁移，尚未开新 PR 或批准其合并。

## #285 显式实体装配与实例生命周期（本地实施，未交付）

属主在 r2 非作者架构复核闭合 R1／R2 后明确“按建议执行”，批准显式 ORM／awaitable cleanup 与受管插件局部结果协议的有界迁移和验证，不含合并、发布或部署。开发基线为已交付 #290 的精确头 `235faca`，仅为复用源码图门而建独立本地分支；#290／#291 的分支与证据保全，#288 不混入，原依赖未落地前不创建 stacked PR。

应用显式装配 core 五个／research 七个实体，先完整校验再 initialize；缺成员、冲突、关系漂移、loader barrier 并发／关闭、初始化和清理双错均有确定性回归。调用 owner 排空 HTTP／SSE／定时器与插件实际 disposer 后才关闭本实例资源；清理失败不假报成功或提前放锁。CLI 正常载荷和业务错误码、schema v15、原幂等／重试预算不变；旧无实例 ORM 调用和受管插件接口的迁移代价已明确授权。

首轮迁移回归 36 文件／283 用例全通过、零跳过；后续非作者代码复核给出的 R1–R8、嵌套生命周期及 generation/setup/restore 反例原红保全并修正，v04 准确 94 输入获 WIP_ACCEPTABLE_STATIC、无新增必修，不替代精确提交与运行验收。v04 完整构建与正常两 worker 全量单测已自然 rc0：244 文件／2149 用例，2023 通过、126 条件跳过、0 失败；README 计数据此更新，真实 PG 仍单独零跳过验收。107 项定向矩阵、严格类型及图门通过，bundle 856077 字节不超过原上限，基线、容差与 keepNames 不改。当前进入正常 pnpm test 完整链和当前版本的隔离 PG／clean-pack／bench 验证，尚无完整工程／精确 code／独立 OPS 结论，不据本段关单或申请合并。#290 实际落地主干后还须整合并对新头复验，旧结果不外推。

## 报告导入路径准入（独立本地修复）

核对 #205 S2 校验接缝时，在任务自有合成 home 直接调用真实导入入口，确认 payload 篡改被拒，但同 run-id 的不同自洽报告会替换旧文件，且 `../...` run-id 能写出 reports 子目录；全部实验输出限制在任务根内。远端 master `734e20f` 精确读取的导入分支也保留相同路径拼接，旧本地对象不可用不作为产品缺陷。

`fix/verify-report-import-paths` 从保全的 `5e64739` 独立处理路径字段，不改 #282/#286 或 S2 schema。最初 28 项源码回归在旧实现 3 过／25 败（修正数组参数化后同样 3／25），最小准入修复后 28／28 通过；构建后新增发布 CLI 正反例及原 CLI 共 68／68 通过。补齐末尾换行、空值、类型和长度边界及同 run-id 旧替换兼容断言后，新组共 42／42 通过；移除产品准入、断言不变的负对照恰 36 败／6 过，恢复后源摘要一致。预期主单测 `2011+42=2053`，以完整主测试和 README 二次计数实测为准。修复覆盖 run-id、spec-id 与二进制摘要三处不可信路径输入，保留合法回执、payload 和签名检查、规范恢复、缺失／null run-id 旧回退；不擅自改变同 run-id 的替换兼容语义。正式提交仍需完整门禁、精确代码评审、打包和 OPS；未合并或远端交付。

## #288 基于实际主干独立交付（待新候选验证）

按先交付 #234、再推进 #288 的顺序，#234 已以精确 `235faca` 正常钩子推送并交付独立 PR #290，远端只读复验通过，尚未合并。为避免将未合并的配置下沉／图门带入报告导入修复，本轮从实际 master `d3b7b88` 新建 `fix/verify-report-import-delivery`，仅提取保全提交 `3a08297` 相对 `5e64739` 的七文件修复；旧分支不变基、不移动，未构造依赖 PR。

产品仍仅报告导入分支的 14 行路径字段准入，42 项测试保持原字节；合法 payload／封包恢复／签名、缺失或 null run-id 回退和同 run-id 替换语义均不扩改。所需夹具、引擎与 canonical 实现在当前 master 已存在且与原测试基线相同。两处文档冲突保留当前主干记录并加入本修复，不引入 #234 代码或门禁；预期主测试 `1975+42=2017`、契约 156，须由新输入完整门禁及 README fresh 计数核验。旧全链、代码与 OPS PASS 不迁移；本轮尚未提交、推送或开 PR，也不批准合并、发布或部署。

## #285 实际主干交付整合（新候选待验证）

原本地候选 `1e8b693` 已完成完整工程、真实 PG/G7、clean-pack、benchmark、非作者精确绑定与指定验收席六判据独立 PASS，原分支和红／中断原证保全。#291 随后以 `457f5ea`、#290 以 `2ffda8a` 普通合入 master；监督席对 #290 的新头 `1e90b73` 完成 macOS 全链 rc0。按属主“继续”，本轮另建 `fix/orm-bootstrap-285-delivery`，从原验收头普通 merge 真实主干 `2ffda8a`；原验收结论不迁为本新头 PASS。新增报告导入路径准入须接入既有局部 JSON 结果端口，保持 #291 的拒绝／替换语义与旧手工 Env 输出，补清理屏障与主副错误回归；README 总数仅按本新候选完整执行更新。本整合首版完整单测自然 rc0：246 文件／2201 用例，2075 通过、126 条件跳过、0 失败；其后非作者评审 D1 指出活动租约抽取改变停工 use／cleanup 的严格回调接收者，原 REQUEST_CHANGES 与 16 通过／2 失败反例保全。仅恢复两条旧 ALS 直接调用的 this=null／零参数，并保持接纳期 this=undefined／一个 detach；D1 后继获 WIP_DELTA_ACCEPTABLE_STATIC、无新增必修。修复版完整单测再次自然 rc0：246 文件／2205 用例，2079 通过、126 条件跳过、0 失败，README 据此更新；被 D1 替代的在途 full01 已停止，不算正常全链 PASS。导入拒绝分支的 6 个真实清理屏障反例先红后绿，原 42 项导入测试语义保持；最终 D1 与原生命周期矩阵 78/78、零跳过。构建通过，bundle 为 856072 字节，不超过原 856077 上限，基线／keepNames 不改。当前尚无本整合头的正常完整链／精确新提交／独立验收结论；不合并、发布、部署或关闭 #234／#285，关单保留发布后复核门。

## #293 监督后继：清理守卫与 HTTP 响应排空（新候选）

监督席对 #293 精确头 `10879da` 完成 macOS 全链（首轮原 watcher #202 rewrite 失败保全，未变字节再跑自然 rc0）及变异探针后，以普通合并落主干 `390dfa8`。两项清理未知不重试守卫、残留 JSON 端口、Node 18 连接收尾另 PR 跟进；runner 私有桥作为已知版本维护成本保留，未擅改实现或声称新跑 unknown-shape 反例。#234／#285 仍开放至发布后复核；#202 的同尺寸改写旧 revision stamp 是独立待定位问题，不在此宣称修复。

从实际主干 `390dfa8` 建 `fix/orm-cleanup-followups-293`，原七保护分支保全。两处 no-retry 新测试分别杀死去掉 ORM／CLI 守卫的变异（1／2 条目标红），恢复源字节后通过；预测空数组、list／audit 和 meta 拒绝 JSON 改走既有局部端口，保 payload／space／rc 与手工 Env fallback。10 形清理屏障先红后绿，夹具误带 audit-only flag 的原失败单列保留，不计假覆盖。

首版单次 closeIdleConnections 经非作者 F1／P1 判定不完整，原 REQUEST_CHANGES 和归档保全；三种 Node 18 语义的真实 TCP／HTTP 模拟回归暴露 API 缺失、误关完整请求但未完响应、活跃后转 idle 三边界共 4 条目标红。后继按每条连接未完成 ServerResponse 数跟踪，原生 response.close 后减计数，停止后仅零计数连接 destroySoon 排空写缓冲再销毁，不改 engines、keepAliveTimeout 或原 5 秒停机预算；流水线、晚到 body、handler 先结束但 response 未 end、半关闭和中途断连末次 DB 使用均有回归。只 end 的半开连接两红、流水线夹具超时／帧断言探索记录均保原，不冒产品根因结论。

最终定向 58/58、零跳过；相同实现的两独立测试进程各 dashboard 14/14，证明夹具隔离，不当两个独立验收。保原 cap 所需的本文件六处相同 HTTP 200 JSON 回应去重，状态码／content-type／序列化及既有提前 writeHead 时序不变。完整构建通过，bundle 855973 字节 ≤ 原 856077，baseline／keepNames／依赖／vendor／schema／事务不改。非作者 `direct-9770c93a` 对准确 candidate-02 给 F1 CLOSED_STATIC／WIP_ACCEPTABLE_STATIC、0 必修；原 73 行裁定前缀保留。完整两 worker unit 自然 rc0：248 文件／2232 用例＝2106 通过＋126 条件跳过，README 据实更新。原生 Node 18 实跑 NOT_RUN，仅版本语义模拟与源码核对；当前进入正常完整链，尚无本后继精确提交／独立运行验收／PR，不合并发布或关闭既有 issue。retention 原单为另线未实施，不混此候选。

## #295 T6 Item 1：经验库项目筛选（独立候选，待完整验收）

属主 observer rollout T6 经监督席 #295 明确派发，1→2→3 各独立 PR，均 Refs #295；监督非作者 PASS 后由监督席以 match-head-commit 正常合并，开发不代合并。#294 已合入实际主干 `62559ef`，其 macOS 全链与六个变异结果仅作原头历史，不迁作本候选通过。本轮从该主干建 `feat/library-project-295`，与两共享席协调后独占运行窗口，八个旧候选保护 ref 不移动。

Item 1 仅使用 claim 的 project_id→项目名作为项目归属；note、promoted skill、check 无权威项目字段，带 project 时在列表/索引读取前具名拒绝 rc2，不从 scope 或关系推断。缺值/空值由 CLI 在开库前拒绝，API 与 MCP 共用纯项目值校验；MCP 项目值用内联旗标传递，保留看似选项的项目名，不静默丢参。原 ygl-library/1 信封、参数化 claim 筛选、计数、since 与稳定游标格式保留，未知项目为空页 rc0，游标不跨项目。

干净 API/CLI 红基线 6 通过/17 失败/零跳过，MCP 原路由 1 通过/11 失败/零跳过；修复后新增和原 library 回归 53/53，零跳过，含真实发布 CLI 与 MCP child。最初夹具缺 content_hash 唯一值导致 suite error/跳过、it.each 数组展开均保原记录，不算产品反例。技能审计此前跳过 library 命令的独立反例先红（checked0）后绿（实际执行两例）；已将 library 纳入既有审计入口，demo 与该入口均在提交前显式重登记。新增 demo 项目页/未知空页/三 kind 拒绝通过，完整技能审计实测 364 命令零拒绝。

原体积上限保持 856077：收敛 library 命令形状/纯项目校验、知识投影及共用分页等重复代码，保持已计算字段顺序与 promoted-only 条件、scope 空值/拒绝、cursor 长度拒绝和手工 Env 输出。完整构建与原回归通过，当前 bundle856076，baseline/keepNames/依赖/vendor/引擎/schema v15/事务写路径未改；体积探索原件不丢。下一步对本准确输入跑正常完整单测，以实测更新 README，正常全链及准确提交由监督非作者与指定验收另门确认；当前尚未提交、推送或开本项 PR。Item 2 scope v16、Item 3 sync 与 macOS 副本115条演练、retention 和 #202 均不在本候选，不作生产数据操作、发布部署或关单。

首次完整两 worker unit 自然 rc1：252 文件／2271 条＝2144 通过＋1 失败＋126 条件跳过；唯一失败为未改动 dashboard-owner 末例的 SSE fixture list-ready 三秒阶段超时，原报告及冻结输入保全。一次透明计时诊断保持原 worker／门限，dashboard 与原同期 dist-manifest 共 19/19 通过，prepareListIndex 40–56ms、watcher 排空不足 1ms；诊断未复现整轮负载，根因仍未知，原测试及全 1149 源文件按字节恢复。依监督裁定 `direct-58aeb0f4f567`，该失败单独建 [#298](https://github.com/NelsonLongxiang/ygl-trees/issues/298)，不阻塞 Item 1 交 PR，不加入 timeout／retry／fallback，也不混 watcher 产品修复。本轮 README 只据实同步总数 2271 和 demo 实测 138，并明确本地完整 unit 非全绿；后继直接窄提交、正常带钩子推送并开 Refs #295 的 Item 1 PR，最终完整测试判定以监督席 macOS 对 PR 精确头的运行结果为准。当前本段只记录交付准入例外，不声称本地完整工程通过、精确提交已被非作者审过或 PR 已落地。

## #295 T6 Item 2：断言授权键（v16，在途候选）

前项 PR299 精确头 `8db72e2` 已由监督席 macOS 完整 pnpm test rc0（2191 通过、80 条件跳过，共2271；contract158、README62、tooling52/0、六变异全杀）独立 PASS，实际合入 `fe1aa5c`；只作前序准入，不迁作本项通过。Item2 自该主干建 `feat/claim-scope-v16-295`，两共享席原单 `direct-fe18178a`／`direct-3341addb` 交回窗口。保护八旧分支及 Item1 头，不混前项红的修复。README 旧 Item1 注记按监督原单删除，但原两红报告与独立 issue298 保留。

九触点：SQLite SCHEMA_SQL 与有数据 v15/版本零回放走 v16 非空空串列；实体同改且 synchronize=false；claims 不新增 FTS。事务服务在显式 scope 校验后判重，同项目/文本同 scope duplicate，异 scope rc1 点名 rescope，force 不能跨 scope；同 scope force 仍保留重复，普通重跑也识别最初加盐的行。claimRescope 与 kbRescope 共用授权键变更事务，实际变化才更新 scope/updated 并记 old_scope/new_scope；PG 按项目/文本取事务锁，批量键稳定排序，状态/证据不改。show/list、Store 与 library 投影携带含空串的 scope，library 项目与 scope 筛选先于分页且游标绑定。导出数据表/镜像表/统计表集合不增，原通用导出及 copyTable 保列；MIGRATE_DDL、PG_UPGRADES v16 和已有 claim 镜像的加列路径均接通，doctor/版本准入仍取 SCHEMA_VERSION。

验证先红后绿：迁移/写入27目标红零跳过；命令入口1过10红、MCP1过14红，首次force身份及显式置信度惰性读取的回归均有独立反例。首次真PG镜像夹具漏迁移账表的错误不计产品反例；修夹具后取得真实旧镜像缺scope列红并修复。最终定向136/136（修配置惰性读取前），后继受影响62/62；完整PG85/85＝82真库＋3离线原语，零跳过，含有数据v15升级、旧镜像刷新、CLI与屏障控制同文本异scope并发。固定npm0.117.1黄金1过零跳过：只逐项允许空scope与既有quote_verified/attach约定，其余字节比较；黄金捕获的旧file冲突诊断变化已恢复，原红保留。

正常两worker完整unit首轮自然rc1，259文件／2337条＝2202通过＋5失败＋130条件跳过，无suite加载错；失败是两旧v15断言、PG目录9份断言及规格超92字节引发的两门禁。只改对应版本/目录断言和精简新R2.6规格，不抬预算或门限；受影响44/44通过。README总数2337据该真实收集结果、demo142据原运行实测，技能审计366条零拒绝，不用加法猜数量。当前所有产品测试与原红保全，待本准确输入正常完整工程链。

体积原上限856077未改，baseline SHA256仍1b98df930a7f43d7e0faea1ec1972732744286e5d19523f5afd5981810c0ddd7；本次通过复用迁移加列、文件校验、claim输入/投影、rescope与同形错误出口消除重复，不改minify/keepNames/vendor/deps或事务重试预算。PG测试容器曾因Docker模板引号适配失败而清理未确认，先实核原ID/标签再复用，最后已按ID移除容器和匿名卷并确认不存在；不留闲置服务。

RSI：本轮复用既有九触点与正式验证入口，未造登记平台；PR正文自动关单会忽略否定语义，故后继提交与PR只写 Refs #295，发布前检查真实文本，避免重演PR299合入时的误关单（监督已重开）。当前未提交/推送本项PR，无作者合并或发布授权；Item1的一次传输例外不用于本项。远端主干后继PR300仅两历史文档修正，本项不动那两文件。Item3项目sync待v16合入后独立开工，115条macOS副本演练由监督执行，不操作生产数据/全局安装/retention/DSH。

## #202 后继：轮询不能挤掉 watcher I/O 诊断（PR302 已合并，根因未修）

按监督队列 `direct-058556cdc0c1` 的 B 项及 [取证缺口说明](https://github.com/NelsonLongxiang/ygl-trees/issues/202#issuecomment-7036632889)，在 Item2 PR301 交付后的空档，初始从 `2c75ddb` 建独立 `test/watcher-io-trace-202`；后依监督新单 `direct-034b751c0d4d` 将旧基线验证停止并保原，从已合入 v16 的实际主干 `2ae9851` 重新验证。两共享席已交回本阶段窗口，Item2 精确头与旧 refs 保留。原测试 256 条环形记录会被 settled/projection 轮询挤掉关键事件；原快照用例加入确定性注入，先观察目标失败，再分离 `io_trace/io_dropped`，普通 trace/dropped 保持。两缓冲各限256条；3000条轮询不挤掉创建/改写的 filename/read/stat、错误及时间戳，I/O 自身溢出如实计数，已取快照不随后续记录改变，序列化仍含原序信息。

原快照的源 PASS／索引 FAIL、revision、脏标记和“不修复索引”断言保留；实际生命周期失败继续在清理前落盘同一快照。PR302 精确头 `6baa42f` 已经监督席 macOS 正常完整链 rc0、三变异杀死及非作者 PASS，合入实际主干 `134c56d`。仅测试诊断，不改产品或超时，#202 仍开放等待真实失败证据；不迁作根因修复。本地正常完整链与带钩子 push 亦 rc0。原队列 A/#178 的 G8 已被监督撤销为 CANCELLED/NOT_RUN，合入 #295 后留待属主批准的发布复核，不改 G8 脚本。

## #295 T6 Item 3：显式项目副本（在途）

从实际主干 `134c56d` 开始，Item1/2 已分别通过监督验收合并；本项独立 Refs #295，不合并、发布或关闭 issue。保留十一条既有 ref，并与两共享席协调独占运行窗口。

CLI project sync 要求明确 home/to、已初始化同 schema 的静止 SQLite 副本，禁 PG 环境回退。先脱离磁盘的只读 image 规划；来源→证据→断言→stance→superseded-by→当前仲裁逐事务重放，保源 ID/scope，目标身份或内容冲突预写拒绝，不推断授权、不修改选择。dry-run/verify/全 duplicate 不启动写 ORM、不改目录或锁；核验读取完整项目图的计数/哈希，不按计划行数推算。正常异常保全已提交前缀；真实子进程 exit 后未checkpoint WAL 用显式 resume，在同源快照/项目且 holder 确认死亡时独占恢复。清理未知保留锁、拒绝盲重跑。

负控已定位并修复：额外目标行漏核验、schema列与unique/FK漂移、多对一误PASS、首写前变动、事务间外部写入、SQLite仲裁同时间戳rowid顺序、仲裁状态矛盾、真实崩溃WAL恢复、原生close未知和恢复锁所有权。原红和可选ID映射收敛记录保留；最小additive-copy不提供自动merge/remap。claim查询先异scope拒绝，再hash快路/项目文本索引回退，forced-first幂等保留。source/evidence同形写事务去重后固定npm0.117.1黄金1/1、隔离PG85/85（82真库＋3离线）零skip；本次容器与匿名卷均移除并确认不存在。相关七spec99/99，后继恢复guard34/34；这些不是最终完整工程PASS。

体积探索原证据保留，未改minify/keepNames/deps/vendor。监督原单 `direct-9b171543236b` 允许最终源码相对实际master134c56d增量≤15000 B后一次归因重签，独立提交；仅bundle与归因note，不改web/cold原值或任何容差。同Windows/Node24.12.0实测master855847 B、最终候选868631 B（+12784），一次归因重签已按原单执行，web/cold原值与所有容差保持；原超门证据保留。构建33与最终受影响64/64零跳过、原两worker完整unit31＝261文件/2373条（2243通过＋130条件skip）自然rc0，之后新增2条PG-home绑定反例先红后绿；README2375待正常完整链实测核对，demo145和skills371已实测rc0。现在跑正常pnpm test，不以定向通过替代本准确源码完整验收。115条真实rulings的macOS演练仅由监督在明确副本执行，本席未触生产、npm/tag、retention或DSH。


最终静态补审 direct-2fc93e98 两P1保原：F1恢复校验到rename之间普通DB可能取走死锁；F2 table_info漏generated列。P1-red39五条准确红后，普通DB与sync共享原子准入闸（非非原子复读），table_xinfo完整比较生成/隐藏列。新回归48/48，后继独立child接管补例49/49零skip；初版闸持有过长造成真实exit37恢复红已修为普通sync发布锁后释放准入，恢复仍独占；Windows不安全整数ino误同文件拒绝改bigint。full36因版本失效主动中断并保原，不计PASS。遵后继裁定 direct-aa0092fbf7b6不再re-sign，原已签868631保持；修复后bundle869369，比实测master855847增13522，≤硬上界870847。修后正常完整pnpm test（full44）自然rc0：261文件/2381条＝2251通过＋130条件skip，独立串行计数复验2381；perf10/10、demo145、contract158、README62/62、skills371零拒绝，ratchet869369/web1401666/cold84全部held。原补审席direct-60838748在绑定三文件SHA上给STATIC_F1_F2_CLOSED、0新增必修，动态NOT_RUN，不迁作监督准确提交终审。下一步独立功能与归因窄提交、正常带钩子GitHub push/Refs #295 PR；监督仍须精确头与副本115条独立复验，本席不代合并发布。

## #303 监督验收后继：准入门死亡回收与完整项目关系（在途）

监督对准确头 `4e65f78` 的 [review5998219078](https://github.com/NelsonLongxiang/ygl-trees/pull/303#pullrequestreview-5998219078) 已独立 macOS 完整 pnpm test rc0（2297通过＋84条件skip＝2381，体积869369）并完成115条副本复制，但 REQUEST_CHANGES 两阻塞：准入门崩溃遗留后无pid回收/诊断出口；真实替代链为8条supersedes原向原词关系，旧仅复制superseded-by使verify误报完整。旧通过与副本结果不迁作新版本验收，#295判据7按监督更新。

B1门记录owner/pid/task，仅ESRCH确认死亡；原子rename至owner寻址、保留非空的代际墓碑，防迟到回收者抢移新门。普通open自动回收，db unlock/doctor --fix识别清死门，活/未知即使force仍拒绝；doctor lockfree以报告而非自锁。B2按原ID/原词/原向复制本项目claims之间全部关系，旧supersession步与计数键覆盖这些内边；外端关系以skipped列表（id/rel/src/dst/reason）及skipped_count显式列出，proof包含所有内边，superseded-by原校验保留。

反例：red01 B1目标红，B2夹具SQL arity错单列保留；修夹具后B2-red02准确缺内关系红。并发回收由独立子进程在观察死门后、rename前屏障交错，随机隔离路径变异被准确杀死；原构建文件逐字恢复。子进程tsx缓存导致断言58绿但全rc1的记录保留，改用正式dist入口后rc0。最终五spec62/62零skip，含真实exit37残门、live/unknown诊断、原F1/F2/ordinary-lock等。代码格式换行经emitJS相等核验。尚待新正常完整链与限定静态补审，不冒全链PASS。

build03体积871299超过870847后已依原单停报；后继裁定 direct-db6b5eeb0333仅准触及sync投影/门元数据/诊断出口内去重，原签868631不再动。当前bundle870827，比master855847增14980，硬界内余20；不改baseline/容差/minify/keepNames/deps/vendor、无无关verify/PGDDL改造、无检查或测试删除。README2394为先前完整2381及本次13个新增病例并集，待新完整运行据实确认。

限定补审 direct-da0dafcd 将B1核心与B2关系静态关闭，但新增无锁doctor的人类fix应用锁清理有C1活锁换主竞态；原报告不回写。独立子进程在第二次pid读取后屏障、普通DB活接后旧doctor误删准确红（C1-red17），修为候选死pid→取得shared admission→重读当前同pid且仍死才删，finally放门。五spec63/63自然rc0零skip，direct-5ff033da在精确三文件SHA上给STATIC_C1_CLOSED、0新增必修，动态NOT_RUN。full15因版本失效主动中断，不算PASS。

C1修复后870887超过旧监督上界40 B，已停报；新裁定 direct-1c643c29869c 将监督上界扩为870947（master855847+15100），明确保持现870887、不再精简/重签、不删检查测试；原签868631和全部容差不变。新正常pnpm test（full16）自然rc0：262文件/2395条＝2265通过＋130条件skip，perf10/10、demo145、contract158、README62/62（独立串行2395）、skills371零拒绝、ratchet870887/web1401666/cold83全部held。README预估2394少C1一例，已仅据此次完整实测修为2395，初输入与修正字节单列保留；源和测试未变。后续同PR303追加窄提交、正常带钩子GitHub push，交监督新准确SHA独立复验与115条副本关系验收，不作者合并/发布/生产操作。

## 明确推迟（不进本计划）

- ~~claim 仲裁工作流、query↔source 关联、markdown 批量导入、调度并发锁~~（0.5.0 已交付）
- ~~单测框架~~（0.17.0 已交付：vitest 37 用例）
- npm 实际发布（外部动作需用户确认 registry）、choice/score 题型接入

## 完成定义（DoD，每里程碑通用）

1. `pnpm build` 零报错；`pnpm test`（build + demo 含新断言）全绿
2. 新行为有 demo 断言或可复现验证记录（命令 + 输出贴进提交说明）
3. README / usage 与实际命令面一致
4. 版本号推进 + git 提交（一个里程碑一个合并点，任务可多提交）
