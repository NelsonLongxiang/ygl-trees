# ygl-trees FAQ — 新用户常见问题

> 预回答你可能会问的问题。有其他问题？提 issue。

---

## 它是什么？

**ygl-trees 是一个给 AI Agent 用的研究工作台 CLI。** 它让 Agent 做「真正的研究」——证据先行、断言可验证、知识可复用——而不是幻觉。

## 跟 ChatGPT/Claude 直接做研究有什么区别？

| | ChatGPT/Claude 直接 | ygl-trees |
|---|---|---|
| 证据 | 模型生成的「事实」 | 必须引用来源原文 |
| 置信度 | 「我确信」 | LLM 评分 0-5 → A/B/C/D |
| 记忆 | 会话结束即丢失 | 知识库 + 技能，下次自动命中 |
| 可反驳 | 你不知道怎么反驳 | 每条断言可链接证据、可 resolve 为 refuted |

## 跟 Obsidian/Notion 有什么区别？

Obsidian/Notion 是**人的**知识管理。ygl-trees 是 **Agent 的**知识管理：
- Agent 通过 CLI/MCP 直接操作（不需要 GUI）
- 知识会被 `agent match` 自动发现（不需要人主动搜索）
- 技能系统让 Agent 跨会话复用学到的东西

## 冷启动有多快？

```
npm install -g ygl-trees    # 10 秒
ygl-trees db init            # 1.3 秒（9 技能自动导入）
ygl-trees agent brief        # 20ms（Agent 立刻知道该做什么）
```

**3 步，总共 <15 秒。**

## 需要什么环境？

- Node.js ≥ 18
- SQLite（内置，零配置，自动创建）
- 可选：PostgreSQL（做分析镜像）、AI API key（决策模型）

**不需要**：Docker、Redis、外部数据库、云服务。单文件 SQLite 是唯一事实源。

## MCP 怎么配？

Claude Desktop 的 `claude_desktop_config.json` 加：

```json
{
  "mcpServers": {
    "ygl-trees": {
      "command": "ygl-trees",
      "args": ["mcp"]
    }
  }
}
```

Cursor / VS Code / Windsurf 同理。8 个工具即刻可用。

## 「决策模型」是什么？

一个 LLM 评估器，用于：
- **claim evaluate** — 评估断言置信度（0-5 → A/B/C/D）
- **evidence assess** — 评估证据质量
- **kb search --eval** — 语义重排搜索结果
- **node can --eval** — 语义解锁判定

**为什么重要**：AI Agent 给自己标 B 的断言，模型评估是 C——**Agent 系统性偏乐观一级**（30 轮实证）。决策模型不是替代判断，是校准。

**离线安全**：没有 API key 时自动降级为 pending，不阻塞工作流。

## 什么是「科技树」？

一个有依赖关系的节点图（类似 RPG 技能树/文明科技树）：
- 节点有前置（解锁条件）
- 条件可以是数值（`level >= 3`）或语义（`--op eval "是否已验证"`)
- 树可以解锁/锁定/查询路径
- WebUI 可视化（拖拽缩放）

**用途**：建模任何有阶段性的东西——产品路线、技能进阶、研究进度、学习路径。

## 什么是「知识闭环」？

```
研究 → 报告 → kb ingest → 知识库 → kb promote → 技能 → agent match → 下次自动命中
```

第一次研究花 30 分钟。第二次同类研究 Agent 自动发现上次的技能，**不用从零开始**。

## 数据安全吗？

- SQLite WAL 模式（事务性，断电不损坏）
- 单文件备份：`ygl-trees db export backup.sql`
- PG 镜像（可选）：`ygl-trees db sync pg <url>`
- 无云依赖：数据全在本地 `~/.ygl-trees/`

## 免费吗？

MIT License。完全免费开源。

## 怎么贡献？

```bash
git clone https://gitee.com/NelsonLongXiang/ygl-trees.git
pnpm install && pnpm build && pnpm test
```

135 单测 + 86 契约断言全绿后提交 PR。

## 有生产案例吗？

**有——本工具自己。** ygl-trees 用自己研究了自己 30+ 轮：
- 24 个研究项目 · 57 条已验证断言 · 11 棵树
- 8 轮冷用户反馈 · 49 项护栏 · 零同类回归
- npm 发布 · MCP 上线 · 知识图谱 · WebUI

**狗粮已吃完并验证。**

## 更多文档

| 文档 | 内容 |
|---|---|
| [README.md](README.md) | 完整命令参考 |
| [ONE-PAGER.md](ONE-PAGER.md) | 30 秒了解 |
| [BLOG-POST-CN.md](BLOG-POST-CN.md) | 为什么造它 |
| [llms.txt](llms.txt) | Agent 一次性获取全部能力 |
| [HANDOFF.md](HANDOFF.md) | 项目全景 |

---

*v0.71.0 · 114 commits · MIT License · [GitHub](https://gitee.com/NelsonLongXiang/ygl-trees) · [npm](https://www.npmjs.com/package/ygl-trees)*
