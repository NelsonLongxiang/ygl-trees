# #27 品味判据候选表（草稿：T3 试点样本 · T8 条文输入）

> #27 实现席 · 2026-10-22 · 基线：`taste-extraction-plan.md`（PR #31，§3 操作定义与 R-T1–R-T6 草案）、契约 1.2 七型检查器（`docs/verify-contract.md` §2）。
> 输入：用户 2026-10-22 提供的两份资料——**A.《taste》品味技能 v1.0.0**（龙翔 2026-10-09 品味投喂，原子能《让编程再次伟大》九表的可调用面）；
> **B. 任务记录《汇总表「数据来源」列品味规范调查与落地》**（mpbs 财务汇总 produce 管线，2026-10-21～22）。
> **本表只列候选，不定案、不实现。** 每一条都是【O】，进材料前须过方案 §3 定义（多个有资格的人独立做出、彼此一致、理由说得清、经得起复核），并等 §4 的 D1–D6 裁定。
> 资料 B 顺带证实：ygl-trees 0.114.5 没有「品味处理功能」（0.114.5 = #34 子句模式工作）。验证器验的是品味判断的**证据结构**，不验品味本身（方案 §0 结论 1）。

> **优先级定向（用户 2026-10-22）**：品味不是当下要解决的问题，数据是第一生产力。先建闭环——**提取**（探针把台账 / git / 报告 / 判断记录变成快照表）→ **分析**（§3 的 S1–S5 统计认定层）→ **反馈循环验证**（R-T1–R-T6 结构判据）→ **回填**（推翻 → spec_version +1 → 指引再生）。闭环成立，品味自成。
> 因此本表的 **§3 S 组与 B10（认定记录）/ B11（推翻升版）是基础设施，优先**；§1 A 组只是种子候选，须经闭环的数据验证才进判据，不能一味依赖技能条目；§7 的投放面技能是闭环的派生物，不是来源。实现闭环的主路径是**元验证器的演进**：`verify meta` 规则集、递归聚合与 R-T5 父级绑定、§4.7 原语（collect / snapshot build / tree run / self-check / package / import-report）、契约 1.3（semantic_scope / provenance / 扫描清单）。

## 0. 怎么读这张表

| 列 | 含义 |
|---|---|
| 候选判据 | 已按舰队子句格式写成一行（`^[A-Z]+[0-9]+ ` 开头），可逐字进 `material.md`；阈值用占位符（n/k/κ/N/L）写进材料再冻结 |
| 判定面 | **M** 机械可检（引擎判）· **H** 人审（验证器只验「判断记录在场且合规」）· **M+H** 机械验留痕 / 一致性，人审内容 |
| 检查器型 | 契约 1.2 七型：`sql`（找违规，`fail_when: rows>0`）· `sql-pair`（两表键对比）· `count`（计数阈值）· `exists`（存在/不存在）· `file`（提交物 glob）· `command`（执行事实，不进 fact 折叠）· `agent`（review 层）。**按 D1 建议不开运行时 agent 判分，本表 H 项一律不配 `agent`**，而是「认定记录表 + `sql` 验记录字段」 |
| 探针列 | 只测不判：探针落什么表、什么列；比较与阈值全在 spec（契约 1.2 列对列 `value:{col}` 可用） |
| 证据要求 | 报告里应有的 witness / 样例行；认定记录应有的字段 |
| 语义边界 | 结果交人时按 R-T6 标注：**structural**（验结构 / 留痕）· **factual**（验数据内容的可判定事实）· **semantic**（判断本身，留给人） |

统一的认定记录表（R-T1/R-T2/R-T3/R-T4 共用，T3 试点先建）：
`taste_judgments(case_id, rule_id, judge_id, verdict, reason, anchor, layer, decided_at, review_by)`；
`taste_rules(rule_id, domain, clause, samples_n, distinct_judges, kappa, decided_at, review_by, spec_version)`。
**方案 §2.3 ④ 的解法**：`count` 没有 DISTINCT，所以「独立判断者 ≥ k」不由 `count` 表达——由探针算出 `distinct_judges`、`kappa` 两列落表（测量），spec 用 `sql` 判 `distinct_judges < k` / `kappa < κ`（判定），零契约成本。

## 1. 来源 A：品味技能（五问 / 红线 / 架构形态 / 前端 / know-why）

| 编号 | 候选判据（子句） | 判定面 | 检查器型 | 探针列 / 数据源 | 证据要求 | R-T | 语义边界 · 备注 |
|---|---|---|---|---|---|---|---|
| A1 | `A1 每个功能类 PR 必须引用需求来源：pr_rows 中 kind 为 feature 且 requirement_ref 为空的行必须为 0。` | M+H | `sql` | `gh pr list/view` → `pr_rows(number, kind, requirement_ref, body_sha)`；kind 取 label / 标题前缀；requirement_ref 解析 `#<issue>` 或指令 id | 违规 PR 号样例行；H 侧：`taste_judgments` 对「需求真实吗」的判断 + 理由 | R-T1 | structural。五问①。空引用能糊弄 → 锚点有效性靠 R-T1 + 抽样人审 |
| A2 | `A2 新增运行时依赖必须有取舍记录：dep_changes 中 added 为 1 且 adr_ref 为空的行必须为 0。` | M+H | `sql` | 逐提交 diff `package.json` → `dep_changes(sha, pkg, added, bumped, adr_ref, changelog_ref, pkg_age_months)`；adr_ref 取 plan.md 执行记录 / ADR / CHANGELOG 段落 | 违规 (sha, pkg)；H 侧：是否最朴素 | R-T1 R-T3 | structural。五问②「别造轮子 / 技术栈越小越好」 |
| A3 | `A3 性能类改动必须附基准前后数据：perf_commits 中 bench_ref 为空的行必须为 0。` | M+H | `sql` | 提交 message / label 含 性能·优化·perf·ratchet → `perf_commits(sha, bench_ref)`；bench_ref 取 `tmp/bench-results.json` 引用或 ratchet 数字 | 违规 sha；H 侧：是否「根基未稳就优化」 | R-T1 | structural。五问③ + 红线⑥合并（make it work → right → fast）。自报 label 可逃避 → 与 A4 联动 |
| A4 | `A4 改动文件数不少于 3 的提交必须带 know-why：commit_rows 中 files_changed 不少于 3 且 has_why 为 0 的行必须为 0。` | M+H | `sql` | `git log --numstat` → `commit_rows(sha, subject, files_changed, has_why)`；has_why = 正文含动机 / 取舍 / 放弃 / 为什么 任一段 | 违规 (sha, subject)；H 侧：理由好不好（R-T1 明示不验） | R-T1（E8） | structural。五问④「一切决策都是取舍」。关键词凑数 → R-T3 盲审抽样 |
| A5 | `A5 临时方案必须挂账：temp_markers 中 ledger_ref 为空的行必须为 0。` | M | `sql` | 扫已跟踪源码的 TODO · FIXME · HACK · 先这样 · 临时 → `temp_markers(path, line, marker, ledger_ref)`；ledger_ref 取 `#<issue>` / task id | 违规 `path:line` 样例 | R-T1 | structural。五问⑤。「退场路径（只用静态配置）」是 H，记入 judgments |
| A6 | `A6 命令入口的 throw 必须在登记的允许名单内：throw_sites 中 allowlisted 为 0 的行必须为 0。` | M+H | `sql` | AST/grep `throw` 于命令处理器文件 → `throw_sites(path, line, allowlisted)`；允许名单写进材料 | 违规 `path:line` | R-T1 | structural。红线①「错误当返回值」。本仓已有契约面：`--json` 错误单对象 + rc（contract 断言），可作参照 |
| A7 | `A7 不得用外部输入拼接执行命令：exec_sites 中 taints_external 为 1 的行必须为 0。` | M | `sql` | grep `spawn/exec/execSync` 且参数来自 argv/stdin/net/文件内容的拼接 → `exec_sites(path, line, taints_external)` | 违规 `path:line` | R-T1 | structural。红线②（Log4j 式）。引擎 `command` 型已有 allowlist + r26 注入防线；静态污点判定是近似，命中项交 H 复核 |
| A8 | `A8 新增对外部框架 SDK 的直接引用必须登记迁移退路：sdk_imports 中 exit_path_ref 为空的行必须为 0。` | M+H | `sql` | import 自材料列出的 SDK 包 → `sdk_imports(path, pkg, exit_path_ref)` | 违规 (path, pkg)；H 侧：是否「动态逻辑」 | R-T1 | structural。红线③「只用静态配置」 |
| A9 | `A9 代码风格由工具唯一裁定：style_tooling 中 config_present 为 1 且 ci_enforced 为 1 的行不得少于 1。` | M | `count`（或 `exists` + `command`） | 仓库根格式化配置 + CI 门禁步骤 → `style_tooling(config_path, config_present, ci_enforced)`；`command`：formatter `--check` rc=0 | 行在场；command 退出码 | — | structural。红线④「规矩只为止争」：验的是「有止争工具」，不验「没争论」 |
| A10 | （不设子句） | H | — | — | `taste_judgments` 记案例 / 判断者 / 理由 / layer=L4 | R-T3 | semantic。红线⑤「Clean Code 洁癖 / 三行不拆十函数」：函数长度、数量任何指标都会被古德哈特（方案 §7），只收案例不进机械判据 |
| A11 | （并入 A3） | — | — | — | — | — | 红线⑥「根基未稳不做性能」= A3 的否定面 |
| A12 | `A12 新增依赖的发布年龄不得少于 N 个月：dep_changes 中 added 为 1 且 pkg_age_months 小于 N 的行必须为 0。` | M+H | `sql` | 同 A2 表；`npm view <pkg> time` → `pkg_age_months`；N 进材料（资料 A 的容器例为 36） | 违规 (pkg, age)；H 侧：是否「全盘引入」 | R-T1 | structural。红线⑦「新概念不跟风」。年龄 ≠ 成熟度，仅作信号 |
| A13 | `A13 多运行时兼容探针必须在场：runtime_probes 的行数不得少于 1。` | M | `count` | 仓库脚本面（如 `smoke:bun`）与 `docs/bun-compat.md` 之类结论登记 → `runtime_probes(name, last_run, verdict)` | 行在场 | — | structural。红线⑧「不押注别人的运行时」；弱代理，结论本身是 H |
| A14 | `A14 架构裁决记录必须写明问题形态：adr_rows 中 problem_shape 为空的行必须为 0。` | M+H | `sql` | plan.md 执行记录 / ADR → `adr_rows(id, date, problem_shape, options, chosen, reason)` | 违规 id；H 侧：形态判得对不对 | R-T1 | structural。§三「按问题形态选架构」速查表的六种形态可做 problem_shape 闭集 |
| A15 | （分类轴，非判据） | — | — | `taste_judgments.layer ∈ {L0,L1,L2,L3,L4}` | 认定记录带 layer | R-T2 | §四五层内核：用于 κ 分层统计与「失守在哪一层」归因，不单独判定 |
| A16 | `A16 前端产物体积只降不升：ratchet_rows 中 metric 为 web_dist 且 over_baseline 为 1 的行必须为 0。` | M | `sql`（或 `command`：`pnpm ratchet` rc=0） | 本仓已有 `scripts/ratchet.mjs` → `ratchet_rows(metric, value, baseline, over_baseline)` | 违规 metric 行 | — | factual。§五「前端要瘦」；本仓现成门禁，可直接试点 |
| A17 | `A17 虚拟列表、日期、校验、拖拽四类若自写实现必须有取舍记录：homegrown_components 中 adr_ref 为空的行必须为 0。` | H（M 仅留痕） | `sql` | 人工登记 `homegrown_components(kind, path, adr_ref)`（自写与否本身是判断） | 违规 kind | R-T1 | semantic 为主。§五「前端别造轮子」 |
| A18 | （不进判据） | — | — | — | — | — | §五「前端工作量被低估」是排期经验，留作研究材料 |
| A19 | `A19 每条架构裁决必须有 ADR 或台账条目：decisions 中 record_ref 为空的行必须为 0。` | M | `sql` | 决策清单（会议 / 指令 / 评审裁定）→ `decisions(id, date, record_ref)` | 违规 id | R-T1（E6/E8） | structural。§六 know-why 沉淀义务的总则；A4 / A14 是它的两个切面 |

## 2. 来源 B：「数据来源」列品味规范案例（真实闭环一例）

| 编号 | 候选判据（子句） | 判定面 | 检查器型 | 探针列 / 数据源 | 证据要求 | R-T | 语义边界 · 备注 |
|---|---|---|---|---|---|---|---|
| B1 | `B1 数据来源列的多成分拼接只用加号连接：source_text 中 has_semicolon_sep 为 1 的行必须为 0。` | M | `sql` | 导出各册「数据来源」列 → `source_text(book, sheet, row, text, has_plus, has_semicolon_sep, dup_segments, trailing_semicolon, double_semicolon, has_guide_phrase, length)` | 违规 (book, sheet, row) 样例 | R-T1 R-T4 | factual。**唯一的真品味项**：方案 A（成分加总统一「+」）由属主授权单人代选，理由已登记（「+」= 成分并列加总；改动面最小）。按 §3 仍需 ≥k 判断者或属主在 D5 定 k；复审期按 D4 |
| B2 | `B2 数据来源列不得有重复段：source_text 中 dup_segments 大于 0 的行必须为 0。` | M | `sql` | 同上 | 违规样例 | — | factual。微观五项之一；更接近整洁 / 正确性，是否算品味待认定 |
| B3 | `B3 数据来源列不得以分号结尾：source_text 中 trailing_semicolon 为 1 的行必须为 0。` | M | `sql` | 同上 | 违规样例 | — | factual |
| B4 | `B4 数据来源列不得出现双分号：source_text 中 double_semicolon 为 1 的行必须为 0。` | M | `sql` | 同上 | 违规样例 | — | factual |
| B5 | `B5 数据来源列长度不得超过 L：source_text 中 length 大于 L 的行必须为 0。` | M | `sql` | 同上；L 进材料 | 违规样例 | — | factual。注记格式一项需先把格式写成闭集再机械化 |
| B6 | `B6 不得残留「明细见[…]sheet(N行)」指引写法：source_text 中 has_guide_phrase 为 1 的行必须为 0。` | M | `sql` | 同上 | 违规样例 | — | factual。S5 第②步「指引转成分式」的验收面 |
| B7 | （不进品味判据） | M | `command` / `sql` | 公式无引号 sheet 引用 → Excel `#NAME?` | — | — | 这是**正确性缺陷**（实锤事故），归正确性门禁，不混进品味 |
| B8 | `B8 产线步骤顺序必须等于材料声明的顺序：pipeline_steps 与 declared_steps 按 position 对比的违规对数必须为 0。` | M | `sql-pair` | 产线配置 → `pipeline_steps(step, position)`；材料声明 → `declared_steps(step, position)`（S1 → S4 → S4b → S5 → S2 → S3） | 违规对 | R-T5（结构） | structural。「手术顺序是隐含契约」：改公式在缓存注入前，文本规范化在验证前 |
| B9 | `B9 依赖升级提交必须引用目标版本的 CHANGELOG：dep_changes 中 bumped 为 1 且 changelog_ref 为空的行必须为 0。` | M+H | `sql` | 同 A2 表 | 违规 (sha, pkg)；H 侧：是否读懂 | R-T1 | structural。教训①「工具升级先查 CHANGELOG 全文」（本例 0.114.5 无品味功能） |
| B10 | `B10 每条品味裁决必须有字段齐全的认定记录：taste_decisions 中 candidates、selected、reason、decider、decided_at 任一为空的行必须为 0。` | M | `sql` | `taste_decisions(rule_id, candidates, selected, reason, decider, decided_at, review_by)` | 违规 rule_id | R-T1 R-T3 | structural。资料 B 已登记选型 A 的候选 / 理由 / 决策者，是这张表的首行 |
| B11 | `B11 被推翻的品味判据必须升版留痕：overturned 中 new_spec_ref 为空、等于 old_spec_ref 或 new_spec_registered 为 0 的行必须为 0。` | M | `sql` | 台账：`overturned(rule_id, old_spec_ref, new_spec_ref, new_spec_registered, reason, overturned_by, overturned_at)`；spec 引用形如 `spec_id@v<n>`；`new_spec_registered` 由探针核对冻结谱系 `ledger/specs/<id>/v<n>/`（或现行索引） | 违规 rule_id 行 | R-T4 | structural。**干跑修正（2026-10-22，ygl-taste-pilot-verifier）**：材料改动后引擎产生的是**新 spec_id（v1）**，`spec_version +1` 只发生在同一份冻结材料重新 prepare 时，所以升版留痕必须记 `spec_id@版本` 而非整数版本号；「已登记」要核对冻结谱系而不是只列现行 spec 的索引（被取代的旧「新 spec」在索引里查不到） |

## 3. 统计 / 认定层（R-T2，试点必备，与域无关）

| 编号 | 候选判据（子句） | 判定面 | 检查器型 | 探针列 | 证据要求 | 备注 |
|---|---|---|---|---|---|---|
| S1 | `S1 进入认定的规则样本量不得少于 n：taste_rules 中 samples_n 小于 n 的行必须为 0。` | M | `sql` | `taste_rules.samples_n`（探针数 judgments） | 违规 rule_id | n 进材料（方案 D5 提议约 30） |
| S2 | `S2 进入认定的规则独立判断者不得少于 k：taste_rules 中 distinct_judges 小于 k 的行必须为 0。` | M | `sql` | 探针算 `distinct_judges`（绕过 count 无 DISTINCT，§2.3 ④） | 违规 rule_id | k 进材料（提议 ≥3）；「同一人判三次」不再能过 |
| S3 | `S3 进入认定的规则一致度不得低于 κ：taste_rules 中 kappa 小于 κ 的行必须为 0。` | M | `sql` | 探针算 Fleiss/Cohen κ 落 `kappa` | 违规 rule_id | κ 进材料；个人偏好 / 低一致度判断按 §3 只作研究材料 |
| S4 | `S4 每条品味判断必须带理由且锚点可解析：taste_judgments 中 reason 为空或 anchor 为空的行必须为 0。` | M | `sql` | `taste_judgments.reason/anchor` | 违规 (case_id, judge_id) | R-T1；说不出理由的案例剔除并计数入报告（方案 T3 验收） |
| S5 | `S5 品味类判据未过复审期：taste_rules 中 review_by 为空或 review_by 早于 as_of 的行必须为 0。` | M | `sql` | `taste_rules.review_by`；探针写 `as_of` 列 | 违规 rule_id | R-T4 约定版（D4）；过期 → 判据产出 NEEDS-MATERIAL 由父级按 R-T5 处理 |

## 4. 与 D1–D6 的对应

- **D1**（运行时 agent 判分）：本表按「不开」写——H 项不配 `agent`，只验认定记录。若远期在三条件下开，A10 / A17 类才可能有 rubric 面。
- **D2**（通道）：按 (a) 数据侧约定，B 组 claim 文本前缀 `[品味·财务汇总]`，A 组 `[品味·工程]`；`taste_rules.domain` 列同名。
- **D3**（契约 1.3）：本表「语义边界」列即 `semantic_scope` 的取值；1.3 落地前由 T6 的渲染约定（缺省 structural）兜底。
- **D4**（复审期）：S5 走约定版（材料条款 + 探针 `as_of` 列）；有数据后再决定是否进契约。
- **D5**（试点域与数据）：方案提议「科目归放」；本表 B 组提供第二个候选域「数据来源列拼接风格」，已有真实案例、脱敏易（只涉及格式）。案例数据只留本地。
- **D6**（工作区）：独立 `YGL_HOME`，与方案建议一致。

## 4b. 干跑记录（2026-10-22，`~/workspace/ygl-taste-pilot-verifier`，本地仓，不碰上游）

闭环基础设施按 §3 S1–S6 + B10（L1）/ B11（L2）+ L3 做成两份材料，首行数据 = 资料 B 的真实裁决（判断者只用角色词）。六轮结果：

| 轮 | 事件 | statistics | ledger | 根 |
|---|---|---|---|---|
| 1 | 首冻结 + 首行数据 | FAIL（S1 样本 1 / S2 判断者 1 / S3 κ 为空） | NEEDS-MATERIAL（无推翻记录，零扫描） | FAIL |
| 2 | 推翻 L2（非空 → 必须大于旧版本号），overturned 首行 | FAIL | PASS | FAIL |
| 3 | 推翻 L2（整数版本号 → spec_id@v + 已登记核对），新 spec 未登记 | FAIL | FAIL（L2 抓到未完成的回填） | FAIL |
| 4 | 登记新 spec 后重跑 | FAIL | FAIL（第 1 行的新 spec 已被取代，索引查不到） | FAIL |
| 5 | 推翻 L2 数据源口径（已登记 = 冻结谱系 ledger/specs），新 spec 未登记 | FAIL | FAIL | FAIL |
| 6 | 登记后重跑 | FAIL | **PASS**（L1 / L2 / L3） | FAIL |

与预测对照：S1–S3 红、S4 / S5 / S6 绿、L1 绿如预期；L2 / L3 首轮零扫描 NEEDS-MATERIAL 如预期；预料之外的是**两条口径修正**（整数版本号不成立；已登记须查谱系），它们本身就是闭环的产出——三次推翻全部记在 `overturned.json`，冻结谱系保留四个 ledger spec 版本。根结论 FAIL 是对「单一决策者尚不构成认定品味」的如实陈述，不是故障。

## 5. 建议的试点最小集（供 T3 排期参考，全部 M，可在 0.114.5 直接 submit → prepare）

B1 · B2–B5 · B6（资料 B 已有数据与一次真实裁决）、A4 · A5 · A16（本仓即数据，探针只读 git / ratchet）、B10 · S4（认定记录本身）。H 项（A1 的需求真实性、A2 的朴素性、A10、A17）试点期只收集 `taste_judgments`，供 S1–S3 统计，不进判定。

## 6. 不进判据、留作研究材料

A10（整洁洁癖）、A18（前端工作量）、§四五层内核（作分类轴）、资料 A 的金句与墓志铭清单、资料 B 的返工实录（教训②③④是流程纪律，可进 AGENTS 而非 spec）。

## 7. 消费面与通过率：判据必须能被 agent 在动手前消费（用户 2026-10-22 定向）

用户对 #27 的最终期望：**通过 ygl-trees 的递归验证，高效提取准确的品味信息与建议，让 agent 运行时作出更符合业务专家品味的决策，从而达到高的验证通过率；反过来，验证总是不通过，验证器就失去了本意。** 这把方案的重心从「验证侧」补到了「消费侧」，对本表的要求是：

| 要求 | 怎么落 | 对应 |
|---|---|---|
| 每条判据都有 **agent 面的指引** | 同一份冻结材料同时产出两种形态：spec（给引擎判）与「问句 + 怎么做才过」（给 agent 读，即资料 A 的五问形态）。单一事实源是 `material.md`，指引是它的派生物，不另写一套 | R-T1 锚点同源；D2 通道前缀 |
| 指引在 **动手前** 到达 agent | 投放面用现成能力：`skills/`（如资料 A 的 `taste` 技能）与 `agent brief` 的下一步提示；不在运行时让引擎打分（D1） | charter P2、D1 |
| FAIL 必须 **可行动** | 报告的 witness 样例行 + 命中的子句原文 + 对应指引三者一起交人 / 交 agent；只给红灯不给路的 FAIL 不合格 | R-T6 边界、T6 渲染面 |
| 通过率是 **信号不是判据** | 探针按 rule_id 记 `first_pass_rate`（首验通过率）与 `overturn_rate`（推翻率）落 `taste_rules`，用于复审排序；**不写进 fail_when**——一旦成为判据就会被优化成「让人认同 / 不被发现」（方案 §7 古德哈特） | R-T2 R-T4、§7 |
| 持续低通过率的处置 | 两种解释、两种出路：措辞不清 → 回流改材料（spec_version +1，B11）；本就不是品味（一致度低、说不出理由）→ 按 §3 剔出判据、留作研究材料 | §3、B11、S3 |
| 试点要量这件事 | T3 在投放指引前后各量一轮首验通过率，作为「验证器有没有教会 agent」的证据；高通过率 + 高一致度才是闭环成功，不是把判据改松 | D5、T3 验收 |

**顺序（用户 2026-10-22 二次定向）**：① 验证器建成 → ② 数据达到规模 → ③ 增强 agent 上下文引导、做品味提取与分析 → ④ 与具体实际业务核算。对本表的含义：

| 阶段 | 门槛（机械可检） | 产出 | 备注 |
|---|---|---|---|
| ① 验证器建成 | `verify meta` 全 PASS、自检全过、闭环三表（judgments / rules / overturned）与 S1–S6 / L1–L3 冻结 | 试点仓（干跑已完成，见 §4b） | 正式化需 D5 / D6 |
| ② 数据规模 | 每条规则 S1 样本量 ≥ n、S2 独立判断者 ≥ k、S3 κ ≥ κ₀ 同时转绿 = 「可认定」 | 认定记录、统计列 | 转绿之前任何规则都只是候选；引导不得从候选规则派生 |
| ③ 上下文引导 + 提取分析 | 只有已认定且未过复审期（S5）的规则才派生 agent 指引；指引从冻结材料生成，带边界（R-T6）与复审期 | skills 条目 / `agent brief` 提示；提取分析报告 | 投放前后各量首验通过率，作为信号 |
| ④ 业务核算 | 每条已认定规则挂一条可结算的业务预期（预测条目 + 结算期），到期用真实业务数据结算；结算为假 → 推翻回流（B11） | 结算记录；推翻记录 | 闭环的终点是业务真值，不是人与人的一致 |

候选 **R-T7（新增，【O】）**：`已认定的品味规则必须有业务核算挂钩：taste_rules 中 settlement_ref 为空或 settled_at 晚于 review_by 的行必须为 0。` 判定面 M，`sql`；探针列 `settlement_ref`（预测台账条目 id）、`settled_at`、`settled_outcome`。现成机制可直接复用：研究管线的预测台账（`[预测·N天]` claim → `research predict list / audit` 结算日历，D2 的 `[品味·<域>]` 前缀与之同构）——把「采用规则 X 后 N 期内首验通过率 ≥ p / 返工率 ≤ q」登记成预测条目，到期以业务数据结算。

因此试点最小集（§5）每条都应补一行 agent 指引，例如 B1：「写数据来源列前，多成分一律用「+」并列，不用分号；理由：+ 表示成分加总，与账务来源 + 明细 sheet 的语义一致」；A4：「提交前写清为什么这样改、放弃了什么，改动文件 ≥ 3 时尤其不可省」。

## 8. 溯源与纪律

- 来源 A 的底本在用户侧（品味登记册），本表只转写高频面；来源 B 的案例数据与判断者身份按方案 §7 只用角色词。
- 本表每条都是【O】；进材料的顺序：属主裁定 D1–D6 → 评审席按方案 §6 复核 → 写入试点仓 `material.md` → `verify lint-candidates --text` / `tools/check-construction.mjs` → prepare 冻结。
- 本稿不开 PR、不改方案文档；采纳与否由属主与两评审席决定。
