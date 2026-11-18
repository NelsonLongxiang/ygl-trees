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
