# M13 复核 r24：0.102.4（`83b2ed1` / `v0.102.4`）

评审对象：r23 的 1 P2 + P3×5 在 0.102.4 的落点；开发线点名两问（严格 ISO 接受面是否还有漏、跨进程原子占位是否要补测试）。
评审方式：HEAD diff 逐段读 + dist 级探针（`normalizeAsOf` 27 例矩阵、双进程 `writePrepareRecord` 并发）+ 全量门禁实跑 + 发布物核验。
结论：**PASS**（r23 六条全部收口且可实证），无阻塞项；留 **P4×3**（文档 basename/基准措辞、HTTP body `record` 基准未写、小数秒截断未写）。两问答案见 §3。

## 0. 实测事实

- 发布物：`83b2ed1` / tag `v0.102.4`；npm 0.102.4（tarball 实测 **1,283,911 B**，fileCount 153）；Gitee release id **1220745**「v0.102.4 r23 收口：as_of 严格 ISO + attempts 原子占位」，assets zip/tar.gz。
- 门禁实跑：unit **463/463（70 文件）**、contract **100/100**、demo rc=0、readme **54/54**；工作树干净。
- 文档/技能：`docs/verify-contract.md` §4.7、CHANGELOG 0.102.4、plan 0.102.4 记录、`skills/ygl-trees-verify`（version 0.102.4 + 两条坑）、llms.txt v0.102.4、`docs/reviews/README.md` 索引行「→ 0.102.4 已收口」均在；r23 报告已入库。

## 1. r23 六条落点复核（全部通过）

1. **P2 文档形状**：§4.7 示例改为 `[{source_clause, findings}]`，注明 `source_clause` 逐字对齐、`vu_id` 由 prepare 生成；CLI 正向回归 `verify-cli.spec.ts:253`「照文档 → ready rc=0、`record === ["specs", spec_id, "prepare.json"].join("/")`、三文件落盘 + 旧嵌套形状 → 非 ready」。实测 `--draft --json` 仍回 `record: null`，形状稳定。
2. **as_of 严格 ISO**：`normalizeAsOf` 改为正则 + 逐字段日历回验（`AS_OF_DATE`/`AS_OF_DATETIME`/`calendarOk`），不再信任 `Date.parse`。
3. **校验次序**：`prepareViaHttp` 的 as_of 校验提到 `candidates` 检查之前、`findMaterial`/`snapshotPath`/`schemaOf` 之前（`verify-jobs.ts` diff）；单测 `verify-jobs.spec.ts:238`「缺材料 + 非法 as_of → 400 而非 404」。
4. **原子占位**：`writePrepareRecord` 用 `writeFileSync(…,{flag:"wx"})` + EEXIST 续号（`-2`/`-3`），删掉 `existsSync` 预检；同毫秒三连测试在 `as-of.spec.ts:92`（首个 + `-2` + `-3`，内容互不覆盖）。
5. **措辞**：撤掉「不可变」，改为「成功以最后一次成功为准、失败的补跑不得冲掉上一轮成功记录」；`prepare.json` 可被后续成功覆盖、`attempts` 只追加——实测与文档一致。
6. **±hh 一致性说明**：§4.7 明示 as_of 比引擎 `ISO_DATETIME_TZ` 更严（拒空格）是有意为之，避免后人当漂移去「修」。

## 2. dist 级探针（`tmp/r24-probe.cjs`）

**`normalizeAsOf` 27 例矩阵**（全部与预期一致）：

- 接受：`2026-10-20`→`2026-10-20T00:00:00.000Z`；`2024-02-29`；`9999-12-31`；`…T10:00:00Z`；`…T10:00Z`（无秒）；`+08:00`/`+0800`/`+08` 三种偏移都归一 UTC；`-00:00`；`.123456789`→`.123Z`（截断）；`.5`→`.500Z`；首尾空白被 trim；`undefined/null/""` → fallback。
- 拒绝：`2026-02-29`（非闰年）、`2026-02-30`、`2026-13-01`、`0000-01-01`；无时区 datetime；空格分隔；`Jan 1 2026`；`+08:0`（分钟不齐）；`24:00:00`；`23:59:60`（闰秒）；`+08:00:00`；小写 `t`/`z`。
- 观察（非缺陷，见 §3-Q1）：`+15:00` 被接受（≤23 小时；RFC 3339 允许 00–23，若按常见 ±14:00 收紧可改）；`+08` 与引擎同口径 ✓。

**双进程并发**：两个 `node` 进程同时 `writePrepareRecord(dir,false,{who:A/B},"2026-10-20T10:00:00.000Z")` → A 拿 `…000Z.json`、B 拿 `…000Z-2.json`，两份内容各自完整（`who` 未串）。`O_EXCL` 保证成立。

## 3. 两问回答

### Q1 严格 ISO 的接受面还有漏吗？

**没有发现「该拒而放行」的类别漏洞**——r23 实测的两个洞（无时区按本机解释、非法日历静默滚动）都被堵住。剩下的是**刻意宽容的三个边界**，需要你拍板取舍（都建议保留或加一句文档）：

1. **纯日期**：接受（UTC 00:00）是约定，不是推导。我判**保留**——日粒度锚（如「截至 2026-10-20 的快照」）是真实需求，UTC 00:00 确定性强，且已在 §4.7 写明。若改成拒，用户会被迫写一串零，收益为零。
2. **小数秒 >3 位**：接受 1–9 位但**静默截断到毫秒**（`.123456789`→`.123Z`，锚点最多偏 0.999ms）。两种都行：①文档补一句「亚毫秒位按毫秒截断存储」；②收紧到 1–3 位（>3 位直接拒）。我倾向①（ISO 允许任意精度，Date 只能存 ms，截断是确定性的），但需写明，否则审计时对不上原文。
3. **首尾空白 trim / 偏移上界 ±23:59**：trim 是便利（也可去掉换严格）；`+15:00` 在 RFC 3339 合法但超出常见 ±14:00 实践。建议 §4.7 一句「首尾空白忽略；偏移按 RFC 3339 允许 00–23 小时」即可，不必改代码。

另可考虑在 §4.7 补一句「拒绝小写 `t`/`z`、闰秒 `:60`、基本格式 `20261020T100000Z`」——这些是严格化的有意选择，写清以免被当成漏。

### Q2 要不要补双进程探针固化成测试？

**不需要进 CI。**理由：EEXIST 续号分支与进程数无关，`as-of.spec.ts:92` 的「同毫秒三连写」已经确定性地覆盖了这条分支（首个 → `-2` → `-3`，内容互不覆盖）；再加子进程测试只会引入 flake 面。本轮的临时双进程探针（`tmp/r24-probe.cjs`）已经确认跨进程行为（A/B 各得一个文件、内容完整），保不保留它作为开发笔记即可。唯一没覆盖的是**1000 次同毫秒碰撞后的抛错路径**（`cannot allocate an attempts record`）——不值得为它造 1000 个文件，留给代码注释或人工演练即可。若真想加保险，一行注释说明「原子性由 `O_EXCL` 保证，跨进程同毫秒也只会有一个写者拿到同一路径」比测试更有价值。

## 4. P4（文档微调，非阻塞）

- §4.7 第 302 行「`file` 是 `attempts/` 目录内的 basename（`attempts/x.json`）」——basename 是 `x.json`，括号里混入了目录前缀（实现 `verify-web.ts:133-140` 用 `readdirSync` 的条目名，确实是纯 basename）。建议改成「`file` 是 attempts 目录内的文件名（如 `x.json`），不含 `attempts/` 前缀」。
- HTTP `POST /api/verify/prepare` 响应里的 `record` 是**相对 spec 目录**（`prepare.json` / `attempts/x.json`，`verify-jobs.ts:155`），与 CLI 的「相对 verify 根」不同，§4.7 只写了 CLI 与投影两种基准，建议把第三种也列上，或统一。
- 文档写「1–9 位小数秒」但没写「截断到毫秒」（见 Q1-2）。

## 5. 证据

- 探针：`tmp/r24-probe.cjs`（27 例矩阵 + 双进程原子占位）、`tmp/r24-tarball.tgz`（1,283,911 B）。
- 门禁：`tmp/r24-unit.log`（70 文件 463 例）、`tmp/r24-contract.log`、`tmp/r24-demo.log`、`tmp/r24-readme.log`。
- 源码：`packages/ops/tools/src/verify-cmds.ts`（`writePrepareRecord`、`normalizeAsOf`、`calendarOk`、`AS_OF_DATE`/`AS_OF_DATETIME`）、`packages/ops/tools/src/verify-jobs.ts`（as_of 提前）、`packages/ops/tools/tests/{as-of,verify-cli,verify-jobs}.spec.ts`、`docs/verify-contract.md` §4.7。
