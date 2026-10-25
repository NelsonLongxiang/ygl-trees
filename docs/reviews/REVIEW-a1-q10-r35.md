---
name: review-a1-q10-r35
description: A1 v1.2 Q10 返工复核（r35）——退回：Q8/Q9/G8 未按裁定单落地、树五值枚举泄漏、V15 全序冲突；0.115.0 暂缓
kind: 评审
---

# A1 v1.2 Q10 返工 · 复核报告（r35）

> 复核对象：HEAD `29d0a3a`（Q10 返工 `eb3d6f2` + Q12/Q13 `29d0a3a`），矩阵声称 green 13→20。
> 方法：代码路径核对 + `pnpm build` 后空 scratch CLI 探针（`YGL_HOME=/d/workspace/a1-countersign/.home`，HEAD 构建）。
> 结论：**退回补做，不签 0.115.0**。绿行测试通过属实，但 Q8/Q9/G8 的绿行与裁定单断言不对应（测试只覆盖子集），另有树五值枚举泄漏与 V15 全序冲突两个契约级问题。

## 0. 已通过项（正向）

- Q11：两次 `tree run` 的 `tree_run_id` 不同（`tr_256c1b50c1fc` / `tr_a3a4221fa463`），`verdict_digest` 相等；run 幂等已删。
- V22（活叶 target 失配）：`--target ...` 与叶 data_source 不一致 → 叶 `STALE`、`stale_reason: target mismatch`、`report_verdict` 保留四值。
- Q13-A：未知 pinned sha → prepare rc2；Q12-B 同轮拒绝代码存在（无测试）。
- V15 纯函数矩阵 17 行通过；Q10-B PASS+ERROR → INFRA_BLOCKED。
- G8 JCS 序列化单测通过（仅 canonical 字符串，见下）。

## 1. 阻塞项

### 1.1 Q8 未按裁定单实现：tree spec 无 `target` 字段、无 subject=repo+commit
- `TreeSpec`/`validateTreeSpec`（`verify-cmds.ts:118-240`）**没有 `target` 字段**，也不进 canonical digest；`tree run` 只读 `--target` flag（`:279`），无法在 prepare 期冻结主体。
- 仓内无 `subject`/`repo + commit` 投影代码（`git grep subject` 零命中）。
- pinned 叶不在 target 比较路径（pinned 分支 `:390-435` 直接 `rep.overall`），与 Q8「全叶 data_source/target 一致」不符。
- 矩阵 Q8 green 的测试标题只有「V22: leaf target mismatch → STALE」，**没有** target 冻结/全叶/pinned 用例 → 绿行名不副实。

### 1.2 Q9 未实现 spec_version 漂移与 pinned 引用失配
- 活叶路径（`:437-479`）只比 target，**不比对** tree 节点冻结的 `spec_version` 与叶 spec/report 版本；节点上的 `spec_version`（`:153`）在 run 期从未读取。
- **复现**：tree leaf 声明 `spec_version: 2`（实际 spec v1），prepare rc0 → run `verdict: FAIL`、leaf `stale:false`、`stale_reason` 缺失；按 Q9 应为 **STALE**（冻结版本漂移）。
- pinned 分支（`:390-435`）验签后直接返回 `rep.overall`，**不比对** pinned report 的 target/spec_version，也不做缺字段 fail-closed；而 Q9 的语义主体正是 pinned 报告。
- 矩阵 Q9 green 同样只引用 V22 target 用例 → 绿行名不副实。

### 1.3 G8 未实现 tree spec pin（engine/corpus/contract）
- `TreeSpec` 无 `engine_version`/`corpus_version`/`contract_version` 字段；`validateTreeSpec` 不检查也不冻结；prepare 不比对引擎实况。
- 矩阵 G8 green 的测试只有 `G8: jcsCanonical sorts keys…`——JCS digest 只是 G8 的一半；**pin 面零覆盖**。

### 1.4 树五值枚举被叶四值泄漏
- `:474` `verdict: stale ? "STALE" : report.overall`——`report.overall` 是引擎四值（含 `ERROR`/`NEEDS-MATERIAL`）。
- **复现**：`verify tree run ts_ffdbdc3ae7ab --db empty.sqlite`（空库，count 查不到表）→ 叶节点 `"verdict": "ERROR"`、root `INFRA_BLOCKED`。`ERROR` 不在 v1.2 §2.4 的五值 `PASS|FAIL|NEUTRALIZED|INFRA_BLOCKED|STALE` 内；`NEEDS-MATERIAL` 同理。
- pinned 叶无 `report_verdict` 字段（`:434`），与 §2.4「stale 叶带 report_verdict」不一致。

### 1.5 V15 全序冲突：`FAIL + INFRA_BLOCKED` 被判 INFRA_BLOCKED
- 裁定单 §2.2 全序：`NEUTRALIZED > STALE > FAIL > INFRA_BLOCKED > PASS`；但代码 `:255` 把 `INFRA_BLOCKED` 当 ERROR 同级 cap（`if ERROR || INFRA_BLOCKED → INFRA_BLOCKED`），测试 `verify-tree.spec.ts:180` 断言 `["all_pass", ["FAIL","INFRA_BLOCKED"], "INFRA_BLOCKED"]`——**FAIL 被 INFRA_BLOCKED 遮蔽，与全序相反**。
- 同时 Q10-B「any ERROR → 父至多 INFRA_BLOCKED（不可能是 PASS/FAIL）」与全序 `FAIL > INFRA_BLOCKED` 本身存在未裁的语义冲突（FAIL+ERROR 应 FAIL 还是 INFRA_BLOCKED）。这是裁定文本缺口，不能由实现方静默选边；需 fdc/属主补一句优先级（建议：ERROR cap 仅作用于 PASS→INFRA，不降级 FAIL/STALE/NEUTRALIZED；或明确 cap 覆盖 FAIL）。**此项未定前 V15/Q10 不能算绿。**

### 1.6 矩阵 provenance 与状态
- 矩阵头 `commit eb3d6f2`，但 Q12/Q13 测试在 `29d0a3a` 才加；矩阵未在最终 HEAD 重生成。
- 矩阵把 Q8/Q9/G8 标 green（依据见上，测试不对应）；修正后应回 partial/planned，并重生成。Q12 代码已落但测试 planned，保持 planned 正确。

## 2. 非阻塞观察
- `jcsCanonical` 对数字/字符串复用 `JSON.stringify`，对当前判定投影（整数/字符串/布尔）够用，但缺 RFC 8785 边界用例（大数、指数、`-0`、控制字符）；建议补 3-5 例或注明投影域。
- Q12-B 同轮拒绝代码已落但无真归档测试；补测试前保持 planned。
- 矩阵 Q4/V21 仍 planned，符合预期。

## 3. 退回要求（完成后再复核）

1. **Q8**：tree spec 增冻结 `target`（`{kind,id,sha256?}`）并纳入 canonical/digest；pinned 与活叶都参与 target 比较；subject=repo+commit 至少进报告投影（若暂不做，矩阵改 partial 并写明）。
2. **Q9**：活叶比对 tree 冻结 `spec_version`；pinned 比对 report 的 target/spec_version；缺字段 fail-closed；补三类用例（漂移/缺字段/pinned 失配）。
3. **G8**：tree spec 冻结 engine/corpus/contract 并在 prepare/run 校验；补 pin 用例；否则 G8 降 partial。
4. **五值**：树节点把 `ERROR`/`NEEDS-MATERIAL` 映射到五值（建议 ERROR→INFRA_BLOCKED、NEEDS-MATERIAL 按裁定或新增显式态）；pinned 叶补 `report_verdict`；补 ERROR/NEEDS-MATERIAL 叶用例。
5. **V15/Q10**：先定 FAIL+INFRA/ERROR 优先级（fdc/属主一句话），再改代码/测试；改完重跑 5×5。
6. **矩阵**：修正 Q8/Q9/G8 状态后在最终 HEAD 重生成（provenance 用会签 commit），再走一次两席会签。

在以上完成前，**0.115.0 暂缓**；已通过项不重开（Q11/V22/Q13/Q10 纯函数）。
