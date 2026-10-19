# M13 复核 r3：R1/R2 落文与 @ygl/verify-core 骨架（评审线 · 2026-10-20）

对象：commit `aa42a32`（contract v0.3 §2.1 witness 表 / count 形状 / attachments 裁定 / VuResult 判别联合）+ `packages/verify/core` 骨架。
核验方式：§2.1 表逐行对照 `packages/verify/core/src/engine.ts`（549 行）与 `contract.ts`；`vitest run packages/verify/core/tests` 实跑 **12/12 通过**（2 files, 230ms）。
结论：**R1/R2 方向可用，不阻塞 corpus 落地**；但有 4 处口径不自洽须改文字，1 处类型不排他，另有 6 项实现级缺口在 `contract_version 1.0` 冻结前必须定（否则 corpus 的 expected-report 会把错误行为固化）。

## 1. §2.1 表（docs/verify-contract.md:96-110）逐行结论

- `sql` 找违规/找缺失（102-103 行）✅；`exists` 两行（106-107）✅；`file`（108）✅；`agent`（110）✅。
- **`sql-pair`（104 行）三处不自洽**：
  1. `matched` 口径「实际比较过的键数」与契约示例 `contract:80` 的 `rows_matched: 3`（=违规数）矛盾；引擎 `engine.ts:198` 是 `witness(keys.length, compared, [], fp)`（matched=compared）。
  2. 「零匹配（matched=0）→ PASS」与引擎冲突：键集不相交时 `compared=0` 但 `violations=keys.length>0`，引擎 `engine.ts:180-201` 先判 `violations>0 → FAIL`，不会 PASS。
  3. `sources` 引擎传空数组（`engine.ts:198`），而示例带 `freight_invoices/purchase_orders` 两条源表。
  → 改：`rows_matched = 违规对数`（与示例一致）、`rows_scanned = 两侧键并集数`；零匹配列改为「PASS 当且仅当 violations=0；键集不相交 → FAIL」；sources 补两侧源表。
- **`sql` 找违规的 `scanned=源表行数合计` 只证明表非空，不证明 WHERE 命中**：`engine.ts:55-66` 用 `runner.tableRows(t)` 对 `extractTables` 出的表取整表行数（忽略 WHERE）。错批次字面量 `batch='2099-01'` → `scanned=42>0, matched=0 → PASS`，B2 的空转仍在。三条修法（建议前两条并行）：①find-violation sql 必须引用上游 scope 行集（`$Vx`）或声明 `scope_sql` 供 witness 计数；②构造守卫要求 WHERE 字面量来自材料锚点（prepare 机械核对）；③corpus 增「错字面量」红队案例（expected NM/FAIL）。
- `exists` 的「scanned=0 → NM」在引擎里靠装配守卫（`engine.ts:433-437`：PASS 且 `rows_scanned=0` → 降 NM，排除 command/agent），检查器内不判。表里应注「引擎装配期降级」，否则按表写单测会误以为检查器内实现。
- **`command` 分类与 md §6.1 冲突**：md:235 把 command 列入 fact 层七型；`contract:94` 与 `engine.ts:438` 的 FACT_TYPES 只含 sql/sql-pair/count/exists/file。二选一：md §6.1 把 command 移出 fact 层（单列执行事实），或给 command 定义 witness（`exit_code/stdout_sha256/duration_ms`）并归 fact。冻结条件②「七型形状齐」依赖这个分类。

## 2. count 形状（contract:52；CountChecker contract.ts:54-75；engine.ts:205-233）

- 语义 ✅：from/sql 二选一、`from` scanned=上游行数、`sql` scanned=源表行数、`0` 是合法计数、op+value 判定、非数字 → ERROR。
- **类型不排他**：`CountChecker` 的 `from?`/`sql?` 都可选，编译期允许并存/双缺，只有运行时 ERROR（`engine.ts:206-228`）。建议判别联合：`{ type:"count"; from:string; sql?:never; op; value } | { type:"count"; sql:string; from?:never; op; value }`，与 sql-pair 左右侧同规。
- 建议契约补一句「sql 必须返回单行单列」；`engine.ts:222` 取 `rows[0]` 首列，与该约束一致。
- **R2 的另一半（占位绑定）未落**：md:173/176 允许 `$Vx.rows` 出现在 sql 的 WHERE IN，但 `engine.ts:103-115` 直接 `runner.query(c.sql)`，无模板绑定。当前 count.from 覆盖了「整集计数」场景，但 md 这句要么实现参数化绑定（临时表/IN 展开，注意注入与规模上限），要么删掉只保留 count.from。否则冻结条件②对该形态不成立。

## 3. 实现级缺口（冻结前定，corpus 会固化行为）

- **source 取数失败被吞**：`executeSourceRows`（`engine.ts:525-534`）catch → `[]`，`runVerify:407-418` 恒给 PASS；与 R5「取数失败 = ERROR 级联」矛盾。应让 source verdict=ERROR、下游引用 → ERROR。
- **refsOf 误抓**：`engine.ts:325-341` 用 `/\$([A-Za-z0-9_-]+)/g` 扫 checker 全部字符串——PG 的 `$1` 占位、`$$` 引号、金额字面量 `$50` 都会被当管线引用 → `topoOrder`（`engine.ts:354`）抛 `unknown unit`。应只在参数位解析（from / sql-pair.from / count.from / sql 占位），或改命名空间（如 `$vu:V1`）并显式排除 `$[0-9]+`、`$$`。
- **schema 指纹只算不比**：`VerifySpec` 无 `schema_fingerprint` 字段，engine 只生成不比对，§2.1/contract:94 的「与 prepare 冻结值不一致 → ERROR」未实现。加字段+比对，或删该句。
- **glob `**/*.pdf` 不匹配根目录文件**：`globToRegExp`（`engine.ts:313-322`）生成 `^.*/[^/]*\.pdf$`。补单测（根目录 + 子目录各一例）或改 glob 语义。
- **无 assert 的 spec → PASS**：`foldOverall`（`engine.ts:391`）对 source-only spec 给 PASS（reason "no assert units"）＝空转 PASS，建议构造期拒绝或 NM。
- **契约示例待重写**：`contract:80` 的 witness（sources、matched=3）按 §1 的修订后口径统一。

## 4. 放行意见

按 §1 的 sql-pair/`scanned`/command 三点改 §2.1 文字 + count 判别联合（约半小时文档 + 少量类型改动），即可开 corpus；§3 六项建议排 M13-1 第一批，先于 `contract_version 1.0` 冻结。骨架本身干净：判别联合类型强制、foldOverall 优先级、拓扑/环检测、sql-pair 1:1 重复键 → ERROR、payload_sha256 剔除自身后规范化哈希，均与契约一致；12/12 测试实跑通过。
