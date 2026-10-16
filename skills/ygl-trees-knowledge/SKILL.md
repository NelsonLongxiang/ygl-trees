---
name: ygl-trees-knowledge
description: >-
  ygl-trees 知识复用闭环：kb 笔记（add/import 批量 markdown/search 中文检索带标题加权/
  link/ingest 报告入库）、promote 笔记提升为可复用 skill（L1/L2/L3 渐进披露）、agent match
  技能命中。让研究报告沉淀为可被下次任务自动命中的技能。
  触发词：知识库、knowledge、kb、笔记、note、批量导入、import、search、检索、promote、
  技能、skill、复用、agent match。
version: 0.61.0
tags: ygl-trees,knowledge,kb,skill,reuse
---

# 知识复用闭环：报告 → 笔记 → skill → 自动命中

## 1. 入库

```bash
ygl-trees kb ingest <reportId>                 # 报告入库
ygl-trees kb add --title "..." --body "..." [--tags a,b]
ygl-trees kb import <dir|file.md>              # 递归批量导入 markdown（frontmatter:
                                               # title/tags/confidence/url；# 标题或文件名回退；
                                               # 单事务批量，2189 条 <1s；内容 hash 幂等）
ygl-trees kb link <a> <b> --rel related
```

## 2. 检索（中文原生）

```bash
ygl-trees kb rm <id>（删除笔记）
kb search（--eval 语义重排：决策模型逐条评估相关性） "闭包表 索引"
```

排序语义：命中 token 数降序 → **标题含 token 优先** → bm25。写查询词时把最独特的关键词
放进去；返回字段含 title_matched（标题命中数）。

## 3. 提升为 skill（L1/L2/L3 渐进披露）

```bash
ygl-trees kb promote <noteId> --name my-skill   # L1 描述自动从正文提炼（含来源标注）
ygl-trees skill refs add my-skill docs/x.md --body "..."   # L3 按需引用
ygl-trees agent match "我要做 X 任务"           # Agent 靠 L1 命中技能
```

- L1 description 常驻上下文（做什么+何时触发+同义词），L2 body 激活才加载
- 好的 L1 决定命中率：写清触发词；promote 的自动提炼已含来源标注
- `skill import <SKILL.md>` 可直接导入带 frontmatter 的技能文件

## 4. 闭环使用姿势

任务开始 → `agent brief` + `agent match "<任务描述>"` → 命中则 `skill show <name>` 读 L2 →
按 L2 干活；任务结束 → 产出报告 → `kb ingest` → 有复用价值就 `kb promote`。
每命中一次 `hits+1`，热门技能自然浮出。
