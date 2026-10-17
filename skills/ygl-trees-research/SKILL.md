---
name: ygl-trees-research
description: >-
  用 ygl-trees 研究管线做证据先行的研究：检索式登记（query add）、来源采集（source add（--relevance 只收整数 0-5，非整数 rc=2） /
  source fetch 网页抓取）、原文摘录（evidence add）、断言与证据链接（claim add / link /
  resolve 人工仲裁）、query↔source 召回关联（query attach）、产出证据支撑的报告
  （produce outline/section/report/export）。
  触发词：研究、调研、evidence、证据、claim、断言、来源、source、引文、仲裁、resolve、
  报告、report、文献、抓取、fetch。
version: 0.73.0
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
ygl-trees research source add --adjudication "会话内裁决：三条件已逐条核对" \
        --tags adjudication                                    # 会话内裁决原生载体（0.80）：
                                                              # url 自动 session://adjudication/<时刻>，
                                                              # 摘要兼作标题——不再需要临时文件绕行
```

来源按 `(project, url_hash)` 去重；`--query` 顺带建立召回关联（query list 显示召回数）。
`--url` 收任意 `<scheme>://`（https/file/session/a2a/…，0.81）——跨 Agent 引用免落盘。
**并发钉住（0.83）**：全组接受 `--project <p>` 长旗标（与 `-p` 等价）——并发会话共享 current 指针互踩时直接钉住目标项目，回执带 `· project <名>` 回显落点；`--query` 引用不存在 → 整体拒绝 rc=1 零落地（半写防护）。

## 2. 摘录与断言

```bash
ygl-trees research evidence add <sourceId> --quote "原文片段" --locator "§2"
ygl-trees research evidence add <sourceId> --file quotes.md         # 长摘录免转义
ygl-trees research claim add "断言文本" --confidence A               # 档位
ygl-trees research claim add "断言文本" --confidence 0.92            # 数值档（0.81：0-1 或 0-100%）
ygl-trees research claim link <claimId> <evidenceId> [--stance refutes]   # 状态自动推导（普通断言）+ 自动模型评估落账（0.84）
ygl-trees research claim resolve <claimId> --as contested --note "矛盾待查"  # 人工仲裁出口
ygl-trees research claim unresolve <claimId>   # 复位回 unverified（0.82.1：撤销链接副作用/抢跑仲裁）
ygl-trees research claim evaluate <claimId>    # 模型置信度评估（0.84：写 claim.eval 事件，不再 stdout 蒸发）
ygl-trees research claim calibration [--all]   # 模型 vs 人工档差读出（0.84：校准预测 ≥60% 判据的测量面）
```

- 有支持有反对 → `contested`；仲裁后新证据链接会重新推导
- **预测断言（`[预测·…]` 前缀）挂证据不自动晋升**（0.82.1）：挂证据 ≠ 仲裁，状态保持 unverified 直到显式 resolve / 到期回测——predict audit 才不会把刚挂证据的预测误判已结案；误晋升用 `claim unresolve` 归位（幂等 duplicate:true）
- **判定史可对账（0.84）**：link 自动评估与手动 evaluate 都落 `claim.eval` 事件（mode: auto-on-link|manual）；`calibration` 按"每断言最新评估胜出"汇总模型档位 vs 人工仲裁档位——巡检"决策模型置信度"预测时先跑它，别手工数事件
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
- 预测断言（`[预测·N天]`）定期 `research predict audit` 回测：本地判据自动测；`--state <file|url>`
  桥接外部计数（裸键名后缀匹配 `counts.y_imported`）；已 resolve 的默认隐藏（`--all` 查看终态表，
  `--json` 始终含全量行含终态——机器读全量、人看增量）
- `--json` 输出可直接 parse 拿 id；列表命令字段：source(id,title,url,relevance,…)、
  claim(id,text,status,confidence,sup,ref)、evidence(id,source,locator,quote,used_by)
