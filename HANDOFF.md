# HANDOFF.md — 六个月后回来时读这个

> 写于 2026-10-17 · ygl-trees v0.71.0 · 109 commits · 30 轮研究之后

## 项目当前状态（一句话）

**ygl-trees 已完成、已发布、已验证——等你让更多人用。**

## 一切在哪里

| 什么 | 哪里 |
|---|---|
| 代码 | https://gitee.com/NelsonLongXiang/ygl-trees (master @ b36faf1) |
| npm 公网 | `npm install -g ygl-trees` (v0.71.0) |
| npm Gitea | `@nelsonlongxiang/ygl-trees` (v0.71.0) @ 192.168.3.88:3000 |
| 工作区 | `~/.ygl-trees` (SQLite, schema v9) |
| PG 镜像 | `ygl_trees` @ 192.168.3.88:15433 |
| WebUI | `ygl-trees webui serve --port 8642 --host 0.0.0.0` |
| MCP | `ygl-trees mcp` (stdio, 8 工具) |

## 已做完的事（不要重做）

- ✅ 研究管线（query→source→evidence→claim→produce）
- ✅ 科技树模型（nodes/edges/conditions/eval gates/closure）
- ✅ 知识闭环（kb→promote→match，R12 验证跨项目命中）
- ✅ 关联织物（rel，8 类实体，知识图谱可视化）
- ✅ MCP Server（8 工具，stdio JSON-RPC）
- ✅ antd WebUI（React + xyflow + SSE + 知识图谱）
- ✅ npm 双仓发布（npmjs.org + Gitea）
- ✅ 契约体系（5 项冻结，86 项机械断言）
- ✅ 决策模型（claim evaluate / evidence assess / kb search --eval）
- ✅ 自动化（agent metrics / job 系统 3 任务 / doctor --fix）
- ✅ 三支柱+生态位理论（内外双验证）
- ✅ 事故→护栏方法论（8 轮，49 项护栏）
- ✅ 30 轮研究（53 断言 100% verified）
- ✅ ONE-PAGER.md / llms.txt / DESIGN.md / 9 技能 / 论文级报告

## 还没做的事（以及为什么）

| 事项 | 为什么没做 | 怎么做 |
|---|---|---|
| **推广** | 需要你行动 | 把 ONE-PAGER.md 发给可能感兴趣的人 |
| **Bun 运行时** | 上游 bug（Windows mkdir 返回 ENOENT） | 等 Bun 修复，或换 Linux |
| **多 Agent 协作** | 需要平台级支持 | ygl-trees 的 A2A 经验已有，需 Agent 编排层 |
| **自进化** | 缺代码生成+审批门 | 见 R27 分析：5/7 组件就绪 |
| **知识图谱增强** | 当前 99 实体够用 | rel 数据增长后可加聚类/路径分析 |

## 关键决策（以及为什么这么决定）

| 决策 | 原因 |
|---|---|
| SQLite 而非 PG 做主库 | 零配置 · 事务性 · FTS5 中文 · 单文件可移植 |
| PG 做镜像（L1.5）而非双写 | 避免分裂脑 · SQLite 永远是唯一写入口 |
| Cordis 框架（DSH fork） | 用户裁定框架级一致性 · 修复 rc.11 时序 |
| 契约冻结（5 项） | 机械护栏 > 人工纪律（8 轮实证） |
| MCP 8 工具（非全量映射） | 精选 > 海量（Ant Design 也只做 7 个参考） |
| serve 不持排他锁 | WAL 允许并发读写 · serve+CLI 共存 |
| flag 校验在 CLI 层 | 跨库类型陷阱只有入口能拦（0.59 教训） |

## 最重要的三个数

1. **冷启动 3 步 20ms** — 从 db init 到 Agent 知道该做什么
2. **断言验证率 100%** — 53/53 条断言全部有证据支撑
3. **同类缺陷回归拦截 100%** — 49 项护栏在 8 轮反馈中零漏网

## 如果你只做一件事

**把 ONE-PAGER.md 发给 3 个可能需要 AI Agent 研究工具的人。**

他们的反馈是解锁 real-users 节点的唯一路径，也是下一轮进化的起点。

## 工作区数据快照

```
~/.ygl-trees · 3,200+ events · doctor ✓
  21 个研究项目 · 53 条断言 · 69 条证据 · 20 条知识
  7 个技能 · 10 棵树 · 122/129 解锁（95%） · 75 条关联
  3 个自动化 job · MCP 8 工具 · 知识图谱 99 实体
```

---

*30 轮 · 109 commits · 0.1.0 → 0.71.0 · 8 轮冷用户反馈 · 53 断言 · 全绿*
