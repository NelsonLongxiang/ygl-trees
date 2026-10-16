# Why I Built ygl-trees: A Research Workbench for AI Agents

*Or: how I stopped worrying about AI hallucinations and learned to love evidence*

---

## The Problem

If you've worked with AI agents on research tasks, you've seen it: the agent produces a beautiful, confident, well-structured answer that's completely wrong. Not because the model is bad — but because it has no obligation to show its work.

Ask an AI agent to "research X" and you get:
- Plausible-sounding conclusions with no citations
- "Facts" that are actually the model's guesses
- A wall of text you can't verify or refute
- Zero memory of what it learned when the session ends

We built **ygl-trees** to fix this. Not with prompts or guardrails bolted onto a chat window — with a proper tool that makes evidence the default.

## What It Is

ygl-trees is a CLI research workbench built specifically for AI agents. It gives the agent:

1. **An evidence pipeline** — query → source → evidence → claim → resolve. Every conclusion must trace back to a verbatim quote from a real source.

2. **A knowledge system** — reports get ingested into a searchable knowledge base. Good findings get promoted to reusable skills. The next agent session can discover them automatically.

3. **A decision model** — an LLM evaluates every claim's confidence (score 0-5 → grade A/B/C/D). This matters because agents are systematically overconfident.

4. **A tech tree model** — build dependency graphs with semantic unlock conditions. Not project management — cognitive modeling.

5. **An MCP server** — 8 tools that any IDE agent (Claude Desktop, Cursor, VS Code) can call directly. No command-line parsing.

```bash
npm install -g ygl-trees
ygl-trees db init        # 9 skills auto-imported, agent-ready in 1 second
ygl-trees agent brief    # agent immediately knows what to do
```

## The Insight That Changed Everything

We ran 30+ rounds of research using ygl-trees to study ygl-trees. One finding appeared consistently across every round:

**AI agents rate their own confidence one level higher than they should.**

When a human agent labels a claim "B" (high confidence), the evaluation model gives it "C" (moderate). This happened 30 times in a row. It's not noise — it's systematic bias.

The solution isn't to trust the model over the agent, or vice versa. It's to surface both ratings and let the gap itself be information. When human says A and model says C, that's a signal to gather more evidence.

This became one of the "three pillars" of our design theory:

1. **Reliability**: Mechanical guardrails > human discipline (49 contract assertions, zero regression in 8 rounds of cold-user feedback)
2. **Cognition**: Decision models calibrate agent intuition (agents are overconfident by exactly one grade)
3. **Evolution**: "Done" is iterative, not terminal (every round revealed gaps in what we thought was complete)

## The Accident→Guardrail Cycle

Here's the methodology that emerged from 8 rounds of real user feedback:

```
Accident happens (cold user finds a bug)
    → Root cause analysis (not just the symptom)
    → Fix the code
    → Add a mechanical guardrail (contract assertion or unit test)
    → Verify the guardrail catches the bug if reintroduced
    → Scan for the same class of problem everywhere
```

Numbers: 8 rounds · 49 guardrails added · 0 regressions from the same bug class.

The key insight: **discipline doesn't scale, but guardrails do.** A rule that says "always validate enum flags" gets forgotten. A contract test that fails CI when you don't validate enum flags never gets forgotten.

## What We Measured

After 30+ rounds, we quantified the tool's value:

| Metric | Value |
|--------|-------|
| Cold start to first productive action | 3 steps · 20ms |
| Skill discovery hit rate | 100% (8/8 test queries) |
| Knowledge search hit rate | 100% (10/10 test queries) |
| Claim verification rate | 100% (57/57 across 24 projects) |
| Same-class bug regression rate | 0% (49 guardrails, 8 rounds) |

## Who It's For

- **AI agent developers** — give your agent a research tool instead of letting it hallucinate
- **Knowledge workers** — your knowledge becomes discoverable by agents, not buried in notes
- **Tool builders** — the three-pillar theory is validated and ready to steal

## Try It

```bash
npm install -g ygl-trees
ygl-trees db init
ygl-trees agent brief
```

That's it. The agent gets 9 skills, full workspace state, and next actions — in under a second.

**MCP users**: add `"ygl-trees": {"command": "ygl-trees", "args": ["mcp"]}` to your Claude Desktop or Cursor config.

**Links**: [GitHub](https://gitee.com/NelsonLongXiang/ygl-trees) · [npm](https://www.npmjs.com/package/ygl-trees) · [One-pager](ONE-PAGER.md)

---

*Built over 111 commits, validated through 8 rounds of cold-user feedback, and 30+ rounds of self-directed research. The dog food is eaten and verified. ygl-trees v0.71.0 · MIT License.*
