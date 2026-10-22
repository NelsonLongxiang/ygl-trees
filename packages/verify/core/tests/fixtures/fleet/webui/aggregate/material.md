# 聚合验收（aggregate）：组节点 = 子验证器结果的合取

验收对象：验证器树（tree.json）里的一个组节点。它的子节点可以是叶子验证器，也可以是别的组节点，判定逐层向上聚合，根节点的结论即整棵树的结论。
数据源：run.mjs 后序遍历验证器树，先跑完全部子节点，再把每个声明的子节点结果写入只读 SQLite 快照表 children(child_id, kind, overall, fail, needs_material, error, run_id, archive_ok, target_sha, round_sha)。声明了但没跑出报告的子节点照样写一行，overall 记为 MISSING。archive_ok 来自对该子报告归档包执行 verify archive verify 的结果；target_sha 是子报告快照里记录的被验提交，round_sha 是本轮的被验提交，两者原样记录，比较在判据里做。

## 判据

G1 每个子验证器都必须通过：children 中 overall 不为 PASS 的行必须为 0。
G2 每个子报告都必须归档且归档自校验通过：children 中 archive_ok 为 0 的行必须为 0。
G3 子验证器必须验同一个被验提交：children 中 target_sha 为空、round_sha 为空或 target_sha 不等于 round_sha 的行必须为 0。
G4 组节点不得为空：children 的行数不得少于 1。

## 纪律

- 同一份冻结 spec 用于树上每个组节点，只有快照不同；组节点永远不重新测量，只聚合子报告。
