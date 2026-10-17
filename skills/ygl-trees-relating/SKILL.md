---
name: ygl-trees-relating
description: >-
  ygl-trees 关联织物方法论（spec R9/R13.2）：用 rel 命令把研究资产挂到树节点——何时挂什么：
  节点↔evidence（依据）、节点↔claim（决策）、节点↔kb（沉淀知识）、节点↔task（跟踪）、
  节点↔artifact/spec/design（产出）。rel 词汇表与方向语义；防止"两条平行流水线"反模式。
  触发词：关联、挂接、rel、evidenced-by、decided-by、tracked-by、关联织物、
  relation fabric、cross-linking、研究资产挂节点。
version: 0.33.0
tags: ygl-trees,methodology,relations,fabric
---

# 关联方法论：让科技树不再孤岛

## 1. 反模式先立靶

**两条平行流水线**：研究管线（source→evidence→claim→report）和科技树各自发育、零缝合——
检阅者看不出"这个节点依据什么证据、由什么断言决定、跟踪着什么任务"。`relations` 表就是缝合线。

**缝合直接喂决策模型（0.80）**：节点挂接的 rel 关系（双向 ≤12 条）自动进 eval 上下文包
`attachments`——claim 带 text+status+confidence、evidence 带 quote 摘要。裁决 `decided-by`
挂链后 `node can --eval` 不必 `--state k=v` 手动携带事实（实测 P 0.30 → 0.92）。
挂链纪律由此获得语义门槛层面的回报。

## 2. rel 词汇表（方向：src --rel→ dst）

| rel | 语义 | 典型挂法 |
|---|---|---|
| `evidenced-by` | 节点的实现/成立有据可查 | node → evidence / kb |
| `decided-by` | 节点由某个决策（claim/design）裁定 | node → claim / design artifact |
| `tracked-by` | 节点的进展由任务跟踪 | node → task artifact |
| `derived-from` | 节点从某知识/报告衍生 | node → kb / report artifact |
| `related` | 兜底弱关联（能起更specific的rel就别用） | 任意 |

## 3. 引用语法与验证

```bash
ygl-trees rel add node:<tree>/<key> kb:<id|title> --rel evidenced-by
ygl-trees rel add node:<key> claim:<id> --rel decided-by
ygl-trees rel add node:<key> artifact:<id|title> --rel tracked-by
ygl-trees rel list --src node:<key>       # 双向过滤 + 对端显示名
```

八类引用：`node claim evidence source query kb artifact skill`（node 裸 key 在当前树解析）。
404→rc1、坏类型→rc2、幂等 duplicate→rc0。

## 4. 何时挂（决策树）

- 写完一条 claim 并 resolve supported，且它解释了树上某节点为何这样设计 → `decided-by`
- kb ingest 了报告且节点是该报告的主体 → `derived-from`
- 建了 task（R12）且任务属于该节点的未来工作 → `tracked-by`
- evidence 的原文直接支撑节点可行性 → `evidenced-by`
- 拿不准 → 先 `related`，语义清楚了再 rm/add 换精确 rel

## 5. 消费面

WebUI 节点详情面板 related 区（React 与内嵌 dashboard 都有）；`rel list` CLI；未解锁节点挂上
evidenced-by 后，检阅者能直接看到"它还差什么证据"。
