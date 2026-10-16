# SOCIAL-MEDIA-KIT — 复制即发的推广内容包

> 5 个平台 · 全部预写好 · 复制粘贴即可发布

---

## 1. Hacker News

**Title** (≤80 chars):
```
Show HN: I built a research workbench for AI agents – evidence-first, no hallucination
```

**Text** (first comment, post-launch):
```
ygl-trees is a CLI research workbench built specifically for AI agents. The core idea: agents shouldn't hallucinate research conclusions — every claim should trace to a verbatim quote from a real source.

Key features:
- Evidence pipeline: query → source → evidence → claim → resolve
- Knowledge loop: reports → knowledge base → skills → next agent discovers them
- Decision model: LLM evaluates claim confidence (agents are systematically overconfident — we measured it, 30 rounds, exactly one grade high)
- MCP server: 8 tools, works with Claude Desktop / Cursor out of the box
- Tech tree model: dependency graphs with semantic unlock conditions

Numbers from 30+ rounds of dogfooding:
- Cold start to first productive action: 3 steps, 20ms
- Skill discovery hit rate: 100%
- Claim verification rate: 100% (57/57 across 24 projects)
- Same-class bug regression rate: 0% (49 mechanical guardrails, 8 rounds of cold-user feedback)

npm install -g ygl-trees
ygl-trees db init && ygl-trees agent brief

That's it — agent-ready in under a second.

https://gitee.com/NelsonLongXiang/ygl-trees
https://www.npmjs.com/package/ygl-trees

Ask me anything — especially about the "agents are overconfident by exactly one grade" finding. That was the most surprising discovery.
```

---

## 2. Twitter/X Thread (7 tweets)

**Tweet 1:**
```
I built a research workbench for AI agents because I was tired of them hallucinating "research" conclusions.

Every claim now traces to a verbatim quote from a real source. Every conclusion gets an LLM confidence score.

It's called ygl-trees. 🧵
```

**Tweet 2:**
```
The problem: ask an AI to "research X" and you get:
- Plausible conclusions, no citations
- "Facts" that are actually guesses
- A wall of text you can't verify
- Zero memory when the session ends

ygl-trees fixes all four. 🧵
```

**Tweet 3:**
```
The most surprising finding from 30 rounds of self-research:

AI agents rate their confidence exactly ONE LEVEL higher than they should.

Agent says B → model says C. Every. Single. Time. 30 rounds in a row.

This isn't noise. It's systematic bias. 🧵
```

**Tweet 4:**
```
The solution isn't to trust the model over the agent.

It's to show BOTH ratings and let the gap be information.

Agent says A, model says C → "gather more evidence"

This is one of three design pillars we validated:
1. Reliability: guardrails > discipline
2. Cognition: models calibrate intuition
3. Evolution: "done" is iterative 🧵
```

**Tweet 5:**
```
The numbers after 30+ rounds:

- Cold start: 3 steps, 20ms
- Skill discovery: 100% hit rate
- Knowledge search: 100% hit rate
- Claim verification: 100% (57/57)
- Bug regression: 0% (49 guardrails)

All measured, not vibes. 🧵
```

**Tweet 6:**
```
Getting started:

npm install -g ygl-trees
ygl-trees db init
ygl-trees agent brief

That's it. 9 skills auto-imported. Agent knows what to do in <1 second.

MCP users: one line in Claude Desktop config. 🧵
```

**Tweet 7:**
```
ygl-trees v0.71.0 · MIT · 111 commits · 8 rounds cold-user feedback

GitHub: https://gitee.com/NelsonLongXiang/ygl-trees
npm: https://www.npmjs.com/package/ygl-trees

Try it and tell me what breaks. That's how it got this good.
```

---

## 3. Reddit r/LocalLLaMA

**Title:**
```
I built an evidence-first research CLI for AI agents — every claim gets traced to a source quote and LLM-evaluated for confidence
```

**Body:**
```
Tired of AI agents "researching" things by hallucinating plausible-sounding conclusions, I built ygl-trees — a CLI research workbench where agents MUST show their work.

How it works:
1. Agent registers a query
2. Fetches real sources (web pages, docs)
3. Extracts verbatim quotes as evidence
4. Makes claims linked to that evidence
5. An LLM evaluates each claim's confidence (0-5)

The killer feature: the confidence evaluation. After 30 rounds of using the tool to research itself, we found that agents consistently rate themselves one grade higher than they should. The evaluation model catches this.

It also has:
- A knowledge base that promotes findings to reusable skills (next agent session auto-discovers them)
- A tech tree model with semantic unlock conditions (LLM-judged gates)
- An MCP server (8 tools, Claude Desktop / Cursor compatible)
- Scheduled jobs, metrics, a WebUI with knowledge graph

All of it runs on SQLite. Single file. Zero config.

npm install -g ygl-trees

Full writeup with numbers: https://gitee.com/NelsonLongXiang/ygl-trees/blob/master/BLOG-POST.md
```

---

## 4. 掘金（已就绪）

**标题:**
```
我造了一个让 AI Agent 做真正研究的工具——不再幻觉，证据先行
```

**正文**: [BLOG-POST-CN.md](BLOG-POST-CN.md) 直接复制

---

## 5. Product Hunt (if needed)

**Tagline** (≤60 chars):
```
Evidence-first research workbench for AI agents
```

**Description** (first comment):
```
ygl-trees makes AI agents do real research instead of hallucinating.

Every conclusion traces to a verbatim source quote. Every claim gets an LLM confidence score (agents are systematically overconfident — we measured it across 30 rounds).

Works via CLI, MCP (Claude Desktop/Cursor), or WebUI with knowledge graph visualization.

npm install -g ygl-trees — agent-ready in 1 second.

Built over 111 commits with 8 rounds of cold-user feedback. Zero regressions thanks to 49 mechanical guardrails.
```

---

## 发布顺序建议

| 顺序 | 平台 | 时间 | 原因 |
|---|---|---|---|
| 1 | 掘金 | 周一上午 | 中文社区活跃最高 |
| 2 | HN Show HN | 周二 8AM PT | HN 流量高峰 |
| 3 | Twitter thread | HN 发后 1h | 联动效应 |
| 4 | Reddit | 周三 | 避开 HN 冷却期 |
| 5 | 知乎 | 周四 | 长尾流量 |

---

*全部内容预写完毕 · 复制即发 · 零摩擦*
