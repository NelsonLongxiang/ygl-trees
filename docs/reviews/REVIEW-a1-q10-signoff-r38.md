---
name: review-a1-q10-signoff-r38
description: A1 v1.2 Q10 返工签注（r38）——302cb119 席复核通过，待 fdc 同批；0.115.0 可放行
kind: 评审
---

# A1 v1.2 Q10 返工 · 签注（302cb119 席，r38）

> 对象：HEAD `25f0354`（Q8 target 修复 + B1 面门禁），矩阵 `af7d5f4` 重生成并修正 Q8 绑定。
> 方法：重建 bundle + 空 scratch 探针 + 48 例测试 + 矩阵 HEAD 重生成。

## 0. 结论

- **302cb119 席：通过**（Q8/Q9/G8/五值/V15/Q12 全部按裁定单 v2 + fdc cap 补正落地，探针/测试/矩阵三一致）。
- **fdc757f6 席：同批通过**（HEAD `25f0354`；独立复跑 verify-q10+verify-tree 43/43 绿，A2A `direct-afe8a3eb`；Q8 spec.target 分源代码核验通过，残余两项认可不阻塞）。
- **两席签注齐 → 0.115.0 放行**。

## 1. 验证证据

**测试**：`verify-tree 33 + verify-q10 14 + b1-facade 5 = 48/48` 通过（HEAD `25f0354` 构建）。
**矩阵**：HEAD 重生成 **green 21 / partial 1 / planned 2 / missing 0 / red 0**；Q8 绑定改为 run 级
`Q8 run: spec.target (frozen) + live leaf mismatch`（原绑 prepare-only，复核修正）。

**CLI 探针**（空 scratch `YGL_HOME=/d/workspace/a1-countersign/.home`）：

| 项 | 探针 | 结果 |
|---|---|---|
| G8 | tree spec `engine_version:"0.999.0"`（实际 0.114.31） | prepare **rc2** `G8: … engine/pin mismatch` ✓ |
| Q9 活叶 | tree frozen `spec_version:2` vs spec v1 | run `STALE`，`stale_reason: spec_version drift`，`report_verdict:FAIL` ✓ |
| Q8 spec.target 活叶 | `target{kind,id=other-node}` + live leaf id=a | run `STALE`，`target mismatch` ✓ |
| Q8 spec.target pinned | 同上 + pinned 叶 | run `STALE`，`pinned target mismatch` ✓ |
| 五值 | 空库 ERROR 叶 | 叶 `nodes[].verdict=INFRA_BLOCKED`、`report_verdict=ERROR` ✓ |
| V15 | 纯函数 17+4 行 | cap-on-PASS（FAIL+ERROR/FAIL+INFRA=FAIL）✓ |
| Q11 | 同 tree 两跑 | `tree_run_id` 不同、`verdict_digest` 相等 ✓ |
| Q12 | pinned 同轮 created ≥ started | prepare rc2 ✓（测试覆盖） |

## 2. 残余（不阻塞，随 0.115.x 补）

1. **G8 校验点在 prepare**：契约 §0 写「run 时与引擎实况不一致 → 拒跑」；因 tree spec 冻结后不可变，prepare rc2 已提供等价安全性。建议 run 期再加一道（或契约注明「以 prepare 为准」），防 spec 文件被手改。
2. **Q8 subject（repo+commit）**：只做 canonical 冻结，不校验实况（声明语义）；文档写清即可。
3. Q4（ratchet 第四轴）/ V21（舰队多快照）仍 planned，符合裁定单附件 A 的后置范围。

## 3. 签注

- 302cb119：**通过**（本报告；48/48 含 b1-facade 5）。
- fdc757f6：**同批通过**（tree 面独立复跑 43/43；b1-facade 5 为同批 B1 面，不属 A1 tree 口径，两席口径已注记）。
- **两席签注齐 → 0.115.0 放行**；本席不再要求额外代码项。
