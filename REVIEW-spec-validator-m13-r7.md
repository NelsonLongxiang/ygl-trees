# M13 评审 r7：4f4299c 复核 + de51446 + prepare 契约草案三问裁定

日期 2026-10-19 · 评审线 302cb119 · 对象：`4f4299c`（轨 B 首切 review 层契约 + W1/W2/W3/W6/W7 收口，30 例/28 测试）、`de51446`（混合币种拒绝例）、`tmp/prepare-contract-draft.md`（152 行草案 v0.1）。

## 1. 4f4299c 复核结论：PASS（有保留）

落地确认（逐条核过代码）：
- W1 部分修：`compare.ts:30` ISO_8601 正则；`compare.ts:20` `exactMinorUnits`（1e-6 分整数，浮点误差 0.1+0.2 不再静默相等）；`compare.ts:187` regex 长度 ≤200 硬拒；`engine.ts:555` 时间函数集合补 `'now'` 字面量（`datetime('now')` 已拦）；`docs/verify-contract.md:155` W7 盲区注记；`corpus.spec.ts` 门禁如实更名并断言 `-fail ≥ 2` + ERROR 形态例 ≥2。
- W2 修：`range` 模式末值开区间；`COMPARE_MODES` 形状互斥；`compare-boundary-inclusive` 例。
- 实测：`vitest run packages/verify/core/tests` 28/28，连跑 3 次稳定；31 个语料目录，`corpus.spec` 门禁通过。
- `sql-pair` 比较期错误 `catch → ERROR`（`engine.ts:247-254`）确认。

### W1b（阻塞）：ISO 正则仍收「无时区 datetime」，结论随时区漂移
`ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/` 的时间段与**时区段都可整体省略**。
- 实测：`"2026-07-01 10:00:00"`、`"2026-07-01T10:00:00"` 均通过正则；`Date.parse` 按**本机时区**解释——本机 UTC+8 下 `2026-07-01T10:00:00` → `1782871200000`（=02:00Z），而 `...Z` → `1782900000`（=10:00Z）。同一份材料/同一 spec，换时区跑出不同窗口，`as_of` 锚定失效。
- `compare.ts:35` 注释「非 ISO 或（无时区）一律不收」与实现不符（注释算错账）。
- 修：**时间部分出现时强制时区**（`Z` 或 `±hh:mm`）；纯日期保留（ES 规范按 UTC 解析，跨时区稳定）。补语料 `compare-window-no-tz`（期望 ERROR，标题写清「缺失时区 → ERROR，不按本地时区猜」）。

### W8–W15（不阻塞，冻结前清）
- **W8 锚点只防一半**：`engine.ts:410-413` 只判 `quote` 与 `locator` 非空；逐字复读是对**整篇** `materialsText`，不校验 quote 落在 locator 指向的 span 里 → Reviewer 可以指错格子而引文全文存在（B6 的「锚错格子」只防一半）。修：locator 格式校验 + 可解析时做 span 校验（prepare 有 material_index；run 期需要把 index 传进 `runVerify`，否则文档写明限制）。
- **W9 rubric 空集**：`pass_if: all` 且 rubric 为空 → `need=[]` → 免检；建议构造期拒绝 agent 单元 `rubric.length===0`（三问仍在，但检查点清单空=没有可验收面）。
- **W10 隐藏协议未进契约**：`rubric:<id>` 靠 `reason` 前缀映射（`engine.ts:422`），`docs/verify-contract.md` §4.5 表只写「rubric 检查点没有 ok findings 覆盖」，没定义前缀/字段 → 外部复核器无法实现。修：加 `ReviewFinding.checkpoint?: string` 字段（显式）或文档化 `reason` 前缀。
- **W11 verdict 未校验枚举**：`"ok"+"maybe"` 走 conflicting→NM（好），但全部 `"maybe"` 时既不 reject 也不 unclear，可落到 PASS；构造期校验三问 + `verdict ∈ {ok,reject,unclear}`。
- **W12 轮次**：`ReviewRequest.blind: true` 仅是类型声明；`≤3 轮` 由 prepare 保证（core 不管），文档写明。
- **W13 rubric 覆盖 fail-open**：`engine.ts:422` 的 `covered` 未过滤 `f.vu_id === vu.id`（`byQuestion` 在 `:385-390` 有过滤）；跨 VU 的 `ok` finding 可冒领检查点。修：加同一过滤（fail-closed 加固，低成本）。
- **W14 宽松处**：`range` 忽略 `currency`（`compare.ts:169-172` 走 `asNumber` 原值）；`validateCompareSpec` 不拒「tolerance 带 value_max」等多余键。非阻塞。
- **W15 materialsText 未绑定**：`runVerify` 收到的 `materialsText` 是普通字符串，未校验其 sha256 → 「冻结材料」在 run 期只靠调用方诚实。prepare P5 应把 `materials_sha256` 写进 spec，runVerify 在开 review 前复核（M13-2 前必须）。
- **W16 NFC 口径不一致**：草案 P0 承诺「只归一空白、NFC」，而 `engine.ts:433-437` `containsVerbatim` 只归一空白、不做 Unicode 归一 → 分解式重音引文会被判 FAIL，且 JS/Rust 双实现若各做一半，逐字门禁永久漂移。二选一：引擎加 `normalize("NFC")`（Rust 同位），或删草案 NFC 承诺。

### W3 文档核验（开发线称已写进契约，实为未落）
`docs/verify-contract.md` 全文无「分母 / 期望侧 / r=0」字样（grep 仅命中 summary 的「分母」）；`tolerance_rel` 的分母口径只存在于 `compare.ts` 实现。契约 §5.3 需补一句「分母=期望侧 |value|，为 0 时退化为绝对差（单位同值）」，否则 M13-1b Rust 双实现各自解释。

## 2. de51446：PASS
`mixed-currency-rejected` 例正确：金额列带 `'CNY 120.00'` → 比较期不隐式 FX → **ERROR**（`expected-report.json` overall ERROR、error:1、witness 1/0），case.json note 记录裁定理由（per-row 币种把归一推给 spec 作者且隐含 FX 快照语义；将来 FX 在 prepare 期显式归一列）。与草案 P4 红队第 4 条「金额带币种混排 → ERROR」一致。31 例 / 28 测试绿。

## 3. prepare 草案三问裁定

### 问 1：谓词 AST 表达力——不够，冻结前必须扩
.157 四类判据对照：**总额差**要聚合（sum）；**逐单差**要联表/键连接（sql-pair 侧可解，但 where 需表限定）；**批次覆盖**现有 where 足够；**附件齐全**走 file/exists，不占 AST。缺口四条：
1. **聚合**：`agg: {fn: count|sum|min|max, col?, as?}`（总额差 = `sum(amount_cents)` 双侧比）。
2. **全集 op + 值类型**：`=,!=,>,<,>=,<=,in,between,is_null,is_not_null`；值类型 `string|integer|decimal|date|iso_datetime`，渲染时按类型加引号/转义，构造期校验列类型与字面量匹配（错误列名、类型不符 → P2 ERROR）。
3. **布尔组合 + 表限定**：`AND/OR/NOT` 嵌套；`from` 支持 alias 与可选 `join[]`，`where.col` 用 `"bills.amount_cents"` 形式。
4. **canonical 渲染**：渲染出的 find/scope SQL 文本进 prepare 报告与 spec（审计可对质）；同一 AST 两段 SQL 共用一个渲染器（单测断言 find/scope 的 WHERE 子串逐字相同）。
不可表达形态 → **P2 直接 ERROR**，禁止回退手写 SQL。四类判据各补 1 例 P2 语料，附件齐全例走 file/exists + glob。

### 问 2：手写 SQL 豁免——首版彻底禁止（但语料不用改）
同意你倾向的「更严」：**prepare 只产 predicate**，`authored:"manual"` 在 prepare 阶段直接拒绝。但要澄清一点：**存量 30/31 例语料不需要 predicate 化**——它们是引擎契约语料（覆盖手写 sql + scope_sql 路径本身也是引擎能力），不是 prepare 产物；只加 2 例负例：`prepare rejects authored:manual`（期望 ERROR/NM，标题写清）。将来确有 manual 需求（第三方集成）再开 `--allow-manual-sql`（默认关）+ 报告「非机械生成清单」，M13-2 决策。

### 问 3：prepare 模型调用——注入 PrepareRunner
同意注入：`PrepareRunner.prepare({ materialText, materialIndex?, hint?, schemaProbe?, round }) → candidate units`，与 `ReviewRunner` 同形；gateway 凭证只活在 CLI 适配层（core 零凭证、可离线测试）；`prompt_version` 记入 `prepare_report`；P3 自审直接复用 `ReviewRunner`（`blind:true`），换模型族才有红队意义。

### 附：契约增补（冻结前，两条）
- **W15 材料绑定**：`spec.materials_sha256` + `runVerify` 复核 `materialsText` 哈希后才开 review（否则「冻结材料」名不副实）。
- **W16 NFC**：引擎 `containsVerbatim` 与 Rust 实现同做 NFC 归一，或草案删 NFC 承诺——两侧口径写进契约。

## 4. 闸门（修完后）
- W1b 修 + `compare-window-no-tz` 语料；W13 加 vu_id 过滤；W10 checkpoint 字段/文档；W11 枚举校验（低成本，一并做）。
- P2 语料：.157 四判据各 1 例 + `prepare-rejects-manual` 负例；`corpus.spec` 门禁保持。
- 契约补 W3 分母句、W15 材料哈希、W16 NFC（或删）。
- 之后准开 predicate 渲染器 + prepare 五阶段骨架实现。
