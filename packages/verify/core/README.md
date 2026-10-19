---
description: "Spec-driven deterministic verifier core: seven checker types, $vu pipeline refs, scope witness, verdict folding, corpus harness"
kind: "package-reference"
---

# @ygl/verify-core

M13 **spec-validator** 的 TS 参考实现：把「业务专家的一段话 + 附件」冻结成可重放的验证规范（spec），
在数据源上跑出可审计的报告（report），零人工确认。

契约真相在 [`docs/verify-contract.md`](../../../docs/verify-contract.md)（当前 v0.4，**未冻结**）；
设计叙事在 [`docs/spec-validator.md`](../../../docs/spec-validator.md)。

## 这是什么

- **七型 checker 闭集**：`sql | sql-pair | count | exists | file | command | agent`
  （前五型属 fact 层、强制 scope witness；`command` 是执行事实；`agent` 需 review 层，封包默认拒绝）
- **判定折叠**：`FAIL > NEEDS-MATERIAL > ERROR > PASS`，只算 `role=assert`；`source` 不参与折叠
- **防空洞**：零扫描→NEEDS-MATERIAL；无 WHERE 且无 `scope_sql`→ERROR；无 assert 的规范构造期拒绝
- **比较契约**：`CompareSpec` 单一形状（exact 无 ε / tolerance 0<ε / unit 只属 window / range 用上下界；
  币种按最小单位整数比较，禁浮点直比；NULL 默认 error）
- **确定性**：`as_of` 必须锚定；SQL 里的 `now()/CURRENT_TIMESTAMP` 构造期拒绝；`$` 占位不展开
- **管线**：`$vu:<id>` 引用（仅 `count.from` 与 `sql-pair` 侧），拓扑执行 + 环检测 + 失败级联

## 用法

```ts
import { runVerify, SqliteRunner } from "@ygl/verify-core";

const runner = new SqliteRunner("case.sqlite");     // 只读 + PRAGMA query_only
const report = await runVerify(spec, { runner, submissionDir: "attachments/", commandAllowlist: ["node"] });
console.log(report.overall, report.summary);        // 判定在报告里，不在退出码里
```

## 语料（corpus）

红队案例用 `case.json` 的 `expect_throw: "<regex>"` 表达「必须被拒绝」（不写期望报告）；每条红队案例各自钉住拒绝理由，门禁不做 join 匹配。

`corpus/cases/<case>/` 每例含 `case.json`（元数据/标签）、`db.sql`（SQLite 种子，文本可 review）、
`spec.json`、`expected-report.json`（**期望投影**：overall/summary/verdict/witness 口径）。
`corpus/run.ts` 逐例物化数据库、跑引擎、与期望投影比对——七型各有至少一例，
`tests/corpus.spec.ts` 把这条门禁钉住。

> 逐字 parity（TS × Rust 四向）留到 Rust 侧存在、JCS serializer 两边共用之后（G4）。

## 状态

M13-1 骨架：契约 v0.4、引擎 + SQLite runner + 语料骨架（30 例：七型 8 + 红队 10 + compare 矩阵 12）、19 测试全绿。
未做：prepare/自审链、命令面（CLI）、封包器（M13-1b）、Rust 二进制。
