# verify 三 JSON 契约（D0 · 草案 v0）

> M13-1 的第一步：契约先行。三个 JSON 是唯一接口真相——TS 参考实现、Rust 二进制、黄金语料都只认这三个形状。
> **冻结条件**：评审席 direct-30389fca（fdc757f6）与 302cb119 两份意见收敛 + 语料骨架落库。冻结后任何变更走 `contract_version` 自增。

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
  "verifier": {
    "engine_version": "0.1.0",
    "corpus_version": "1"
  },
  "vu": [
    {
      "id": "V1",
      "role": "source",
      "title": "拉超期未对账账单",
      "severity": "S2",
      "source_clause": "每笔 FBA 头程发货必须有对应运费账单（verbatim）",
      "checker": { "type": "sql", "sql": "SELECT … WHERE …" },
      "expected_from": { "kind": "runtime-query", "note": "当前态查询" },
      "outputs": { "rows": "rowset" }
    },
    {
      "id": "V2",
      "role": "assert",
      "title": "账单金额与应付一致",
      "severity": "S1",
      "source_clause": "每张运费发票金额与对应订单应付金额一致（verbatim）",
      "checker": {
        "type": "sql-pair",
        "left":  { "table": "freight_invoices", "key": "order_id", "value": "amount", "from": "$V1.rows" },
        "right": { "table": "purchase_orders",  "key": "id",       "value": "payable_amount" },
        "tolerance": { "kind": "abs", "value": 0.01 }
      },
      "expected_from": { "kind": "material-extract", "source_id": "src_…", "anchor": "报价基准.xlsx·Sheet1·R5C3" }
    }
  ],
  "attachments": [
    { "role": "baseline", "path": "attachments/报价基准.xlsx", "sha256": "…" },
    { "role": "submission", "path": "attachments/账单截图.png", "sha256": "…" }
  ],
  "sealed": { "review": false }
}
```

**角色语义（评审 C1 钉死）**：`role:"assert"` 参与总判定；`role:"source"` 恒 PASS-by-construction、不进 summary 分母，且必须被至少一个下游 `$Vx.out` 引用。

## 2. 报告（report，`report.json`）

```json
{
  "contract_version": "1.0",
  "run_id": "run_3f9c…",
  "started": "2026-10-20T09:02:11.000Z",
  "finished": "2026-10-20T09:02:19.500Z",
  "verifier": {
    "mode": "sealed",
    "binary_sha256": "…",
    "engine_version": "0.1.0",
    "spec_version": 3,
    "corpus_version": "1"
  },
  "summary": { "pass": 3, "fail": 2, "needs_material": 1, "error": 0 },
  "overall": "FAIL",
  "vu": [
    {
      "id": "V1", "role": "source", "verdict": "PASS",
      "outputs": { "rows": { "count": 42 } },
      "evidence": { "sql_rows": 42, "sample": [] },
      "trace": "PASS-by-construction (source)"
    },
    {
      "id": "V2", "role": "assert", "verdict": "FAIL",
      "source_clause": "每张运费发票金额与对应订单应付金额一致（verbatim）",
      "evidence": {
        "violations": 2,
        "rows": [
          { "order_id": "A-1001", "invoice": 412.50, "payable": 350.00, "diff": 62.50 }
        ]
      },
      "guard": { "leniency_checks": ["not-same-source", "bounded-tolerance", "falsifiable"] }
    }
  ],
  "exceptions": [ { "vu": "V2", "severity": "S1", "row_count": 2 } ],
  "artifacts": { "attachment_sha256": ["…"] }
}
```

**铁律**：`overall = 所有 role=assert 的 verdict 合取`（任一 FAIL → FAIL；有 NEEDS-MATERIAL 无 FAIL → NEEDS-MATERIAL；仅 ERROR → ERROR）；`summary` 计数以 assert 为分母，source 单列 trace。报告**不可变**，重跑生成新 run_id。

## 3. 语料条目（corpus，`corpus/<case>/`）

```
corpus/
  <case>/
    case.json          # { id, title, targets: ["sql","sql-pair",…], dialect: ["sqlite","pg"], expect: "expected-report.json" }
    spec.json          # 被验证的规范（输入）
    db.sqlite          # fixture 数据库（sql 型用；PG 用 schema.sql + data.sql）
    attachments/       # 文件型用例的附件
    expected-report.json  # 期望报告（除 started/finished/run_id/binary_sha256 外逐字比对）
```

**parity 门禁**：`{SQLite, PG} × {TS, Rust}` 四向逐字一致（除时间戳/run_id/二进制哈希）；任一不一致 → 门禁红，先改语料再改实现。

## 4. 命令面（M13-1 实现目标）

```
verify list
verify submit --title <t> --text <一句话> --attachment <file>…      # 注册材料（source）
verify prepare <spec>                                               # 提取→翻译→自审（≤3 轮）
verify run <spec> [--db file] [--pg url] [--json]
verify report <run_id> [--json]
verify trace <spec> [--json]                                        # 构造追溯（只读）
verify export <spec> --out <file>                                   # 构建原料 .yglverify.json
verify import-report <report.json>                                  # 二进制跑回的报告入库
```

## 5. 状态

- v0 草案：字段名/形状按已批准设计（§5.1 角色、§5.5 管线、§8.5.1 封包）书写，**未冻结**。
- 冻结动作：①评审双签收敛；②corpus 骨架 ≥7 型 ×3 案例落库；③`contract_version` 钉为 `1.0` 并在 CHANGELOG 记。
