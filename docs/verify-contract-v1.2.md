# verify 契约 1.2 设计草案：可引用列的判据（col-to-col 与 count.against）

> 状态：**已实现 / 已被取代（历史设计稿）**。1.2 已随 0.107.0 实现；现行契约见
> [verify-contract.md](verify-contract.md)（`CONTRACT_VERSION` / `CORPUS_VERSION` = 1.2）。本文仅保留设计历史。

## 1. 要解决的真实问题

验证席（ae07421e）转来 v0.102.4 实测：用户想表达的不变量是

```
executions 的行数 > policy.max_executions
```

`count` 检查器只能把计数与**字面量**比（`count.op` + `count.value: number`），
`PredicateCondition.value` 也只收字面量。于是：
- 「计数 > 另一张表里的阈值」无法表达（V2 ERROR 根因）；
- 「同一行里 A 列 > B 列」也无法表达（`value` 只能写字面量）。

这不是缺一个快捷方式，而是判据语言缺一类**可引用列**的右值。1.2 只加这一类的两种最小形态，
其余（`group_by` / `having`）另行评估（见 §6）。

## 2. 形态一：同表列对列 `value: { col }`

```jsonc
{
  "col": "settled_at",
  "op": ">",
  "value": { "col": "due_at" }          // 新增：右值是同一 from 表的列
}
```

**约束（构造期拒绝，不进运行期 SQL 报错）**：
- `{col}` 只允许引用 `predicate.from` 同一张表的列；跨表引用 → P2 typed 拒绝，
  文案点名「cross-table column comparison needs sql-pair (join key is a claim you did not make)」。
- 列必须存在于快照 schema（`probeOfDb` 的真实列），缺列 → P2 typed 拒绝。
- `op` 仍限 1.1 的 `PredicateOp` 集合；`is null` / `is not null` 不接受 `{col}` 右值。
- 类型不做隐式转换：SQL 的比较语义即契约（与 `sql` 检查器一致）；文本/数字混比按 SQLite/PG
  各自语义，报告 witness 里记录两侧原始值，不替用户 cast。

**渲染**：`<col> <op> <ident(value.col)>`，两个标识符都走现有 `ident()` 白名单。

## 3. 形态二：`count` 对单值标量 `count.against`

```jsonc
{
  "predicate": { "from": "executions", "select": [], "where": { … } },
  "op": ">",
  "against": { "from": "policy", "col": "max_executions", "agg": "max" }   // 新增：右值取标量
}
```

**语义**：`SELECT (SELECT count(*) FROM <from> WHERE <where>) <op> (SELECT <agg>(<col>) FROM <against.from>)`。
- `agg` **必填**（`max|min|sum|count`）：缺省 → P2 构造期拒绝（`missing_agg`）。不设默认——
  默认 `max` 在「配置表意外多行」时静默取最大，是典型的 helpful magic；且「多行才拒绝」是
  **数据依赖**的判据（行数是快照数据而非 schema），会让 spec 有效性随数据漂移。显式 `agg`
  同时让「阈值取 max」成为 spec JSON 里可审计的声明。
- `against.from` 为空表时，聚合结果为 NULL：按 `compare.null` 既有约定处理（默认 `error`），
  语料用一例冻结该行为。
- 其余单值性：`against.from` 聚合后天然单行，无需运行期再检查。
- `count.predicate` 的现有禁令保留（不得带 `agg`，count 自身是聚合）。
- 与形态一不叠加：`against` 与 `value` 互斥（P2 拒绝同时出现）。
- `against.from` 支持 `$vu:` 引用吗？**不支持**——上游 VU 的输出是行集，不是标量；
  要拿上游值请用 `count from $Vx` 且 `op` 与字面量比（1.1 已表达）。

**witness**：`rows_scanned` / `rows_matched` 语义不变；evidence 增加
`compared: { left: n, right: m }`（仅本形态出现，便于报告回算）。
**S1 空洞防护**（air hole）沿用：`rows_scanned === 0` → NEEDS-MATERIAL，绝不 PASS。

## 4. 兼容与版本

- `CONTRACT_VERSION` 1.1 → **1.2**；`CORPUS_VERSION` 同步 1.2（语料重冻，见 §5）。
- **1.1 的 spec 在 1.2 引擎下行为不变**：新形态是可选键，旧 spec 不出现即走旧路径。
- **版本不匹配仍是「引擎拒跑」而非 verdict**（保留现行为）：declared 1.1 的 spec 带 1.2 形态
  → `runVerify` 入口硬抛（rc 非 0），不产出 PASS/FAIL/NEEDS-MATERIAL/ERROR 报告。
- **构造期错误**用 `evidence.spec_error`（**新设**，1.1 无此字段）细分，值域为封闭码表，随
  1.2 键控进形状守卫：`cross_table_col` / `missing_column` / `missing_agg` /
  `null_rhs_for_null_op` / `version_shape`。四值 verdict 骨架不变——新增第五值会破坏报告消费者、
  WebUI、Rust parity 与 evaluator 协议；封闭码表才是可枚举比对面的稳定契约，`reason` 只给人读。
- 报告 `contract_version` 取引擎版本（与现行为一致），`spec.contract_version` 单独保留。
- Rust 实现（M13-1b 封包）必须同版：`contract.rs` 加两处形状、`engine.rs` 加两条渲染与构造期校验、
  `tests/parity.rs` 语料逐例整份报告 parity 保持全绿。

## 5. 语料（corpus 1.2，+5 例）

| 例 | 形态 | 期望 |
|---|---|---|
| `col-ref-pass` | `value:{col}` 同表 A>B 且成立 | PASS（witness 有两侧值） |
| `col-ref-fail` | 同上但 A<B | FAIL（evidence 点名两侧值） |
| `count-against-pass` | `count` vs `against.max` 成立 | PASS + `compared:{left,right}` |
| `count-against-fail` | 计数 == 阈值（`>` 不成立） | FAIL + `compared` |
| `agg-variants` | 同一数据上 `max`/`min`/`sum`/`count` 四断言 | 四组独立 witness，可 parametrize 成一例多断言 |
| `construct-rejects`（5 个负例共用一例目录） | 跨表 `{col}`、缺 `agg`、缺列、`is null` 配 `{col}`、declared 1.1 却用 1.2 形态 | 全部构造期 ERROR（`spec_error` 封闭码）/版本闸拒跑，不进 SQL |
| `against-null` | `against.from` 空表 + `agg` → 右值 NULL | 按 `compare.null` 约定冻结（默认 error） |
| `type-mixed` | 文本列 vs 数字列比较 | 按 SQL storage class 语义冻结（better-sqlite3 与 rusqlite 的 parity 高价值区） |

`manifest.json` 按 LF 重冻（0.103 事故后的铁律：`.gitattributes` + 盘上字节 == manifest 哈希
双检，见 fdc757f6 的裁定），digest 在 CHANGELOG 记录旧→新与「纯新增例」理由。

## 5b. 实现期冻结（fdc757f6 批准，含条件）

**形态一（col-col）的逐行两侧值**：不进 `ScopeWitness`（那是扫描域证明），用
`evidence.compared_rows`（采样，≤5 行 `{left,right}`）+ `evidence.compared_total`。
两个硬条件：
1. `compared_total` **无条件出现**（即使全部行都在采样内）——消费者要能区分「恰好 3 行」与
   「3/N 采样」；条件性出现会让形状守卫出现两套。
2. 采样确定性：渲染 SQL 带显式 `ORDER BY rowid`（TS/Rust 自然序理论上有漂移空间）；
   并且语料必须有一例 `compared_total > compared_rows.length`，让采样路径在字节级被 parity 冻结。

**`agg:"count"` 语义**：`count(col)`（跳过 NULL），与 max/min/sum 家族一致；`count(*)` 会让
`col` 失义。附带不对称（写进契约文档）：**count 是家族里唯一不会产生 NULL 右值的 agg**——
空表/全 NULL 时 `count` → 0，而 `max/min/sum` → NULL。`against-null` 语料把这对对比
（count-over-empty=0 vs max-over-empty→NULL）冻在同一例里。

## 6. 明确不在 1.2 范围（评审已裁定：拆 1.3）

- **`group_by` / `having`**：**拆 1.3**（fdc757f6 裁定）。1.3 锚点先记下，防止将来与 1.2 自相矛盾：
  逐组判 PASS/FAIL；`violations[]` 带组键（对齐 find-violation 形状）；`overall` = 任一组 FAIL 即 FAIL；
  `rows_scanned` = 跨组总行数；witness 记违规组（有界：前 N 组 + 总数）。1.3 落地时 1.2 的
  「`{col}` 只许同表」规则原样适用。
- 任意子查询 / 表达式右值：不做——那会把「判据」变成 SQL，破坏「AST 是机械生成唯一形态」。
- 隐式类型转换、NULL 特殊语义：不做，按 SQL 语义；NULL 比较的结果由 `compare.null` 既有约定管。

## 7. 已裁定（fdc757f6，2026-10-20）

1. **`agg` 必填，无默认**；缺省 → P2 `missing_agg`（永远是 schema 可判，不依赖数据行数）。
2. `value:{col}` 的 having 场景 1.2 自然不存在（having 归 1.3）。
3. **不新增 verdict**：四值骨架冻结；构造期细分走新设 `evidence.spec_error` 封闭码表；
   版本不匹配保持「引擎入口拒跑」。
4. 语料 **+8 例**（原 5 + `against-null`、`type-mixed`、版本闸负例；「多行无 agg」改写为「缺 agg」；
   `agg` 变体可 parametrize）。
- 附带语义：`agg` 作用在空 `against.from` → 右值 NULL，按 `compare.null` 约定并冻结语料。
