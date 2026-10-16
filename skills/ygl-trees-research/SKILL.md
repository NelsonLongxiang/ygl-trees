---
name: ygl-trees-research
description: >-
  用 ygl-trees 研究管线做证据先行的研究：检索式登记（query add）、来源采集（source add /
  source fetch 网页抓取）、原文摘录（evidence add）、断言与证据链接（claim add / link /
  resolve 人工仲裁）、query↔source 召回关联（query attach）、产出证据支撑的报告
  （produce outline/section/report/export）。
  触发词：研究、调研、evidence、证据、claim、断言、来源、source、引文、仲裁、resolve、
  报告、report、文献、抓取、fetch。
version: 0.14.0
tags: ygl-trees,research,evidence,claim,report
---

# 证据先行的研究管线

核心循环：**来源 → 证据 → 断言 → 报告**。断言状态由证据链接自动推导
（supported/refuted/contested/unverified），报告只把已证实的写成结论。

> **什么时候动这些命令**（时机而非机制）见 `ygl-trees-lifecycle` 技能。

## 1. 采集

```bash
ygl-trees research query add "邻接表 vs 闭包表"              # 登记检索式
ygl-trees research source add --title t --url https://... \
        --abstract "..." --relevance 4 --query "邻接表 vs 闭包表"   # 手工入库+关联检索式
ygl-trees research source fetch https://example.com/page     # 自动抓取（title/meta/正文；
                                                              # 非 html 拒收零副作用；薄内容打 needs_review）
```

来源按 `(project, url_hash)` 去重；`--query` 顺带建立召回关联（query list 显示召回数）。

## 2. 摘录与断言

```bash
ygl-trees research evidence add <sourceId> --quote "原文片段" --locator "§2"
ygl-trees research claim add "断言文本" --confidence A
ygl-trees research claim link <claimId> <evidenceId> [--stance refutes]   # 状态自动推导
ygl-trees research claim resolve <claimId> --as contested --note "矛盾待查"  # 人工仲裁出口
```

- 有支持有反对 → `contested`；仲裁后新证据链接会重新推导
- 全部命令幂等：同内容重跑返回已存在行（`duplicate: true`，rc=0）

## 3. 产出

```bash
ygl-trees produce outline          # 按 claim 状态生成骨架
ygl-trees produce section "结论" --body "..."
ygl-trees produce report           # 摘要→结论(带证据编号)→章节→证据清单→来源→局限
ygl-trees produce export <reportId> report.md
```

未证实断言自动进"局限与未决问题"，不伪装成结论。

## 4. Agent 检查清单

- 先 `agent brief --json` 看 next_actions（它会告诉你缺来源/缺证据/缺断言）
- 每条断言至少一条证据再进报告；contested 的要么补证据要么 resolve
- `--json` 输出可直接 parse 拿 id；列表命令字段：source(id,title,url,relevance,…)、
  claim(id,text,status,confidence,sup,ref)、evidence(id,source,locator,quote,used_by)
