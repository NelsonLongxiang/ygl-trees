---
name: ygl-trees cli
description: CLI 应用入口——参数解析、组合启动（profile-boot 典范）、命令分发、有界停机。模式对齐 DSH apps/cli（bin 薄入口 + src/ concern-per-file）。
---

# apps/cli — CLI 应用层

组装 packages（经 Cordis Context），跑产品。**无领域逻辑**——只有组合与分发。

## 结构（对齐 DSH apps/cli）

```
index.ts                 入口面（dist/apps/cli/index.js，bin/ygl-trees.js 引用此稳定路径）
src/
  bin.ts                 可执行入口：parse args → boot → dispatch → shutdown（DSH bin.ts）
  profile-boot.ts        组合启动：base bundle → user layer → 服务沉降 + StartupError（DSH profile-boot）
  startup-diagnostics.ts 启动诊断：终端简洁摘要 + 报告落盘 logs/startup-<uuid>.log（DSH startup-diagnostics）
  process-shutdown.ts    有界停机：幂等合并 / 信号升级 / 5s 宽限（DSH process-shutdown）
tests/                   vitest 单测（package.json vitest include 覆盖 apps/*/tests）
```

## 与 DSH apps/cli 的对齐与分歧

| 面 | DSH | 本目录 |
|---|---|---|
| 入口 | `bin.ts` 自执行分发 | `bin.ts` 导出 `main()`；自执行在 `bin/ygl-trees.js`（rc 契约由 wrapper 保管） |
| 源码 | `src/`，concern-per-file | 同（profile-boot / startup-diagnostics / process-shutdown 同名） |
| 导入扩展名 | 显式 `.ts`（NodeNext） | **分歧**：仓库根 tsconfig 为 CJS classic 解析，扩展名导入被拒；保持无扩展名（0.36 记录，迁移需整体切 moduleResolution） |
| 构建 | tsdown | 根 tsc（`pnpm build`） |
| 插件管理 | `src/plugin.ts`（launcher 自有） | 库在 `packages/ops/tools/src/plugins.ts`（gate+vitest 覆盖），命令组 plugin-cmds 同包——apps 不反向依赖保持分层 |

## 关键契约

- 退出码 0/1/2（冻结）；`--json` 纯净；cmd.run 遥测（R10）
- 组合声明：`ygl.bundle.json`（base）+ `$YGL_HOME/ygl.user.bundle.json`（用户层，R14 L3）
