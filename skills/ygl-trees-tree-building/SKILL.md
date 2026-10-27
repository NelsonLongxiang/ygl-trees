---
name: ygl-trees-tree-building
description: >-
  ygl-trees 树构建方法论（spec R13.2）：把一个领域分解成丰富科技树的实践法——能力域识别、
  层级设定（tier=成熟度/里程碑轴）、必检 vs 可选边（prereq/unlock/enables/excludes × AND/OR/XOR/NOT）、
  语义门槛挂 eval 三题型、未来节点用真实条件锁定而非空缺。防止"三节点演示链"反模式。
  触发词：树构建、领域分解、节点设计、tier 规划、衍生、子节点、反模式、演示链、
  tree building、decomposition、node design、derivation。
version: 0.116.0
tags: ygl-trees,methodology,tree,decomposition
---

# 树构建方法论：从领域到 30+ 节点的丰富树

## 1. 反模式先立靶

**三节点演示链**（a→b→c）是最常见的失败形态——它验证不了分叉、互斥、可选路径与门语义。
真实领域树的特征：**多根或多干、每层 2-6 分叉、20% 可选边、未来节点带真实条件锁定**。

## 2. 分解四步

1. **能力域识别**：领域切成 5-8 个能力域（ygl-trees 例：架构/研究/知识/模型/运维/Web）——每个域一条生长干
2. **tier = 里程碑轴**：t0 地基（不依赖别人的）、t1 架构、t2 模型层……tier 语义要在建树前说清楚（成熟度？时间？依赖深度？）
3. **边三问**：必检吗（required prereq）？可选吗（--optional，只影响 cost）？互斥吗（excludes，分支死锁）？
4. **未来节点锁定**：还没发生的里程碑也进树（npm-publish/bun-runtime），**用真实 eval 条件锁**——registry 选型用 `--op eval-choice`、就绪度用 `--op eval-score`，让门可以随现实翻转

## 3. 节点命名与粒度

- key 用短横线小写复合（`eval-mixed`、`webui-serve`），name 放中文全称
- 一个节点 = 一个可独立陈述的里程碑（"采用 TypeORM" ✓；"数据库" ✗ 太泛）
- 粒度判据：**这个节点的完成日期能被唯一回答吗**？

## 4. 建树命令节奏

```bash
ygl-trees tree new <name>
ygl-trees node add <key> --tier <t> --name "<全称>"     # 批量加完再连边
ygl-trees node link <parent> <child> [--optional|--rel excludes]
ygl-trees node cond add <future-key> --name <cond> --op eval-choice --options k=... --answer k   # 未来门
ygl-trees node unlock <done-key>                         # 已完成里程碑
ygl-trees node index && ygl-trees node validate
ygl-trees tree use <name> && ygl-trees webui serve       # React 客户端 pan/zoom 检阅
```

## 5. 自检清单

- [ ] ≥30 节点、≥5 层、≥4 条生长干
- [ ] 可选边 ≥15%（--optional / effect cost_mul）
- [ ] 未来节点 ≥2 个带真实 eval 条件（不是空缺）
- [ ] doctor 全绿（信封有效）；node validate 无环
- [ ] 已完成里程碑 unlock（时间轴布局能看到解锁弧）
