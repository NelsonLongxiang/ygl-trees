# M13-1 r9 复核：24d9c4a（r8 F1–F5 + prepare P0–P5）

评审线 · 2026-10-19 · 对象 commit `24d9c4a`（基线 `c96ac68`）
方法：全文读 engine/compare/prepare/contract + docs diff；实跑 `vitest run packages/verify/core/tests`（64/64，6 文件，含 33 语料例）；另用 `tmp/r9probe.spec.ts` 对三处语义做实证（结果见下，均已复现）。

## 结论

**24d9c4a 方向正确，但 E1–E5 必须在冻结/开 corpus 之前修。** prepare 拍板：**接受 P1–P5 阶段划分与「无 redteam 不 ready」口径**，附 5 条口径条件（§3）。64/64 与 33 例语料复核通过；F1–F5 的「机制」都在，问题集中在谓词侧聚合的新通道与 prepare 的类型白名单。

## 1. 阻塞（实证）

### E1 sql-pair 谓词侧 key 提取错位（`engine.ts:262-289`）
`readSide` 对谓词侧返回 `[{ key: <常量>, value }]`，而 `sideKey()` 返回的却是常量字符串 `side.key ?? "total"`，`group()` 用它当**列名**取 `r["total"]` → 恒为 `undefined`。实证（`sql-pair` 两侧谓词、bills 200000 vs declared 190000）：

```
PAIR { "verdict": "FAIL", ..., "evidence": { "violations": 1, "key": "undefined" } }
```

影响：①报告 evidence 的违规键恒为 `"undefined"`（审计面噪声）；②谓词侧显式 `key` 是死字段，看起来能按批键对齐、实际被忽略；③谓词侧与 rowset 侧混搭不报错，会按「一侧键全缺」判 FAIL——本应构造期拒绝。修：谓词侧统一返回列名 `key`（或两侧皆谓词时直接单值比较），混搭报 ERROR，并补 evidence 断言测试。

### E2 `sql` 型谓词 + agg = 恒判（`engine.ts:140-175`）
谓词路径不校验 `predicate.agg`，纯聚合渲染出 `SELECT SUM(...)` 恒一行：`fail_when:"rows>0"` → 永远 FAIL，`rows==0` → 永远 PASS。实证（账期数据存在、金额无关）：

```
AGG-SQL { "verdict": "FAIL", "evidence": { "violations": 1, "rows_total": 1 } }
```

修：`sql` 型见 `agg` 非空直接 ERROR（agg 只属于 sql-pair 谓词侧）；`count`/`exists` 的谓词形态里 `agg` 被 `renderScan` 静默丢弃（`engine.ts:702`），同样构造期拒绝。

### E3 空批「总额对总额」→ PASS（空转在聚合通道复活）
两侧谓词各自 `SUM(...)` 在无匹配行时返回 NULL，`compareValues` 的「两侧都缺 = 同构缺失」判 equal（`compare.ts:91-95`）。实证（batch `2099-01`，两表均无行）：

```
EMPTY-PAIR { "verdict": "PASS", "rows_scanned": 1, "rows_matched": 0 }
```

这正是评审 B2 要堵的空转：批号打错/漏批 → 两边都空 → 绿灯，且 witness 只看键数（1），不反映两侧扫描面为空。修：谓词侧 pair 同时计算 `count(*)` scope（每侧），两侧 scope 均 0 → NEEDS-MATERIAL（批不存在）；一侧 0 → NEEDS-MATERIAL；witness 里给每侧 scope_rows（§2.1 的 sql-pair 口径也要补「聚合对」一行）。

### E4 `±hh` 形态自相矛盾（`engine.ts:611, 623-629`）
`ISO_OFFSET` 接受 `[+-]\d{2}`，但 `Date.parse("2026-07-01T00:00:00+08")` = NaN → 归一函数抛错。实证：

```
PLUS08 { "verdict": "ERROR", "reason": "predicate literal \"2026-07-01T00:00:00+08\" looks like an ISO datetime but cannot be parsed" }
```

契约（`docs/verify-contract.md:57` 与 §1.5）只承诺 `Z` / `±hh:mm` / `±hhmm`。修：要么从正则去掉 `[+-]\d{2}`，要么自己解析小时偏移；另注意 window 比较的 `ISO_DATETIME_TZ`（`compare.ts:33`）只收 `±hh:mm`，与字面量归一的 `±hhmm` 不一致，建议一处定义、两处共用。

### E5 prepare P2 白名单未收口（`prepare.ts:148-233`）
- `count.sql` / `exists.sql` 手写形态**未被拒**（只有 `sql` 型走了 `sqlChecker.sql` 分支）——违反 `docs:67`「prepare 产出只允许谓词 AST」。
- `sql-pair` 谓词侧只校 `agg` 列数与 compare，**没做 schema 探针**（`p2` 的 schema 校验只在 `checker.type === "sql"` 里）；表/列拼错要到 run 期才 ERROR。
- `PrepareCandidate.requires_execution`（`prepare.ts:56`）是死字段：`agent` 只要 rubric 非空就放行，且 P5 一律 `sealed.review: true`（`prepare.ts:382`）——封包 fact-only 下这类 spec 运行时必 ERROR。
- `$` 守卫用 `JSON.stringify(predicate).includes("$")`，会把合法字面量（如 `'$50'`）也拒掉；应收窄为 `$vu:`。

修：P2 改成「按 type 的允许形态」白名单（sql=predicate；count=from|predicate；exists=predicate；sql-pair=谓词/表侧 + schema；file=glob/min/max/sha256；command 拒；agent 需 requires_execution 且 review 开启），schema 校验覆盖**所有**谓词出现处（sql/sql-pair/count/exists），`$` 守卫收窄。

## 2. 非阻塞（冻结前/后清）

- **P1 只校验 `anchor`，不校验 `expected_from.quote/locator`**（`prepare.ts:127-145`）：`expected_from` 可被编造而 anchor 合规。应一并对 `expected_from` 做逐字 + locator 归属校验。
- **P3 轮次语义**：首轮只要有候选被 kept 就 `break`（`prepare.ts:355-356`），与 `docs:185`「盲审 ≤3 轮」的表述不一致。建议文档写死「上限 3 轮；一旦出现可冻结候选即收敛」，或改成按候选重试（rejected 单独再抽）。
- **P4 失败仍携带 spec**（`prepare.ts:386-409`）：红队不过返回 `verdict:"error"` 但 `spec` 已在结果里，CLI 若直接落盘就冻了一个没跑过红队的 spec。契约写明「非 ready 不落盘」，或结果加 `frozen:false`/非 ready 不带 spec。
- **P5 冻版字段**：`as_of` 硬编码为 prepare 的 wall clock（`prepare.ts:379`，语义应为调用方给的快照时间）；`attachments` 恒空（`prepare.ts:381`，应从 `materialIndex.files` 映射 sha256/mime）；`spec_version` 恒 1（应由调用方递增）；`verifier.engine_version/corpus_version` 硬编码。
- **P0**：`knownMaterialHashes` 只写诊断不拦截（`prepare.ts:297-299`）——可接受，但契约要写明「重放同材料 = 告警而非拒绝」。
- `exists` 运行时同时给 `predicate` + `sql` 不报错（`engine.ts:395-400`，predicate 静默优先）；contract 类型已排他，运行时补守卫。
- `engine.ts` 内 `RenderedPredicate` interface 声明了两次（合并无害，属合并残留）；`readSide` 里 `renderPredicate` 被调用两次（小性能）。

## 3. prepare 拍板意见（回答「P1–P5 与无 redteam 不 ready 是否接受」）

**接受。** 阶段划分与草案一致：P0 材料冻结（调用方给 text+sha256，本模块只校验）→ P1 逐字/locator/不可判词 → P2 仅谓词 AST + 构造期校验 → P3 盲审三问 fail-closed → P4 红队注入 → P5 冻版（`materials_sha256` + 拒绝清单）。「无 reviewer / 无 redteam 都不 ready」是正确 fail-closed 口径（实现与 10 条单测一致）。

附 5 条口径条件（建议随本轮一起落文档）：
1. **P0–P5 规则进 `docs/verify-contract.md`**：目前详细口径只在 `tmp/prepare-contract-draft.md`（`tmp/` 未入库，`git ls-files tmp/` 为空），docs 只有零星引用（`:67/:185/:230`）。契约不进版本库 = 冻结后不可对质。
2. **P3 轮次**按 §2 建议写死（上限 3 轮、有 kept 即收敛），并把「每轮新上下文、blind=true、不带上一轮结论」写清。
3. **P4 失败 = ERROR 且不落盘**（结果不带可冻结 spec，或显式 `frozen:false`）。
4. **P5 字段来源**：`as_of` 由调用方给；`attachments` 从 materialIndex 映射；`spec_version` 由调用方递增；版本号取自包/构建。
5. **P2 类型白名单 + schema 全量校验 + `$vu:` 收窄**（E5）。

另：`docs:230` 已写「review/prepare 模型调用一律走注入接口」——注入 `PrepareRunner` 与我 r7 的裁定一致，无异议。

## 4. 复核通过项

- F1 agg：`renderAggs` 纯聚合/别名唯一/混排拒绝在 `r8.spec` 有测试；`agg-total-mismatch` 语料证明聚合值确实参与比较（FAIL、witness 1/1）。
- F2 count/exists 谓词形态渲染正确（scope 计数为源表行数，与 §2.1 一致）。
- F3 in/between 同型、is null 带 value 拒绝、闭区间写入契约（`docs:86-91`）。
- F4/F5 `+08:00`/`+0800` 折 Z 有对照测试（`r8.spec:157-170`），SQLite 字典序问题已在注释与契约说明。
- W1b 已修：`ISO_DATE_ONLY` / `ISO_DATETIME_TZ` 分离，无时区 datetime 构造期 ERROR（`compare.ts:29-42`）。
- 64/64 单测、33 语料例、`gate 10/10` 复核通过（本机实跑）。

## 5. 证据

- `packages/verify/core/src/engine.ts:140-175`（sql 谓词路径）、`:229-289`（sql-pair 谓词侧/key/group）、`:611/623-629`（ISO_OFFSET/normalizeIsoLiteral）、`:702`（renderScan 忽略 agg）、`:395-400`（exists 运行时形态）。
- `packages/verify/core/src/compare.ts:29-42`（W1b 正则）、`:91-95`（两侧 null = equal）。
- `packages/verify/core/src/prepare.ts:56,127-145,148-233,355-356,379-382,386-409`。
- `docs/verify-contract.md:57,67,151,185,230`；`tmp/prepare-contract-draft.md`（未入库）。
- 实证脚本：`tmp/r9probe.spec.ts` + `tmp/vitest.probe.config.ts`（gitignored；`vitest run --config tmp/vitest.probe.config.ts`）。
