# 舰队成员验收（member）：一个会话的递归验证器是否交出了可信的通过结论

验收对象：舰队登记表 fleet.json 里的一个成员（一个并行会话维护的、以结果为导向的 ygl-trees 递归验证器）。
数据源：probe.mjs 读取该成员的 work/results/latest.json（契约 ygl-verifier-latest/1），用钉版本的 ygl-trees 引擎对其根报告归档执行 verify archive verify，并在被验仓库里解析 target.rev 的当前提交，写入只读 SQLite 快照表 member(member_id, present, overall, age_minutes, archive_ok, selfcheck_cases, selfcheck_pass, goal_chars, target_is_git, target_sha, target_now, engine_major, engine_minor, engine_patch, meta_failed)。present 表示 latest.json 存在且契约名正确；age_minutes 是 judged_at 与可选字段 checked_at（成员确认目标未变、结论仍成立的时刻）中较晚者距本轮探测的分钟数；selfcheck_cases / selfcheck_pass 原样取自成员的 selfcheck 字段；target_sha 是成员声明的被验提交，target_now 是被验仓库里 target.rev 此刻解析出的提交（解析不了记 "(unresolvable)"），target_is_git 表示被验对象是否是本机 git 仓库；engine_major / engine_minor / engine_patch 是成员仓库 package.json 里钉的 ygl-trees 版本号的三段（读不到为空）；meta_failed 是本仓库钉版本的引擎对成员仓库执行 verify meta 后结论不为 PASS 的规则条数（跑不出结果为空）。探针不做比较，比较都在判据里。

## 判据

M1 成员必须按契约报到：member 中 present 为 0 的行必须为 0。
M2 成员的根结论必须通过：member 中 overall 不为 PASS 的行必须为 0。
M3 成员的结论不得过期：member 中 age_minutes 大于 1440 的行必须为 0。
M4 成员的根报告归档必须自校验通过：member 中 archive_ok 为 0 的行必须为 0。
M5 成员必须有自检且全部符合预期：member 中 present 为 1 且（selfcheck_cases 为空、selfcheck_cases 小于 1 或 selfcheck_pass 不等于 selfcheck_cases）的行必须为 0。
M6 成员必须写明自己的目标：member 中 goal_chars 小于 8 的行必须为 0。
M7 成员验的必须是被验分支的当前提交：member 中 target_is_git 为 1 且（target_now 为空或 target_now 不等于 target_sha）的行必须为 0。
M8 快照必须包含该成员：member 的行数不得少于 1。
M9 成员钉的引擎不得高于舰队审计所用的 0.114.0：member 中 present 为 1 且（engine_major 为空、engine_minor 为空、engine_patch 为空、engine_minor 大于 114，或 engine_minor 等于 114 且 engine_patch 大于 0）的行必须为 0。
M10 成员仓库必须通过元验证（章程 v1.1 声明式编排登记）：member 中 present 为 1 且（meta_failed 为空或 meta_failed 大于 0）的行必须为 0。

## 纪律

- 舰队聚合器只读成员的结果文件，不改成员仓库，不替成员重跑；成员不过 → 监督席派活给该成员的会话。
- 未报到（还没建好验证器）照样判 FAIL：舰队结论不因成员缺席而变绿。
- M9 的上限跟着舰队审计引擎走，精确到 patch（0.114.1 的 #34 修复让每个成员的重新冻结失败，评审席 2026-10-21 在 #34 上复现）：舰队钉的 ygl-trees 升级后改材料放开上限、升 spec 版本；成员不得跑在审计方没见过的引擎上。
- M10 用舰队自己钉的引擎（0.114.0，meta 索引 v2 + R5a）判成员仓库，不信成员自报：编排必须在 verify/orchestration/ 下逐文件登记（sha256 / role / replaced_by / sunset），否则 R3 不过。`--no-meta` 绕过不作常规用途。
