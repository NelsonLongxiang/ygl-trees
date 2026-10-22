# WebUI 产物体积验收（bundle）

验收对象：被验提交全量构建后的 dist/apps/web/dist。
数据源：probe.mjs 在独立 worktree 里调用被验仓库自己的 scripts/ratchet.mjs --json，只取读数（value 实测字节、base 基线、tolerance 容差字节），写入只读 SQLite 快照表 metrics(metric, value, base, tolerance, headroom)，其中 headroom = base + tolerance - value，无基线时为空。

## 判据

B1 web 产物体积不得超出棘轮基线容差：metrics 中 metric 为 web_dist_bytes 且 headroom 小于 0 的行必须为 0。
B2 web 产物必须有基线约束：metrics 中 metric 为 web_dist_bytes 且 headroom 为空的行必须为 0。

## 纪律

- 本验证器不改基线：认账（ratchet --write）由用户批准后在被验仓库提交。
- 只验 web 产物；CLI bundle 与冷启动属于后端，不在前端验收范围。
