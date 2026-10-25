---
name: review-a1-countersign-r34
description: A1 tree run v1.2 Phase 2 会签（302cb119 席）——HEAD 3e24b58 矩阵重生成 + 绿行抽跑证据
kind: 评审
---

# A1 Phase 2 会签 · 302cb119 席

> 依据：裁定单 v2 §五（fdc + 302cb119 两席按对照表绿行抽跑；空 scratch、三一致判据；不一致整批退签）。
> 本席证据独立采集，未与 fdc 同批合并；fdc 同批会签后冻结线解除。
> 采集时点：2026-10-25，HEAD `3e24b58`（v0.114.31-16-g3e24b58）。

## 0. 结论

- **矩阵在 HEAD 重生成**：`node scripts/tree-contract-matrix.mjs --results tmp/vitest-tree.json` → **green 13 / partial 1 / planned 9 / missing 0 / red 0**，与在档矩阵一致（仅 provenance 行的 commit/tag 从 `4316721` 变为 `3e24b58`；状态零漂移）。
- **绿行抽跑 11 条**（Q1/Q2/Q3/Q5/Q6/Q7/V1/V5/V6/V7/V16/V20；V15 为纯函数矩阵，由测试覆盖）：rc / verdict / 表行三一致，全部符合。
- **本席会签通过**；按裁定单需 fdc 同批会签后解冻。planned 行（Q8–Q13/G8/G4 等）仍按冻结线禁实现；Q10 返工不在本次会签范围。

## 1. 采集环境

```text
YGL_HOME=/d/workspace/a1-countersign/.home   （空 scratch，db init + project new）
BIN=node dist/bundle/bin.cjs                  （HEAD 3e24b58 构建）
leaf spec: spec_b0de240263b4（材料 S1 + count(claims)>=1，prepare ready 1/1）
tree: root(all_pass) → a,b（同 leaf spec）；snapshot.sqlite 为工作区库副本
```

矩阵重生成命令：

```bash
pnpm exec vitest run packages/ops/tools/tests/verify-tree.spec.ts \
  --reporter=json --outputFile tmp/vitest-tree.json
node scripts/tree-contract-matrix.mjs --results tmp/vitest-tree.json \
  --out tmp/tree-contract-matrix.md
```

## 2. 绿行抽跑（命令 → 结果）

| 行 | 命令（摘要） | rc | 观测 | 表行期望 |
|---|---|---|---|---|
| Q5 | `verify tree prepare <mat>`（valid two-leaf） | 0 | `ts_ffdbdc3ae7ab`，sha `ffdbdc3a…`，nodes=3，`path` 存在 | 冻结 id/sha/nodes + 文件 |
| V20 | 同一 tree material 再 prepare | 0 | 两次均 `ts_ffdbdc3ae7ab`（同 id） | 同 canonical tree 幂等 |
| Q6 | `verify tree prepare`（空组） | 2 | `error: empty group rejected (Q6)` | rc2 |
| Q1 | 同上（`aggregate: "median"`） | 2 | `unknown aggregate 'median' (…)` | 未知算子 rc2 |
| V16 | 同上（`quorum2`） | 2 | `unknown aggregate 'quorum2'` | 畸形形态 rc2 |
| V5 | 同上（a↔b 环） | 2 | `cycle detected at node a` | rc2 |
| Q7 | 同上（17 层 group + leaf） | 2 | `tree depth exceeds 16 at node leaf (Q7)` | rc2 |
| Q3 | `verify tree run ts_… --db snapshot.sqlite` | 0 | `round_id: rmvn92qdk`（第二跑 `rmvn92r60`，每跑不同） | run 由 CLI 生成 round_id |
| V1 | 同上（两 leaf 均 FAIL） | 0 | `verdict: FAIL`，root FAIL | 叶 FAIL → 根 FAIL |
| V7 | 同树第二次 run | 0 | `verdict_digest` 两次均 `f78caad67dbd…`（逐字节相等） | 同输入双跑 digest 相等 |
| V6/Q2 | pinned 归档追加 `\0` 后 `tree run` | 0 | `verdict: NEUTRALIZED`，leaf `neutralized_reason: archive zip_sha256 mismatch`，root 非 PASS | 篡改 → 子树 NEUTRALIZED、根不得 PASS |

原始输出留档：`/d/workspace/a1-countersign/probes.md`（每项含完整 JSON）。

## 3. 两点观察（不阻塞绿行）

1. **两次 `tree run` 的 `tree_run_id` 相同**（`tr_f78caad67dbd`），仅 `round_id` 不同。这是 v1.1 的 run 幂等行为；v1.2 Q11 裁定「删 run 幂等、只保留 prepare」属于 **planned**，未实现，不影响本次绿行会签；Q10 返工时一并处理。
2. **V15 纯函数矩阵**由 `verify-tree.spec.ts` 的 7 例覆盖（测试 JSON 全绿），本次未重复手工矩阵；Q4/G8/Q8–Q13/V21 均为 planned，按冻结线不动。

## 4. 会签意见

- 本席：**通过**（HEAD 3e24b58，绿行抽跑与矩阵一致；空 scratch 无 meta 门干扰）。
- 待 fdc 同批会签（同批=同一 HEAD、同一抽跑清单；任一不一致整批退签）。
- 建议开发线在会签 commit 上一并提交本报告的矩阵 provenance 更新（仅生成行变化），冻结线解除后即进 Q10 返工 + 九缺口补齐 → 0.115.0。
