# vendor/ — DSH fork 框架全家桶（用户裁定 2026-10-17：框架级一致性）

从 DSH vendor **源码同步**（非 npm 安装——DSH 模式：fork 仓库源码 git 跟踪 + workspace:~ 链接）。
所有包 rescope 到 `@deepseek-ai/` scope，版本与 DSH vendor 一致。

| 目录 | npm 名 | 版本 | 用途 |
|---|---|---|---|
| `cordis/` | `@deepseek-ai/cordis` | 4.0.5-alpha.2 | Context/Service/插件系统（**修复 rc.11 setImmediate 时序**） |
| `cosmokit/` | `@deepseek-ai/cosmokit` | 1.8.6-alpha.2 | cordis 依赖的工具库 |
| `schemastery/` | `@deepseek-ai/schemastery` | 3.18.5-alpha.2 | schema 校验（bundle/user bundle 声明） |
| `loader/` | `@deepseek-ai/cordis-plugin-loader` | 1.0.6-alpha.2 | 声明式插件加载器（**探针证实可用但未采纳**，见下） |
| `include/` | `@deepseek-ai/cordis-plugin-include` | 1.0.10-alpha.2 | 配置 include（bundle 分层叠加） |
| `group/` | `@deepseek-ai/cordis-plugin-group` | 1.0.5-alpha.2 | 插件嵌套分组 |
| `hmr/` | `@deepseek-ai/cordis-plugin-hmr` | 1.0.20-alpha.2 | 插件热替换 |
| `timer/` | `@deepseek-ai/cordis-plugin-timer` | 1.1.7-alpha.2 | 生命周期托管定时器（**已启用**：base bundle 第 5 插件，webui serve 心跳） |
| `logger-console/` | `@deepseek-ai/cordis-plugin-logger-console` | 1.0.5-alpha.2 | 控制台 logger |

**为什么是 fork**：上游 cordiverse/cordis 停在 rc.11（时序 bug），DSH fork 4.0.5 修复（fork 探针：单 yield 后全部服务就绪 ✓）。

## 纪律

- **来源**：与 DSH vendor 同步（同版本同 commit），git 跟踪
- **升级**：同步 DSH vendor → `pnpm install`（workspace 链接）→ `pnpm build` → `pnpm test` → fork 时序探针
- 禁止在此目录开发业务代码；只镜像 DSH fork
- 第三方依赖不 vendor，留在 npm

## 已知/后续

- **弹药启用状态**：`timer` 已启用（base bundle 第 5 插件，ctx.timer 生命周期托管定时器，webui serve 心跳在用）；其余六件（loader/include/group/hmr/logger-console）尚未 import——等真实需求接入
- **loader 裁决（0.40，探针实证 no-go，能力已采纳）**：探针实测 loader 与我们的模块形态**完全兼容**（ESM default / ESM named apply / CJS `exports.apply` / CJS `module.exports={apply}` 四种全通，config 透传 ✓、`update()` 重配 ✓）。但两处硬冲突：① **编译产物不暴露 `moduleNamespace`**（`vendor/loader/src/config/entry.ts:49,237` 有该字段，`lib/` 构建产物没有）→ 拿不到用户插件的 `commands` 导出，除非二次 import（等于双份导入机制）；② loader 按 specifier **运行时动态导入** → tsdown 不可追踪 → 用于基础插件会把这些模块挤成 external，**破坏 0.38 自包含单文件产物与 8% 启动优势**（基础插件也无已发布包名可指向）。**采纳能力而非机械**：用户层 bundle 支持 `config` / `enabled`（Entry options 真正有用的两项）。**重审触发条件**：需要运行时插件图更新（长驻 serve 热启用/重配，配合 `hmr`）、基础插件获得已发布包名、或需要 `group` 嵌套组合与 DSH 式分层 profile（配合 `include`）
- **bundle 化**：`pnpm build` = tsc 树 + tsdown 单文件（dist/bundle/bin.cjs，根 bin 字段指向它）；受控对比 bundle p50 560ms vs 树 607ms（~8% 提速）
