---
name: ygl-plugin-demo
description: ygl-trees 用户插件示例（spec R14 L3）——最小完整契约：apply(ctx,config) + commands 贡献 CLI 命令组。demo 组 12 的回归载体。
kind: 参考
---

# ygl-plugin-demo — 用户插件示例

业务域接入 ygl-trees 的最小完整形态。安装后即刻贡献 `ygl-trees demo` 命令组。

## 试跑

```bash
ygl-trees plugin install ./examples/plugin-demo   # 本地目录自动 link:
ygl-trees demo hello      # → demo plugin: hello from the user layer (R14 L3)
ygl-trees demo env        # → 当前加载的插件与命令组清单
ygl-trees demo greet --name Ada --json  # → {"plugin":"ygl-plugin-demo","greeting":"Hello, Ada","name":"Ada"}
ygl-trees demo greet --name Ada --name=Grace --json  # 普通键重复：末值 Grace
ygl-trees demo greet --json -- --literal            # -- 后成为位置参数
ygl-trees plugin list     # → 版本 / spec / 可解析态
ygl-trees plugin remove ygl-plugin-demo
```

## 已声明接口与当前参数行为

| 导出 | 必填 | 语义 |
|---|---|---|
| `apply(ctx, config)` | 否 | Cordis 插件体——可用 `ctx.database / ctx.research / ctx.techtree / ctx.webApp` |
| `commands` | 否 | `{ <组名>: { run(env, action, rest, args) → rc } }`——贡献 CLI 命令组 |

以下为 v0.117.x 当前实现行为：`args = { _: string[], flags: Record<string, string | boolean | string[]> }`；`args._` 含 group/action，`action` 单独传入，`rest = args._.slice(2)` 不含 action。`greet` 从 `args.flags.name` 读值，优先于 `rest[0]`，省略用 world；裸 `--name` 或空字符串返回 rc2。普通重复键取末值，只有 attach/db 这两个当前指定键收数组；`--k=v` 值为字符串，`--` 结束旗标解析。**解析细节 unstable，非冻结契约**；四参数签名为已声明接口。完整布尔/重复/边界例子见[插件指南](../../docs/plugin-authoring.md#run-的参数与旗标当前实现unstable)。

`package.json` 可选声明 `"yglTrees": "^0.36"`（兼容声明；主版本不符启动时仅警告）。

## 写自己的插件

复制本目录改三处：name、commands 的组名与 run 实现。完整指南（结构/锁/诊断/故障排查）见 [docs/plugin-authoring.md](../../docs/plugin-authoring.md)。

## 已知限制

- apply 体留空——真实业务请注册自己的 Service（模式参照 `packages/core/database/src/plugin.ts`）
- 回归位于 `packages/ops/tools/tests/plugin-args.spec.ts`：真实 CLI init→plugin install→greet，核对 rc/完整 JSON、inline/重复/位置参数优先级/裸值拒绝/-- 边界。运行：`pnpm exec vitest run packages/ops/tools/tests/plugin-args.spec.ts`。这记录当前实现，不把解析细节升级为冻结契约。
