# M13 评审 r6（评审线 · 2026-10-19）— b1f314d / 8fe4d86 / aa00000

本文件收口两个任务：`direct-96d51dfb`（r5 四项残留 S1–S4 处理）与 `direct-cefbc86d`（轨 A compare 八 mode 矩阵）。评审对象：`b1f314d`（S1/S2/N6 守卫 + 红队 3 例，18 例/21 测试）、`8fe4d86`（P2 五件套 gate 10/10）、`aa00000`（轨 A 27 例/22 测试）。

## 0. 结论

**PASS ×2。** r5 的 S1（`now()` 漏判）、S2（scope 只证明有过滤）、N6（as_of 未强制）、S3（语料门禁）均已按约落位并可复现；轨 A 的八 mode 语料矩阵与两处语义修正（window 真换算、tolerance_rel ε>0）成立。冻结前仍需处理 W1/W2（时间解析与货币舍入的静默语义），W3–W7 随轨 A/B 收口。

## 1. r5 残留核验（b1f314d / 8fe4d86）

- **S1 ✓** 新正则 `/(^|[^A-Za-z0-9_])(now\s*\(|(current_timestamp|current_date|current_time)(?![A-Za-z0-9_]))/i`（engine.ts:470）实测：`now()`/`now ( )`/`NOW()`/`now(x)` 命中；`foo_now()`、`current_timestamp_utc` 不误伤；`current_timestamp`/`CURRENT_DATE` 命中；`throw-now-function` 例（sql 里 `created_at = now()`）在 6 条 throw 门禁中逐例断言文案。注释内 `now` 不误伤（先剥注释再测，N5 的一半）。
- **S2 ✓** 构造期守卫（engine.ts:485-494）：scope_sql 与 sql 的表集合完全不相交 → ERROR，文案 `no shared table means the "batch" is not the one being checked`；`red-scope-mismatch`（sql 读 invoice_lines、scope_sql 读 invoices）命中。判据用「不相交」而非「缺一张」是对的（scope 表通常是 sql 表之一）。
- **N6 部分 ✓**（engine.ts:477-482）：`vu.expected_from.as_of` 存在但既无 scope_sql 也无 `AS OF` 子句 → ERROR；`throw-as-of-unanchored` 命中。注意范围仍是「unit 级 expected_from.as_of」，spec 级 `as_of` 依旧只进报告头——与 N6 原意（所有时间窗口锚定 as_of）相比是缩小版，可接受，但别在 md 写成「as_of 已强制」。
- **S3 ✓** corpus.spec 现为 5 测试：七型覆盖；compare 矩阵（八 mode 全覆盖、案例 ≥25、`-fail` ≥2）；throw 逐例断言 6 条文案（no assert/time function/not supported/as_of/not the one being checked）；red-* 分别钉 ERROR（vacuous、duplicate-key）/NEEDS-MATERIAL（wrong-batch）；逐例投影一致。
- **S4 余项**：JCS（N4）仍挂账（dev 确认随 G4）；R13 位置仍在 run 入口（等轨 B prepare）；as_of 见 N6 部分。

## 2. 轨 A 核验（aa00000）

- 实测 `packages/verify/core/tests` **22/22 绿 ×3 连续**（3 files，约 2.5s）；`corpus/cases` 27 目录；`meta.mode` 覆盖 exact/tolerance_abs/tolerance_rel/window/subset/superset/range/regex 八 mode（tolerance_abs 由 `sql-pair-tolerance` 的 meta 补齐）。
- `compare.ts` 读后确认：range 端点含边界、lo/hi 归一；NULL 默认 error（两侧全 NULL=同构相等）；currency+scale 一律化最小单位整数；tolerance_abs 在货币域把 ε 也换算成分；tolerance_rel 分母取右侧（期望侧）；window 用 unitMs 真换算（d/h/s）且数字不当日期；subset/superset 按集合、regex 用右侧作 pattern。`validateCompareSpec` 的 A7 单形状口径（exact 无 ε、ε>0、unit 只属 window）与 R7 一致。
- 语义修正与 dev 描述一致：window 旧实现退化为数值容差已不存在；tolerance_rel ε≥0 收紧为 >0。
- 评审过程中曾见中间态红（`compare mode without corpus case: tolerance_abs`，当时 aa00000 未提交、meta 正在补），提交后重跑稳定——非 flake，属编辑期状态。

## 3. 残留项

### W1（冻结前必改）window「只认 ISO」名不副实
- `toEpochMs` 用 `Date.parse`（compare.ts:16-23）：`"2026/07/01"`、`"07/01/2026"`、`"2026-07-01 10:00:00"`（无时区按本地时区解释）都能过；同一 spec 在不同时区机器上可能得到不同判决——与「只认 ISO 字符串」的注释和逐字重放目标冲突。
- 修法：先过严格 ISO 校验（`/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/`，无时区一律拒绝或按 UTC 显式约定），再 `Date.parse`；补一例非 ISO 日期负例。

### W2（冻结前必改）exact + currency 静默四舍五入
- `toMinorUnits` 用 `Math.round(v*10^scale)`（compare.ts:26-37）：`1290.404` 与 `1290.40` 都化到 129040 → **exact 判 PASS，实际差 0.4 分**，与「不差一分」类判据矛盾。
- 修法：exact 域要求数值可被 scale 精确表示（`Math.abs(v*10^scale - Math.round(...)) < 1e-9`，否则 ERROR「amount has more precision than scale」）；tolerance_abs 可保留舍入（ε 已吸收），但需在契约写明。

### W3 tolerance_rel 分母口径未入契约
- 代码固定 `|l-r|/|r|`（右=期望侧），`r=0` 时退化为 `l===0`。契约/md 未钉分母定义，边界（0 基、负值、l/r 方向）无语料。建议 md 写明「分母=期望值绝对值；0 基时仅 0 通过」，补 0 基与负值两例。

### W4 regex 无界回溯风险
- 右侧 pattern 来自 spec（agent 生成），`new RegExp(rs).test(ls)` 无长度/复杂度上限，灾难性回溯（如 `(a+)+$`）可挂住验证进程。建议限制 pattern 长度 + 输入长度，或换 RE2 类线性实现；至少加超时/工作量防护。

### W5 compare 矩阵门禁名不副实
- 「正负例成对」只断言 `-fail` ≥2；实际只有 window、tolerance_rel 各有负例，exact/range/subset/superset/regex/tolerance_abs 无负例。要么每 mode 补一负例（推荐，G2 本来就要边界负例），要么把测试名/门禁改成「八 mode 覆盖 + ≥2 负例」。

### W6 R13 仍漏 `datetime('now')`
- 新正则不匹配 `datetime('now')`/`strftime(...,'now')`（引号内 now 后不是 `(`）；SQLite/PG 这些都是非确定性时间源。补 `datetime\s*\(\s*'now'` 与 `'now'\s*\)` 之类备择，或把「时间函数」口径扩成「任何 now 字面量/时间函数白名单外出现」。

### W7 scope 守卫的表提取盲区
- `extractTables` 只认 FROM/JOIN 后的裸标识符；scope_sql 若写成 `select count(*) from (select ...) x` 或 CTE，两侧表集为空 → 守卫静默跳过（不误报，但也不设防）。可接受为「尽力而为」，在契约注明探测不到时的行为。

## 4. 下一步

- 冻结前：W1、W2 修 + 语料；W5 补负例；W6 补 pattern。N4 JCS serializer 与 N5 R13 位置随轨 B/G4。
- 轨 B：reviewRunner 契约草案（材料+三问+锚点复读）待 dev 发来后映射 B6 验收（盲审/红队语料/异模型族）。
