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

## React 资源清单（用户裁定 2026-10-17，按需取用；2026-10-20 取舍）

已用：xyflow · react-router（7，hash 路由）· react-markdown。裁定不引入（体积棘轮 2% 实测，见
[DESIGN.md](../../DESIGN.md) Building 表与 ygl-trees claim 65f458cde5 / 6ca956b4a7 / fde289131a）：
ant-design pro-components（antd 6 仅 beta，web_dist +54%）· react-grid-layout（+5.4%，概览用 CSS grid）·
react-pdf（+88%，且用户裁定不做导出）· remix（framework 模式需 React 19）· ahooks（仅用 useTheme，自写 hook 更稳，已移除）。

## 交付验收（验证器口径，2026-10-20 起）

每个视图提交前过本地门禁，提交后由外部结果验证器 ygl-webui-verifier 实测（独立仓库，不随上游发布，监督席运行：对指定提交构建、起 `webui serve`，用 Playwright 逐视图逐场景实测并归档结果，文件按 `<sha12>--<run_id>.json` 命名）；下面的口径是给维护者看的契约，不依赖那个仓库也能照着验。
里程碑节点（ygl-trees 树 `webui` 的 `webui-release`）只在验证器对被验提交 root PASS 后解锁，证据 = run_id + 结果文件路径。

- **本地门禁**（仓库内命令）：`pnpm test` 全绿（build + 单测 + demo + contract:audit + ratchet：web_dist
  容差 2%）；单项可跑 `pnpm test:unit`、`pnpm contract:audit`、`pnpm ratchet`；apps/web 测试只用
  `react-dom/server` 静态渲染，不引 jsdom。
- **视图层实测**：6 个视图（概览 / 研究管线 / 科技树 / 知识图谱 / 验证器 / 产出工件）× 3 场景
  （深色 / 浅色 / 存储禁用——`localStorage` 与 `sessionStorage` 一访问即抛 SecurityError）：
  无控制台错误、无错误告警、主区至少 20 个字（空态必须有引导文案）、画布有节点、
  可见文字按实际渲染色逐字测对比度 ≥4.5:1（24px+ 或非文字 ≥3:1；实心主按钮含正常 / 悬停 / 按下三态，
  表格列筛选下拉会先点开再测）。
- **接口**：7 个前端接口全部 200 且 JSON 合法。
- **色板**：DESIGN.md 两套色板每一对文字配对 ≥4.5（`text-dim` 为非文字 token，按 3:1）；
  图表系列色 `chart-*` 以色板验证器核：相邻对 CVD ΔE ≥8、普通视觉 ≥15、对底 ≥3:1，两套主题各验一次。
- **规则**：前端只读；agent 建议的命令可一键复制、页面不执行写操作；导出 / PDF 不在范围（用户裁定 2026-10-20）。

### 可选工具（需另行安装，不在门禁内）

- `npx -y @ant-design/cli lint ./src`：antd 弃用 / 可访问性 / 用法检查，建议保持 0 项（本轮交付为 0）。
- `npx -y -p @google/design.md designmd lint DESIGN.md`：DESIGN.md 格式与对比度检查，建议保持 0 error（本轮交付为 0，仅余 orphaned-tokens 一类警告）。
