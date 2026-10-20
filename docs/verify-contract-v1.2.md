# verify 契约 1.2 设计草案：可引用列的判据（col-to-col 与 count.against）

> 状态：**草案，未实现**。目标评审：K3 评审席、fdc757f6（契约持闸）。实现排 0.107.0。
> 现行契约为 1.1（`CONTRACT_VERSION` / `CORPUS_VERSION` = 1.1）。

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
  "against": { "from": "policy", "col": "max_executions" }   // 新增：右值取标量
}
```

**语义**：`SELECT (SELECT count(*) FROM <from> WHERE <where>) <op> (SELECT <agg>(<col>) FROM <against.from>)`。
- `agg` 可选：`max`（默认，适合「阈值配置」）、`min`、`sum`、`count`。
- 两侧都必须是**单值**：`against.from` 聚合后天然单行；`max()`/`min()` 对多行也单值；
  但若 `against` 省略 `agg` 且表有多行 → 构造期拒绝（「scalar right side is not a claim you can make — give agg」）。
- `count.predicate` 的现有禁令保留（不得带 `agg`，count 自身是聚合）。
- 与形态一不叠加：`against` 与 `value` 互斥（P2 拒绝同时出现）。
- `against.from` 支持 `$vu:` 引用吗？**不支持**——上游 VU 的输出是行集，不是标量；
  要拿上游值请用 `count from $Vx` 且 `op` 与字面量比（1.1 已表达）。

**witness**：`rows_scanned` / `rows_matched` 语义不变；evidence 增加
`compared: { left: n, right: m }`（仅本形态出现，便于报告回算）。
**S1 空洞防护**（air hole）沿用：`rows_scanned === 0` → NEEDS-MATERIAL，绝不 PASS。

## 4. 兼容与版本

- `CONTRACT_VERSION` 1.1 → **1.2**；`CORPUS_VERSION` 同步 1.2（语料重冻，见 §5）。
- **1.1 的 spec 在 1.2 引擎下行为不变**：新形态是可选键，旧 spec 不出现即走旧路径；
  `prepare` 校验以 spec 声明的 `contract_version` 为准——declared 1.1 却用 1.2 形态 → 拒绝，
  不允许「用新语法混过旧版本」。
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
| `construct-rejects`（3 个负例共用一例目录） | 跨表 `{col}`、`against` 多行且无 `agg`、缺列 | 全部构造期 ERROR，不进 SQL |

`manifest.json` 按 LF 重冻（0.103 事故后的铁律：`.gitattributes` + 盘上字节 == manifest 哈希
双检，见 fdc757f6 的裁定），digest 在 CHANGELOG 记录旧→新与「纯新增例」理由。

## 6. 明确不在 1.2 范围（请评审确认）

- **`group_by` / `having`**：需要定义「分组后的 PASS/FAIL 归属」（部分组失败怎么判？witness
  是逐组还是汇总？）与报告形状扩展，比「右值可引用列」大一档。**建议 1.3 单独立项**，
  1.2 只解决用户当前表达不了的那条不变量。若评审认为必须同批，请给出 PASS/FAIL 的分组语义裁定。
- 任意子查询 / 表达式右值：不做——那会把「判据」变成 SQL，破坏「AST 是机械生成唯一形态」。
- 隐式类型转换、NULL 特殊语义：不做，按 SQL 语义；NULL 比较的结果由 `compare.null` 既有约定管。

## 7. 待评审问题（请逐条回答）

1. `against` 默认 `agg` 取 `max` 是否合理？还是必须显式给 `agg`（更啰嗦但更不容易猜错）？
2. 形态一是否允许 `value:{col}` 出现在 `predicate.agg` 的 `having` 场景（如果 1.3 才做 having，
   1.2 里就自然没有）？
3. 构造期错误码沿用 `ERROR` + `spec_error` 细分，还是新增 `CONTRACT_VERSION_MISMATCH` 类？
4. 语料 +5 例是否足够覆盖「跨表列引用」与「多行标量」两类负例？
