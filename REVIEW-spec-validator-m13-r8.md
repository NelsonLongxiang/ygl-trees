# M13 评审 r8：c96ac68（谓词 AST + W1b + W8–W16）复核

日期 2026-10-19 · 评审线 302cb119 · 对象：`c96ac68`（32 例 / 42 测试 / gate 10/10 / tsc 干净，开发线自报）。

## 0. 结论

**PASS（有保留）。** W1b 修复与 W9/W10/W11/W13/W15/W16 全部核实落地，测试 42/42 实跑通过；`renderPredicate` 的标识符守门、字面量转义、find/scope 同 WHERE、rendered SQL 进 evidence 均验证。但发现 **F1 阻塞（先于 prepare P2 修）**：agg 目前是死特性——有渲染、无消费方，且渲染形状在 PG 上非法、无法表达 .157「总额差」。F2 为谓词覆盖缺口（exists/count 无机械形态）。F3–F5 为形状收紧项。

## 1. F1（阻塞）：agg 没有消费方，且渲染出 PG 非法形状

**事实链**（逐行核过）：
- `contract.ts:62-77`：`agg` 只挂在 `Predicate` 上，而 `Predicate` 只属于 `PredicateChecker`（`type:"sql"`，`:102-109`）；`SqlPairChecker` 的 `PairSide`（`:112-115`）是 `{from|table, key, value}`，无 agg/predicate；predicate 的 `from` 只允许单个裸标识符（`engine.ts` `ident`），**无 join/子查询**。
- `engine.ts:141-172`（谓词执行）：结论只看 `findRows.length`（`fail_when: rows>0` → 有行即 FAIL；`rows==0` → 无行即 FAIL），**agg 渲染出的值从头到尾没被读取或比较**。
- 推论：**「总额差 ≤1」（双方 SUM 差）不可表达**——sql 型不比数值，sql-pair 型不能聚合，predicate 不能跨表。开发线 commit message「agg 别名（总额差双侧 sum 可表达）」与 r7 我的「扩 agg 即可」都不成立，需在此更正。
- **PG 非法形状**：`renderPredicate` 把 `select` 与 `agg` 直接拼接（`engine.ts:664-668`），且 `select` 强制非空（`:647-649`）。于是 `select:["batch"] + agg:[SUM]` 渲染成 `SELECT batch, SUM(amount_cents) AS total …` **无 GROUP BY**：SQLite 容忍（返回任意一行 batch），PostgreSQL 直接报 "column must appear in the GROUP BY clause"。`docs/verify-contract.md` §1.5 的示例、`tests/predicate.spec.ts:99-108` 的断言都固化了这个形状——目标含 PG（.157/Odoo），prepare 机械产出在 PG 上必然 ERROR。
- 反向缺口：`select` 强制非空 ⇒ 连 `SELECT SUM(…)`（纯聚合，总额差真正需要的形状）都渲染不出来。

**修法（闭集内，成本低）**：
1. `sql-pair` 的 `PairSide` 增加 `{ predicate: Predicate; key?: string }` 形态，值列 = agg 别名（总额差用常量 key，如 `"total"`），比较走现有 `CompareSpec`（含 `tolerance_abs`）——七型闭集不变。
2. agg 存在时：允许 `select: []`（纯聚合）；**禁止**纯列与 agg 混排（AST 无 GROUP BY，PG 不接受），混排 → 构造期 ERROR。
3. agg 别名唯一性校验：重复 alias（含自动名 `fn_col` 撞名，如 `count(*)` 与 `count(col="all")` 都得 `count_all`）→ ERROR。
4. 语言测试补引擎行为（不止字符串快照）：纯聚合渲染、聚合比较 PASS/FAIL、混排被拒。

## 2. F2（阻塞 prepare P2，低修成本）：谓词覆盖不全，但文档称「唯一取数形态」

- `exists` 只有 `{sql, expect}`（`contract.ts` ExistsChecker）——手写 SQL 形态；prepare 严格禁手写 SQL 时 **exists 无法机械生成**，而 .157「附件齐全」类判据与记录存在性都要它。
- `count` 的机械形态只有 `from: "$vu:Vx"`（上游行集）；独立「带过滤的计数」（如批次应到 3 单）只能走 `count.sql` 手写。
- 文档 §1.5 标题「机械生成的唯一取数形态」与实现不符；开发线上一条消息亦称「sql / sql-pair → predicate」。
- 修：`exists`/`count` 都接受 `predicate`（渲染器现成：`SELECT 1 … LIMIT 1` / `SELECT count(*) …`），或文档明确「exists/count 的机械形态由 prepare 生成方式另行约束」并给 P2 形状。建议直接扩，成本低且堵住「prepare 不得不手写」的例外。

## 3. F3（形状收紧，建议随 F1 一起）

- `in`/`between` 数组元素**未校验同型**：`in: [1, "2"]` 渲染 `IN (1, '2')`——SQLite 按类型序比较、PG 直接类型错误；`between` 同理。修：元素必须全 number 或全 string，number 需有限，禁 null/undefined。
- `is null` / `is not null` 携带 `value` 时被静默忽略（`renderCondition` 不读 value）→ 构造期拒绝多余值。
- `between` 闭区间语义请写进 §1.5（SQL BETWEEN 含两端；SQLite 对文本按字典序，见 F5）。

## 4. F4（文档/兼容）：时区格式只收 Z 或 ±hh:mm

`ISO_DATETIME_TZ = /…(?:Z|[+-]\d{2}:\d{2})$/` 拒收 `+08`、`+0800`、`+08:00:00`（PostgreSQL 常见文本输出形态）。要么文档写明「材料里的时间字面量必须先规范化到 Z/±hh:mm」，要么放宽到 `[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?`。W1b 的语义修复本身正确（无时区 → ERROR）。

## 5. F5（prepare 侧纪律）：带偏移的日期字面量在 SQLite 上按字符串比较

SQLite 把 ISO 文本当字符串；`BETWEEN '2026-07-01T10:00:00+08:00' AND …` 的字典序与时间序**不等价**（`+08:00` 与 `Z` 混排会翻车）。prepare 生成日期字面量时应统一规范化为 UTC `…Z`（或要求日期列只放 `YYYY-MM-DD`），并写进 §1.5；Rust 双实现同口径。

## 6. 已核实通过项

- W1b：`ISO_DATE_ONLY` + `ISO_DATETIME_TZ` 拆分（`compare.ts:32-33`），`'2026-07-01 10:00:00'` 构造期 ERROR，`compare-window-no-tz` 语料钉住。
- W9 空 rubric → NEEDS-MATERIAL（`engine.ts:499-502`）；W10 `checkpoint?` 字段优先、reason 前缀兼容（`:513-517`）；W11 未知 verdict → ERROR（`:459-462`，且在校验 vu_id 过滤之前，fail-closed）；W13 覆盖集只认本 VU（`:515`）；W15 `materials_sha256` 开 review 前复核（`:424-431`）；W16 `containsVerbatim` NFC + 空白折叠（`:523`）。
- 谓词引擎路径：找违规无 where → ERROR（`:137-139`）；scope 单行单列非负整数（`:157-163`）；零扫描 → NEEDS-MATERIAL（`:165`）；rendered find/scope 进 evidence（`:168,172`）；标识符守门与 `''` 转义（`predicate.spec` 覆盖）。
- 实测：`vitest run packages/verify/core/tests` 42/42（4 files）。`gate 10/10` 与 `tsc` 干净我未复跑（此包只跑单测）。
