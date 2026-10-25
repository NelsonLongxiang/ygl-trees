---
name: ygl-trees-quickstart
description: >-
  ygl-trees 工作台快速上手与全局契约：初始化（db init）、研究项目（project new）、
  agent brief 定位下一步、--json 纯净纪律与退出码契约、健康检查（doctor）、
  任务清单（task）、关联织物（rel）、用户插件（plugin install）、WebUI（webui serve）、
  备份导出（db export）、PG 镜像/迁移、调度（job add/tick）、性能基准（pnpm bench）、
  bundle 构建（build:bundle）、临时文件 tmp/ 规范。
  触发词：ygl-trees 入门、初始化、quickstart、工作区、退出码、exit code、备份、export、
  PostgreSQL、sync、migrate、镜像、job、tick、定时、doctor、健康检查、任务、task、
  关联、rel、插件、plugin、WebUI、webui、仪表盘、dashboard、bench、基准、bundle、
  MCP、mcp、read、write、verify、doctor、domain、action、工具、tool。
version: 0.115.1
tags: ygl-trees,quickstart,backup,postgres,schedule,doctor,plugin,webui,bench
---

# ygl-trees 快速上手与全局契约

单一 SQLite 文件是唯一事实源；PostgreSQL 只做单向导出。所有命令支持 `--json`。

## 0. 三种接入方式（选一）

| 方式 | 适合 | 入口 |
|---|---|---|
| **CLI 直调** | 本地开发/脚本/运维 | `ygl-trees <group> <action> [args] --json` |
| **MCP 工具** | AI agent（Claude/DSH/市场网关） | `ygl-trees mcp`（stdio）或 `ygl-trees mcp --http --port 9820`（HTTP） |
| **技能面** | agent 自学 | 你正在读的这个 |

**MCP 4 工具**（0.115.0 收敛，domain×action 路由——少工具、富参数）：

```
read   → 一切读面：{domain: "agent|kb|tree|node|task|rel|research|produce|project|db|skill", action: "brief|search|state|list|can|...", ...}
write  → 一切写面：{domain: "research|kb|tree|task|rel|project|produce", action: "query-add|source-add|node-add|attach|...", ...}
verify → 验证管线：{action: "submit|prepare|run|report|archive|meta", a: ..., b: ..., c: ..., db: ...}
doctor → 健康检查：{fix: true|false}
```

**MCP 与 CLI 的映射规则**：`domain` = CLI 命令组，`action` = CLI 子命令（`-` 连接），其余参数透传。
例：`read {domain:"research", action:"source-search", query:"供应商"}` ≈ `research source search "供应商" --json`。

**安全边界**：MCP 写面是枚举闭集（action 只能取 schema 中列出的值）；管理面（db reset/sql、plugin、config、job、patrol）物理排除在 MCP 之外——agent 只能通过本地 CLI 执行管理操作。

## 0b. MCP 覆盖边界（哪些 CLI 动作不在 MCP 里，为什么）

MCP 覆盖 agent 研究工作面约 80%；其余 CLI 动作分两类**刻意排除**，不是遗漏：

### A 类：物理排除——安全边界（不可协商，永不进 MCP）

| CLI 面 | 排除原因 |
|---|---|
| `db reset` | 删库——提示注入可诱导 agent 自毁工作区 |
| `db sql "..."` | 任意 SQL——绕过写服务的事务化/幂等/坏引用保护 |
| `db init / export / sync / migrate` | 工作区生命周期管理——部署者操作，非 agent 面 |
| `plugin install / enable / disable` | 代码执行面——插件可跑任意 JS |
| `config set / reset` | 系统配置变更——影响引擎行为 |
| `job add / rm / tick` | 调度器管理——可触发任意已注册 job |
| `patrol add / rm` | 巡检管理——同上 |
| `webui serve` | 长驻进程——MCP 工具调用是短生命周期 |

**原则**：agent 能做研究工作但物理不能动基础设施。这些操作只能通过本地 CLI 由人执行。

### B 类：破坏性写面——agent 可建不可毁（永不进 MCP）

| CLI 面 | 排除原因 |
|---|---|
| `research evidence rm --force` | 级联删除+重算——不可逆 |
| `research source rm` | 删来源——级联影响下游 |
| `research claim unlink / unresolve` | 撤销操作——幂等设计里撤销是人的决定 |
| `skill rm / enable / disable` | 技能生命周期——管理面 |

**原则**：MCP 写面全部幂等（同内容重跑=已存在，安全重试）；删除不幂等——被注入的 agent 删了就没了。创建走 agent，销毁走人。

### C 类：路由缺口（可加但未加，逐步补）

| CLI 面 | 状态 | 何时加 |
|---|---|---|
| `research source fetch <url>` | 网络副作用读 | 可加 |
| `research predict audit` | 读面但复杂 | 可加 |
| `produce outline / section / export` | 报告子命令 | 可加 |
| `verify tree prepare/run/report` | A1 递归验证 | 随 0.115.0 契约落定 |
| `verify self-check / probe / example` | 专用工具面 | 低优先 |
| `verify lint-candidates` | lint 无仪式版 | 可加 |
| `skill add / import / refs` | 技能创建 | 可加 |
| `node export / import` | 树导入导出 | 可加 |

### 汇总

| 类别 | 数量 | 原因 | 处置 |
|---|---|---|---|
| A 物理排除 | ~18 个动作 | 安全边界（不可协商） | 永不进 MCP |
| B 破坏性写 | ~6 个动作 | agent 可建不可毁 | 永不进 MCP |
| C 路由缺口 | ~12 个动作 | 还没来得及 | 逐步补入 |

**判断口诀**：看到一条 CLI 命令想通过 MCP 调——先问「删东西吗？动基础设施吗？」都是→不在 MCP，走本地 CLI；否→应该在 MCP 里，若不在查上面 C 类表。

## 1. 冷启动三步

```bash
node dist/apps/cli/src/bin.js db init           # 建工作区（$YGL_HOME，默认 ~/.ygl-trees）
node dist/apps/cli/src/bin.js project new <name> -q "<研究问题>"
node dist/apps/cli/src/bin.js agent brief       # 我在哪、有什么、下一步做什么（从这里开始）
```

MCP 等价：`write {domain:"project", action:"new", name:"...", question:"..."}` → `read {domain:"agent", action:"brief"}`

## 2. Agent API 契约（冻结，勿靠猜）

- **退出码**：`0` 成功（含"重复已存在"）、`1` 运行错误/404、`2` 用法错误
- **--json 纯净**：写 = 单个 JSON 对象（重复带 `duplicate: true`）；读 = 数组/对象
- **写入幂等**：claim/evidence/query/kb/job 按内容 hash 判重；`--force` 显式保留重复
- 输出字段名是冻结契约，snake_case

## 2a. 技能发现（Agent 一键连接）

```bash
ygl-trees skill link              # 连接到 ./.agents/skills/（DSH/Claude 等 Agent 即刻可发现）
ygl-trees skill link --global    # 连接到 ~/.agents/skills/（全局）
```

## 2a. v2 新命令（0.72+）

```bash
ygl-trees agent ask "<问题>"       # 自然语言路由（projects/search/tree/health/...）
ygl-trees db time-travel "日期"    # 查询过去某时刻的工作区状态
ygl-trees db timeline              # 增长时间线（events/天+里程碑）
ygl-trees db timeline --actor <a> [--session <s>]  # 按 actor/会话过滤 + 最近 20 条原始事件（多 Agent 对账）
ygl-trees db workspace list        # 多工作区管理
ygl-trees db obsidian [dir]        # 导出 Obsidian markdown vault
ygl-trees skill init <name>        # 模板创建技能
ygl-trees skill refs <name>        # 技能引用展示
ygl-trees llms --section <name>    # 能力清单节选
ygl-trees llms --json              # 结构化 JSON
```

## 2b. 运维命令速查

```bash
ygl-trees doctor           # 10 项健康检查（含锁 pid 存活、幻影写入对账）
ygl-trees doctor --fix     # 一键安全修复（脏索引 + 死 pid 陈旧锁 + 幻影事件标记 reconciled；活 holder 不动）
ygl-trees db unlock        # 清残留 .ygllock（死 pid 直清；活 holder 回显其命令行并拒绝，--force 强清）
ygl-trees kb rm <id>       # 删除笔记（与 skill rm 对称）
ygl-trees webui serve --host 0.0.0.0 --port 8642  # LAN/WSL 可访问
ygl-trees webui serve --help   # 只打印用法不启服务（0.79.1 短路）
ygl-trees webui export --out snap.json  # 服务形态快照（0.88：HTML 仪表盘退役，React 唯一前端）
```

PG 迁移预检：`db migrate pg` 前自动逐表扫描 INTEGER 列类型——非整数值会**点名 table.column rowid=N** 而非迁移时才爆。

## 2b2. 多会话安全（0.79 → 0.85）

- **0.85 会话选择分辨率（根治）**：`project use`/`tree use` 写**会话键**（`current_project@<sid>`，sid=YGL_SESSION||DSH_SESSION_ID）——每个 Agent 会话独立选择，互不踩踏；优先级 flag > env（YGL_PROJECT/YGL_TREE）> 会话键 > 全局键。多项目未选择时 `research`/`produce`/`agent brief` fail-closed（rc=2 点名出路），单项目自动命中；`project show --json` 带 `selection_source`，`tree show` 报来源+统计
- **0.83 并发钉住（写命令内联）**：写命令直接钉住目标：`research * --project <p>`、`produce/task * --project <p>`、`node * --tree <t>`（`node import --tree` 是目标树名，非选择器）；写回执带 `· project <名>` 回显落点
- `tree use` / `project use` 落 `tree.use` / `project.use` 事件（`YGL_SESSION` 会话标识）
- `agent brief` 的 `selection_changed`：最近 10 分钟选择变更；跨会话变更置顶提示带 `-t`/`-p`
- `kb add` 回执自检（`verified:true`）+ 工作区回显（防写错 home 的"丢笔记"事故）
- `research claim link <cid> <sid> --by-source`：来源下全部证据一次挂齐；误传来源 id 会列出其证据 id
- `research source add --query` 引用不存在 → 整体拒绝 rc=1 零落地（0.83 半写防护）
- `--help` 任意深度打组帮助 rc=0（如 `kb add --help`）；job 子命令无锁启动（`ygl-trees …` 型任务命令不再与 runner 死锁）
- 到期巡检范式：`job add "到期巡检" --every 1440 -- ygl-trees node cond --due --days 30`

## 2c. DB 锁行为（0.68 → 0.79.1）

- CLI 短命令：进程级锁（保护写窗口，退出自动释放）；锁文件记录**持有者命令行**，撞锁/`db unlock`/`doctor` 都回显真实持有者身份
- webui serve：无锁（WAL 并发安全，与 CLI 共存；从不取写锁）
- 死锁自愈：下一进程探测持有者 PID，死则即时清（无需手动 rmdir）
- 无锁进程（serve / `db unlock` 自身）退出绝不误清并行会话的活锁（0.79.1 所有权守卫）
- YGL_TEST=1：全旁路（测试并行）

## 3. 健康检查与任务

```bash
ygl-trees doctor                     # 10 项健康检查（schema/索引/FTS/重复/孤儿/config/锁存活/eval信封/插件/幻影写入→warn）
ygl-trees task add "<标题>"           # 建任务（todo 起步）
ygl-trees task add "验证 X" --node <tree>/<key>   # 建任务并挂树节点（tracked-by，0.81）
ygl-trees task list                  # 按状态分组
ygl-trees task done <id>             # 勾销（全程留痕）
```

## 4. 关联织物（把研究资产挂到树节点）

```bash
ygl-trees rel add node:<tree>/<key> claim:<id> --rel decided-by
ygl-trees rel add node:<key> kb:<id> --rel evidenced-by
ygl-trees rel add node:<key> artifact:<id> --rel tracked-by
ygl-trees rel list --src node:<key>  # 双向过滤 + 对端显示名
```

八类引用：`node claim evidence source query kb artifact skill`。
详细方法论见 `ygl-trees-relating` 技能。

## 5. 用户插件（业务域扩展位）

```bash
ygl-trees plugin init                          # 建 $YGL_HOME/plugins profile
ygl-trees plugin install <npm包|git地址|本地目录> # 本地目录自动 link:
ygl-trees plugin list                          # 版本 / spec / 可解析态
ygl-trees plugin remove <name>
```

插件契约：`export apply(ctx, config)` + 可选 `export commands = { <组名>: { run } }`
贡献 CLI 命令组。编写指南：`docs/plugin-authoring.md`。示例：`examples/plugin-demo/`。

## 6. WebUI

```bash
ygl-trees webui serve --port 8642   # React 客户端（xyflow 树 + 时间轴 + 产出渲染）
ygl-trees webui export --out d.html # 零依赖单文件导出（离线可开）
```

构建 React 客户端：`pnpm --filter @ygl/web build`。设计系统：仓库根 `DESIGN.md`。

## 7. 备份 / PostgreSQL / 调度

```bash
ygl-trees db export <file.sql>          # 全部数据表 + 行数摘要
ygl-trees db sync pg <url>              # 可刷新 PK-only 镜像
ygl-trees db migrate pg <url> [--fresh] # 一次性完整保真迁移
ygl-trees job add <title> -- "<cmd>" --every 60   # cron 每分钟跑 job tick
ygl-trees job add "闸门探针" -- "node probe.mjs" --every 30   # 树节奏化监控：任意命令皆可（0.79.1 实证）
```

禁止双后端同写：ygl-trees 永远只写 SQLite，PG 是单向出口。

## 8. 性能基准

```bash
pnpm bench               # 7 席（startup/写入/检索/索引），结果 tmp/bench-results.json
pnpm build:bundle        # tsdown 单文件 bundle（~323KB，10% 启动提速）
```

## 9. 临时文件铁律

一切临时脚本/数据放 `<repo>/tmp/`（已 gitignore），**禁止**写系统临时目录。

## 10. 用户配置（config 表）

```bash
ygl-trees config list                  # 全部键
ygl-trees config set eval.pass_threshold 0.8   # 写入即校验 + 留痕
ygl-trees config reset eval.pass_threshold
```

## 10b. 什么时候动数据（时机问题）

本技能讲"怎么动"；**"什么时候动"看 `ygl-trees-lifecycle` 技能**——事件→动作触发表
（树侧何时 unlock/add/link、研究侧何时写 source/evidence/claim/kb/task）、节奏纪律
（改结构后必 `node index`+`validate`、解锁后必挂证据、会话收口前必 `agent brief`+`doctor`）、
以及漂移反模式。开场先 `agent brief`，收口前 `doctor`。

## 10c. 冻结契约五项（0.55 定契）

| 契约 | 含义 | 门禁 |
|---|---|---|
| ① 退出码 | 0 成功 / 1 运行错误 / 2 用法错误 | contract 4 |
| ② 写入幂等 | 同内容重跑 rc=0 + `duplicate:true` | contract 1+2 |
| ③ 坏引用点名 | `xxx not found: <id>`（不裸异常） | contract 3 |
| ④ --json 通道 | 成功+失败都可整体 `JSON.parse` | contract 5 |
| ⑤ flag 校验 | 裸 flag / 枚举非法 → rc=2，不落库 | contract 6 |

`pnpm contract:audit` 84 项机械化断言以上全部。

## 11. 常见坑

- 数据库打不开报 "database is locked"：可能残留 `<db>.lock` 目录
- `job --force` 必须在 `--` 之前（之后都算命令内容）
- 测试工作区：`YGL_HOME=<dir>` 指到临时位置
- Windows 下 `.cmd` shim 需 shell 解析（plugin install 已处理）
- CLI 入口是 `dist/apps/cli/src/bin.js`（自执行，rc 契约在此）；`dist/bundle/bin.cjs` 是 bundle 版（更快）
