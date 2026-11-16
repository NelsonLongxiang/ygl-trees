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


## 0.126.0 候选准备（未发布）

从 master `17c2ac2` 建 `release/0.126.0`，包含 #273（#178）、#277（#258）、#278（#275）、#279（#276）。版本/CHANGELOG/能力清单收口后冻结候选，依次执行完整门禁、pack:check 与 exact-head G7，并在 #90 留记录。只准备候选：不创建 tag、不 publish，发布须新的属主批准；Windows 包仅供验证/跨机比对，不替代经复核的官方 tarball。

## #276 scope v15（代码已合并，待发版复核）

#278 已合入 master；#276 采用 merge 保留主干历史。`kb_notes/skills.scope` 使用市场精确词表（空串未归属，非公开），不从项目默认；相同内容写入保留旧 scope，只有 id 选择的 rescope 改笔记授权并记 old/new 事件。note/skill 列表、检索、MCP 与 library 过滤先于排序/分页，空与未给参数不混同。旧 SQLite/PG 工作区只加默认空列、不回填；技能普通 upsert 不清除既有授权。JSON 加法字段 scope 与历史字节黄金的例外只覆盖 note add/show 的空 legacy 值，其他字节照常钉死。验收以 #279 exact head 的单测、契约、G7 与独立复评为准；未发版不关闭 #276。

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

## 报告导入路径准入（独立本地修复）

核对 #205 S2 校验接缝时，在任务自有合成 home 直接调用真实导入入口，确认 payload 篡改被拒，但同 run-id 的不同自洽报告会替换旧文件，且 `../...` run-id 能写出 reports 子目录；全部实验输出限制在任务根内。远端 master `734e20f` 精确读取的导入分支也保留相同路径拼接，旧本地对象不可用不作为产品缺陷。

`fix/verify-report-import-paths` 从保全的 `5e64739` 独立处理路径字段，不改 #282/#286 或 S2 schema。最初 28 项源码回归在旧实现 3 过／25 败（修正数组参数化后同样 3／25），最小准入修复后 28／28 通过；构建后新增发布 CLI 正反例及原 CLI 共 68／68 通过。补齐末尾换行、空值、类型和长度边界及同 run-id 旧替换兼容断言后，新组共 42／42 通过；移除产品准入、断言不变的负对照恰 36 败／6 过，恢复后源摘要一致。预期主单测 `2011+42=2053`，以完整主测试和 README 二次计数实测为准。修复覆盖 run-id、spec-id 与二进制摘要三处不可信路径输入，保留合法回执、payload 和签名检查、规范恢复、缺失／null run-id 旧回退；不擅自改变同 run-id 的替换兼容语义。正式提交仍需完整门禁、精确代码评审、打包和 OPS；未合并或远端交付。

## #288 基于实际主干独立交付（待新候选验证）

按先交付 #234、再推进 #288 的顺序，#234 已以精确 `235faca` 正常钩子推送并交付独立 PR #290，远端只读复验通过，尚未合并。为避免将未合并的配置下沉／图门带入报告导入修复，本轮从实际 master `d3b7b88` 新建 `fix/verify-report-import-delivery`，仅提取保全提交 `3a08297` 相对 `5e64739` 的七文件修复；旧分支不变基、不移动，未构造依赖 PR。

产品仍仅报告导入分支的 14 行路径字段准入，42 项测试保持原字节；合法 payload／封包恢复／签名、缺失或 null run-id 回退和同 run-id 替换语义均不扩改。所需夹具、引擎与 canonical 实现在当前 master 已存在且与原测试基线相同。两处文档冲突保留当前主干记录并加入本修复，不引入 #234 代码或门禁；预期主测试 `1975+42=2017`、契约 156，须由新输入完整门禁及 README fresh 计数核验。旧全链、代码与 OPS PASS 不迁移；本轮尚未提交、推送或开 PR，也不批准合并、发布或部署。

## 明确推迟（不进本计划）

- ~~claim 仲裁工作流、query↔source 关联、markdown 批量导入、调度并发锁~~（0.5.0 已交付）
- ~~单测框架~~（0.17.0 已交付：vitest 37 用例）
- npm 实际发布（外部动作需用户确认 registry）、choice/score 题型接入

## 完成定义（DoD，每里程碑通用）

1. `pnpm build` 零报错；`pnpm test`（build + demo 含新断言）全绿
2. 新行为有 demo 断言或可复现验证记录（命令 + 输出贴进提交说明）
3. README / usage 与实际命令面一致
4. 版本号推进 + git 提交（一个里程碑一个合并点，任务可多提交）
