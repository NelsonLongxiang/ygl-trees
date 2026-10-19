# M13 终审判定（评审线 · 2026-10-19）— 1e51a6d

评审对象：`1e51a6d`「M13-1 红队语料：构造期拒绝 + 边界/空转/重复键（G3 起点）」，在 `95c27b1`（N1/N2/N7/N8 守卫 + 七型 8 例）之上的补批。本文件同时收口前一轮 `direct-08e5cf5f`（95c27b1 终审）与 `direct-c9f00b52`（红队语料）两个任务。
方式：HEAD 实跑 + 语料逐例投影核验 + 守卫逐条对读 + 正则实证。

## 0. 结论

**PASS（准进轨 A / 轨 B）。** 15 例语料（七型 8 + 红队 7，其中 3 例 `expect_throw` 构造期拒绝）+ 20/20 实跑绿；`$` 守卫前移到 topoOrder 之前，错误面正确；`scope_sql` 三守卫、`$` 拒绝、`now()` 反例、注释剥离、尾部 `a/**` glob 均已落位。**R13 的 `now()` 漏网必须修**（见 S1，1 行修正 + 1 例语料，不阻塞轨 A 开工，冻结前必须闭合）。

## 1. 本轮核验（全部通过）

- HEAD `1e51a6d`，`packages/verify/core/tests` 实跑 **20 passed / 3 files / 731ms**。
- `corpus/cases` 15 个目录；`loadCases` 已按 `expected-report.json` 存在性分流（`run.ts:47,53`），`runThrowCase` 用 `meta.expect_throw` 正则匹配错误文案（`run.ts:94-107`），`runCorpus` 按 meta 分流（`run.ts:137`）。
- `runVerify` 入口先做 `$` 扫描再 `topoOrder`（`engine.ts:449-457` vs `:458`），红队 `throw-dollar-placeholder` 现在拿到契约里那条「not supported」而不是「unknown unit」。
- R13 守卫在 `runVerify` 入口（`engine.ts:462-470`）；`throw-time-function` 用 `CURRENT_TIMESTAMP`，命中 ✓。
- `scope_sql` 三守卫（行/列/非负整数，`engine.ts:114-132`）+ 无 WHERE 且无 scope_sql → ERROR（`:108-109`），与 §2.1 表一致。
- 语料覆盖：FAIL（sql 找违规/找缺失、sql-pair 容差）、PASS（boundary 容差边界、count、exists、file、command）、NEEDS-MATERIAL（错批次零扫描）、ERROR（agent 封包拒、无 WHERE、重复键 1:1），七型齐全，空转反例有锚点（`red-wrong-batch-zero-scan`）。

## 2. 残留项

### S1（冻结前必改）R13 正则漏 `now()`
- 实证：`/\b(now\s*\(|current_timestamp|current_date|current_time)\b/i` 对 `select now()` 判 **false**（尾部 `\b` 在 `(` 后无边界；`now(x)` 才有边界）；`current_timestamp`/`CURRENT_DATE` 判 true，`foo_now()` 判 false。
- 后果：审计最常见的写法 `now()` 不被拒绝，直接落库执行（SQLite 报 no such function → ERROR 而非构造期拒绝），与 md「非确定性时间函数构造期拒绝」不符；现语料只钉了 `CURRENT_TIMESTAMP`，测不出。
- 修法：`/(^|[^A-Za-z0-9_])(now|current_timestamp|current_date|current_time)\s*\(/i`（或枚举 `now\s*\(\s*\)` 备择分支），去掉对 `(` 的尾部 `\b`；补一例 `throw-now-function`（或把 throw-time-function 扩成两例），并对 `local_time`/`datetime(` 一并决定口径。

### S2（设计残留，轨 A 检查单）scope_sql 与 sql 的扫描面无法机械对账
- 守卫只证明「有 WHERE 或给了 scope_sql」，不证明两者过滤同一批。手工 spec 可写成 `scope_sql: count(*) where batch='2026-10'` 而 `sql: ... from t`（全表）——find-violation 方向会 FAIL（安全），**find-missing 方向会因全表行数 >0 而 PASS**（错批次冒充通过）。
- 建议：prepare 生成的 find-missing sql 必须与 scope_sql 同源过滤（同一 WHERE 模板）；或加红队例 `red-scope-mismatch`（scope_sql 带 batch、sql 不带 → 期望 NM/ERROR）。

### S3（语料门禁加固，G3/G4）
- `corpus.spec` 红队门禁只断言 `throws.length>=3` 且 `patterns.join("|")` 匹配三类之一；应逐例断言（3 例循环）、并单独断言 `red-*` 覆盖 ERROR 与 NEEDS-MATERIAL 两类运行时判定。
- 投影仍只比 overall/summary/verdict/witness；`exceptions[]`、`evidence.violations`、报告头（`attachments`/`as_of`）未钉——建议 G4 前补最小投影，防止错误面静默变化。

### S4 已挂账（与 N4–N6 一致，冻结前清）
- N4 JCS 子集（stableStringify 仅键排序，缺 NFC/数字定点/RFC3339）——Rust 双实现前必须共用 serializer，否则逐字 parity 必假。
- N5 R13 守卫位置（run 入口 → 拟 prepare）与注释内 `now` 误伤（守卫扫描含注释的整段 sql，建议先剥注释再判）。
- N6 `as_of` 只携带未强制（G2 负例）。

## 3. 下一步建议

- 轨 A（compare 七域矩阵）：每域正例 + 至少一负例（边界、NULL、币种最小单位、range 端点、window 时区），与 §2.1 表逐行对齐。
- 轨 B（prepare/自审链）：reviewRunner 接口先定「只拿材料 + VU 三问 + 锚点复读」的形态；接口草案过目后我再确认与 B6 验收契约（盲审/红队语料/异模型族）的映射。
- 冻结前的门禁清单：S1 修 + 语料；S2 红队例；S3 投影加固；N4/N5/N6 清账；随后 M13-1b Rust 七型 + 语料双实现逐字。
