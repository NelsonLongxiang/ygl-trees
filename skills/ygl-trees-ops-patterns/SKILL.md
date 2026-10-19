---
name: ygl-trees-ops-patterns
description: ygl-trees 自动运维三件套模式（主推场景①，从 .157 业务实战提炼）：采纳监测（adoption-snapshot-daily）、预测回测（backtest-audit-daily）、边界巡检（patrol，0.93 产品化）。要给自己的 ygl-trees 工作区配自动运维、要监测团队/agent 的真实采纳、要把边界断言变成带处置队列的巡检时使用。触发词：自动运维、采纳监测、回测巡检、patrol、边界断言、SOP 巡检、零未处置。
version: 1.0.0
---

# 自动运维三件套（ops-patterns）

研究工作台的「业务侧」：不只记录知识，还持续检查现实有没有按记录走。三个模式都经过真实业务运转验证（.157 跨境电商全链路，2026-10）。

## ① 采纳监测（adoption-snapshot）

**问题**：上了新能力，没人用——你三个月后才发现。
**模式**：cmd.run 遥测 → 日快照 → 差分 → 人工研判。
- 0.93 起 cmd.run 带 actor/session 归因——采纳从命令级升到会话级（谁在用，不只是用了没）。
- 快照：`db sql "SELECT date(ts) d, count(*) FROM events WHERE kind='cmd.run' GROUP BY d"`（配 job every 1440 落文件）。
- 研判三问：新能力首用出现在哪个会话？失败率升了吗（error 级 cmd.run）？周环比？
- 阈值化：把「本周 cmd.run ≥ N」直接做成解锁门 `node cond add <key> --op telemetry --value "cmd.run:7d>=N"`——能力树的解锁即采纳证明。

## ② 预测回测（backtest-audit）

**问题**：预测发出去就忘，永远不知道准不准。
**模式**：到期 ≤3 天 ALERT；硬判=人工 resolve，不提前不拖后。
- 断言格式 `[预测·N天] <日期> 前 observable 事件`（判据必须可观测可计数）。
- `predict audit --due` 巡检（job 到期提醒）；`predict list --all` 看全表（0.90 起 outcome/brier/settler 投影）。
- 结算 note 三段式：`outcome=1|0, brier=0.xx, settler=<席位>`——校准曲线 SQL 直出。
- **人审铁律**：机器不代结算。模型 eval 门过 ≠ 解锁（事实性走证据，语义性才用 eval 门）。

## ③ 边界巡检（patrol，0.93 命令族）

**问题**：数据里的边界条件（僵尸任务/过期状态/违约行）没人看。
**模式**：断言 → 队列 → 处置，零未处置铁律。
- `patrol add <name> --sql "SELECT …"`（只放行 SELECT；severity S1|S2|S3）；
- `patrol run` 巡检：新违反 open、消失 auto-fixed、**复发自动重开**、ack 在办存活；
- `patrol ack|fp|fix <id>` 三道处置（fp=白名单道）；
- doctor 挂钩：open S1>0 → doctor fail——S1 未处置 = 工作区不健康。
- 巡检示例：僵尸任务（`SELECT id FROM artifacts WHERE kind='task' AND meta LIKE '%todo%' AND created < date('now','-30 days')`）。

## 共同纪律

- 三个模式都是**日节奏**（every 1440）配 DSH schedule 晨间推进——运维不是实时监控，是有节奏的回顾。
- 盲区登记：actor 归因 0.93 才有（历史数据不分会话）；技能召回无命中计数。
- 事故→工具化：每次巡检漏报/误报，改判据不改脾气（.157 教训：FP 白名单是活的，每周清一次）。
