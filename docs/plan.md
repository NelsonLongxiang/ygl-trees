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

### M13 — spec-validator 验证规范驱动器（2026-10-19 立项 m11350，设计阶段）

> **执行记录已归档**：0.96–0.116 全部子批（七型检查器/封包签名/自校验/契约 1.0→1.2/验证器包规划）→ [plan-archive-2026-10-28.md](plan-archive-2026-10-28.md)。
> 现行工作见 GitHub issues（#80 谓词 1.3 提案 / #94 A 簇）与 docs/reviews/contract-1.3-proposal.md。


## 明确推迟（不进本计划）

- ~~claim 仲裁工作流、query↔source 关联、markdown 批量导入、调度并发锁~~（0.5.0 已交付）
- ~~单测框架~~（0.17.0 已交付：vitest 37 用例）
- npm 实际发布（外部动作需用户确认 registry）、choice/score 题型接入

## 完成定义（DoD，每里程碑通用）

1. `pnpm build` 零报错；`pnpm test`（build + demo 含新断言）全绿
2. 新行为有 demo 断言或可复现验证记录（命令 + 输出贴进提交说明）
3. README / usage 与实际命令面一致
4. 版本号推进 + git 提交（一个里程碑一个合并点，任务可多提交）
