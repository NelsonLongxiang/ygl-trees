---
name: ygl-trees-eval-gates
description: >-
  ygl-trees 决策模型布尔门槛（spec R8）：语义型必检条件用 --op eval 声明，node can --eval
  把节点上下文包（父链+祖先链+条件+解锁集+state 袋）交给评估模型（TypeSafe jev via Vercel
  AI Gateway）判定 P(true)，三态映射 P≥0.7 通过 / P≤0.4 未通过 / 灰带 0.4-0.7 pending。
  离线安全：无凭证回落 pending。何时用 eval 门槛 vs 确定性 op。
  触发词：决策模型、布尔判定、evaluation、P(true)、灰带、gray band、pending、eval gate、
  语义门槛、quest 条件、AI 判定、jev、gateway。
version: 0.14.0
tags: ygl-trees,eval,gate,decision-model,boolean
---

# Gate 决策模型布尔评估

## 1. 何时用

确定性条件（等级≥3、资源≥100、flag 有无）用普通 op（>=/==/has…），本地判定。
**语义型门槛**——"前置任务完成了吗""情境是否满足"——状态袋里没有对应键，用 `--op eval`：
value 写判定问题（与上下文字面对齐，模型严格按字面读、不脑补；空 value 回落用条件名）。

## 2. 用法

```bash
ygl-trees node cond gate-node --name quest_done --kind quest --op eval \
           --value "前置任务已完成且上下文满足门槛吗"
ygl-trees node can gate-node --state x=1 --eval
ygl-trees node can gate-node --eval --json     # evaluated[] + pending[] 字段
```

## 3. 三态语义（材料纪律）

| P(true) | 判定 | 聚合行为 |
|---|---|---|
| ≥0.7 | pass | 从 missing_required 移除（视为满足） |
| ≤0.4 | fail | 保留并标注 P |
| 0.4–0.7 | **pending 灰带** | 独立泳道：不放行、不报错、**禁作终态** |

实测谱系（真实网关 1.5s/次）：可证事实 P=0.97 / 未满足前提 P=0.39 / 歧义上下文 P=0.45——
证据不足时概率塌向灰带而非硬答。

## 4. 上下文包（模型看到什么）

节点元数据（key/name/kind/tier/cost）+ 直接父（node_edges）+ 祖先链（node_closure）+
该节点全部条件 + 已解锁集 + `--state` 袋。**state 必带上下文包**——裸 state 大概率落灰带。

## 5. 凭证与端点（优先级：config > 环境变量/文件 > 默认网关）

- **config 优先**：`ygl-trees config set decision_model_llm_token <t>` 与
  `config set decision_model_llm_api_base <url>`（api_base 给主机名自动补
  `/v4/ai/evaluation-model`，也可给完整端点——代理/自托管网关用它接管）
- 回落：环境变量 `AI_GATEWAY_API_KEY` → `~/.vercel.ai-gateway.env`（`token=...`，vck_ 前缀）
- **离线安全**：无 token/网络失败 → 该条件 pending（`no evaluator configured`）、rc=0——
  评估器是增强不是依赖，别把 pending 当失败重试
- `YGL_EVAL_OFFLINE=1` 强制离线（测试/demo 确定性；优先于 config 的 eval.offline）
- 网关协议：v4 端点 + 四个协议头（缺一 400/404）；429/529 自动退避重试≤3，400/401 不重试

## 6. 判定留痕

每次 `--eval` 记 events（kind=`eval.gate`，含各条件 P 与 outcome），`agent log` 可审计。
结果不落库——每次 can 现评，保持无状态。
