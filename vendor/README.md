# vendor/ — DSH fork 框架全家桶（用户裁定 2026-10-17：框架级一致性）

从 DSH vendor **源码同步**（非 npm 安装——DSH 模式：fork 仓库源码 git 跟踪 + workspace:~ 链接）。
所有包 rescope 到 `@deepseek-ai/` scope，版本与 DSH vendor 一致。

| 目录 | npm 名 | 版本 | 用途 |
|---|---|---|---|
| `cordis/` | `@deepseek-ai/cordis` | 4.0.5-alpha.2 | Context/Service/插件系统（**修复 rc.11 setImmediate 时序**） |
| `cosmokit/` | `@deepseek-ai/cosmokit` | 1.8.6-alpha.2 | cordis 依赖的工具库 |
| `schemastery/` | `@deepseek-ai/schemastery` | 3.18.5-alpha.2 | schema 校验（bundle/user bundle 声明） |
| `loader/` | `@deepseek-ai/cordis-plugin-loader` | 1.0.6-alpha.2 | 声明式插件加载器 |
| `include/` | `@deepseek-ai/cordis-plugin-include` | 1.0.10-alpha.2 | 配置 include（bundle 分层叠加） |
| `group/` | `@deepseek-ai/cordis-plugin-group` | 1.0.5-alpha.2 | 插件嵌套分组 |
| `hmr/` | `@deepseek-ai/cordis-plugin-hmr` | 1.0.20-alpha.2 | 插件热替换 |
| `timer/` | `@deepseek-ai/cordis-plugin-timer` | 1.1.7-alpha.2 | 生命周期托管定时器 |
| `logger-console/` | `@deepseek-ai/cordis-plugin-logger-console` | 1.0.5-alpha.2 | 控制台 logger |

**为什么是 fork**：上游 cordiverse/cordis 停在 rc.11（时序 bug），DSH fork 4.0.5 修复（fork 探针：单 yield 后全部服务就绪 ✓）。

## 纪律

- **来源**：与 DSH vendor 同步（同版本同 commit），git 跟踪
- **升级**：同步 DSH vendor → `pnpm install`（workspace 链接）→ `pnpm build` → `pnpm test` → fork 时序探针
- 禁止在此目录开发业务代码；只镜像 DSH fork
- 第三方依赖不 vendor，留在 npm

## 已知/后续

- 七个 cordis-plugin 尚未在代码中 import——可用弹药，等真实需求接入
- **bundle 化**：tsdown 脚手架就绪（build:bundle），DOMAIN_ROUTES 动态 require 需改静态 barrel 后 bundle 才完整可用
