# WebUI 可视化方案（0.18.0 设计稿，后续批次实施）

日期：2026-10-16 ｜ 状态：设计定稿，待实施 ｜ 原则：零新依赖

## 路线

**静态 HTML 导出**：`ygl-trees webui [--out <file>]` 生成单文件 `dashboard.html`，数据内嵌为 `<script>` JSON，浏览器直接打开——不需要服务器、不需要 npm 依赖、不需要网络。刷新 = 重跑命令。

## 三个视图

### 1. Agent Brief 仪表盘（首页）
- 数据源：`agent brief --json` 输出
- 显示：当前项目、counts（sources/evidence/claims/artifacts/kb/skills）、next_actions、健康度提示
- 布局：卡片网格

### 2. 科技树可视化
- 数据源：`node export --json` 输出
- 渲染：SVG DAG（节点=矩形 tier 分层，边=箭头 rel 着色：prereq 黑/unlock 蓝/excludes 红/enables 绿，虚线=可选）
- 交互：点击节点展开 can/conditions 面板
- 布局：Kahn 拓扑序已存 node_index，直接映射 Y 轴

### 3. 研究管线视图
- 数据源：`research claim list --json` + `research evidence list --json`
- 渲染：claim 卡片（状态色：supported 绿/refuted 红/contested 黄/unverified 灰），点击展开证据链接列表
- 布局：按状态分组的水流式

## 技术约束

| 约束 | 理由 |
|---|---|
| 零 npm 依赖 | 保持运行时面最小 |
| 单 HTML 文件 | 可直接分享/离线打开 |
| 内嵌 CSS/JS | 不需要静态资源服务器 |
| 纯 SVG/CSS 渲染 | 不引入图表库 |
| `<script>` JSON 数据 | CLI 侧拼好嵌入，前端只做渲染 |

## 实施路径

```
src/webui/
  dashboard.ts    HTML 模板 + 数据注入
  views/
    brief.ts      仪表盘渲染函数
    tree.ts       SVG DAG 渲染函数
    research.ts   管线渲染函数
```

CLI 侧：`cmds/webui.ts` → 调用 `agent brief --json` + `node export --json` + `claim list --json` → 注入模板 → 写文件。

验证：demo 增加 `webui --out tmp/dashboard.html` + 断言文件存在且包含关键 HTML 标签。
