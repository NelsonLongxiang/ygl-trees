# WebUI 可视化方案

日期：2026-10-16 ｜ 状态：**已实施（0.19.0 export / 0.22.0 serve / 0.24.0 三视图交互 / 0.88.0 React 唯一前端）** ｜ **设计系统：[DESIGN.md](../DESIGN.md)（0.30.1 起 token 单一事实源，@google/design.md lint）**

## 路线（0.88.0 起的现状）

**React 客户端 = 唯一前端（用户裁定 0.88 单3）**：`apps/web`（Vite + @xyflow/react + antd + react-markdown）。
npm 包自带 `dist/apps/web/dist`（build 尾自动拷贝，`scripts/stage-web-dist.mjs`），隔离安装开箱即用。

**服务形态快照导出**：`ygl-trees webui export [--out <file>]` 落 `snapshot.json`——与 `/api/data`
同一载荷（meta.generated + brief + claims/sources/evidence/tree/timeline/...），原子写。可视化在
`webui serve`，数据在这。原「单文件 dashboard.html」与内嵌零依赖仪表盘、`/classic` 路由已退役。

**活数据仪表盘（0.22.0）**：`ygl-trees webui serve [--port N]`（默认 8642）：
- `/` — React 客户端（dist 缺失时**拒绝启动** rc=1，诚实报错，不静默回落）
- `/api/data` `/api/events`（SSE 表指纹推送）`/api/node` `/api/artifact`
- Ctrl+C / SIGTERM 优雅停机；CLI `finally` 在 server 关闭后才关 db

## 三个视图

### 0. 未选择态（R16.4，0.90.1 P1-3）
- 无授权项目选择时（多项目工作区 + 无会话/环境/旗标选择）：不展示任何项目内容，渲染「未选择项目」面板——可选项目清单 + `project use` 指引；不回退全局指针（brief.project 服务端剥除）。
- 知识图谱同规则：未选择态为空；授权态按项目过滤 claim/evidence/artifact 端点（node/kb 工作区级保留）——**R19 决策（0.90.1 P2-2）**：知识图谱为工作区级视图，其端点标签携带断言/证据原文，故授权与项目过滤是内容边界，非可选装饰。

### 1. Agent Brief 仪表盘（首页）
- 数据源：`agent brief --json` 输出
- 显示：当前项目、counts（sources/evidence/claims/artifacts/kb/skills）、next_actions、健康度提示
- 布局：卡片网格

### 2. 科技树可视化
- 数据源：`node export --json` 输出
- 渲染：SVG DAG（节点=矩形 tier 分层，边=箭头 rel 着色：prereq 黑/unlock 蓝/excludes 红/enables 绿，虚线=可选）
- 交互：点击节点展开 can/conditions 面板 ✅（0.24.0：`/api/node` 端点 + 右侧详情面板，确定性 can 判定）
- 布局：Kahn 拓扑序已存 node_index，直接映射 Y 轴

### 3. 研究管线视图
- 数据源：`research claim list --json` + `research evidence list --json`（载荷已按 R16 授权域收集）
- 渲染：claim 卡片（状态色：supported 绿/refuted 红/contested 黄/unverified 灰），点击展开证据链接列表
- 布局：按状态分组的水流式
- **状态（0.90.1 诚实修正，review direct-a35d58ae P2-3）**：0.88 单3 退役纯 HTML 面板时该视图随之下线，React 客户端尚未重建——此前标注的 ✅ 属于已退役的 HTML 实现。列 **0.91 路线图**（claims/evidence 载荷已在推送，只欠渲染组件）。

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

CLI 侧：`ops/tools/src/webui.ts` → `gatherData()` 单一收集器 → serve 各 /api 端点与 export 快照共用。

验证：demo §8 断言 `webui export` 落 snapshot.json 且 meta/brief/claims 载荷可解析（0.88 起）。

---

## 0.39 增补：事件驱动实时通道（SSE）

**问题**：0.33–0.38 的 React 客户端每 10s 轮询 `/api/data`——数据变更最长 10s 后才可见，且每次轮询都要全量重算 dashboard 载荷。

**方案**：服务端推送（Server-Sent Events），客户端零轮询。

```
GET /api/events   →  text/event-stream
  retry: 3000
  event: data
  data: {<完整 dashboard 载荷>}      ← 连接即发首帧（客户端无需另发 /api/data）
  …变更时再推同形帧…
```

**变更检测（服务端）**：1.5s 一次的**表指纹**——对 dashboard 渲染涉及的表取 `COUNT(*)`
拼成串（`FP_TABLES` 常量清单），指纹变化才 `gatherData` 并推送。要点：

- **按表容错**：某表缺失时该项记为 `?` 而不是整串抛错。**教训**：最初用
  `SELECT COUNT(*) FROM tasks` 取指纹，但任务不是独立表（是 `artifacts` kind='task' +
  meta 状态信封），查询每 tick 抛错 → 指纹恒为 `""` → 永不推送。容错式清单修掉。
- **代价常数**：18 张表 18 次 COUNT，无论客户端数量；推送前才做重载荷计算。

**生命周期**：指纹 tick 挂在 `ctx.timer.setInterval`（vendor 弹药 `cordis-plugin-timer`）
——ctx 释放即自动清理；插件缺失时回退裸 `setInterval().unref()`。

**停机**：SSE 客户端会永久占住 socket，`server.close()` 单独调用会等它们而永不回调。
`serve` 的 shutdown 先 `closeLive()`（结束所有 SSE 响应）再 `closeAllConnections()`
再 `close()`。**实测**：挂着 SSE 客户端时 SIGTERM → 324ms 退出。

**降级路径**：客户端 `subscribeDashboard()` 保留 10s 轮询，但**仅在 SSE 未接管时执行**
（`live` 标志）——老服务端、剥离 event-stream 的代理、EventSource 不可用时仍可用。

**验证**：
- 单测（`webui.test.ts`）：连接 → 首帧含 `tasks` 数组 → 写入新任务 → 1.5s 内收到变更帧且携带新标题
- 端到端（真实二进制）：首帧任务数 4 → 变更帧 5，帧内标题匹配
