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
ygl-trees plugin list     # → 版本 / spec / 可解析态
ygl-trees plugin remove ygl-plugin-demo
```

## 契约（index.js 全文 30 行）

| 导出 | 必填 | 语义 |
|---|---|---|
| `apply(ctx, config)` | 否 | Cordis 插件体——可用 `ctx.database / ctx.research / ctx.techtree / ctx.webApp` |
| `commands` | 否 | `{ <组名>: { run(env, action, rest, args) → rc } }`——贡献 CLI 命令组 |

`package.json` 可选声明 `"yglTrees": "^0.36"`（兼容声明；主版本不符启动时仅警告）。

## 写自己的插件

复制本目录改三处：name、commands 的组名与 run 实现。完整指南（结构/锁/诊断/故障排查）见 [docs/plugin-authoring.md](../../docs/plugin-authoring.md)。

## 已知限制

- apply 体留空——真实业务请注册自己的 Service（模式参照 `packages/core/database/src/plugin.ts`）
- 无测试——示例定位；业务插件建议带自己的 tests 并在发布前离线验证 install→命令可达
