---
name: contract-1.3-proposal
description: "#80 谓词扩容三边界的契约 1.3 提案（总工裁 direct-a7b1e30a C；提案先行·两席+属主）"
kind: 参考
---

# 契约 1.3 提案：verify 谓词扩容（pragma / 派生表 / view）

> 状态：**提案**（按纪律需评审席+总工席两席过目、属主裁后才动 CONTRACT_VERSION）。
> 基线：CONTRACT_VERSION = "1.2"（2026-10-21）。

## 提案动机

七型检查器当前只能查**基表**；真实判据常需要 pragma 信息（schema 版本/索引）、临时聚合（派生表）、或可复用查询面（view）。但快照 sha256 是证据链锚——任何 DDL 触碰主快照等于改证据面。

## 三边界（裁文照录 + 落地面）

### ① pragma：只读白名单

- 新判据形态 `predicate.pragma`，白名单：`table_info` / `index_list` / `user_version`。
- **禁**：`writable_schema` / `foreign_keys` / 任何可改连接状态的 pragma（prepare P4 守卫拒绝，spec_error=pragma_not_allowed）。
- 落地：`renderPredicate` 扩展 + P4 守卫清单。

### ② 派生表：:memory: 独占

- `predicate.from` 允许 `WITH x AS (...) SELECT` 形态时，派生表物化在 **:memory: 独占连接**。
- P2 红队新增断言：**派生表 SQL 不得引用主快照路径**（attach/文件路径出现 → 拒）。
- 落地：engine runner 分离 snapshot 连接与 scratch 连接。

### ③ view：仅 :memory: + snake_case 冻结词表 + 登记面

- `CREATE VIEW` 只允许在 :memory: scratch 连接执行。
- 视图名 snake_case，**冻结词表**（spec 内 `views: []` 登记段）；P2 增检查：**spec 里 from 引用的视图必须在登记面内**。
- **from 引用未登记视图 = 红 → 并入 G3 真调用门族**（评审过程门：tools/list 出现不算证明，引用必须是登记过的）。
- 落地：contract.ts spec schema + prepare P2 + verify:run 引擎。

## 兼容性

1.2 spec 在 1.3 引擎下行为不变；声明 1.2 却用 1.3 形态 → 入口拒（version_shape，同 1.1→1.2 先例）。
Rust 二实现同批升级（parity 冻结语料加 1.3 例）。

## 判据锚（每项红→绿对照）

| 项 | 红例 | 绿例 |
|---|---|---|
| pragma 白名单 | writable_schema → spec_error | user_version → 判定 |
| 派生表隔离 | SQL 引主快照路径 → 拒 | 纯 memory WITH → 判定 |
| view 登记 | from 未登记视图 → 红（G3） | 登记后引用 → 判定 |
