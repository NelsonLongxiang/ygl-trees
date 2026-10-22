# 审查台账验收（ledger）：没有既无 issue 又无明确结论的悬案

验收对象：审查台账（ygl-trees 默认工作区数据库，即 `ygl-trees db path` 给出的位置）里所有名称以 review- 开头的项目中的断言（每条断言是一条审查发现）。
数据源：probe.mjs 用 node:sqlite 只读打开台账，写入只读快照表 findings(project, claim_id, status, linked_issues, linked_open, text)。status 为 supported 表示发现仍成立且未处置；refuted（已修复）与 contested（已明确裁定不处理）都是有结论。linked_issues 是该断言的证据来源中指向本仓库 GitHub issue 的 issue 个数；linked_open 是其中尚未关闭（或状态查不到）的个数。

## 判据

L1 仍成立的发现必须有 issue 跟踪：findings 中 status 为 supported 且 linked_issues 为 0 的行必须为 0。
L2 跟踪它的 issue 关闭后，发现必须给出结论：findings 中 status 为 supported、linked_issues 大于 0 且 linked_open 为 0 的行必须为 0。
L3 台账必须可读：findings 的行数不得少于 1。

## 纪律

- 结论只能来自复核：修复要有反证证据（refuted），不处理要写明理由（contested）；不得为让 L1 通过而删除断言。
