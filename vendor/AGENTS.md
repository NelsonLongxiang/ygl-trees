# AGENTS.md — Vendored Packages

本目录包含从 DSH vendor 源码同步的 Cordis 框架件及其基础库（用户裁定 2026-10-17：框架级一致性）。manifest（版本表）、fork 理由、同步纪律见 [vendor/README.md](README.md)。

**不要随意编辑 `vendor/*/src/` 文件。** 每一处与上游的本地分歧必须完整记录在 `vendor/README.md` 的"Local modifications"节。`vendor/*/tsconfig.json` 是例外——为适配 monorepo 构建而重生成，可为类型检查策略调整（如 `noImplicitAny`）而修改。

变更不可避免时，遵循 `vendor/README.md` 的同步程序。

## 我们的补充纪律

- **来源纪律**：从 DSH vendor 同步（同版本同 commit），git 跟踪；不是 npm install 也不是 git clone——是 fork 仓库源码的 vendored 副本
- **升级**：与 DSH vendor 同步升级 → `pnpm install`（workspace 链接）→ `pnpm build` → 全量 `pnpm test` → fork 时序探针（tmp/fork-probe.js 模式）
- **第三方依赖**（js-yaml、chokidar、picomatch、@standard-schema/spec、supports-color、node-addon-require-builtin）**不 vendor**，留在 npm 由 pnpm 安装
- **六个 cordis-plugin**（loader/include/group/hmr/timer/logger-console）中仅 **timer 已启用**（base bundle 第 4 插件）；其余五件未 import——属可用弹药，等真实需求接入；接入前须在根 AGENTS 架构节声明用途
