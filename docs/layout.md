# ygl-trees 项目目录层级规划

日期：2026-10-16 ｜ 参考：deepseek-harness 仓（packages/apps/vendor 分层 + Cordis 框架） ｜ 状态：定稿

## 设计原则（从 deepseek-harness 提炼并适配）

1. **packages/ = 库代码，apps/ = 应用入口**：领域模块是可复用的库；应用层组装它们
2. **vendor/ = 上游框架**：DSH fork 的 Cordis 全家桶源码副本（来源与版本规则见 [vendor/README.md](../vendor/README.md)），pnpm workspace 管理
3. **一个事实一个家**：每条信息只在一个文档里是权威源
4. **根 AGENTS.md = 常驻守则**：短、可操作、链接到归属地
5. **Cordis 框架**：运行时服务发现、多服务生命周期、事件驱动组合、动态插件加载

## 当前目录结构

```
ygl-trees/
├── AGENTS.md / README.md / CHANGELOG.md / ARCHITECTURE.md / DESIGN.md / FAQ.md / llms.txt
├── package.json          ← 发布单元（bin → dist/bundle/bin.cjs）+ workspace root
├── pnpm-workspace.yaml   ← packages: vendor/*, packages/*/*, apps/*
├── ygl.bundle.json       ← base bundle：database → ops → research → timer
│
├── vendor/               ← DSH fork 的 Cordis 全家桶（cordis / cosmokit / schemastery / timer + loader / include / group / hmr / logger-console）
├── packages/             ← 领域模块（库代码，每个包一个 package.json，src/ + tests/ + README.md）
│   ├── core/database       @ygl/core-database     db / orm / entities / container / search / plugin（ctx.database）
│   ├── core/text           @ygl/core-text         text / fmt / eventbus / flagcheck / scope
│   ├── research/pipeline   @ygl/research-pipeline query → source → evidence → claim，predict（预测与打分）
│   ├── research/produce    @ygl/research-produce  produce / project 命令组（报告、spec、design 产物）
│   ├── techtree/model      @ygl/techtree-model    tree / node 命令组、闭包与条件
│   ├── techtree/eval       @ygl/techtree-eval     决策模型评估
│   ├── knowledge/skills    @ygl/knowledge-skills  kb / skill 命令组
│   ├── ops/tools           @ygl/ops-tools         config / db / job / agent / patrol / verify 命令组、mcp、webui、plugin（ctx.ops）
│   ├── verify/core         @ygl/verify-core       spec-validator 引擎与语料
│   └── web/app             @ygl/web-app           React 客户端静态资源（openStatic / resolveDistRoot）
├── apps/
│   ├── cli/                @ygl/cli：src/bin.ts 即可执行入口（rc 契约、profile-boot、plugin）
│   └── web/                @ygl/web：React 富客户端（xyflow 树视图）
├── rust/yglverify/       ← spec-validator 的 Rust 实现（语料 parity）
├── benchmarks/           ← 按用户路径的性能基准
├── scripts/  tests/  examples/  skills/  docs/  verify/  monitored/
├── .agents/skills/       junction → skills/（gitignored）
└── tmp/                  临时（gitignored）
```

## 依赖方向

按各包 `package.json` 声明（`@deepseek-ai/*` 来自 vendor 对应的 npm 版本）：

```
@ygl/core-text, @ygl/techtree-eval, @ygl/verify-core ──→ (无内部依赖)
@ygl/core-database, @ygl/web-app ──→ @deepseek-ai/cordis
@ygl/techtree-model ──→ core-database, core-text
@ygl/research-pipeline ──→ core-database, ops-tools
@ygl/research-produce, @ygl/knowledge-skills ──→ core-database, core-text, research-pipeline
@ygl/ops-tools ──→ core-database, core-text, research-pipeline, techtree-model, web-app, @deepseek-ai/cordis
@ygl/cli ──→ core-database, core-text, ops-tools, research-pipeline, techtree-model, web-app, @deepseek-ai/cordis / cordis-plugin-timer / schemastery
```

**现存例外**：`research-pipeline` 与 `ops-tools` 互相依赖（pipeline 的 `cmds.ts` 引 `ops/tools/src/config` 的配置读取；ops-tools 的 db / doctor / job / patrol / verify 命令引 pipeline），不符合原定的「单向、无循环」。

**铁律**：packages/ 内的域模块**不知道** apps/ 的存在；apps/ 知道 packages/ 并组装它们。vendor/ 不知道上层的任何东西。

## 未来扩展位

| 目录 | 何时创建 | 内容 |
|---|---|---|
| `docs/cookbook/` | 出现重复操作模式时 | 步骤化指南 |
| `.agents/notes/` | 有不可逆决策时 | Agent Notes（决策记录） |
