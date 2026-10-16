# AGENTS.md — ygl-trees

ygl-trees 是面向 AI Agent 的研究工作台 CLI（研究 → 产出 → 知识复用 + 科技树模型），基于 Cordis 框架构建。任何 Agent 进入本仓库前先读完此文件。

**核心铁律**：改 `packages/` 前读 [packages/AGENTS.md](packages/AGENTS.md)（包级纪律）与 [docs/conventions.md](docs/conventions.md)；改 schema 前读 [docs/spec.md](docs/spec.md)；每个版本的决策证据链在 [docs/plan.md](docs/plan.md) 执行记录里。

## 仓库布局

```
vendor/           DSH fork 框架全家桶（用户裁定框架级一致性，pnpm workspace 管理）
  cordis/           @deepseek-ai/cordis 4.0.5-α（修复 rc.11 时序）
  cosmokit/         @deepseek-ai/cosmokit 1.8.6-α
  schemastery/      @deepseek-ai/schemastery 3.18.5-α
  timer/            @deepseek-ai/cordis-plugin-timer 1.1.7-α **已启用**（base bundle 第 5 插件；ctx.timer 生命周期托管定时器，webui serve 心跳在用）
  loader/ include/ group/ hmr/ logger-console/（六件可用弹药，等需求接入）

packages/         领域模块（库代码，可被 apps 组合；pnpm workspace 成员，各带 package.json 依赖图）
  core/             基础层（db/orm/text/fmt/types/entities/container）
  research/         研究域（query→source→evidence→claim→produce）
  techtree/         科技树域（nodes/edges/conditions/eval gates/closure）
  knowledge/        知识域（kb/skills/match）
  ops/              运维域（config/pgsync/jobs/agent/rels/webui）
  web/              Web 域（app：React 客户端宿主插件，ctx.webApp，DSH 模式）
  （Cordis 服务定义在 core/database/src/plugin.ts 与 web/app/src：declare module 声明合并）

apps/             应用入口（workspace 包：各带 package.json 声明依赖图）
  cli/              CLI 应用（@ygl/cli；src/bin.ts 即可执行文件：shebang+自执行，rc 契约在此；profile-boot/startup-diagnostics/process-shutdown/plugin 同 DSH）
  web/              React 富客户端（xyflow 树视图，spec R13.5；CLI 内嵌零依赖 dashboard 保留）

（发布单元 = 仓库根 ygl-trees：dist/ 运行时从根 node_modules 解析，根 package.json 须保留 dist 用到的运行时依赖——包内声明是依赖图真相，根声明是发布面需求，两者并存）

benchmarks/       性能基准套件（bench.js 七席 + README，pnpm bench）
tests/            vitest 单测
skills/           专属 Agent Skills（junction 到 .agents/skills/）
docs/             文档体系
examples/         demo.sh 端到端回归脚本
tmp/              临时脚本与数据（gitignored）
```

## 命令

```bash
pnpm install              # pnpm workspace（vendor/* + packages/*/* + apps/*）
pnpm build                # tsc -> dist/ + tsdown -> dist/bundle/bin.cjs（单文件发布产物）
pnpm test:unit            # vitest 单测
pnpm test                 # 三段制：unit + build + demo（demo 跑 bundle 发布产物）
pnpm bench                # 性能基准（先 build；结果落 tmp/bench-results.json）
pnpm smoke:bun            # Bun 运行时探针（当前 Windows 受阻，见 docs/bun-compat.md）
```

**入口**：发布产物 = `dist/bundle/bin.cjs`（tsdown 单文件，bin 字段指向它）；开发路径 = `dist/apps/cli/src/bin.js`（tsc 树）。demo/bench 优先测发布产物。

**测试纪律**：提交前 `pnpm test` 全绿（严格校验退出码——管道 grep 会掩盖 demo 失败，0.30 教训）。demo 有 15 组断言。新功能必须有 demo 断言或单测。

## 架构（Cordis 框架）

本项目使用 [Cordis](https://github.com/cordiverse/cordis) 框架（vendored 在 `vendor/cordis/`），获得：

- **运行时服务发现** — `ctx.database`、`ctx.research` 等按名访问
- **多服务生命周期** — Services 随 Context 启动/停止，自动资源清理
- **事件驱动组合** — `ctx.on()/emit()` 跨域事件
- **动态插件加载** — `ygl.bundle.json` 声明组合 + 用户层 `$YGL_HOME/ygl.user.bundle.json`（R14）；由 apps/cli/src/bin.ts 按声明加载
- **时空可组合性** — 子 Context 隔离、作用域嵌套

```typescript
// packages/core/database/src/plugin.ts（web/app 同模式）
export class DatabaseService extends Service { ... }   // ctx.database
export class WebAppService extends Service { ... }     // ctx.webApp
export function apply(ctx: Context, config) { ... }    // apps 经 ctx.plugin() 组合
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
- Schema 走 `PRAGMA user_version`（当前 v8：events.level 遥测级 + artifacts.meta 信封）；`synchronize` 永久 false
- 加表九触点 → [docs/conventions.md](docs/conventions.md) §一
- TypeORM 边界（读走 ORM，写走事务化服务）→ [docs/conventions.md](docs/conventions.md) §五

## 决策链

```
docs/spec.md           需求规格 R1-R14 + 验收标准
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
7. **vendor 管理**：从 DSH vendor 源码同步（用户裁定 2026-10-17：框架级一致性，fork 4.0.5 修复 rc.11 时序问题），`@deepseek-ai/` scope，通过 pnpm workspace `workspace:~` 引用；与 DSH vendor 同版本升级
