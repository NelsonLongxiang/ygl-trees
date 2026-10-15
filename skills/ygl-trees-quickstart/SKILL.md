---
name: ygl-trees-quickstart
description: >-
  ygl-trees 工作台快速上手与全局契约：初始化工作区（db init）、建研究项目（project new）、
  agent brief 定位下一步、--json 纯净纪律与退出码契约、备份导出（db export）、PG 镜像/迁移
  （db sync pg / migrate pg）、调度（job add/tick）与临时文件 tmp/ 规范。
  触发词：ygl-trees 入门、初始化、quickstart、工作区、退出码、exit code、备份、export、
  PostgreSQL、sync、migrate、镜像、job、tick、定时。
version: 0.14.0
tags: ygl-trees,quickstart,backup,postgres,schedule
---

# ygl-trees 快速上手与全局契约

单一 SQLite 文件是唯一事实源；PostgreSQL 只做单向导出。所有命令支持 `--json`。

## 1. 冷启动三步

```bash
node bin/ygl-trees.js db init                    # 建工作区（$YGL_HOME，默认 ~/.ygl-trees）
node bin/ygl-trees.js project new <name> -q "<研究问题>"
node bin/ygl-trees.js agent brief                # 我在哪、有什么、下一步做什么（从这里开始）
```

## 2. Agent API 契约（冻结，勿靠猜）

- **退出码**：`0` 成功（含"重复已存在"）、`1` 运行错误/404、`2` 用法错误——按 rc 分支是安全的
- **--json 纯净**：写命令 stdout = 单个 JSON 对象（重复带 `duplicate: true`）；读命令 = 单个数组/对象；绝不混人类文本，可直接 `JSON.parse` 全量
- **写入幂等**：claim/evidence/query/kb/job 等按内容 hash 判重，Agent 重试不产生脏数据；`--force` 显式保留重复（job 用标题后缀）
- 输出字段名是冻结契约，snake_case

## 3. 备份 / PostgreSQL / 调度

```bash
ygl-trees db export <file.sql>          # 全部数据表 + 行数摘要；可重放恢复（先删库再逐行执行）
ygl-trees db sync pg <url>              # 可刷新 PK-only 镜像（分析用）；url 或环境变量 YGL_PG_URL
ygl-trees db migrate pg <url> [--fresh] # 一次性完整保真迁移（FK/UNIQUE 齐全，目标库独立持有）
ygl-trees db dups                       # 列出同内容多行
ygl-trees job add <title> -- "<cmd>" --every 60   # cron 每分钟跑 job tick（幂等+并发锁）
```

禁止双后端同写：ygl-trees 永远只写 SQLite，PG 是单向出口。

## 4. 临时文件铁律

一切临时脚本/数据放 `<repo>/tmp/`（已 gitignore），**禁止**写系统临时目录（Git Bash 的 /tmp）。

## 4b. 用户配置（config 表，schema v6）

```bash
ygl-trees config list                  # 全部键：当前值 + 默认 + 说明
ygl-trees config set eval.pass_threshold 0.8   # 写入即校验（类型/范围）并留痕
ygl-trees config reset eval.pass_threshold     # 回落默认
```

键（均真实接线）：`eval.pass_threshold/fail_threshold/offline`、`fetch.timeout_ms/user_agent`、
`search.limit`、`default_confidence`、`job.stale_minutes`。环境变量 > config > 默认。

## 5. 常见坑

- 数据库打不开报 "database is locked"：可能残留 `<db>.lock` 目录（外部进程崩了），确认无活动进程后 rmdir
- `job --force` 必须放在 `--` 分隔符**之前**（之后的都算命令内容）
- 测试工作区：`YGL_HOME=<dir>` 指到临时位置，别用真实库调试
