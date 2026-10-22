# 发布规范验收（releases）：npm 上的每个版本都有标签与源码，且源码先于 npm

验收对象：npm 上 ygl-trees 的每个已发布版本。
数据源：probe.mjs 用 npm view 读发布时间，用 git（已 fetch 标签）与 GitHub 推送记录读标签与源码到达 master 的时间，写入只读快照表 releases(version, npm_published_at, ver_major, ver_minor, ver_patch, ver_pre, tag_present, tag_on_master, tag_pkg_version, source_pushed_at, tagged_at, deviation_issue, deviation_issue_state, ack_author, ack_issue)。ver_major / ver_minor / ver_patch 是版本号三段整数，ver_pre 是预发布后缀（正式版为空）。tag_present 为 1 表示存在 v<version> 标签；tag_on_master 为 1 表示标签提交是 origin/master 的祖先；tag_pkg_version 是标签处 package.json 的 version。时间列一律是 UTC ISO（毫秒，Z 结尾），可直接按字符串比较：npm_published_at 是 npm 发布时间；source_pushed_at 是 GitHub 推送记录里第一条使标签提交可从其推送后状态回溯到的推送时间（只在推送记录覆盖的时间窗内可测，窗外为空）；tagged_at 是附注标签的打标时间（轻量标签为空）。
偏差登记：data/release-deviations.json 记录维护者已认可的发布顺序偏差 {version, issue, ack_url}。探针对登记的版本测量 deviation_issue（登记的 issue 号）、deviation_issue_state（GitHub 上该 issue 的状态）、ack_author（ack_url 那条评论的作者）、ack_issue（那条评论所属的 issue 号）；未登记的版本四列为空。
范围：标签范围 = ver_pre 为空，且 ver_major 大于 0 或 ver_major 为 0 且 ver_minor 不小于 79，即不低于 0.79.0 的正式版本（仓库开始为每次发布打标签的第一个版本；更早的 0.66–0.78 与 0.0.0-stage 发布时还没有打标签的习惯，只记录不判）。顺序范围 = ver_pre 为空，且 ver_major 大于 0 或 ver_major 为 0 且 ver_minor 不小于 109，即不低于 0.109.0 的正式版本（2026-10-20 约定"推 master → 打标签 → npm 发布"之后第一个按此顺序发布的版本）。

## 判据

R1 范围内的每个版本都必须有标签：releases 中处于标签范围且 tag_present 为 0 的行必须为 0。
R2 标签必须指向 master 上的源码：releases 中处于标签范围且 tag_on_master 为 0 的行必须为 0。
R3 标签处 package.json 的版本号必须与发布版本一致：releases 中处于标签范围，且 tag_pkg_version 为空或不等于 version 的行必须为 0。
R4 源码必须先于 npm 到达 master：releases 中处于顺序范围，且 source_pushed_at 为空或不早于 npm_published_at 的行必须为 0。
R5 标签必须先于 npm 打好，除非该偏差已登记且获维护者认可：releases 中处于顺序范围、tagged_at 为空或不早于 npm_published_at，且 deviation_issue 为空、deviation_issue_state 为空、ack_issue 为空、ack_author 为空、ack_author 不是 NelsonLongxiang、ack_issue 不等于 deviation_issue 六者任一成立的行必须为 0。
R6 发布面必须被测量：releases 中处于标签范围的行数不得少于 49。

## 纪律

- 范围起点（0.79.0 / 0.109.0）是事实记录，不是放宽：新版本自动落入两个范围。
- 偏差登记不是放宽：只在维护者在对应 issue 下明确认可后写入；认可评论必须出自 NelsonLongxiang、必须属于登记的 issue、该 issue 的状态必须被测到，三者缺一 R5 照判不通过。
