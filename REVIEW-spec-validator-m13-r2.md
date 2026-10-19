# M13 spec-validator 复核 r2（302cb119 · 2026-10-19）

对象：commit `bb08d8f`（`docs/spec-validator.md` 403 行、`docs/spec-validator.html`、`docs/plan.md` M13 段、`docs/verify-contract.md` v0.2）+ 契约类型骨架 `packages/verify/src/contract.ts`（只核形状，未审实现）。
结论：**PASS —— 开工放行**。B1/B3/B4/B5/B6 已正确落文，C4/C6/C7 到位；无复议。但 `contract_version: 1.0` 冻结前必须补 **R1–R4**（全在契约面，不推翻任何 B 项）；R5/R6 为表述与结转。

## 1. 逐项核对

| 项 | 判定 | 证据 |
|---|---|---|
| B1 判定聚合 + severity 权属 | ✅ | md:183-196（折叠规则 FAIL>NM>ERROR>PASS、overall+reason 出头、severity 构造期赋值/自审只上调/不改数学）；contract:91；演示 V3 改 FAIL、统计 2/4/1、V3 报告条目补齐 |
| B2 scope witness | ⚠️ 规则落文但一刀切（见 R1） | md:213-226；contract:92；contract.ts:156-162 |
| B3 外部锚链 | ✅ | md §8.5.1（build 登记 artifact kind=verify-binary / import 三项校验 / footer magic+offset+length+三段哈希 / build_sha256=H(engine‖spec) 防自指 / ed25519 可选 / tamper-evidence 与 tamper-proof 的诚实切分）；contract:132-143 |
| B4 两阶段冻结 + 附件 | ✅（表述有残留，见 R3） | md §8.5.1（基准 submit 冻结值+锚点+引文；提交物 run 时同字节 sha256 校验；content-addressed blob；第四类运行时输入=网关凭证）；contract:49-56 |
| B5 CompareSpec | ✅ | md:198-211（八模式/currency+scale 最小单位整数/基数默认 1:1 重复键 ERROR/null 默认 error/count-exists 业务数据源语义）；contract:49-56；contract.ts:16-32 |
| B6 自审可验收 | ✅ | md:112-117（锚点复读逐字引用；图片=裁剪区+OCR；盲审每轮新上下文；红队 ≥8 例 100% 拒绝；异模型族优先） |
| C4 agent 型封包 | ✅ | md §8.5.1「封包×agent」段（默认 fact-only、`--with-review` 才放开、凭证运行时传入不入库、self-check 明示限制） |
| C6/C7 文档一致性 | ✅ | `docs/plan.md` M13 段重写（无 表单编辑器/确认视图/六端点/NEEDS-HUMAN 残留）；html 页首横幅 + Rust chip + 「run 零模型」修正 + 裁决/V3 修正 |
| 契约 v0.2 | ✅ 基本齐 | 三 JSON 形状、七型标签联合、corpus 目录与 parity/矩阵/红队门禁、冻结条件三条 |

## 2. 冻结前必补（R1–R4）

**R1（B2 精度，必须）witness 语义按类型定义，删掉 schema 里不存在的「期望非空」条件。**
现行规则（md:223-224 / contract:92）是**一刀切**：「`rows_scanned=0` → NM；期望非空而 `rows_matched=0` → NM」。但 `contract.ts` 的检查器已各自携带真值语义——`SqlChecker.expect/fail_when`（`rows>0`=找违规：matched=0 应 PASS；`rows==0`=找缺失：matched=0 应 FAIL，contract.ts:34-41）、`ExistsChecker.expect`（expect=true：matched=0 应 FAIL，contract.ts:62-66）、`FileChecker.min/require`（缺文件是 FAIL 还是 NM 未定，contract.ts:68-78）。一刀切会把「存在性/缺失类」判据从 FAIL 翻成 NM，把「无违规」类从 PASS 翻成 NM——恰好毁掉 B2 要保的真值。
修法：契约加 witness 语义表（每型：`scanned` 口径 / `matched` 口径 / 空范围判定 / 零匹配判定），判定条件引用 schema 内字段（`expect`/`fail_when`/`op`/`expect(bool)`/`min`/`require`），禁止使用「期望非空」这类未定义谓词；G2 边界语料按该表写 `expected-report.json`。

**R2（形状缺口，必须）count 的上游集合源无可表达形状。**
md:173/176 声明 count 的集合源可引用 `$Vx.out`（管线示例 V3 就是 `$V2.violations == 0`），但 `CountChecker`（contract.ts:54-60）= `{sql, op, value}`，无 `from`；契约亦未定义 sql 模板里 `$Vx.rows` 的绑定语法（临时表 / 参数化 IN / 子查询）。二选一：①加 `from`（rowset 引用），定义 `scanned`=上游行数、`matched`=计数；②在契约 §1 写明 sql 字符串占位语法与绑定规则。`exists` 若同样支持上游输入，同规。冻结条件②「七型 checker 形状齐」在此条闭合前不成立。

**R3（残留表述，必须）附件仍写成 source。**
md:55、md:253、md:254、md:263（§7）仍写「附件注册为 source（file://）」「附件 source id 快照」，与 §8.5.1（content-addressed blob / attachments 表）及 `AttachmentRef`（contract.ts:128-134）冲突。统一为 attachments 语义，并在契约里定死 `sources` 增列 vs 新表（九触点）二选一——这决定 §7 API 与 schema v13。

**R4（类型强制，必须）** `VuResult.witness?` 可选（contract.ts:170）而规则写「每个 fact checker 必须输出」——类型不强制=漏输出可静默通过。按 role/checker 判别联合把 fact 型 witness 设必填。

**R5（表述）** source「恒 PASS-by-construction（取数失败才是 ERROR）」（md:154/179；contract:49）自相矛盾——改为「source 不参与判定折叠；执行失败=ERROR 并级联」。

**R6（结转，非冻结前置）** C1 clause inventory 未进契约（md:120 仍是 per-source_clause 覆盖）；C3 PG 只读事务/只读账号未进文档（md:311/334 仍把「只读前缀门」当结构保证）；C6 的 md 侧缺口（七域定义/代码落点/测试金字塔目前只在 HTML）；C5 平台矩阵待 M13-1b。

## 3. 放行意见

B 项闭环、无复议。开工序按 plan.md（契约冻结 1.0 → fact 引擎+空洞防护 → prepare → 管线拓扑 → .157 端到端 → 封包器前置）。**R1/R2 必须在契约冻结前落**——它们决定 corpus 的 `expected-report.json` 形状，先冻会返工；R3/R4 与 R1/R2 同提交；R5/R6 随首批。开工后可先做与 R1/R2 无关的部分（spec 校验器、CompareSpec 单测、corpus 布局），不空转。
