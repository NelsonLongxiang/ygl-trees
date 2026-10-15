# ygl-trees 项目目录层级规划

日期：2026-10-16 ｜ 参考：D:\workspace\deepseek-harness（packages/apps/vendor 分层 + Cordis 框架） ｜ 状态：定稿

## 设计原则（从 deepseek-harness 提炼并适配）

1. **packages/ = 库代码，apps/ = 应用入口**：领域模块是可复用的库；应用层组装它们
2. **vendor/ = 上游框架**：从 cordiverse/cordis 上游 vendor（非 DSH fork），pnpm workspace 管理
3. **一个事实一个家**：每条信息只在一个文档里是权威源
4. **根 AGENTS.md = 常驻守则**：短、可操作、链接到归属地
5. **Cordis 框架**：运行时服务发现、多服务生命周期、事件驱动组合、动态插件加载

## 当前目录结构（0.18.0 起）

```
ygl-trees/
├── AGENTS.md            ← Agent 常驻守则（入口）
├── CHANGELOG.md          ← 逐版本聚合
├── README.md             ← 面向使用者的产品文档
├── package.json          ← workspace root（deps: cordis workspace:~, cosmokit workspace:~, typeorm, better-sqlite3, ...）
├── pnpm-workspace.yaml   ← packages: vendor/*, apps/*
├── tsconfig.json
│
├── vendor/               ← 上游框架（pnpm workspace 管理）
│   ├── cordis/             Cordis 框架核心（Context/Service/事件/插件）
│   └── cosmokit/           Cordis 依赖的工具库
│
├── packages/             ← 领域模块（库代码）
│   ├── core/               基础层
│   │   ├── db.ts             DB 封装 + SCHEMA_SQL + 迁移
│   │   ├── orm.ts            TypeORM DataSource
│   │   ├── text.ts           纯函数（ngram/contentHash/clip）
│   │   ├── fmt.ts            输出助手（ok/bad/table/writeResult）
│   │   ├── types.ts          共享类型（Args/Ctx/Env + 参数解析）
│   │   ├── entities.ts       Event 实体
│   │   ├── container.ts      轻量 DI 容器（Cordis 备选）
│   │   └── index.ts          导出面
│   ├── research/           研究域
│   │   ├── entities.ts         TypeORM 实体（7 个）
│   │   ├── reads.ts            Store 读路径
│   │   ├── writes.ts           事务化写服务
│   │   ├── cmds.ts             research 命令组
│   │   ├── project-cmds.ts     project 命令组
│   │   ├── produce-cmds.ts     produce 命令组
│   │   └── index.ts            导出面
│   ├── techtree/           科技树域
│   │   ├── reads.ts            TreeStore 读路径
│   │   ├── writes.ts           treeWrites 事务化服务
│   │   ├── eval.ts             决策模型布尔评估客户端
│   │   ├── cmds.ts             tree/node 命令组
│   │   └── index.ts            导出面
│   ├── knowledge/          知识域
│   │   ├── cmds.ts             kb 命令组
│   │   ├── skill-cmds.ts       skill 命令组
│   │   └── index.ts            导出面
│   ├── ops/                运维域
│   │   ├── config.ts           config 注册表
│   │   ├── pgsync.ts           PG 镜像/迁移
│   │   ├── db-cmds.ts          db 命令组
│   │   ├── job-cmds.ts         job 命令组
│   │   ├── agent-cmds.ts       agent 命令组
│   │   ├── config-cmds.ts      config 命令组
│   │   └── index.ts            导出面
│   ├── context.ts          Cordis Context（DatabaseService/ResearchService）
│   └── index.ts            包导出面
│
├── apps/                 ← 应用入口
│   ├── cli/                CLI 应用
│   │   ├── main.ts           参数解析 + 命令分发 + usage
│   │   └── index.ts          export { main }
│   └── webui/              未来 WebUI
│
├── bin/                  可执行入口
│   └── ygl-trees.js
├── tests/                vitest 单测
├── skills/               专属 Agent Skills
├── .agents/skills/       junction → skills/（gitignored）
├── docs/                 文档体系
├── examples/             demo.sh
└── tmp/                  临时（gitignored）
```

## 依赖方向（单向，无循环）

```
vendor/cordis ──────→ (无依赖)
vendor/cosmokit ────→ (无依赖)
       ↓
packages/core ──────→ vendor/cordis（仅 context.ts）, vendor/cosmokit
       ↓
packages/research ──→ packages/core
packages/techtree ──→ packages/core, packages/research（cross-domain read）
packages/knowledge ─→ packages/core, packages/research（writes + reads）
packages/ops ───────→ packages/core, packages/research（writes + reads）
       ↓
apps/cli ───────────→ packages/*（通过 DOMAIN_ROUTES require）
```

**铁律**：packages/ 内的域模块**不知道** apps/ 的存在；apps/ 知道 packages/ 并组装它们。vendor/ 不知道上层的任何东西。

## 未来扩展位

| 目录 | 何时创建 | 内容 |
|---|---|---|
| `apps/web/` | WebUI 落地时 | 静态 HTML 生成器 |
| `packages/core/architecture.md` | 代码量 >8000 行时 | 架构图：模块关系、数据流 |
| `packages/*/README.md` | 域模块需要独立文档时 | per-domain 契约（配置/语义/边界） |
| `docs/cookbook/` | 出现重复操作模式时 | 步骤化指南 |
| `.agents/notes/` | 有不可逆决策时 | Agent Notes（决策记录） |
