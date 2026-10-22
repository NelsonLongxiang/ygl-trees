# 已关闭 issue 复核验收（issues）：每个关闭的 issue 都有基于已发布版本的复现复核

验收对象：本仓库作者（zhujun200409-cloud）在 NelsonLongxiang/ygl-trees 打开、且已关闭的每一个 issue。
数据源：probe.mjs 用 gh 只读取 issue 与评论，取本仓库作者的最后一条评论作为复核评论，写入只读快照表 closed_issues(number, title, reverify_comments, cited_version_released, cited_sha_released, rc_mentions, arrow_mentions, repro_words, cited)。reverify_comments 是本方在该 issue 下的评论条数；其余各列取自本方最后一条评论：cited_version_released 为 1 表示其中引用的某个版本号存在于 npm；cited_sha_released 为 1 表示其中某个反引号括起的提交哈希可从某个 v* 发布标签回溯到；rc_mentions、arrow_mentions、repro_words 分别是退出码记号 rc=（不分大小写）、命令输出箭头 →、复现字样 repro 或 复现（不分大小写）在评论中出现的次数。

## 判据

I1 每个关闭的 issue 都必须有本方的复核评论：closed_issues 中 reverify_comments 为 0 的行必须为 0。
I2 复核必须基于已发布的版本：closed_issues 中 cited_version_released 为 0 且 cited_sha_released 为 0 的行必须为 0。
I3 复核必须带复现证据：closed_issues 中 rc_mentions、arrow_mentions、repro_words 都为 0 的行必须为 0。
I4 复核面不缩水：closed_issues 的行数不得少于 9。
