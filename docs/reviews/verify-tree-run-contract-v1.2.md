---
name: verify-tree-run-contract-v1.2
description: A1 tree run 契约 v1.2 定稿（属主 2026-10-23 14:01 直令裁定 Q8-Q13 + G9；Phase 2 依据）
kind: 规范
---

# 递归验证器契约 v1.2 · 定稿（属主已裁定）

> **状态：已裁定定稿（2026-10-23 14:01 属主直令，评审席 fdc757f6 会话直收）。**
> 裁定人=属主；渠道=fdc757f6 会话直令；证据形态=裁定消息 + 会话记录。这是**落章**，不再是 relayed-order。
> 本文件取代 v1.1（`verify-tree-run-contract.md`，历史草案）与 v1.2 草案；Q1–Q7 补 provenance，
> Q8–Q13 + G8/G9 见裁定单 v2（`verify-tree-run-ruling-sheet.md`）。冻结线在 Phase 2 会签通过后解除。

## 0. 裁定摘要

| 项 | 裁定 |
|---|---|
| Q8 同主体 | `tree run` 声明 **target**；全叶 `data_source`/target 一致；subject = **repo + commit** |
| Q9 stale | **D：引用失配**（target 失配 + 子 `spec_version` 相对 tree spec 冻结版本漂移）；round_id 连续性为次选；时间性只留 advisory |
| Q10 ERROR | **B：any ERROR → 父至多 `INFRA_BLOCKED`**（不可能是 PASS/FAIL） |
| Q11 幂等 | **删 run 幂等声明**；prepare 幂等（V20）保留 |
| Q12 V17 | **B：V17 移 run 期**；pinned 必须来自已完成的 run（registry + 验签） |
| Q13 V8 | **A：仅本 workspace** 归档可作为 pinned；跨 workspace 留 v1.3 |
| G8 | `verdict_digest` 走 **JCS（RFC 8785）** canonical；tree spec 冻结 engine/corpus/contract |
| G9 | 附件 A 次要项按推荐接（V13 取代 / Q4 ratchet / meta 覆盖；fleet 批量 --db 缓） |

## 1. 递归语义（在 v1.1 S-1…S-7 上修订）

- **S-1/S-2**：组/叶、后序遍历、聚合算子封闭集（Q1）不变。
- **S-3**：每层真实 run + archive；子判定以子 **`verdict_digest`** 引入；archive 字节/时钟/主机进 audit。
- **S-4 轮次**：一次 tree run 共享 round_id；跨轮引用必须 `pinned` 并满足 Q12/Q13。
- **S-5 失败面**：叶 FAIL 按策略聚合；叶 ERROR 单字段 `ERROR`；环/悬空 prepare 拒绝。
- **S-6 归档验签失败** → 子树 `NEUTRALIZED`（显式中性化），阻断根 PASS。
- **S-7 确定性**：`verdict_digest` 只覆盖判定投影，**JCS** 序列化；不含 archive 字节/时钟；run 无幂等声明（Q11）。

## 2. 主体、target 与 stale（Q8/Q9 绑定澄清节）

### 2.1 target 投影（Q8/Q9 共用）

- `tree run --target <kind>:<id>[#sha256]`；tree spec 可冻结 `target`。
- 每叶可见 `data_source` 投影 = `{kind, id, sha256?}`；**kind+id 恒比；tree 声明 sha256 时才比 sha**；
  缺被比字段 → **fail-closed 判 stale**。
- **subject = repo + commit**（Q8 裁定）：同一 repo/commit 下 target 差异才进入判定；跨 repo/commit 不声称可比。

### 2.2 Q8 绑定（活叶失配）

- 声明了 target 的叶：`data_source` 与 target 不一致 → 该叶 **STALE**（沿父链传播，祖先=STALE，阻 PASS）。
- **弃草案 §1 的 INFRA_BLOCKED 处置**；V22 改固定断言 STALE，差异上报属主可见。
- 未声明 target 的叶：file/command 等**无 data_source 叶不参与 (a)**；**(b) 仍适用**（V 行记「豁免非数据叶」）。

### 2.3 Q9 选项 D：引用失配（stale）

- stale 判据（按序）：① target 投影失配；② 子 `spec_version` 相对**tree spec 冻结的该叶版本**漂移
  （基准是冻结版本，不是当前注册）；③ round_id 连续性（次选，非时钟）；④ 时间性仅 advisory，不进判定。
- 缺被比字段 → fail-closed stale。
- **传播与聚合**：stale 沿父链传播；祖先 = `STALE`；**STALE 阻断 PASS**（不采用「不计入聚合」，防 FAIL 稀释）。
- `stale` 进 `verdict_digest`；`advisory.round_gap` 定名、**不进** digest/verdict。
- 正文措辞统一「引用失配」；时间性只留 advisory。

### 2.4 第五 verdict STALE（树层）

- tree 报告 verdict 五值：`NEUTRALIZED > STALE > FAIL > INFRA_BLOCKED > PASS`（全序）。
- **叶 report.overall 仍四值**（PASS/FAIL/NEEDS-MATERIAL/ERROR，engine contract 1.2 不变）；
  tree `nodes[].verdict` 五值；stale 叶带 `report_verdict` 映射原四值。
- tree 报告独立 `tree_contract_version`（不混同 engine contract_version）；**tree 面 TS-only**，
  不挂 Rust parity/语料义务。
- 「五值/全序」形状推论**属主可否决**（标注）。

## 3. 聚合与验收矩阵（Q10-B + 五钉）

- **Q10-B**：任一子 `ERROR` → 父至多 `INFRA_BLOCKED`；不可能是 PASS/FAIL。
- **全序**：`NEUTRALIZED > STALE > FAIL > INFRA_BLOCKED > PASS`；被 STALE 遮蔽的 FAIL 记 `nodes[]`/审计可见。
- **V15 5×5**：五种父状态 × 子组合表驱动；禁止把 STALE/FAIL 稀释成 PASS。
- **V22（新增）**：活叶 target 失配 → STALE 传播；固定断言（不是 INFRA_BLOCKED）。
- **配额/规模**：Q4 ratchet 第四轴；V9 4 层×64 叶；深度 16（Q7）；空组 rc2（Q6）。

## 4. 接口与 rc

```bash
ygl-trees verify tree prepare <tree-material-id> [--draft] [--pinned <node>=<archive-sha256> ...] [--target <kind>:<id>[#sha256]] [--json]
ygl-trees verify tree run <tree-spec-id> [--target <kind>:<id>[#sha256]] [--db <snapshot> | --db <node>=<snapshot> ...] [--json]
ygl-trees verify tree report|trace|archive ...
```

| rc | 含义 |
|---|---|
| 0 | 执行完成（FAIL/NEUTRALIZED/STALE/INFRA_BLOCKED 均为 0） |
| 1 | 基础设施自身故障（快照不可读/进程内部错误） |
| 2 | 用法/冻结错误（缺参、环、悬空、未知算子、空组、超深度、未知 pinned / prepare 期验签失败） |

- **Q12-B**：pinned 必须来自**已完成 run**（registry 存在 + 验签通过）；V17 移 run 期；
  同轮自引用在 run 期拒绝（pinned created ≥ 本轮 started → rc2）。
- **Q13-A**：pinned 只解析**本 workspace** registry；外来归档 → rc2（跨 workspace 信任根留 v1.3）。
- **Q11**：删除 run 幂等声明；`tree_run_id` 每次运行新生成；prepare 同 canonical tree 幂等（V20）。

## 5. JSON 形状（新增字段）

- tree 报告：`tree_contract_version`、`target`、`verdict`（五值）、`nodes[].verdict`（五值）、
  `nodes[].report_verdict`（叶原四值）、`nodes[].stale`、`advisory.round_gap`（不进 digest）、`verdict_digest`。
- `verdict_digest`：JCS canonical 对固定投影（tree_spec_sha256、root、target、nodes[{id,verdict,aggregate?,pinned?,stale?,report_verdict?}]、pinned）sha256；**不含** audit/时钟/archive 字节。
- 归档验签失败：子树 NEUTRALIZED；叶 `ERROR` 不进 PASS/FAIL 计票（Q10-B 父至多 INFRA_BLOCKED）。

## 6. Q1–Q7 与 provenance 补正

- Q1–Q7 按 2026-10-23 14:01 属主直令确认为**已裁定**（此前仅转达，按 fdc 0.1 已披露；现落章）。
- 裁定单 v2 承载：属主逐字裁定（Q1–Q7 补 provenance + Q8–Q13）、§2 绑定澄清节、五钉、边界、冲突上报通道。
- charter §4.7 增补文字按裁定单 v2 定稿（双评审席会签后入 charter）。

## 7. 附件 A（G9）

| 项 | 处置 |
|---|---|
| V13 树 spec 取代 | 接：old/new digest + 理由；旧 run 仍可验 |
| Q4 ratchet 第四轴 | 接：tree-run 耗时，显式 `--write` 认账 |
| meta 覆盖 | 文档明确：submit 覆盖材料 gate；prepare/run 不重复 |
| fleet --db 批量投影 | 缓（先单叶绑定；矩阵 planned） |
| JSON enum | 节点五值（STALE 增）；叶 report 四值不变 |
| 事件 | prepare/run/node/archive 只增 |
| 深度/空组 | 16 / rc2 不变 |
| Rust parity | tree 面 TS-only，不挂 parity/语料 |
| 跨 workspace | v1.3（Q13-A） |

## 8. Phase 2 顺序（评审席定）

①本定稿 SHA 回 fdc → ②两席按对照表绿行抽跑会签（空 scratch、三一致、不一致整批退签）→
③冻结线解除 → ④Q10 返工 + 九缺口补齐（G1/G2/G3/G8 + V22/五值矩阵）→ ⑤0.115.0 收口
（relayed-order 披露注记随版）。
