# verify 三 JSON 契约（D0 · 草案 v0.2）

> M13-1 的第一步：契约先行。三个 JSON 是唯一接口真相——TS 参考实现、Rust 二进制、黄金语料都只认这三个形状。
> **冻结条件**：①评审席 direct-30389fca（fdc757f6）与 direct-7510b90f（302cb119）两份意见收敛；②**七型 checker 形状齐**（sql / sql-pair / count / exists / file / command / agent，corpus 每型 ≥1 案例）；③`contract_version` 钉为 `1.0` 并在 CHANGELOG 记。冻结后任何变更走 `contract_version` 自增。

## 1. 规范文件（spec，`.yglverify.json`）

```json
{
  "contract_version": "1.0",
  "spec_id": "vs_7f3a…",
  "spec_version": 3,
  "title": "FBA 头程运费对账",
  "domain": "logistics.freight",
  "created": "2026-10-20T09:00:00.000Z",
  "runtime_min": "1.0",
  "verifier": { "engine_version": "0.1.0", "corpus_version": "1" },
  "as_of": { "kind": "snapshot", "value": "2026-10-19T22:40:00.000Z" },
  "vu": [
    {
      "id": "V1", "role": "source", "title": "圈定本批账单", "severity": "S2",
      "source_clause": "本批 2026-10 头程账单（verbatim）",
      "checker": { "type": "sql", "sql": "SELECT id, order_id, amount FROM freight_invoices WHERE batch='2026-10'" },
      "expected_from": { "kind": "runtime-query", "note": "当前态查询" },
      "outputs": { "rows": "rowset" }
    },
    {
      "id": "V2", "role": "assert", "title": "账单金额与应付一致", "severity": "S1",
      "source_clause": "每张运费发票金额与对应订单应付金额一致（verbatim）",
      "checker": {
        "type": "sql-pair",
        "left":  { "from": "$V1.rows", "key": "order_id", "value": "amount" },
        "right": { "table": "purchase_orders", "key": "id", "value": "payable_amount" },
        "compare": { "mode": "tolerance_abs", "value": 0.01, "currency": "CNY", "scale": 2, "cardinality": "1:1", "null": "error" }
      },
      "expected_from": { "kind": "material-extract", "source_id": "src_…", "anchor": "报价基准.xlsx·Sheet1·R5C3", "quote": "2.35 元/kg（verbatim 复读）" }
    }
  ],
  "attachments": [
    { "role": "baseline",   "path": "attachments/报价基准.xlsx", "sha256": "…", "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "size": 18234 },
    { "role": "submission", "path": "attachments/账单截图.png", "sha256": "…", "mime": "image/png", "size": 90211 }
  ],
  "sealed": { "review": false }
}
```

**字段铁律**

- `role`：`assert` 参与总判定；`source` **不参与折叠**（PASS-by-construction；取数失败=ERROR 级联到引用它的下游）、不进 summary 分母，且必须被至少一个下游 `$vu:<id>.out` 引用（否则空转，构造拒绝）。管线引用统一命名空间 **`$vu:<vu-id>`**（r3 意见 b：避免 PG 占位符 `$1`/`$$`、金额 `$50` 被误认）。
- `severity` ∈ `S1|S2|S3`：构造阶段按判据语气赋值（必须/不得→S1，应→S2，建议→S3），自审只可上调；**不改变 overall 数学**，只影响呈现顺序与处置优先级（**NEEDS-MATERIAL 自动开 task**；首版 FAIL 只进报告例外清单、不自动开——与 md 决策表 E 一致，R9）。
- **checker 形状互斥**：`checker` 是**标签联合**——`type` 决定其余键。`sql-pair` 的每一侧是 **`from`（rowset 引用）或 `table`（基表）二选一，不得并存**（fdc757f6 ①）；`from` 在位时 `key`/`value` 指 rowset 列名，`table` 无意义。
- **count 形状闭合**（评审 R2）：`count` 的集合来源 **`from`（上游 `$Vx` 行集）或 `sql`（业务数据源单语句）二选一，不得并存、不得缺失**；`from` 在位时 `scanned = 上游行数`、`matched = 计数`；`sql` 在位时 `scanned = 源表行数`。占位绑定语法：`from` 写 `"$vu:V1"`（行集）或 `"$vu:V1.rows"`（同义），引擎按 `$vu:` 命名空间解析；`sql` 文本内不支持占位展开。
- **`scope_sql`**（评审 r3 追补，已反灌契约）：`sql` 型找违规时用于证明「扫的是本批范围」的旁路查询——必须返回**单行单列非负整数**（通常是 `select count(*) …`），引擎取其值作为 `rows_scanned`；多行/多列/非整数 → **ERROR**（N1）。无 `scope_sql` 时回退源表行数，且要求 `sql` 自带 WHERE。
- **CompareSpec**（评审 B5 + R7 单一形状）`compare`：`mode ∈ exact|tolerance_abs|tolerance_rel|window|subset|superset|range|regex`；`currency`+`scale` 必填则按最小单位整数比较（禁浮点直比）；`cardinality ∈ 1:1|1:N|N:1`（默认 1:1，重复键→ERROR 点名；`1:N` 须带 `agg`）；`null ∈ error|equal|ignore`（默认 error）。
  - **ε 规则**：`exact` **不带 ε**（带 `value` 即构造错误）；`tolerance_abs`/`tolerance_rel`/`window` 的 ε **必须 0 < ε**（ε=0 就是 exact，混用即空转）；`range` 用 `value`=下界、`value_max`=上界。
  - **相对容差分母（W3）**：`tolerance_rel` 判 |l−r| ≤ ε·|r|，**分母取期望侧 r**；r=0 时退化为 l==0。换分母等于换判据，属破坏性变更。
  - **时间字面量（W1b）**：`window` 只收纯日期 `YYYY-MM-DD` 或**带时区**的 datetime（`Z` / `±hh:mm`）；无时区时间戳构造期 ERROR。
  - **unit 只属 window**，取值 `d|h|s`；其余模式带 `unit` 即构造错误。
- `expected_from`：值三源之一——`material-extract`（带 `anchor` + **`quote` 原文复读**，锚点可机械核对）、`explicit`（专家显式给出）、`runtime-query`（运行时查询）；prepare 时冻结。
- **附件两阶段**（评审 B4）：`baseline` 在 submit 冻结（值进 spec）；`submission` 的字节在 run 时校验 `sha256`（同路径换内容=新附件行）；附件走 content-addressed blob（sha256/size/mime），不参与 FTS。
- **附件落点裁定**（评审 R3，冻结前置）：**新表 `attachments`**（走九触点：SCHEMA_SQL/实体/迁移/写服务/读服务/导出/清理/测试/文档），**不在 `sources` 增列**——`sources` 只按 `sha1(text)` 存 UTF-8 正文且 `url_hash` 重复早返回（`writes.ts:139,152`），没有二进制按字节入库的路径；把附件塞进 source 会让「同一路径换内容」静默复用旧行。spec 的 `attachments[].sha256` 即 `attachments.content_sha256` 的外部锚。
- `as_of`（评审 C2）：所有时间窗口与 `now()` 必须锚定——`kind: snapshot`（SQLite 用文件哈希，PG 用只读事务快照 id）。
- `sealed.review`：封包是否允许 review 层（默认 false；`--with-review` 置 true）。

## 1.5 谓词 AST（机械生成的唯一取数形态）

prepare 产出的 spec **只允许谓词 AST**，不允许手写 SQL（`authored:"manual"` 只在评审放行的存量/例外场景）。
引擎从**同一个 AST** 渲染 find 与 scope 两段查询，二者共享逐字相同的 WHERE 子句——这是"扫描面不可伪造"的实现方式。

```jsonc
{ "type": "sql", "fail_when": "rows>0",
  "predicate": {
    "from": "bills",
    "select": ["id", "batch"],
    "agg": [{"fn": "sum", "col": "amount_cents", "as": "total"}],
    "where": { "op": "and", "conditions": [
      { "col": "batch", "op": "=", "value": "2026-07" },
      { "op": "or", "conditions": [
        { "col": "bills.amount_cents", "op": ">", "value": 100000 },
        { "col": "status", "op": "in", "value": ["hold", "void"] }
      ]}
    ]}
  }}
```

- 条件 op 闭集：`= != > >= < <= in between is null is not null`；`in` 传非空数组，`between` 传两元素数组且**闭区间**（含两端）。
- **元素同型**（r8 F3）：`in` / `between` 的元素必须全为数字或全为字符串——混合类型在 PG 直接报错、在 SQLite 按类型序比较，结论不可移植；`is null` / `is not null` 带 `value` 是构造错误（不得静默忽略）。
- 组节点 `and|or|not` 可嵌套；`not` 内部按 AND 连接后整体取反。
- `agg` 支持 `count|sum|min|max`（count 可省略 col）；别名进报告，便于审计，且**别名必须唯一**（自动名 `count_all` 也在唯一性检查内）。
- **纯聚合形态**（r8 F1）：`agg` 非空时 `select` 必须为空数组——列与聚合混排需要 GROUP BY，而 AST 里没有 GROUP BY，渲染出的 `SELECT batch, SUM(x)` 在 PG 非法。纯聚合适用于总额对账：两侧都用 `agg:sum` 的 sql-pair 谓词侧比较总额。
- **sql-pair 的谓词侧**（r8 F1）：`{ "predicate": {...} }` 是最新形态，值列 = 该谓词唯一的 agg 列，key 缺省为常量 `"total"`；两侧都用谓词即"总额对总额"。谓词侧必须恰好一列 agg、且查询只产出一行。
- **count / exists 也接受谓词形态**（r8 F2）：`{"type":"count","predicate":{...},"op":"==","value":N}` 由引擎渲染 `SELECT count(*)`；`{"type":"exists","predicate":{...},"expect":true}` 渲染 `SELECT 1 ... WHERE`。手写 SQL 形态仍是评审例外，不属于机械生成面。
- **谓词形态的扫描域 `scan`**（1.0 定稿）：`Predicate.scan` 是「这次检查看哪一批数据」的域过滤（AND/OR/NOT），渲染进 `findSql` 与 `scopeSql` 两侧；`where` 只描述判据、只进 `findSql`。因此 `witness.rows_scanned` 的含义是**域内检查过的行数**，`rows_matched` 是命中判据的行数。把批次条件写进 `where` 会让干净批次扫出 0 行被判 NEEDS-MATERIAL（M13-1 端到端实测到的错误用法）。
- **零扫描判定**：fact 型 PASS 且 `rows_scanned === 0` → 降级 NEEDS-MATERIAL（「扫了 0 行」只能说明没数据，不能说明合规）。
- **时间字面量规范化**（r8 F4/F5）：带偏移的 ISO 时间（`+08:00` / `+0800` / `Z`）在渲染时统一折成 UTC `Z`——SQLite 里日期是字符串，`BETWEEN '+08:00'` 是字典序比较，与时间序不等价；折成 Z 后同一 spec 在任何机器上给同一结论，Rust 侧同口径。无时区的时间字面量仍拒绝（W1b）。
- 标识符守门：列名/表名只允许裸标识符（可 `表.列`），表达式与子查询一律构造期拒绝；字符串值按 `''` 转义。
- **找违规型（`fail_when:"rows>0"`）必须给 where**，否则整表非空就能冒充"扫过本批"。
- 渲染结果 `rendered.find_sql` / `rendered.scope_sql` 写进报告 evidence，与 witness 对账。
- `authored:"mechanical"` 的手写 sql 直接 ERROR（机械 spec 只能用 predicate）；手写 sql 形态必须自带 `scope_sql` 或 WHERE。

## 1.6 prepare 流水线（P0–P5，评审 302cb119 拍板条件）

构造面 = **模型只提议、机器只接受机械形态**。五阶段全在 `packages/verify/core/src/prepare.ts`，每阶段拒绝都进 `rejected[]`（带 `stage` 与原因），不静默丢。

| 阶段 | 门 | 失败后果 |
|---|---|---|
| **P0** 材料冻结 | 材料非空；`materials_sha256` 由调用方文本算出；命中 `knownMaterialHashes` 只记 diagnostic（v1 是提示不是拦截） | 空材料 → `needs-material` |
| **P1** 判据抽取 | `source_clause` 与 `anchor.quote` 都必须在冻结材料里**逐字**存在；`anchor.locator` 必须由 `material_index` 声明；含不可判词（应尽量/建议/合理/酌情/视情况/适当）→ 拒 | 记 `rejected[stage=P1]` |
| **P2** 翻译成 VU | 只允许**谓词 AST**（手写 `sql` 一律拒；count/exists 的 `sql` 形态也拒）；`$vu:` 只允许出现在 `count.from` 与 sql-pair 侧，谓词内出现 → 拒（金额字面量 `$50` 不误伤）；渲染不得含时间函数；schema 探针**全量**校验表/列（sql、sql-pair 双侧、count、exists）；agent 必须带非空 rubric；`requires_execution` 只属于 agent 型；compare 走同一 `validateCompareSpec` | 记 `rejected[stage=P2]` |
| **P3** 盲审 | 复用 run 期 `ReviewRunner`（`blind:true`）：三问 fid/decidable/not-vacuous 缺一不可，未知 verdict/同问矛盾/reject/unclear/引用别的 VU 的 ok/锚点非逐字 → 都不 ready；**上限 3 轮**，每轮新上下文，出现可冻候选即收敛 | 记 `rejected[stage=P3]`；无 reviewer → `error` |
| **P4** 红队门禁 | 由调用方注入（要真库/真附件/真对抗样本）；未注入**不落 ready**（CLI 可退化为"空库最小红队"） | 失败 → `error`，且**不落可冻结 spec**（`spec` 省略） |
| **P5** 冻版 | `as_of` 由调用方给（快照口径）；`attachments` 从 `material_index.files` 映射（带**文件级 sha256/size**，防同一文本不同二进制重放）；`spec_version` 由调用方递增；`engine_version`/`corpus_version` 取构建版本 | `ready` 才产出 frozen spec |

**发射集（当前 = 四型 fact）**：prepare 的 P2 闸只放行 `sql` / `sql-pair` / `count` / `exists`；`file` / `command` / `agent` 的构造面尚未开放（P2 直接拒），它们只在引擎执行面可用（手写 spec + 评审例外）。七型是**引擎闭集**，不是构造面闭集——两者口径分开读（验证席回灌 ②）。

> **prepare 的 rc 口径（r11 R6）**：`verify prepare` 只有在 `verdict="ready"`（产出可冻结 spec）时 rc=0；`needs-material`（材料不足/自审不通过）与 `error`（调用方配置缺件，如无评审器/红队未过）都返回 **rc=1** —— 它们都没产出冻结件，CI 应视为失败。判定原因在 `--json` 的 `verdict`/`rejected[]`/`diagnostics[]` 里，不要从 rc 反推三态。`run` 同理：rc 只表达过程（FAIL 报告仍 rc=0），判定看报告 `overall`。
`verdict` 三态归因（fdc757f6 F2）：`needs-material` = **材料本身不足**；`error` = **调用方配置/环境问题**（缺 reviewer、缺红队、红队失败）；`ready` = 可冻结。CLI 按 verdict 分流，不靠 diagnostics 猜。

## 1.7 file 检查的排除集（`ignore`，0.98.0）

```jsonc
{ "type": "file", "glob": "*.pdf", "min": 2, "require": ["invoice.pdf"],
  "ignore": ["*.tmp", "draft/**"] }
```

- `ignore` 是相对提交物根（POSIX 分隔）的 glob 数组，`*` 不跨目录、`**/` 可匹配零层或任意层（与 CLI 的 walk 同实现）；`**` 单独作通配一切会被 P2 拒。
- 被排除的文件**不进扫描面**：`witness.rows_scanned`/`rows_matched` 只统计可见文件，`evidence.ignored` 记排除数量。这样"临时文件混进来"不会稀释分母。
- `require` 与 `sha256` 仍按**字面路径**校验——即使该路径被 ignore 命中，缺文件/哈希不符照样 FAIL（排除是缩小扫描面，不是豁免义务）。
- 全部文件被排除 → NEEDS-MATERIAL（`every file was excluded by ignore globs — nothing left to scan`），不判 PASS。
- 构造期拒绝：绝对路径、含 `..` 段、空字符串、通吃 glob。

## 1.8 CLI 的文件形态（构造面输入，0.98.0）

`verify prepare` 不做模型调用，构造面产物由调用方（agent）以文件注入。三种文件都是**单对象或裸数组都收**：

```jsonc
// --candidates：模型提议的判据（P1/P2 会逐条机械校验）
{ "candidates": [{
  "source_clause": "账单总额须等于申报总额。",              // 必须在材料里逐字出现
  "anchor": { "quote": "账单总额须等于申报总额。", "locator": "material.md#I1" },
  "checker": { "type": "sql-pair",
    "left":  { "predicate": { "from": "bills", "select": [], "agg": [{ "fn": "sum", "col": "amount_cents", "as": "total" }], "scan": { "op": "and", "conditions": [{ "col": "batch", "op": "=", "value": "2026-07" }] } } },
    "right": { "table": "declared", "key": "id", "value": "total" },
    "compare": { "mode": "exact", "currency": "CNY", "scale": 2 } },
  "expected_from": { "kind": "material-extract", "source_id": "materials", "quote": "…", "anchor": "material.md#I1" }
}]}
// --reviews：盲审结论（每候选三条 findings；缺一条就判"自审不完整"）
{ "reviews": [[{ "vu_id": "V1", "question": "faithful", "verdict": "ok", "reason": "…", "anchor": { "quote": "…", "locator": "material.md#I1" }, "checkpoint": "anchor-verbatim" }]] }
// --db：schema 探针用的库（只读打开；也可用 --attachments 目录 + 空库）
```

- `--candidates`/`--reviews` 读不到/JSON 解析失败 → rc=1 并点名文件；`verdict` 三态见 §1.6。
- `--draft`（0.98.0）：只跑 P0–P5 给结论，**不写** `spec.json`/`prepare.json`/`trace.json`、不消耗 `spec_version`；rc 仍按 verdict（ready=0 / 非 ready=1）。用于「先看机器能不能接受这批候选」，避免试错污染版本号。
- 未知旗标一律 rc=2 并点名（`unknown flag for verify submit: --attachment`）——构造期静默比报错危险（`--attachment` 曾静默落成 `files: []`）。

## 2. 报告（report，`report.json`）

```json
{
  "contract_version": "1.0",
  "run_id": "run_3f9c…",
  "started": "2026-10-20T09:02:11.000Z",
  "finished": "2026-10-20T09:02:19.500Z",
  "verifier": {
    "mode": "sealed", "binary_sha256": "…", "engine_version": "0.1.0",
    "spec_version": 3, "corpus_version": "1", "sealed_review": false
  },
  "as_of": { "kind": "snapshot", "value": "2026-10-19T22:40:00.000Z" },
  "summary": { "pass": 2, "fail": 4, "needs_material": 1, "error": 0 },
  "overall": "FAIL",
  "reason": "V2/V3 FAIL (S1)",
  "vu": [
    {
      "id": "V2", "role": "assert", "verdict": "FAIL", "severity": "S1",
      "source_clause": "每张运费发票金额与对应订单应付金额一致（verbatim）",
      "witness": { "rows_scanned": 42, "rows_matched": 3, "sources": [{"table":"freight_invoices","rows":42},{"table":"purchase_orders","rows":38}], "schema_fingerprint": "sha256:…" },
      "evidence": { "violations": 3, "rows": [ { "order_id": "A-1001", "left": 1290.40, "right": 1204.00, "diff": 86.40 } ], "sort": "key_asc" },
      "guard": { "leniency_checks": ["not-same-source", "bounded-tolerance", "falsifiable", "has-where"] }
    }
  ],
  "exceptions": [ { "vu": "V2", "severity": "S1", "row_count": 3 } ],
  "payload_sha256": "sha256:…",
  "artifacts": { "attachment_sha256": ["…"] }
}
```

**铁律**

- `overall`（评审 B1）：`FAIL if 任一 assert=FAIL`；否则 `NEEDS-MATERIAL if 任一 assert=NEEDS-MATERIAL`；否则 `ERROR if 任一 assert=ERROR`；否则 `PASS`。**优先级 FAIL > NEEDS-MATERIAL > ERROR > PASS**；`summary` 以 assert 为分母，source 单列 trace。
- `witness`（评审 B2 + R1/R4）：**fact 型（sql/sql-pair/count/exists/file）必填**——类型层面 `VuResultFact.witness: ScopeWitness` 非可选；`agent`/`command` 型可选。逐型口径见 **§2.1**（不同型的「空范围」「零匹配」结论不同，禁止一刀切）。`schema_fingerprint` 与 prepare 冻结值不一致 → **ERROR**。

### 2.1 witness 语义表（评审 R1）

> 「零扫描 ⇒ NEEDS-MATERIAL」只对**找违规**语义成立。逐型定义如下；G2 语料按本表写 `expected-report.json`。fact 层 = `sql|sql-pair|count|exists|file`（类型上 `VuResultFact` 强制 witness）；`command`/`agent` 不属 fact 层。

| checker | `rows_scanned` 口径 | `rows_matched` 口径 | 空范围（scanned=0） | 零匹配（matched=0） | 依据字段 |
|---|---|---|---|---|---|
| `sql`（**谓词形态**，r11 R1） | **域内行数**：与 find 同一次渲染的 `scan` 域（无 scan 时 = 源表行数；find 判据 `where` 不进 scope） | 违规行数 | **NEEDS-MATERIAL** | **PASS**（无违规） | `predicate.scan`/`fail_when` |
| `sql`（**手写形态** + `scope_sql`） | `scope_sql` 返回的单行单列非负整数 | 违规行数 | **NEEDS-MATERIAL** | **PASS**（无违规） | `fail_when`/`scope_sql` |
| `sql`（**手写形态**，无 `scope_sql`） | 源表行数回退（构造守卫要求 sql 自带 WHERE，否则 ERROR） | 违规行数 | **NEEDS-MATERIAL** | **PASS**（无违规） | `fail_when` |
| `sql`（fail_when=rows==0，找缺失） | 源表行数合计 | 命中行数 | **NEEDS-MATERIAL** | **FAIL**（应存在） | `fail_when` |
| `sql-pair` | 两侧键并集数 | **违规对数**（与契约示例 `rows_matched:3` 对齐） | **NEEDS-MATERIAL**（无可比键） | **PASS 当且仅当 violations=0**；键集不相交 → **FAIL** | `compare`/`cardinality` |
| `count`（from/sql） | 上游行数或源表行数 | 计数结果 | **NEEDS-MATERIAL** | 由 `op`+`value` 判定（0 本身是合法计数） | `op`/`value` |
| `exists`（expect=true，找存在） | 源表行数 | 命中行数（0/1+） | **NEEDS-MATERIAL**（引擎装配期降级，非检查器内判） | **FAIL** | `expect` |
| `exists`（expect=false，找不存在） | 源表行数 | 命中行数 | **NEEDS-MATERIAL** | **PASS** | `expect` |
| `file` | 提交物文件总数 | glob 命中的文件数 | **NEEDS-MATERIAL**（目录为空） | `min`/`require` 缺省时 **PASS**；`min>0`/`require` 命中缺失 → **FAIL** | `min`/`max`/`require` |
| `command`（**执行事实，不属 fact 层**，不进 §2.1 折叠判据；见 md §6.1） | — | — | 仅以 `expect_exit`/`stdout_matches` 判 | 同左 | `expect_exit` |
| `agent` | —（review 层） | — | 缺凭证/无 review runner → **ERROR** | 由 rubric 判 | `rubric`/`pass_if` |

> **聚合对（sql-pair 双侧聚合，r9 E3）**：两侧都是谓词聚合时必须各自先算 scope——任一侧 `rows_scanned=0` → **NEEDS-MATERIAL**（批号打错/漏批时两侧 SUM 都是 NULL，「同构缺失」不能判相等）。谓词侧与 rowset 侧混用 → 构造期 **ERROR**（键空间不相交）。

> **count/exists 谓词形态的扫描面（1.0 已知局限，r11 R2）**：`count`/`exists` 的谓词形态当前用 `SELECT count(*) FROM <from><where>` 直接取数，witness 的 `rows_scanned` 取的是**该次查询的扫描行数**（即源表/域行数），而不是「判据命中数」。因此在「期望 0 命中」的场景里，`sql` 形态仍可能出现「0 行 ⇒ 无违规行可看」的空转嫌疑——这个口径 1.0 冻结不改，1.1 收紧为「谓词形态的 count/exists 与 sql 形态同规则：先算 scan 域行数，域为空即 NEEDS-MATERIAL」。

> **review 层字段口径**：`ReviewFinding.checkpoint` 是 rubric 检查点 id 的正式通道（reason 前缀 `rubric:<id>` 仅为兼容）；只有**同一 VU** 的 ok findings 能覆盖检查点（跨 VU 冒领按未覆盖处理）。`spec.materials_sha256` 给出时，run 会在开 review 前复核材料哈希，不一致 → ERROR（W15）。
>
> **锚点 locator 校验（W8）**：引擎保证 quote 在冻结材料里逐字复读、locator 非空；quote 是否落在 locator 指向的 span 内，需 prepare 阶段带 material_index 才可判，v1 在报告里标注 `anchor_locator_unverified`，M13-2 收敛。

> **file 型 v1 能力边界（裁定 A/B/C 之 B）**：只判**结构/签名/清单**类事实——文件存在性、命中数量、行数、sha256、页数。**不做 OCR、不做内容语义理解**（图片里的金额、PDF 里的条款都不读）。带内容级判据的用例在报告里标 `dim: "content-pending-M13-2"`，不得算作已覆盖。
- 证据行 **canonical 排序**（主键升序、NULL 置末）——否则「逐字重放」不成立。
- **规范化算法**（评审 R10）：报告与语料比对一律走 **JCS 子集**（RFC 8785）：①对象键按 UTF-16 码元升序 ②数字按 ECMAScript `Number::toString` 形态输出（含 `1e+21`/`1e-7`，`-0` 归一为 `0`），NaN/Infinity 拒绝——即 JCS 原口径，不用"定点小数"限制③时间统一 RFC 3339 UTC 毫秒 ④字符串 NFC ⑤数组保序。TS 与 Rust 必须共用同一 serializer——TS 实现是 `packages/verify/core/src/canonical.ts`（`canonicalStringify`/`canonicalTimestamp`），跨实现向量在 `packages/verify/core/corpus/canonical/vectors.json`（**只增不改**，改 = 升版本），Rust 侧必须逐条对上。对象里值为 `undefined` 的键视同不存在（与 `JSON.stringify` 的可选字段语义一致）；数组里的 `undefined` 拒绝。**相对 RFC 8785 的三条有意偏离**（r10 F4，均写进 vectors 与测试）：①字符串先做 NFC 再转义（JCS 要求原样，但我们的材料来自 OCR/多语言文档，不归一同一句话就有两种哈希）②对象里 `undefined` 整键省略（JCS 未定义，不省略则"字段在内存里有但没值"会让哈希随实现漂）③只接受纯对象（Date/Map/类实例直接拒绝，JCS 对它们没有通用投影——把 `Date` 序列化成 `{}` 是伪装成功）。
- `schema_fingerprint` **方言相关**：SQLite 按 `sqlite_master` 表名+规范化 DDL 元组排序哈希；PG 按 `information_schema.columns` 的 (table,column,type,notnull) 元组排序哈希。prepare 冻结的值只能与同方言 run 比对，跨方言比对一律 ERROR。
- `payload_sha256`：整份报告除该字段外的规范化哈希（import 前可校验文件未被手改，评审 B3）。
- 报告**不可变**：重跑生成新 `run_id`。

## 3. 语料条目（corpus，`corpus/<case>/`）

```
corpus/
  <case>/
    case.json          # { id, title, targets: ["sql","sql-pair",…], dialect: ["sqlite","pg"],
                       #   expect: "expected-report.json", tags: ["vacuous","tolerance-boundary","duplicate-key",…] }
    spec.json          # 被验证的规范（输入）
    db.sqlite          # fixture 数据库（sql 型用；PG 用 schema.sql + data.sql）
    attachments/       # file/agent 型用例的附件（含 sha256 清单）
    mock/              # agent 型：mock gateway 请求-响应对（录制回放）
    expected-report.json  # 期望报告（除 started/finished/run_id/binary_sha256/payload_sha256 外逐字比对；浮点 canonical 化）
```

**parity 门禁**：`{SQLite, PG} × {TS, Rust}` 四向逐字一致；任一不一致 → 门禁红，先改语料再改实现。
**矩阵门禁（G2）**：七型 × 七域边界（空表/空集/全 NULL/重复键/容差边界/负值/大数/Unicode/时区窗口）至少各一条案例。
**红队门禁（G3）**：≥8 例故意松弛/错误规格必须 100% 被拒（恒真谓词、错列、同源期望、无 WHERE、全匹配 glob、含税误读）。

## 4. 命令面（M13-1 实现目标）

```
verify list
verify submit --title <t> --text <一句话> --attachment <file>…      # 注册材料（baseline=source / submission=附件）
verify prepare <spec>                                               # 提取→翻译→自审（盲审 ≤3 轮，含红队）
verify run <spec> [--db file] [--pg url] [--attachments <dir>] [--json]
verify report <run_id> [--json]                                     # 复核历史报告
verify report import <report.json>                                  # 二进制跑回的报告入库（校验 binary_sha256/spec_version/payload_sha256）
verify trace <spec> [--json]                                        # 构造追溯（只读）
verify export <spec> --out <file>                                   # 构建原料 .yglverify.json
verify archive <run-id|spec-id> [--with materials|snapshot|binary|all] [--out <file>]
verify archive verify <file.yglverify.zip>                          # 重算归档全链
verify list --unarchived                                            # 跑过但没归档的 run
```

> 命令名唯一：`verify report import`（fdc757f6 ②，与设计文档 §8.5.1 同步；曾写作 `import-report`）。

**rc 契约**：`0`=跑完出报告（含 FAIL/NM/ERROR 结论）、`1`=运行错误、`2`=用法错误。判定在报告不在退出码。

**`--db` 语义（r15 P1-1）**：在 `verify` 组里 `--db <file>` 一律指**业务库快照**（run/prepare 的取数对象），工作区库固定是 `$YGL_HOME/ygl-trees.db`——verify 命令不会打开业务库做 ygl schema 迁移，也不写它；`run` 先复制快照再读，`data_source.sha256` 记的是**原始字节**。这是「证据可复核」的前提：任何会改写源库的路径都不该出现在验证链上。

**`--no-archive`**：`run` 默认归档（契约 §7），`--no-archive` 跳过；归档失败不改写报告、但 rc=1（过程错误）。

**未知旗标**：verify 组每个动作有旗标白名单，未知旗标一律 rc=2 并点名（`unknown flag for verify run: --attachment`）——构造期静默比报错危险。

**注（W7）**：`scope_sql` / `sql` 的同表守卫依赖 FROM/JOIN 粗提取——对子查询、CTE、视图展开是尽力而为；提取不到时守卫静默跳过，不视为通过证据。prepare 阶段应以同一 predicate 模板生成两段查询（同源生成才是强保证，守卫只是兜底）。


## 4.5 review 层契约（B6 可验收形态）

review（agent 型）与 fact 型同样有可验收形状，不是"再问一次模型"：

```jsonc
// ReviewFinding（复核器必须逐条给出，缺一条即不通过）
{ "vu_id": "V2", "question": "faithful|decidable|not-vacuous",
  "verdict": "ok|reject|unclear", "reason": "…",
  "anchor": { "quote": "<材料原文逐字片段>", "locator": "p1 第 2 行 / sheet!B7" } }
```

机械判定（引擎侧，fail-closed）：

| 情形 | 结论 |
|---|---|
| 任一问 `reject` | FAIL |
| 任一问 `unclear` 或该问缺失 | NEEDS-MATERIAL |
| 同一问出现互相矛盾的结论 | NEEDS-MATERIAL |
| `faithful` 无 anchor、或引文在冻结材料里不能逐字复读 | NEEDS-MATERIAL / FAIL |
| rubric 检查点（`pass_if: all`）没有 `ok` findings 覆盖 | NEEDS-MATERIAL |
| 没有冻结材料文本（materialsText） | NEEDS-MATERIAL（盲审没有材料=没断言） |

盲审约束进接口类型：`ReviewRequest.blind` 是常量 `true`，请求体只含「冻结材料 + 待审 VU + 圈数」，**不含**构造理由、修订历史、历史结论。review 轮次建议 ≤3（§4.3）。

## 4.6 语料版本纪律（裁定 A/B/C 之 C）

- 每个 ygl-trees 版本 = 一次**冻结语料快照** + G2/G3/G4 全量跑（不按日历排期）。
- 语料**只增不改**：已冻结案例的文件内容是否定不得的（改了就再也证明不了旧版本行为）；要改 = 升 `corpus_version` 并在 CHANGELOG 记差异。
- `contract_version` 钉 `1.0` 时同时钉 `corpus_version`；此后二者各自独立自增，报告里两个版本号都记。
  （2026-10-20 起二者均为 `1.1`：contract 1.1 是封包签名身份字段，corpus 1.1 是 33 份 spec 随契约升版重铸。）
- 时间字面量纪律（W1b）：`window` 只接受「纯日期」或「带时区的 datetime」；`'2026-07-01 10:00:00'` 这类无时区时间戳构造期 ERROR（否则 Date.parse 按本机时区解释，换台机器窗口就漂）。
- 真实网关凭证在 M13-1b（封包 fact-only 闭环）之前**不接**：review/prepare 层的模型调用一律走注入接口，测试用假 runner。

## 5. 封包元数据（footer，评审 B3）

```
[engine 字节][spec 字节][footer]
footer = magic("YGLVF1") | offset(u64) | length(u64) |
         spec_sha256 | engine_version | corpus_version | build_sha256 | [signature]
build_sha256 = H(engine || spec)          # 不含 footer 自身（含自身即自指循环）
```

- build 完成同步登记 artifact（kind=verify-binary）：`{spec_id, spec_version, engine_version, corpus_version, platform, binary_sha256, build_at, signature?}`。
- `verify report import` 校验：binary_sha256 命中登记 ∧ spec_version 匹配 ∧ payload_sha256 一致；任一不符 → 拒绝并点名。
- 自检：`self-check` 重算三段并比对；`--expect <sha256>` 提供带外比对通道；可选 ed25519 签名（公钥带外分发）。

**1.0 实现形态（Rust `yglverify`，2026-10-20）**——上面是语义布局，实际字节是：

```
[engine 字节][spec json (JCS)][footer json (JCS)][footer_len: u32 LE]
footer = { magic:"YGLVF1", format_version:1, spec_offset, spec_length,
           spec_sha256, engine_sha256, build_sha256,
           engine_version, corpus_version,
           sig_alg:"ed25519", key_id, sig }          # 后三项可选；无 format_version = legacy unsigned
```

- `seal --spec <spec.json> --out <file>` 产出封包：拷贝当前开放的二进制 + 内嵌 spec + footer；**已封包的二进制拒绝二次 seal（rc=2）**。
- **legacy（无 `format_version`）读取纪律**：0.98.0 及以前的 footer 由 serde 序列化（字段序不是 JCS 字典序）、spec 也可能带缩进，因此「raw == JCS(parse)」规范形断言**只对 `format_version` 存在的 footer 与 spec 生效**；legacy 仍逐项校验 magic / 布局 / `spec_sha256` / `build_sha256`（若有 `engine_sha256` 也比），并按 **unsigned** 报告身份（`register` 记 `signature.signed=false`，绝不假称已验证）。
- `run` 解析顺序：先看自身是否封包 → 封包且给了 `--spec` 一律 **rc=2**（改规范必须重打二进制）；封包且没给 `--spec` 用内嵌规范，报告 `verifier.mode="sealed"`、`verifier.binary_sha256 = "sha256:" + H(整个封包文件)`；开放构建仍可 `--spec`（`mode="open"`、无 `binary_sha256`）。
- 篡改检测 fail-closed：spec 字节与 `spec_sha256` 不符、或 `engine||spec` 与 `build_sha256` 不符 → **rc=1 点名**；尾部结构是封包但校验不过时**不得**当开放构建继续跑（`looks_sealed` 判别）。
- `self-check` 在封包构建上多打一行 `sealed-spec: ok (<spec_id> v<n>, build <build_sha256>, corpus <version>)`；开放构建打 `sealed-spec: skip (open build)`。
- `verify register <sealed-binary>` 解析 footer 并复算两条哈希（spec_sha256 / build_sha256），写 `registrations/<key>.json`（spec_id/version、engine、corpus、platform、size）与 `binaries/<key>.bin` 副本；`<key>` 是去掉 `sha256:` 前缀的十六进制（冒号在 Windows 文件名非法）。
- `verify report import` 在登记命中时，若 `specs/<spec_id>/spec.json` 不在工作区，就从 `binaries/<key>.bin` 的封包里恢复内嵌 spec（报告 + 二进制是自描述包，工作区只是缓存）；随后 `verify archive --with binary` 可把登记/二进制一起收进归档并重算全链。
- **签名（1.1 起）**：签名输入 = `JCS(去掉 sig 的 footer)`；`sig_alg`/`key_id` 在签名输入内、`sig` 不在。
  `key_id = sha256(32 字节原始公钥)` 小写 hex。验签**认表不认报文**：`key_id` 必须命中 `docs/verify-signing.md` 密钥表且未 `retired_at`，
  签名必须验过；公钥不得只由报告/封包自带材料自证。轮换只增不换（旧 key 标 `retired_at` 保留）。
  `verify signature <sealed>` 验签（0=过，1=不过/不是封包，2=用法）；`register` 对签名构建先验签再登记，
  `report import` 对已登记签名构建重新验签并核对报告 `verifier.public_key_fingerprint`；验签失败一律 rc=1，不回落开放模式。
  细节与事故处置见 [verify-signing.md](./verify-signing.md)。

## 6. 状态

- **v1.4（2026-10-20）**：`contract_version` 升 **1.1**、`corpus_version` 升 **1.1**——报告 `verifier` 增 `signature` / `signing_scheme` / `public_key_fingerprint` 三个可选字段；封包 footer 增 `format_version` / `engine_sha256` / `sig_alg` / `key_id` / `sig`（语义布局与字节布局合一，§5）。TS 与 Rust 各自实现 ed25519，固定种子下签名逐字节一致（`seal-parity.spec.ts`）；五向篡改矩阵（spec 字节 / engine 字节 / 非规范 footer / 签名字节 / 未知或退役 key / format_version）全部点名拒绝。语料 digest 因 33 份 spec 的 `contract_version` 升版而变：`4cac21b4f5bc…`（差异仅版本字段，见 `packages/verify/core/CHANGELOG.md`）。
- **v1.3（2026-10-20）**：双实现 parity 从「投影一致」升级为「整份报告逐字节」——`rust-parity.spec.ts` 33 例剥 `data_source` 后 `canonicalStringify` 全等，且把环境锚注入 TS 侧后两边重算的 `payload_sha256` 三方相等；Rust 侧补齐 `data_source`、`guard`、`artifacts`、`exceptions`、`evidence.rows`/`rendered`、`reason` 折叠文案与真实 `started/finished`（`--now` 可钉）。`contract_version` 仍 1.0（Rust 追平 TS，不是形状变更）。
- **v1.2（2026-10-20）**：Rust `yglverify` 补封包形态（§5 实现形态：`seal` / 内嵌 spec / 拒绝 `--spec` / 双哈希篡改检测 / `self-check` 的 `sealed-spec` 行）；`contract_version` 仍 1.0（交付形态，不是 spec/report 形状变更）。
- **v1.1（2026-10-20）**：新增 §7 归档包（命名语法 / 包内目录 / 确定性 zip / 校验链 / 侧车登记），`verify run` 默认归档；`contract_version` 仍 1.0（归档是命令面能力，不是 spec/report 形状变更）。
- **v1.0（冻结，2026-10-19）**：v0.5 之后并入 r10 评审 F1–F6（prepare sql 分支 `$vu:` 收窄、window 的 `±hh` 偏移归一、M13-1 拒 agent 型 + `sealed.review=false`、as_of 必由调用方给、canonical 拒非纯对象、数字口径改 ES 形态并写明三条相对 RFC 8785 的有意偏离）；引擎入口加契约版本守卫（1.0 引擎只跑 1.0 spec）；报告增 `spec_id` / `data_source` 两个可选自描述字段。**冻结**：`contract_version = "1.0"`、`corpus_version = "1.0"`；此后形状变更走 1.0→1.1 升版，不得静默改 1.0 内文。
- v0.5：r9 评审 E1–E5 落文与修复（sql-pair 谓词侧键名/同族守卫、空批聚合对 NEEDS-MATERIAL、sql/count/exists 禁 agg、±hh 偏移归一、prepare P2 白名单与 schema 全量校验、`$vu:` 收窄、附件 sha256 进 spec、P3/P4 配置错误归 `error`）+ JCS canonical 落地实现与跨实现向量 + §1.6 prepare 五阶段规则表。
- v0.4：评审 R7–R13 落文（CompareSpec 单一形状 + ε 规则 / 零匹配按型 / task 副作用统一 / JCS canonical + 方言相关指纹 / as_of 时间函数构造期拒绝）+ 实现缺口 a–f 修复（source 失败级联 ERROR、`$vu:` 命名空间、schema 漂移 ERROR、glob 根目录、无 assert 拒绝、witness 口径重写）。
- v0.3：评审 302cb119 R1/R2/R3/R4 契约面落文（witness 语义表 / count from-sql 互斥 / attachments 新表裁定 / VuResult witness 类型强制）。
- v0.2：已并入 fdc757f6 D0 快检三条（sql-pair 互斥 / 命令名统一 / 七型形状齐为冻结前置）与 302cb119 B1/B2/B3/B5 契约面（overall+severity / witness / footer+登记 / CompareSpec+as_of）。**未冻结**。
- 冻结动作：上述冻结条件三条满足后，`contract_version` 钉 `1.0` + CHANGELOG 记录 + 双评审收尾回执。

## 7. 归档包（`verify archive`，默认动作）

`verify run` 结束即归档（`--no-archive` 可关）；归档是**默认动作**，材料字节默认入包，快照与二进制按需。
报告保持不可变：归档身份写在工作区侧车 `$YGL_HOME/verify/archives/<run_id>.json`，不改写 `report.json`。

### 7.1 文件名规范

```
yglverify-<domain>-<slug>-v<spec_version>-<utcstamp>-r<run8>.yglverify.zip
```

| 段 | 语法 | 来源 |
|---|---|---|
| `domain` | `[a-z][a-z0-9]{1,15}`，非法/缺省 → `general` | `spec.domain` |
| `slug` | `[a-z0-9]+(-[a-z0-9]+)*`，≤40；折叠为空 → `s<spec_id 后 8 位>` | `spec.title` |
| `v<n>` | `\d{1,4}` | `spec.spec_version` |
| `utcstamp` | `\d{8}T\d{6}Z`（UTC 秒） | 归档创建时刻（不是 `as_of`） |
| `run8` | `[0-9a-f]{8}` | `run_id` hex 前 8 位 |

全 ASCII、无空格、≤120 字节；manifest 记 `filename`，`archive verify` 对改名只告警（身份在哈希不在名字）。

### 7.2 包内目录规范（唯一布局）

```
manifest.json
report.json
spec.json
prepare.json  (可选)
trace.json    (可选)
materials/<material_id>/material.txt
materials/<material_id>/files/<sha12>-<safe-basename>
snapshot/<sha12>.sqlite      (仅 --with snapshot)
verifier/registration.json   (仅 --with binary 且存在登记)
verifier/binary/yglverify    (仅 --with binary 且存在字节)
```

规则（违反 → 拒绝归档/拒绝校验）：顶层只允许固定名；空目录不建；POSIX `/`；深度 ≤4；全路径 ≤240、单段 ≤100；
包内名 ASCII 化（`[A-Za-z0-9._-]`，其它 → `_`，截断 60，Windows 保留名加 `_` 前缀），原文件名记 `items[].original_name`；
大小写不敏感 + NFC 冲突拒绝；禁 `..`/绝对路径/盘符/反斜杠/尾随点空格。

### 7.3 确定性

store-only zip（不压缩）、条目按路径字节序、mtime 固定 `1980-01-01T00:00:00Z`、外部属性 `0644`、无目录条目/extra/comment
→ 同输入同字节，`zip_sha256` 跨平台可复算。`archive_sha256 = sha256(canonical(manifest 去掉 archive_id/archive_sha256))`，
`archive_id = arc_<archive_sha256 前 12>`。
`manifest.created` 缺省取 `report.finished`（报告不可变 → 同一 run 反复归档字节相同）；显式 `created` 才改变文件名里的时间戳。
`buildArchive` 拒绝没有 `payload_sha256` 的报告（否则产出必然过不了 §7.4 链）。

### 7.4 校验链（`verify archive verify`）

条目路径规范 → 每条 item 的 sha256/size → `archive_sha256` 重算 → 未声明条目点名 →
`report.payload_sha256` 重算 → summary/overall **按 VU 结果重算**并与报告比 → `contract_version`/`corpus_version`/`spec_version`/`run_id` 一致 →
`materials_sha256` 与 spec 一致；`manifest.engine_version` 与 `report.verifier.engine_version` 一致。
任一环失败 rc=1 并点名文件；判定结论（PASS/FAIL）不在归档校验里表达。

### 7.5 rc 与默认策略

`archive` 成功 rc=0；run 时归档失败不改写报告但 rc=1（`--json` 带 `archive_error`）；`--no-archive` 仅跳过归档。
默认落点 `$YGL_HOME/verify/archives/<filename>`（`--out` 覆盖）——归档不写调用者 cwd，仓库不会被 `*.yglverify.zip` 污染。
`verify list --unarchived` 列出「有报告无侧车」的 run——不阻塞 run，但交付判据可要求为空。
**跨实现快照（r14 R1）**：`archive --with snapshot` 默认只认工作区里 retained 的快照（`$YGL_HOME/verify/snapshots/<sha>.sqlite`，sha 从报告 `data_source.sha256` 派生，统一 `sha256:<hex>` 形态）。Rust 直跑的报告没有 retained 快照，此时用 `--snapshot <db>` 显式交同一份字节：归档前按报告 sha 校验，不符 `--snapshot … does not match report.data_source.sha256 (report <a>, file <b>)` 直接拒，不产半包。

### 7.6 `verify self-check`（递归验证单入口）

```
verify self-check [--corpus <dir>] [--no-cases] [--limit N] [--json]
```

按「由便宜到贵」跑六环，映射递归验证层：

| 项 | 层 | 判据 | 缺数据时 |
|---|---|---|---|
| `environment` | L8 | node / platform / contract_version / corpus_version | — |
| `canonical-vectors` | L0 | `corpus/canonical/vectors.json` 逐例 `canonicalStringify(input) === expected` | skip |
| `corpus-digest` | L1 | 重算 `corpusDigest()`（cases/** + vectors.json）与 `manifest.json` 一致，漂移点名 changed/added/removed | skip |
| `shapes` | L3 | `corpus/shapes/*.shape.txt` 存在且每行符合 `path:type` | skip |
| `corpus-cases` | L2 | 实跑全部语料（含红队）并比对 expected 投影；`--no-cases` 显式关 | skip |
| `archives` | L6 | 逐侧车重算归档校验链（`archive verify` 同一实现） | skip |

`archives` 在**目录为空**时也报 SKIP（没有可验对象 ≠ 验过），只有真的逐包重算过才报 ok。

**SKIP 不等于 OK**：没有语料时报 SKIP 并在详情里说明缺少路径（`--corpus` / `YGL_VERIFY_CORPUS`），
不允许静默显示通过——发布产物不含 `corpus/`，这正是该命令在出厂形态下必须诚实的地方。
rc：全项非 fail → 0，任一项 fail → 1；`--json` 输出 `{ok, items[], environment}`。
