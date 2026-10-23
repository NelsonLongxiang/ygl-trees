---
name: mcp-dsh-connector
description: DSH 经 dsh-mcp-connector 直连 ygl-trees mcp 的配置方案（方案 D：零代码集成，工具随包版本走）
kind: 参考
---

# DSH ⇄ ygl-trees 集成：dsh-mcp-connector 配置（方案 D）

> 属主裁定（2026-10-23）：不建独立插件仓、不进 apps——**扩展现有 MCP 桥**。
> ygl-trees 0.114.26 起 `ygl-trees mcp` 提供 **11 工具** stdio 面；DSH 侧用现成
> `dsh-mcp-connector`（npm ≥0.2.78）直连。集成交付物 = **本配置段**，不是代码包。

## 为什么这条路赢

| 维度 | 定制插件（已废） | connector + 现有 MCP（本方案） |
|---|---|---|
| 版本 | 插件 pin ygl-trees → 永久漂移 | **随 ygl-trees 包版本走，永无漂移** |
| 发布 | 双包同日双发 | **单包**（ygl-trees 自身） |
| 代码 | 第二座桥（6 工具 schema 永久维护） | **零**——工具面在 mcp.ts 单点演进 |
| rc 契约 | 自建信封 | MCP `isError:true` + 机器可读 `{rc, error}`（0.114.26 保真） |

## 配置（DSH 侧）

`dsh plugin --profile <name> add dsh-mcp-connector`，然后在 profile 的 connector 配置中登记
ygl-trees server（以 connector 自身 config 形态为准，语义如下）：

```yaml
# dsh-mcp-connector 条目（spawn 语义；具体键名以 connector 文档为准）
- name: ygl-trees
  command: node
  args: [<ygl-trees 安装路径>/dist/bundle/bin.cjs, mcp]
  env:
    # per-workspace 隔离（0.114.22 选择观测语义：禁共享 default 桶）
    YGL_HOME: <workspace>/.ygl-trees
    YGL_SESSION: ${DSH_SESSION_ID}
```

要点：
- **YGL_HOME**：per-workspace（默认 `<workspace>/.ygl-trees`；env/config 可覆盖）——经 connector
  spawn env 透传，MCP server 及其 CLI 子进程全链继承；
- **YGL_SESSION**：绑 DSH 会话 id，会话桶隔离；
- **版本**：connector spawn 的就是当前安装的 ygl-trees（建议全局 `npm i -g ygl-trees` 或
  connector 环境内 pin），升级 ygl-trees 即升级工具面。

## 11 工具面（0.114.26）

| 工具 | 面 | 说明 |
|---|---|---|
| agent_brief / agent_match | 读 | 工作区定位 / 技能匹配（总从这里开始） |
| kb_search / claim_evaluate | 读 | 中文全文检索 / 决策模型置信度 |
| tree_state / produce_report / doctor / task_advance | 读+状态 | 树态 / 报告 / 健康检查 / 任务推进 |
| **research_write** | 写 | query/source/evidence/claim 六动词，幂等（duplicate:true） |
| **tree_write** | 写 | tree-new/use · node-add/link/unlock/index（改结构后必 index） |
| **verify** | 写 | submit→prepare→run→report→archive→meta 全管线 |

rc 契约全链保真：0 成功（含重复）/ 1 运行错误 / 2 用法错误——失败时 MCP 响应带
`isError:true`，content 为机器可读 `{rc, error}` JSON。

## 技能面

走 DSH 文件系统技能层（`.agents/skills` 扫描，与 connector 正交）：ygl-trees 仓
`skills/` junction 到 `.agents/skills` 的既有机制已在用；核心 5 技能（quickstart/research/
techtree/verify/lifecycle）无需经 MCP 分发。

## 验收映射（验证席重排）

| 面 | 验收点 |
|---|---|
| 工具 | connector 装配后 `tools/list` → DSH 工具可见的**映射保真**（11/11，rc 语义不丢） |
| 技能 | 文件系统层 junction 实证 |
| L5 真实任务 | 随 headless 环境修复后补 |
