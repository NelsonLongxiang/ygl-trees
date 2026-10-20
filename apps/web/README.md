---
name: ygl-trees web
description: React rich client for the ygl-trees workbench — xyflow tree view with pan/zoom + minimap, DESIGN.md tokens, Vite build. Dev proxies /api to `ygl-trees webui serve --port 8642`.
---

# @ygl/web — React rich client（spec R13.5）

WebUI 的富客户端家园。CLI 内嵌零依赖 dashboard（`webui export/serve`）**保留**用于离线单文件导出；本应用承载需要构建链的能力（xyflow 交互树、后续 react-markdown 报告渲染、grid-layout 面板等）。

## 用法

```bash
ygl-trees webui serve --port 8642   # 数据面（任意工作区）
pnpm --filter @ygl/web dev          # http://localhost:5173（/api 代理到 8642）
pnpm --filter @ygl/web build        # 产物 apps/web/dist（静态托管，/api 指向 serve）
```

## 架构

- **token 单一事实源**：`src/tokens.css` 镜像仓库根 [DESIGN.md](../../DESIGN.md)（改设计先改 DESIGN.md 再同步此处）；`colors:` = 深色、`colors-light:` = 浅色，漂移守卫 `tests/tokens.spec.ts` 两套都校
- **双主题**（`src/theme.tsx`）：深色 / 浅色可切换，默认跟随系统；选择存 `localStorage["ygl-theme"]`（system / light / dark），`index.html` 内联脚本首帧前生效（无闪烁）；antd 按主题换 `darkAlgorithm` / `defaultAlgorithm`，xyflow 传 `colorMode`。行内样式一律用 `tokens.ts` 的 `C.*`（CSS 变量），切换主题不重渲染
- **路由外壳**（`src/App.tsx` + `src/pages.tsx`）：react-router hash 路由——概览 `#/` · 研究管线 `#/pipeline` · 科技树 `#/tree` · 知识图谱 `#/graph` · 验证器 `#/verify` · 产出工件 `#/artifacts`。hash 而非 path：`api/*` 保持相对路径，静态产物可挂任意子路径；实时订阅（`src/data.tsx`）全局一条，切路由不重连
- **xyflow 树视图**（`src/TreeFlow.tsx`）：tier 布局 + pan/zoom/drag + MiniMap（R13.3）；点击节点出详情面板（conditions / 确定性 can / R9 related）
- **API 形状**：`src/api.ts` 与 `packages/ops/tools/src/webui.ts` 的 gatherData 对齐

## React 资源清单（用户裁定 2026-10-17，按需取用）

xyflow · ahooks · react-router · ant-design pro-components · remix · react-grid-layout · react-pdf · react-markdown
