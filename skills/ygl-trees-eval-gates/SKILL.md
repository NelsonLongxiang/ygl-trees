---
name: ygl-trees-eval-gates
description: >-
  ygl-trees 决策模型门槛（spec R8）：语义型必检条件用 eval 题型声明——布尔 --op eval 判 P(true)、
  多选一 --op eval-choice 判期望答案概率、等级评分 --op eval-score 判 ±1 灰带；node can --eval
  把节点上下文包（父链+祖先链+条件+解锁集+state 袋）交给评估模型（TypeSafe jev via Vercel
  AI Gateway）。三态映射 P≥0.7 通过 / P≤0.4 未通过 / 灰带 pending。离线安全：无凭证回落 pending。
  触发词：决策模型、布尔判定、多选、评分、evaluation、P(true)、灰带、gray band、pending、
  eval gate、语义门槛、quest 条件、AI 判定、jev、gateway、choice、score。
version: 0.26.0
tags: ygl-trees,eval,gate,decision-model,choice,score
---

# Gate 决策模型评估（boolean / choice / score）

## 1. 何时用

确定性条件（等级≥3、资源≥100、flag 有无）用普通 op（>=/==/has…），本地判定。
**语义型门槛**——"前置任务完成了吗""情境是否满足"——状态袋里没有对应键，用 eval 题型：
value 写判定问题（与上下文字面对齐，模型严格按字面读、不脑补；空 value 回落用条件名）。

## 2. 三种题型

```bash
# 布尔：P(true) 三态
ygl-trees node cond gate-node --name quest_done --kind quest --op eval \
           --value "前置任务已完成且上下文满足门槛吗"

# 多选一：期望答案的概率走同一三态（0.26.0）
ygl-trees node cond gate-node --name team_pick --kind quest --op eval-choice \
           --value "该派哪个团队处理" \
           --options "proc=采购:ERP与供应商, ops=物流:账单核对" --answer proc

# 等级评分：score∈[0,N-1] 概率加权均值，±1 灰带（0.26.0）
ygl-trees node cond gate-node --name maturity --kind quest --op eval-score \
           --value "实现成熟度如何" \
           --levels "原型:仅演示, 可用:有测试, 成熟:有用户" --min-score 2

ygl-trees node can gate-node --state x=1 --eval
ygl-trees node can gate-node --eval --json     # evaluated[] 带 type 字段 + pending[]
```

选择/评分题面纪律（材料 §3）：选项/等级描述必须编码业务价值排序（裸用"轻微/中等/严重"
与价值观系统性分歧，实测 ρ=0.25）；等级描述带 P0/节奏等语境词。

## 3. 三态语义（材料纪律）

| 题型 | 判定量 | pass | fail | pending |
|---|---|---|---|---|
| boolean | P(true) | ≥0.7 | ≤0.4 | 0.4–0.7 灰带 |
| choice | P(期望答案) | ≥0.7 | ≤0.4 | 0.4–0.7 灰带 |
| score | score | ≥min | ≤min−1 | [min−1, min) 灰带 |

聚合行为：pass 从 missing_required 移除；fail 保留并标注；**pending 独立泳道——不放行、
不报错、禁作终态**。

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

## 6. 批量判定与留痕

`node ready --eval`（0.16.0）：仅被 eval 门槛阻塞的节点逐节点**一次多题请求**（协议原生
批量，同延迟）判定——全过提升进 ready（`eval_verified` 标记），其余进 `eval_pending`
（逐题带 P）；离线全 pending、rc=0。

每次 `--eval` 记 events：单节点 `eval.gate`（各条件 P/outcome）、批量 `eval.ready`
（promoted/pending 键集），`agent log` 可审计。结果不落库——现评现判，保持无状态。
