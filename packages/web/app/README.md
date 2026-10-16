---
name: ygl-trees web-app
description: Cordis 运行时胶水插件——解析构建产物 apps/web/dist 并以 ctx.webApp 服务静态面；dist 缺席时调用方回落内嵌零依赖 dashboard。模式源自 DSH packages/bundle/web-app。
kind: 库
---

# @ygl/web-app — React 客户端宿主插件（spec R13.5）

## 服务 API

- `ctx.webApp.available(): boolean` — 构建产物存在与否（`apps/web/dist/index.html`）
- `ctx.webApp.open(urlPath): { body, mime } | null` — URL → 静态文件（SPA 回落 index.html；路径遍历安全：resolve 后必须仍在 dist 内）

纯函数出口：`resolveDistRoot()`（短命 CLI 进程直接调用，不赌异步插件时序——0.19 教训）。

## 组合

```typescript
import { apply as WebAppPlugin } from "@ygl/web-app";
app.plugin(WebAppPlugin);
// webui serve: dist 存在 → React 客户端挂 /（内嵌 dashboard 移驻 /classic）
```

## 设计说明

- **workspace 知识而非用户配置**：dist 路径由仓库布局决定（DSH 同款裁决）
- 构建链在 apps/web（vite）；本包零构建依赖，只做解析与服务
- CLI 的 `webui export`（单文件离线导出）不经本包——零依赖面保持

## 已知限制

- dist 为构建产物不入库（gitignored）：`available()` 在未构建检出上为 false，属预期
- 无 HTTP 缓存头（ETag/304）——本地检阅场景收益低，未实现
