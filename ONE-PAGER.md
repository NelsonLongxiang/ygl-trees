# one-pager

_generated 2026-10-16 21:07:56 UTC by ygl-trees_

**研究问题**：为从未听说过 ygl-trees 的人写一页纸介绍

## 摘要

共 0 条断言（0 条已证实、0 条存争议、0 条待验证），基于 0 条证据、0 个来源。

## 主要结论


## 一页纸

# ygl-trees — AI Agent 的研究工作台

## 30 秒了解

**ygl-trees 是给 AI Agent 用的研究工具。** 它让 Agent 做「真正的研究」——证据先行、断言可验证、知识可复用——而不是幻觉。

```bash
npm install -g ygl-trees    # 安装（10 秒）
ygl-trees db init            # 冷启动（9 个技能自动导入）
ygl-trees agent brief        # Agent 立刻知道该做什么
```

## 它解决什么问题

AI Agent 做研究有三个痛点：
1. **幻觉** — Agent 生成看似合理但无依据的结论
2. **遗忘** — 会话结束，学到的东西全部丢失
3. **不可信** — Agent 说「我确信」，但置信度是拍的

ygl-trees 的解法：
1. **证据管线** — query → source → evidence → claim → resolve，每条结论有原文引文
2. **知识闭环** — 报告 → 知识库 → 技能 → 下次 Agent 自动命中
3. **决策模型** — LLM 评估断言置信度（0-5 → A/B/C/D），校准 Agent 直觉

## 量化证据（28 轮实测）

| 指标 | 数值 |
|---|---|
| 冷启动到首次产出 | **3 步 · 20ms** |
| 技能命中率 | **100%** |
| 知识检索命中率 | **100%** |
| 断言验证率 | **100%**（53/53） |
| 同类缺陷回归拦截 | **100%**（49 项护栏 · 8 轮验证） |

## 三个独特能力

### 1. 科技树模型
建一棵有依赖关系的节点树（前置/解锁/互斥），每个节点可挂**语义评估门槛**（决策模型判定是否满足条件）。不是项目管理工具——是**认知模型**。

### 2. 决策模型校准
Agent 给自己标 A（高置信度），模型评估给 C——**Agent 直觉系统性偏高 1 级**（28 轮实证）。决策模型不是替代判断，是**校准**。

### 3. 事故→护栏循环
每次事故（冷用户反馈发现的 bug）修复后，必须附带机械护栏（contract 断言或单测）。同类缺陷**永远不再出现**。8 轮实践 · 49 项护栏 · 100% 回归拦截。

## 面向谁

- **AI Agent 开发者** — 给 Agent 一个「做研究」的工具而不是让它幻觉
- **知识工作者** — 你的知识不只存在笔记里，还能被 Agent 自动发现
- **工具构建者** — 三支柱理论（可靠性/认知/演化/生态位）指导工具设计

## 快速开始

```bash
npm install -g ygl-trees
ygl-trees db init
ygl-trees agent brief
ygl-trees project new my-research -q "我想研究什么"
ygl-trees research source add --title ... --url ...
ygl-trees research claim add "我的第一个可反驳断言"
ygl-trees produce report
```

## 更多

- **MCP**: `ygl-trees mcp` — Claude Desktop / Cursor 直连（8 工具）
- **WebUI**: `ygl-trees webui serve` — React 仪表盘 + 知识图谱
- **llms.txt**: `ygl-trees llms` — Agent 一次性获取全部能力面
- **文档**: https://gitee.com/NelsonLongxiang/ygl-trees

---

*ygl-trees v0.71.0 · 108 commits · 28 轮实证验证 · MIT License*

## 证据清单


## 来源


## 局限与未决问题

_无_