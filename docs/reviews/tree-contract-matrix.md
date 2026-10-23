---
name: tree-contract-matrix
description: A1 tree run 契约对照表（机器生成，禁手改；status 来自 vitest JSON + git）
kind: 评审
---

# A1 tree run 契约对照表（机器生成）

> 生成：`node scripts/tree-contract-matrix.mjs --results <vitest.json>`；commit **dadf3e0**，tag **v0.114.22-2-gdadf3e0**。
> 状态口径：green=对应测试通过；partial=有测试但断言面未全覆盖；planned=尚未落码；missing=清单有、测试未找到；red=测试失败。
> **不得手改本表**——改清单 `docs/reviews/tree-contract-matrix.json` 后重跑。

| # | 断言 | 来源 | 状态 | 测试 | 探针 | 证据 |
|---|---|---|---|---|---|---|
| Q1 | 聚合算子封闭集 count_fail/all_pass/quorum(N)，min/max/and/or 后置 | v0.4 Q1 | **green** | A1 tree run (runtime first cut) aggregate all_pass PASS+PASS => PASS | verify tree prepare 未知算子 → rc2 | verify-tree.spec / V16 |
| Q2 | NEUTRALIZED 独立 verdict，阻断根 PASS | v0.4 Q2 | **green** | A1 tree run (runtime first cut) aggregate all_pass NEUTRALIZED+FAIL => NEUTRALIZED | verify tree run pinned 篡改 → NEUTRALIZED | verify-tree.spec / V6 |
| Q3 | run 发起时 CLI 生成 round_id | v0.4 Q3 | **green** | A1 tree run (runtime first cut) runs a two-leaf tree: verdict, per-leaf runs, deterministic digest, events | verify tree run --json \| jq .round_id | tree report round_id |
| Q5 | tree spec 用 JSON（可机械校验/digest） | v0.4 Q5 | **green** | verify tree prepare (A1) valid tree freezes: id/sha/nodes + file written | verify tree prepare --json | verify-tree.spec |
| Q6 | 空组 prepare 拒绝 rc2 | v0.4 Q6 | **green** | verify tree prepare (A1) Q6 empty group → rc=2 | verify tree prepare 空组 → rc2 | verify-tree.spec |
| Q7 | 叶路径深度默认 16，超限 rc2 | v0.4 Q7 | **green** | verify tree prepare (A1) V12 depth > 16 → rc=2 | verify tree prepare 深度 17 → rc2 | verify-tree.spec |
| V1 | 三层嵌套一叶 FAIL → 根 FAIL，逐层 report | V1 | **green** | A1 tree run (runtime first cut) runs a two-leaf tree: verdict, per-leaf runs, deterministic digest, events | tree run FAIL 叶传播 | verify-tree.spec（两层） |
| V15 | 四态聚合矩阵 | V15 | **green** | verify tree prepare (A1) V16 unknown aggregate → rc=2 | 纯函数矩阵 | verify-tree.spec 7 例 |
| V16 | 未知聚合算子（含畸形形态）prepare rc2 | V16 | **green** | verify tree prepare (A1) V16 malformed aggregates rejected: quorum2 / quorum(2 / quorum() / all_pass() | quorum2 / all_pass() → rc2 | verify-tree.spec |
| V20 | 同 canonical tree 重复 prepare 幂等同 id | V20 | **green** | verify tree prepare (A1) V20 same canonical tree is idempotent (same tree_spec_id) | tree prepare 两次同 id | verify-tree.spec |
| V5 | 树含环 prepare rc2 | V5 | **green** | verify tree prepare (A1) V5 cycle → rc=2 | tree prepare 环 → rc2 | verify-tree.spec |
| V6 | 归档篡改 → 子树 NEUTRALIZED，根不得 PASS | V6 | **green** | A1 tree run (runtime first cut) runs a two-leaf tree: verdict, per-leaf runs, deterministic digest, events | pinned 归档追加字节 → run NEUTRALIZED | verify-tree.spec V6 段 |
| V7 | 同输入双跑 verdict_digest 逐字节相等 | V7 | **green** | A1 tree run (runtime first cut) runs a two-leaf tree: verdict, per-leaf runs, deterministic digest, events | tree run 两次 diff digest | verify-tree.spec |
| V3 | 叶 ERROR → 组/根 infra-blocked，非 FAIL | V3 | **partial** | A1 tree run (runtime first cut) aggregate all_pass ERROR+ERROR => INFRA_BLOCKED | 全 ERROR 叶 | aggregate 矩阵（CLI ERROR 叶待补） |
| G8 | tree spec pin engine/corpus/contract + JCS verdict_digest | v1.2 G8 | **planned** | — | 待裁定后落码 | v1.2 draft §8 |
| Q10 | ERROR 单一规则（A 不否决 PASS / B 至多 INFRA_BLOCKED） | v1.2 G3 | **planned** | — | 待裁定后落码 | v1.2 draft §3 |
| Q11 | 幂等键：删 run 幂等，只保留 prepare | v1.2 G5 | **planned** | — | 待裁定后落码 | v1.2 draft §5 |
| Q12 | V17 同轮自引用：pinned 必须来自已完成 run | v1.2 G6 | **planned** | — | 待裁定后落码 | v1.2 draft §6 |
| Q13 | V8 跨 workspace 信任根（本 workspace / 外钥登记） | v1.2 G7 | **planned** | — | 待裁定后落码 | v1.2 draft §7 |
| Q4 | V9 规模基线进 ratchet 第四轴 | v0.4 Q4 | **planned** | — | pnpm ratchet（待第四轴） | 附件 A |
| Q8 | subject 定义（target / target+tree / target+spec 集） | v1.2 G1 | **planned** | — | 待裁定后落码 | v1.2 draft §1 |
| Q9 | stale 谓词（round/clock/N 轮） | v1.2 G2 | **planned** | — | 待裁定后落码 | v1.2 draft §2 |
| V21 | 舰队多快照 --db node=path 绑定 | V21 | **planned** | — | 待实现/测试 | v1.2 附件 A |

## 汇总

- green: **13**
- partial: **1**
- planned: **9**
- missing: **0**
- red: **0**

