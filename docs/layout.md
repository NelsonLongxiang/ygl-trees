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
│   ├── core/database       @ygl/core-database     db / orm / entities / container / config 读取 / search / plugin（ctx.database）
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
@ygl/research-pipeline ──→ core-database
@ygl/research-produce, @ygl/knowledge-skills ──→ core-database, core-text, research-pipeline
@ygl/ops-tools ──→ core-database, core-text, research-pipeline, techtree-model, web-app, @deepseek-ai/cordis
@ygl/cli ──→ core-database, core-text, ops-tools, research-pipeline, techtree-model, web-app, @deepseek-ai/cordis / cordis-plugin-timer / schemastery
```

配置登记与只读解析位于 `core/database/src/config.ts`，四个域的命令从该层读取；ops 保留配置写入、审计和脱敏。旧 ops 配置读取导出暂作兼容，不供域包新增依赖。`scripts/gate.js --workspace-graph` 浅读 workspace 清单并检查**声明依赖图**的命名有向环，接入 `contract-audit`；不遍历 `node_modules` 或目录联接，workspace 布局变化须同步检查器。它不解析源码引用，不能据此宣称源码 import 图无环。

`node scripts/gate.js --source-graph` 是另一项严格诊断：解析 `packages/*/*/src` 内字面量相对 import、类型导入、重导出、require 与动态 import，解析失败或源路径链接均拒绝。当前 `core/database/src/orm.ts` 静态读取 `research/pipeline/src/entities.ts` 的 `RESEARCH_ENTITIES`，研究域又依赖 core/database，源码图因此仍有循环；ORM 同步和异步数据源均须在初始化时拥有完整实体列表。此既有装配边界尚未被裁定为架构例外，本次不改实体注册或启动顺序，不加泛化豁免。源码模式当前返回非零且未作为契约放行门；应另裁精确例外或实体装配解耦，不能用清单门的绿灯替代。

**铁律**：packages/ 内的域模块**不知道** apps/ 的存在；apps/ 知道 packages/ 并组装它们。vendor/ 不知道上层的任何东西。

## 未来扩展位

| 目录 | 何时创建 | 内容 |
|---|---|---|
| `docs/cookbook/` | 出现重复操作模式时 | 步骤化指南 |
| `.agents/notes/` | 有不可逆决策时 | Agent Notes（决策记录） |
