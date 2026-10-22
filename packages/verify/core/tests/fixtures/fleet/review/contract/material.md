# 契约体检验收（contract）：上游 master 的 contract:audit 在当前覆盖面上全部通过

验收对象：origin/master 当前提交。
数据源：probe.mjs 在验证器自己的本地克隆里检出 origin/master，安装依赖、构建后执行被验仓库自己的 scripts/contract-audit.sh，只读取退出码与"通过数/总数"，写入只读快照表 audit_runs(target_sha, rc, passed, total)。

## 判据

C1 契约体检必须正常结束：audit_runs 中 rc 不为 0 的行必须为 0。
C2 每一项体检都必须通过：audit_runs 中 passed 为空、total 为空，或 passed 不等于 total 的行必须为 0。
C3 体检覆盖面不缩水：audit_runs 中 total 小于 133 的行必须为 0。
C4 体检必须被执行：audit_runs 的行数不得少于 1。
