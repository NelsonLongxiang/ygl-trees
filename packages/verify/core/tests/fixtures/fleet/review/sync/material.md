# 本地与上游同步验收（sync）：本地 master 与 origin/master 一致，或只差仍在评审中的 PR

验收对象：本地 ygl-trees 仓库的 master 分支与 GitHub 上游 origin/master。
数据源：probe.mjs 先 git fetch origin，再比较两棵树，写入只读快照表 sync_state(fetched_ok, origin_sha, local_sha, diff_files, uncovered_files) 与 sync_diff(path, covered_by_open_pr)。sync_diff 每行是一个内容不同的文件（证据明细），covered_by_open_pr 表示该文件是否出现在本仓库作者仍处于打开状态的某个 PR 的改动文件里；sync_state 只有一行，uncovered_files 是 sync_diff 中 covered_by_open_pr 为 0 的文件数（完全一致时为 0，此时 sync_diff 为空表）。只比较已提交的内容，工作区未提交的改动不在范围内（那是并行会话的在制品）。

## 判据

S1 必须拿到上游的最新状态：sync_state 中 fetched_ok 为 0 的行必须为 0。
S2 本地与上游的差异只能来自仍在评审中的 PR：sync_state 中 uncovered_files 大于 0 的行必须为 0。
S3 同步状态必须被测量：sync_state 的行数不得少于 1。

## 纪律

- 本验证器不合并、不推送：同步由审查席按流程执行，验证器只判结果。
