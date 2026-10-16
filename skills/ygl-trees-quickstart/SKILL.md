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
  关联、rel、插件、plugin、WebUI、webui、仪表盘、dashboard、bench、基准、bundle。
version: 0.63.0
tags: ygl-trees,quickstart,backup,postgres,schedule,doctor,plugin,webui,bench
---

# ygl-trees 快速上手与全局契约

单一 SQLite 文件是唯一事实源；PostgreSQL 只做单向导出。所有命令支持 `--json`。

## 1. 冷启动三步

```bash
node dist/apps/cli/src/bin.js db init           # 建工作区（$YGL_HOME，默认 ~/.ygl-trees）
node dist/apps/cli/src/bin.js project new <name> -q "<研究问题>"
node dist/apps/cli/src/bin.js agent brief       # 我在哪、有什么、下一步做什么（从这里开始）
```

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

## 2b. 运维命令速查

```bash
ygl-trees doctor           # 9 项健康检查
ygl-trees doctor --fix     # 一键安全修复（脏索引标记 + 陈旧锁清理）
ygl-trees kb rm <id>       # 删除笔记（与 skill rm 对称）
ygl-trees webui serve --host 0.0.0.0 --port 8642  # LAN/WSL 可访问
```

PG 迁移预检：`db migrate pg` 前自动逐表扫描 INTEGER 列类型——非整数值会**点名 table.column rowid=N** 而非迁移时才爆。

## 3. 健康检查与任务

```bash
ygl-trees doctor                     # 9 项健康检查（schema/索引/FTS/重复/孤儿/config/锁/eval信封/插件）
ygl-trees task add "<标题>"           # 建任务（todo 起步）
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
