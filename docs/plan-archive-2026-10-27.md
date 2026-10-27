# plan 执行记录归档 · 2026-10-27

> 从 [plan.md](plan.md) 拆出：M11（0.93 业务接线批）与 M12（0.94/0.95 硬化收尾批）——已完结的历史里程碑，
> 现行里程碑（M13+）仍在 plan.md。拆分依据 G11 仓内体量门（spec §5）。

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

