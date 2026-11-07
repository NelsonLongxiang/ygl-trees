# M13 终审 r4：commit 84b15d0（评审线 · 2026-10-20）

对象：`84b15d0`「M13 冻结前置：R7-R13 落文 + a-f 实现缺口修复」。
核验：`vitest run packages/verify/core/tests` → **17/17 通过**（compare 6 + engine 6 + 守卫 5）；逐项对照 `engine.ts`（624 行）、`contract.ts`、`docs/verify-contract.md`、`docs/spec-validator.md` 与 commit diff。
结论：**PASS——准开 corpus。** r3 四点与 a–f 全部核到落位，契约表与引擎实现一致；余 2 项文字须在语料落地前修（N1/N2），5 项列 M13-1 轨 A 尾项（N4–N8），不阻塞 corpus。

## 1. r3 四点 + a–f 核验（全部通过）

- sql-pair：`engine.ts:229` `witness(keys.length, violations.length, sources, fp)`——`rows_matched=违规对数`、`scanned=键并集`、`sources` 收两侧表；契约 `:82` 示例（`rows_matched:3` + 两表）与 `§2.1:106` 口径三者一致；「PASS 当且仅当 violations=0；键集不相交→FAIL」与 `engine.ts:196-216` 一致。
- sql 找违规：`engine.ts:107-108` 无 WHERE 且无 `scope_sql` → ERROR；`scope_sql` 分支（`:113-125`）单独取扫描面；构造守卫不再允许「整表非空」冒充「扫过本批」。
- exists：`§2.1:108` 已注「引擎装配期降级，非检查器内判」，与 `engine.ts:268-272 + 492-497` 一致。
- command：md §6.1 与契约 `:111` 改为「执行事实，不进 fact 折叠，witness 可选」，与 `contract:94`/`engine.ts:498` FACT_TYPES 一致。
- count：`contract.ts:59-82` 判别联合（`from:string;sql?:never | sql:string;from?:never`）；`engine.ts:243-266` 双给仍 ERROR 兜底；`:253-255` 新增「sql 必须返回单行单列」校验；md `:173/176` 收窄为「只 count.from 与 sql-pair 两侧 from；sql 文本不支持占位」。
- a：`executeSourceRows` 返回 `{rows,error}`（`engine.ts:600-609`），source verdict=ERROR（`:452-467`），下游 `refsOf` 命中 ERROR 上游 → 级联 ERROR（`:480-485`）。
- b：`refsOf` 只认 `$vu:`（`engine.ts:364`），`refId` 严格校验（`:573-578`），PG `$1`/`$$`/金额 `$50` 不再误判。
- c：`VerifySpec.schema_fingerprint`（`contract:175`）+ 运行期比对（`engine.ts:487-491`）+ 报告 `schema_drift`（`:540-545`）。
- d：`globToRegExp`（`engine.ts:347-356`）`**/` → `(?:.*/)?`，根目录与子目录都匹配。
- e：无 assert 构造期抛错（`engine.ts:446-448`），`foldOverall` 兜底 NM（`:425`）。
- f：契约 `:82` 示例 witness 已按新口径重写（违规数/两表/指纹）。
- R7：`compare.ts:157-170` exact 禁 ε、tolerance ε>0、unit 只属 window(d|h|s)、range 用 value/value_max；md §4.1 同步。
- R8/R9/R13：md 零匹配改引 §2.1、task 副作用统一 NM 自动开、as_of 时间函数拒绝（`engine.ts:437-445`）。

## 2. 语料落地前须修（2 项，文字/小改）

- **N1 `scope_sql` 口径不一致**：契约 `:104` 写「`scope_sql` 行数」，引擎 `engine.ts:116` 取的是**首行首列的值**（`Number(Object.values(scopeRows[0])[0])`）——应写成「`scope_sql` 必须返回单行单列整数（扫描面行数），引擎取其值；多行/多列/非整数 → ERROR」。同时引擎补 `Number.isInteger && >=0` 校验（当前非数字 → `scanned=NaN` → `scanned===0` 为 false → 可带着 NaN witness 落 PASS，JSON 序列化成 null）。
- **N2 md 声称的 `$` 拒绝守卫未实现**：md:176 写「SQL 文本里出现 `$` 一律按非法字符拒绝」，`engine.ts` 无此守卫（`refsOf` 只认 `$vu:`，但 sql 文本会原样送 runner）。二选一：sql 检查器构造期加 `/\$/` 拒绝；或 md 改为「不支持占位展开（`$vu:` 仅在 count.from / sql-pair.from 生效）」。

## 3. M13-1 轨 A 尾项（不阻塞 corpus，先于 contract_version 1.0 冻结）

- **N4 R10 canonical 未落实现**：`stableStringify`（`engine.ts:618-624`）只做了键排序，缺 JCS 子集的 NFC、数字定点格式、时间 RFC 3339 UTC 毫秒归一；`payload_sha256` 目前只保证 TS 内自洽，Rust 双实现逐字门禁（G4）前须共用 serializer。
- **N5 R13 守卫在 run 入口而非 prepare/构造期**（`engine.ts:437-445` 在 `runVerify` 内）；正则 `current_date` 会误伤 `current_date_flag` 这类标识符与字符串字面量，建议改为 `\bcurrent_date\b` 并跳过注释/字符串，或明确记入已知误报。
- **N6 as_of 仅携带未强制**：查询是否真按 `as_of` 过滤仍靠构造/自审，建议在 G2 矩阵加「改 as_of 结果应变化」的负例。
- **N7 glob 尾 `**`**：`a/**` 不会匹配 `a/b/c`（`**/` 才展开）；文件型语料补一条尾 `**` 用例或文档标注限制。
- **N8 sql 无 WHERE 守卫**用 `/\bwhere\b/i` 全文匹配，注释/字符串里的 WHERE 会误放行；G3 红队已有「无 WHERE」例，补一条「WHERE 只出现在注释」即可。

## 4. 放行

r3 全部意见与 a–f 已闭合，17/17 实跑通过，契约表与引擎一致；**同意按「语料骨架（expected-report 先行，七型×七域）→ 轨 A 七型核 ∥ 轨 B submit/prepare/自审 → 管线/命令面/报告 → .157 运费对账端到端」开工**。N1/N2 与语料第一批同批修掉；N4–N8 在 contract_version 1.0 冻结前清账。
