# AGENTS.md — ygl-trees

ygl-trees 是面向 AI Agent 的研究工作台 CLI（研究 → 产出 → 知识复用 + 科技树模型），基于 Cordis 框架构建。任何 Agent 进入本仓库前先读完此文件。

**核心铁律**：改 `packages/` 前读 [docs/conventions.md](docs/conventions.md)；改 schema 前读 [docs/spec.md](docs/spec.md)；每个版本的决策证据链在 [docs/plan.md](docs/plan.md) 执行记录里。

## 仓库布局

```
vendor/           上游框架（从 cordiverse/cordis vendor，pnpm workspace 管理）
  cordis/           Cordis 框架核心（Context/Service/事件总线/插件系统）
  cosmokit/         Cordis 依赖的工具库

packages/         领域模块（库代码，可被 apps 组合）
  core/             基础层（db/orm/text/fmt/types/entities/container）
  research/         研究域（query→source→evidence→claim→produce）
  techtree/         科技树域（nodes/edges/conditions/eval gates/closure）
  knowledge/        知识域（kb/skills/match）
  ops/              运维域（config/pgsync/jobs/agent）
  context.ts        Cordis Context 定义（DatabaseService/ResearchService）
  container.ts      轻量 DI 容器（Cordis 备选方案）
  index.ts          包导出面

apps/             应用入口（组装 packages，跑产品）
  cli/              CLI 应用（参数解析/命令分发/usage）
  web/              未来 WebUI 应用（webui serve 内嵌在 ops/tools，本目录预留）

bin/              可执行入口
benchmarks/       性能基准套件（bench.js 七席 + README，pnpm bench）
tests/            vitest 单测
skills/           专属 Agent Skills（junction 到 .agents/skills/）
docs/             文档体系
examples/         demo.sh 端到端回归脚本
tmp/              临时脚本与数据（gitignored）
```

## 命令

```bash
pnpm install              # pnpm workspace（vendor/* + apps/*）
pnpm build                # tsc -> dist/
pnpm test:unit            # vitest 单测
pnpm test                 # 三段制：unit + build + demo
pnpm bench                # 性能基准（先 build；结果落 tmp/bench-results.json）
pnpm smoke:bun            # Bun 运行时探针（当前 Windows 受阻，见 docs/bun-compat.md）
```

**测试纪律**：提交前 `pnpm test` 全绿。demo 有 8 组断言。新功能必须有 demo 断言或单测。

## 架构（Cordis 框架）

本项目使用 [Cordis](https://github.com/cordiverse/cordis) 框架（vendored 在 `vendor/cordis/`），获得：

- **运行时服务发现** — `ctx.database`、`ctx.research` 等按名访问
- **多服务生命周期** — Services 随 Context 启动/停止，自动资源清理
- **事件驱动组合** — `ctx.on()/emit()` 跨域事件
- **动态插件加载** — `ctx.plugin()` 运行时注册
- **时空可组合性** — 子 Context 隔离、作用域嵌套

```typescript
// packages/context.ts
import { Context, Service } from "cordis";

export class DatabaseService extends Service { ... }
export class ResearchService extends Service { ... }
export function createApp(dbFile: string): Context { ... }
```

## Agent API 契约（冻结）

| 面 | 契约 |
|---|---|
| 退出码 | `0` 成功（含重复）· `1` 运行错误/404 · `2` 用法错误 |
| --json | 写=单 JSON 对象（重复带 `duplicate:true`）；读=数组/对象 |
| 写入幂等 | 同内容重跑返回已存在行 rc=0；`--force` 保留重复 |
| 字段名 | snake_case，冻结；改字段名 = 破坏性变更 |

## 数据模型

- SQLite 唯一事实源；PG 单向导出（sync 镜像 / migrate 迁移）
- Schema 走 `PRAGMA user_version`（当前 v6）；`synchronize` 永久 false
- 加表九触点 → [docs/conventions.md](docs/conventions.md) §一
- TypeORM 边界（读走 ORM，写走事务化服务）→ [docs/conventions.md](docs/conventions.md) §五

## 决策链

```
docs/spec.md           需求规格 R1-R8 + 验收标准
docs/plan.md           里程碑 + 逐版本执行记录（证据链）
docs/conventions.md    数据模型应用规范
docs/pg-compat.md      PG 兼容方案（L2 已取消）
docs/layout.md         目录层级规划
docs/webui-design.md   WebUI 方案（export + serve 已实施）
docs/bun-compat.md     Bun 目标运行时兼容方案（Windows 受阻，含证据与迁移清单）
CHANGELOG.md           逐版本聚合
```

## 开发规则

1. **Schema 变更**：SCHEMA_SQL + 实体同 commit；bump SCHEMA_VERSION；走九触点
2. **写命令**：必须走 writes/treeWrites（事务化服务）
3. **FTS 双写**：基表 + 影子表同事务
4. **临时文件**：`<repo>/tmp/`（gitignored）
5. **README 健康**：每版本收口前过一遍
6. **技能维护**：skills/ 随命令面变更同步
7. **vendor 管理**：上游 cordis/cosmokit 从 npm tarball 落盘到 vendor/，通过 pnpm workspace `workspace:~` 引用；**不依赖 @deepseek-ai fork**
