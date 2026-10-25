---
name: verify-tree-run-ruling-sheet
description: A1 tree run 属主裁定单 v2（Q1–Q7 provenance 补正 + Q8–Q13 + G8/G9 + 绑定澄清/五钉/边界）
kind: 裁定
---

# 递归验证器 · 属主裁定单 v2（A1 契约 v1.2 配套）

> **裁定人=属主；渠道=fdc757f6 会话直令 2026-10-23 14:01（「开始安排吧」）；证据形态=裁定消息 + 会话记录。**
> 本次为**落章**，不是转达。v1.1 的 relayed-order 披露保留在 plan/CHANGELOG 与 v1.1 §0.1，不撤回历史。
> 契约正文：`verify-tree-run-contract-v1.2.md`（定稿）；历史 v1.1：`verify-tree-run-contract.md`。
> 两席：fdc757f6（裁定单合成+草案六条）、302cb119（三修正+九缺口清单）；Phase 2 会签窗口另行知会。

## 一、属主裁定（逐项）

| # | 问题 | 属主裁定 | 备注 |
|---|---|---|---|
| Q1 | 聚合算子初始名单 | `count_fail` / `all_pass` / `quorum(N)`；min/max/and/or 后置 | v1.1 relayed 内容，现补 provenance |
| Q2 | NEUTRALIZED | 独立 verdict，阻断根 PASS | 同上 |
| Q3 | 轮次 id 发行者 | run 发起时 CLI 生成，写入所有层 archive | 同上 |
| Q4 | V9 规模基线 | ratchet 第四轴（tree-run 耗时），显式 `--write` 认账 | 同上 |
| Q5 | 树 spec 格式 | JSON（可机械校验/digest） | 同上 |
| Q6 | 空组 | prepare rc=2 拒绝 | 同上 |
| Q7 | 叶深度上限 | 16，超限 prepare rc=2 | 同上 |
| **Q8** | 同主体定义 | `tree run` 声明 **target**；全叶 data_source/target 一致；失配 V 行；**subject = repo + commit** | 澄清①⑤；活叶失配=STALE（非 INFRA_BLOCKED） |
| **Q9** | stale 谓词 | **D：引用失配**（target 失配 + 子 `spec_version` 相对**冻结版本**漂移）；round_id 次选；时间性仅 advisory | 六澄清全吸收；五钉②③⑤ |
| **Q10** | ERROR 规则 | **B：any ERROR → 父至多 INFRA_BLOCKED** | 唯一改已实现行为项；返工既倒 |
| **Q11** | 幂等键 | 删 run 幂等声明；prepare 幂等（V20）保留 | tree_run_id 每次新生成 |
| **Q12** | V17 同轮自引用 | **B：移 run 期**；pinned 必须来自已完成 run（registry+验签） | 同轮自引用 run 期拒绝 |
| **Q13** | V8 信任根 | **A：仅本 workspace**；跨 workspace 留 v1.3 | 外来归档 rc2 |
| **G8** | digest | `verdict_digest` 走 **JCS（RFC 8785）**；tree spec pin engine/corpus/contract | 与 canonical.ts 同一实现 |
| **G9** | 附件 A | 按推荐接（V13 取代/Q4 ratchet/meta 覆盖；fleet 批量 --db 缓） | 附件 A 逐项 |

## 二、绑定澄清节（承载六澄清 + 五钉 + 边界）

### 2.1 六澄清（Q8/Q9 共用 target 投影）

1. **(b) 基准**：tree spec **冻结的该叶 `spec_version`**，不是「当前注册」。
2. **缺被比字段**：fail-closed 判 stale（不默认通过）。
3. **传播**：stale 沿父链传播，祖先 = STALE，**阻 PASS**；**不采用「不计入聚合」**（防 FAIL 稀释）。
4. **措辞**：「引用失配」；时间性只留 advisory（不进判定）。
5. **digest**：stale 进 `verdict_digest`；`advisory.round_gap` 不进。
6. **第五 verdict**：`STALE` 限树层；tree 报告五值、叶 `report.overall` 四值、engine contract 1.2 不动；
   「形状推论属主可否决」标注。

### 2.2 五钉

1. **全序**：`NEUTRALIZED > STALE > FAIL > INFRA_BLOCKED > PASS`；V15 出 **5×5**；被 STALE 遮蔽的 FAIL
   记 `nodes[]`/审计可见。
2. **形状**：leaf report.overall 四值 / tree nodes[].verdict 五值 / stale 叶带 `report_verdict` 映射。
3. **(a) 适用条件**：仅树声明 target 时适用；kind+id 恒比；树声明 sha 才比 sha；pinned 缺被比字段 fail-closed。
4. **Q8 活叶失配**：= STALE 同通道传播（**弃草案 §1 的 INFRA_BLOCKED**）；V22 改固定断言，差异上报属主可见。
5. **tree report**：带独立 `tree_contract_version`；tree 面 **TS-only**，不挂 Rust parity/语料义务。

### 2.3 边界

- target 比较只适用于**声明了 target 的叶/报告**；file/command 等**无 data_source 叶不参与 (a)**，
  **(b) 仍适用**；V 行记「豁免非数据叶」。
- `advisory.round_gap` 定名，**不进** digest/verdict。
- V22 与 `report_verdict` 对齐。

## 三、冲突上报通道

- 实现与裁定冲突：开发线 24h 内上报 fdc757f6 + 302cb119，附命令/期望/证据；不得静默改语义。
- 裁定文本冲突：以本单「属主裁定」列为准；§2 澄清与正文冲突时以澄清节为准。
- 形状推论（五值/全序）：属主可否决；否决后回到四值 + STALE 子码方案。

## 四、charter §4.7 增补（按本单定稿）

> **递归验证器身份与边界。** ygl-trees 的验证器生产线以「树形验证」为治理原语：叶节点复用七型检查器，
> 组节点以封闭聚合算子聚合子判定；每层真实 run + archive，`verdict_digest` 只覆盖判定字段（JCS），审计字段单列。
> **身份判据**：能对一条业务规范给出可复核的树形判定（含 `NEUTRALIZED`/`STALE`/`INFRA_BLOCKED` 显式态），
> 且归档可独立验签、可被外部引用；不要求绑定单一编排实现。**边界**：不引入任意表达式/脚本钩子；
> 不承担 pi 兼容层（WP-B 属 jf 仓）；发布门仍由 prepublish-guard + meta gate 把关。
>
> 上方文字为定稿草案，charter 正文修改按既有流程（属主 + 双评审席）入册。

## 五、Phase 2 会签与执行

1. 定稿 SHA 回 fdc（本单 + v1.2 + 矩阵）；
2. **已会签（2026-10-25，HEAD `3e24b58`）**：fdc + 302cb119 按对照表绿行抽跑，空 scratch、三一致判据；两席通过（302 报告 `REVIEW-a1-countersign-r34.md`，fdc A2A `direct-5e6243d9` 同批通过）；
3. **冻结线已解除**；
4. Q10 返工 + 九缺口补齐（G1/G2/G3/G8 + V22/五值矩阵）；
5. 0.115.0 收口（relayed-order 披露注记随版）。

## 六、签署

| 角色 | 状态 |
|---|---|
| 属主 | **已裁定** 2026-10-23 14:01（渠道 fdc757f6） |
| fdc757f6 | **已会签** 2026-10-25（同批 `3e24b58`；`direct-5e6243d9`） |
| 302cb119 | **已会签** 2026-10-25（同批 `3e24b58`；报告 r34） |
| 开发线（ygl-trees） | 定稿+矩阵已交；冻结线已解除，进 Q10 返工 |
