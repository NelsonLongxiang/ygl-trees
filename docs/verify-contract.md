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
        "compare": { "mode": "tolerance_abs", "value": 0.01, "unit": "day", "currency": "CNY", "scale": 2, "cardinality": "1:1", "null": "error" }
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

- `role`：`assert` 参与总判定；`source` 恒 PASS-by-construction、不进 summary 分母，且必须被至少一个下游 `$Vx.out` 引用（否则空转，构造拒绝）。
- `severity` ∈ `S1|S2|S3`：构造阶段按判据语气赋值（必须/不得→S1，应→S2，建议→S3），自审只可上调；**不改变 overall 数学**，只影响呈现顺序与处置优先级（S1 FAIL/NM 自动开 task）。
- **checker 形状互斥**：`checker` 是**标签联合**——`type` 决定其余键。`sql-pair` 的每一侧是 **`from`（rowset 引用）或 `table`（基表）二选一，不得并存**（fdc757f6 ①）；`from` 在位时 `key`/`value` 指 rowset 列名，`table` 无意义。
- **CompareSpec**（评审 B5）`compare`：`mode ∈ exact|tolerance_abs|tolerance_rel|window|subset|superset|range|regex`；`currency`+`scale` 必填则按最小单位整数比较（禁浮点直比）；`cardinality ∈ 1:1|1:N|N:1`（默认 1:1，重复键→ERROR 点名；`1:N` 须带 `agg`）；`null ∈ error|equal|ignore`（默认 error）。
- `expected_from`：值三源之一——`material-extract`（带 `anchor` + **`quote` 原文复读**，锚点可机械核对）、`explicit`（专家显式给出）、`runtime-query`（运行时查询）；prepare 时冻结。
- **附件两阶段**（评审 B4）：`baseline` 在 submit 冻结（值进 spec）；`submission` 的字节在 run 时校验 `sha256`（同路径换内容=新附件行）；附件走 content-addressed blob（sha256/size/mime），不参与 FTS。
- `as_of`（评审 C2）：所有时间窗口与 `now()` 必须锚定——`kind: snapshot`（SQLite 用文件哈希，PG 用只读事务快照 id）。
- `sealed.review`：封包是否允许 review 层（默认 false；`--with-review` 置 true）。

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
- `witness`（评审 B2）：每个 fact checker 必须输出；`rows_scanned=0` → 该 VU 判 **NEEDS-MATERIAL**；期望非空而 `rows_matched=0` 同判；`schema_fingerprint` 与 prepare 冻结值不一致 → **ERROR**。
- 证据行 **canonical 排序**（主键升序、NULL 置末）——否则「逐字重放」不成立。
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
```

> 命令名唯一：`verify report import`（fdc757f6 ②，与设计文档 §8.5.1 同步；曾写作 `import-report`）。

**rc 契约**：`0`=跑完出报告（含 FAIL/NM/ERROR 结论）、`1`=运行错误、`2`=用法错误。判定在报告不在退出码。

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

## 6. 状态

- v0.2：已并入 fdc757f6 D0 快检三条（sql-pair 互斥 / 命令名统一 / 七型形状齐为冻结前置）与 302cb119 B1/B2/B3/B5 契约面（overall+severity / witness / footer+登记 / CompareSpec+as_of）。**未冻结**。
- 冻结动作：上述冻结条件三条满足后，`contract_version` 钉 `1.0` + CHANGELOG 记录 + 双评审收尾回执。
