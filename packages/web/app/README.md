---
name: ygl-trees web-app
description: 解析 React 客户端构建产物 apps/web/dist 并按 URL 取静态文件的纯函数库，供 webui serve 调用；dist 缺席时由调用方返回 503。模式源自 DSH packages/bundle/web-app。
kind: 库
---

# @ygl/web-app — React 客户端静态资源解析（spec R13.5）

## 导出

纯函数，不挂 ctx（0.86 删去服务壳）。调用方是 `packages/ops/tools/src/webui.ts`。

- `resolveDistRoot(from?): string | null` — 自 `from` 向上找仓库根（含 `ygl.bundle.json` 的目录），返回存在 `index.html` 的 `apps/web/dist`；短命 CLI 进程直接调用，不赌异步插件时序（0.19 教训）
- `openStatic(urlPath): { body, mime } | null` — URL → 静态文件（SPA 回落 index.html；路径遍历安全：resolve 后必须仍在 dist 内）；dist 不存在时为 null

## 组合

```typescript
import { resolveDistRoot, openStatic } from "@ygl/web-app";
// webui serve：resolveDistRoot() 为 null → 非 /api/ 请求一律 503 并提示构建；否则 openStatic(url) 回静态文件
```

## 设计说明

- **workspace 知识而非用户配置**：dist 路径由仓库布局决定（DSH 同款裁决）
- 构建链在 apps/web（vite）；本包零构建依赖，只做解析与服务
- CLI 的 `webui export`（JSON 快照，与 `/api/data` 同载荷）不经本包

## 已知限制

- dist 为构建产物不入库（gitignored）：未构建的检出上 `resolveDistRoot()` 为 null，属预期
- 本包不出 HTTP 缓存头；`webui serve` 只给带哈希的 `/assets/*` 加长缓存，没有 ETag/304
