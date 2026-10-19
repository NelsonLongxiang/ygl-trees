# M13 复核 r10：d452a65（E1–E5 + 拍板）与 0c03d01（语料冻结）

评审对象：`d452a65`（r9 E1–E5 修复 + JCS canonical + prepare P0–P5 入契约）、`0c03d01`（语料冻结清单 + 守卫）。实跑 `vitest run packages/verify/core/tests`：**79/79 passed**（8 files），0c03d01 后仍绿。
结论：**PASS**。r9 三条实证均已实修，拍板 5 条件按文档落位；语料冻结守卫成立。残留 F1–F6 按下列等级处置（F1/F2 契约冻结前修，其余随批）。

## 1. 复核通过项（逐条实证）

| # | r9 要求 | 落位与实证 |
|---|---|---|
| E1 | sql-pair 谓词侧键错位 | engine `readSide` 谓词分支返回 `{[kName]: kName, value: rows[0][alias]}`，与 `sideKey/sideVal` 同口径；新增同族守卫（谓词×行集 → ERROR）。probe：`PAIR` 例 key=`total` 与行集侧 `"total"` 相等，未修前为 `"undefined"`。 |
| E2 | sql/agg 恒判、count/exists 静默丢 agg | `sql` 型谓词 agg 非空 → ERROR；`count`/`exists` 谓词 agg 非空 → ERROR。probe：`AGG-SQL` → ERROR（未修前 FAIL）。 |
| E3 | 空批聚合对冒充 PASS | 谓词侧先 `renderPredicate(pred).scopeSql` 计 scope；n=0 → NEEDS-MATERIAL witness(0,0)。probe：`EMPTY-PAIR` → `NEEDS-MATERIAL` witness `(0,0)`。契约 §2.1 新增「聚合对」注。 |
| E4 | ±hh 偏移归一 + 单一定义 | compare 导出 `ISO_DATETIME_TZ(Z｜[+-]\d{2}(?::?\d{2})?)` + `withOffsetMinutes(+08→+08:00)`；engine 删本地 ISO_OFFSET 改用导入版。probe：`PLUS08` → PASS（未修前 ERROR）。 |
| E5 | prepare P2 白名单/schema/`$vu:` | `checkPredicateSchema` 抽公共助手（sql/sql-pair/count/exists 共用）；拒 count/exists 的 sql 形态；`$vu:` 收窄；`requires_execution` 只属 agent；P4 未注入或失败 → error 且 spec 省略；无 reviewer → error。 |
| 拍板 | 5 条件 | docs §1.6 P0–P5 规则表（每阶段门 + 失败后果 + verdict 三态归因）落位；P3 上限 3 轮 + 可冻即收敛；P5 as_of/spec_version/版本/attachments 映射（sha256+size）落位。 |
| N4 | JCS canonical | `canonical.ts`（键排序/ES 数字/时间/UFC-16 键序/undefined 语义）+ `corpus/canonical/vectors.json` 12 条（含 unicode-nfc、1e+21/1e-7、2^53 边界）+ payloadHash 改 canonicalStringify。 |
| 冻结 | 语料只增不改 | `freeze.mjs`（逐文件 sha256 + 聚合 digest，`--write` 才改写）+ `manifest.json` + `corpus-freeze.spec`（entries+digest 全等，>100 断言）。manifest 129 文件（cases + vectors.json）。 |

## 2. 残留（按处置等级）

**F1（契约冻结前修，一行）** `prepare.ts:195`：sql 型谓词分支的 `$` 守卫仍是 `includes("$")`，只把 count/exists（:238）收窄成 `$vu:`。后果：合法字面量（如 `where note = '$50'`）在 sql 单元仍被 P2 误拒，与引擎/契约「`$vu:` 只允许在 count.from 与 sql-pair 侧」不一致。修：:195 改 `$vu:`，补一条 sql 单元 `$50` ready 用例。

**F2（契约冻结前修，一行）** `compare.ts:46-52` `toEpochMs` 未走 `withOffsetMinutes`：`ISO_DATETIME_TZ` 现在收 `+08`，但 `Date.parse("+08")=NaN` → window 比较返回 ERROR（实测 `WIN-OFFSET` error，`WIN-0800` equal）。与 E4「单一定义」目标不符；PG 值若是 `+08` 形态窗口比较会直接 ERROR。修：`const ms = Date.parse(withOffsetMinutes(t))`；补 `+08` 窗口把正例。

**F3（契约口径，冻结前明确）** `prepare.ts:251-255` 只在 `requires_execution === false` 时拒 agent（undefined 放行）；`prepare.ts:420` `sealed: { review: true }` 硬编码，与 docs:63「默认 false；`--with-review` 置 true」及候选注释「默认拒绝」矛盾。M13-1 是 fact-only 封包，建议 P2 直接拒 agent（或要求 `requires_execution:true` 才放行，且 `sealed.review = 含 agent 单元`）。

**F4（文档同步）** `docs/verify-contract.md:174` 规范化 bullet 仍写「数字只允许安全整数与定点小数（禁 NaN/Infinity/科学计数法输出差异）」，但 canonical/vectors 明确输出 ECMAScript 形态（`1e+21`、`1e-7`，2^53 边界向量）。改文案为「任意有限数按 ECMAScript Number::toString；禁 NaN/Infinity」，并把「NFC 归一 + undefined 省略」标为相对 RFC 8785 的**有意偏离**（Rust 侧必须照做，不是标准 JCS）。

**F5（尾项/CHANGELOG）** `prepare.ts:416` `as_of` 缺省回退 `now()`（拍板说由调用方给快照口径）；`prepare.ts:419` attachments 依赖 `materialIndex`，缺省时为空——P5 的「附件映射」在调用方不传 index 时静默不成立。建议 `asOf` 必填或记 diagnostic；`ready` 需要 materialIndex（或至少 diagnostic + 报告标注）。（`spec_version` 缺省 1 不递增已文档化为调用方责任，不另记。）

**F6（尾项）** `canonicalStringify(Date)` 输出 `"{}"`（Date 是对象但无 own enumerable keys）——建议拒绝非纯对象（Date/Map/Set），或文档写明入参必须是 JSON 数据模型；CANONICAL 的 Rust 侧实现同口径。

## 3. 冻结核验（0c03d01）

- `freeze.mjs`：walk cases + vectors.json，逐文件 sha256，`path:sha256` 换行 join 后聚合 digest；`--write` 才改写 manifest，非 write 模式 drift 时点名 added/changed/removed 并 rc=1。纪律正确（只增不改、升 corpus_version 才重写）。
- `corpus-freeze.spec.ts`：entries 全等 + digest 全等 + entries>100，97 行无绕过；`manifest.json` 129 文件、corpus_version "1"。
- 影响面：语料 4 个 window 例（pass/fail/non-iso/no-tz）均不含 `+08` 值，**F2 不影响已冻结期望**，corpus_version 1 可维持（F2 修完需补的 `+08` 窗口例是**新增**，符合只增不改）。
- 措辞：commit message「128 例文件」与 manifest 129（含 vectors.json）差 1，建议口径统一（trivial）。

## 4. 闸门建议

- 契约冻结前：F1、F2、F3（口径决定）、F4（文档）→ 单提交。
- 之后：F5/F6 进 CHANGELOG 尾项；corpus_version 1 不动。
- 下一步 verify 命令面（list/submit/prepare/run/report/trace/export）开工不受 F 项阻塞，但 prepare 的 `--json` 通道要按 §1.6 的 verdict 三态归因（needs-material/error/ready）分流，不要靠 diagnostics 猜。
