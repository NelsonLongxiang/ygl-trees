# 已合并 PR 交付验收（prs）：合并的内容 = 验证器放行的那个提交

验收对象：本仓库作者（zhujun200409-cloud）向 NelsonLongxiang/ygl-trees 提交、且已经被合并的每一个 PR。
数据源：probe.mjs 用 gh 只读取 PR 状态与合并时的 head 提交（headRefOid），与 data/pr-verifications.json 里登记的"验证器放行提交 + 放行 run_id"逐条比对；放行证据读自监督席结果验证器的结果文件（<sha12>--<run_id>.json），写入只读快照表 merged_prs(pr, state, head_sha, verified_tip, verify_run, evidence_kind, evidence_overall, evidence_sha, evidence_archive_ok)。evidence_kind 是放行证据的形态：archive 表示证据取自放行验证器 ledger 里的根归档（CLI 产物）——evidence_archive_ok 为该归档执行 verify archive verify 的结果（1 通过），evidence_overall 取归档内 report.json 的 overall，evidence_sha 取归档内快照 meta 的 target_sha；legacy-summary 表示 format v2 之前的登记，证据取自放行验证器的汇总文件（overall 与 target.sha），保留不改写。evidence_sha 是放行证据里记录的被验提交。探针只记录取值、不做比对，比对由判据完成。未登记的已合并 PR 照样写一行，verified_tip 为空。

## 判据

P1 每个已合并 PR 必须登记过验证器放行提交：merged_prs 中 verified_tip 为空的行必须为 0。
P2 合并时的 PR head 必须等于验证器放行的提交：merged_prs 中 head_sha 为空、verified_tip 为空，或 head_sha 不等于 verified_tip 的行必须为 0。
P3 放行证据必须存在且结论为 PASS：merged_prs 中 evidence_overall 不为 PASS 的行必须为 0。
P4 放行证据验的必须是同一个提交：merged_prs 中 evidence_sha 为空，或 evidence_sha 不等于 verified_tip 的行必须为 0。
P5 交付面不缩水：merged_prs 的行数不得少于 3。
P6 归档形态的放行证据必须通过归档自校验：merged_prs 中 evidence_kind 为 archive，且 evidence_archive_ok 为空或为 0 的行必须为 0。
P7 放行证据形态只能是 archive，legacy-summary 只限 format v2 之前的登记：merged_prs 中 evidence_kind 为空、evidence_kind 既不是 archive 也不是 legacy-summary，或 evidence_kind 为 legacy-summary 而 pr 不在 4、5、13、15、16 之中的行必须为 0。

## 纪律

- 放行登记（data/pr-verifications.json）只记事实：PR 号、放行提交、放行 run_id；不得为了让 P2 通过而改登记。
