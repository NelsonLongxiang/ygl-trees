# ygl-trees 开发计划

日期：2026-10-15 ｜ 规格：[spec.md](spec.md) ｜ 调研：[research.md](research.md) ｜ 规模标记：S ≤ 半会话 / M ≈ 一会话 / L > 一会话

> **执行记录（2026-10-15）**：M1/M2/M3 全部完成——`5622835`（0.2.0）、`84cc285`（0.3.0）、见 git log（0.4.0）。
> 实施中的偏差与计划外收获：
> - spec R2 jobs 行改为应用层判重（存量撞名无法安全建唯一索引）
> - spec R6.2 验收按实测修正为"命中且进前二"（原'排第一'对人工编写的 skill 不成立）
> - 计划外修复：`bin/ygl-trees.js` 曾把退出码吞成 0（Agent 按 rc 判断会全部误判）；export 的 FTS5 影子表 DDL 会破坏 dump 重放；`DB.tx` 改可重入；CLI 对异步命令（source fetch）保持 db 打开直至完成
> - `source fetch` 的三类页面行为（静态 html / 404 / 非 html）以本地 http 服务实测验证，demo 保持离线可跑

## 里程碑总览

| 里程碑 | 主题 | 版本 | 包含需求 | 出口条件 |
|---|---|---|---|---|
| M1 | 数据不丢 + 写入幂等 | 0.2.0 | R1、R2、R7.1 | demo 含幂等断言全绿；round-trip 备份实测通过 |
| M2 | 可移植 + 校验补全 | 0.3.0 | R3、R4、R5、R7.2 | export→import 等价性实测；错误出口全部非 0 退出 |
| M3 | 研究管线增强 | 0.4.0 | R6 | source fetch 对 3 类真实页面可用；brief 健康度生效 |

里程碑串行执行；每个里程碑收尾 = `pnpm test` 全绿 + git 提交 + 版本号推进 + README 同步。

## M1 — 数据不丢 + 写入幂等（0.2.0）

| # | 任务 | 涉及 | 规模 | 验收 |
|---|---|---|---|---|
| M1-1 | `db export` 表清单补全七张树表；`--lean` 跳过 closure/index 数据；导出摘要行 | cmds/db.ts | S | spec R1.1–R1.4 |
| M1-2 | 备份恢复演练：export → 删库 → 重放 → `db stats` 计数一致 + `node validate` 干净 | 手工脚本（临时，不入库） | S | 记录在提交说明 |
| M1-3 | schema v3：五表 content_hash 列 + 唯一索引 + 存量回填，事务内迁移 | db.ts | M | 老库（demo 旧数据）打开即迁移，行为不变 |
| M1-4 | 六个写命令幂等化 + `--force`（加盐 hash）+ `! duplicate` 输出 | store.ts + cmds/research.ts, kb.ts, job.ts | M | 同命令连跑两遍计数不翻倍（spec R2.5） |
| M1-5 | demo.sh 增幂等断言段（写命令×2 断言 duplicate 提示与计数） | examples/demo.sh | S | `pnpm test` 内生效 |
| M1-6 | `pnpm test` 改为 build + demo（临时 YGL_HOME） | package.json | S | `pnpm test` 一条命令可跑完 |

**依赖**：M1-3 → M1-4 → M1-5；M1-1 独立可先行。
**风险**：存量库回填 hash 时若已有重复行，唯一索引创建失败 → 迁移先检测重复，重复行加盐后建索引并在迁移日志中报告数量（不静默改数据）。

## M2 — 可移植 + 校验补全（0.3.0）

| # | 任务 | 涉及 | 规模 | 验收 |
|---|---|---|---|---|
| M2-1 | `node import --file [--tree][--merge]`：解析 + 严格校验 + 事务导入 + 自动 index | tree.ts（importTree）+ cmds/tree.ts | M | spec R3.4 round-trip 等价 |
| M2-2 | `validate` 门控边全集环检测（含可选边） | tree.ts validate | S | `db sql` 直写可选环 → validate 报 issue |
| M2-3 | 404 语义：`query done` / `job enable|disable` / `source rm` 命中 0 行报错退出 1 | cmds/research.ts, job.ts | S | spec R4.1 |
| M2-4 | CLI 负数 flag 值修复（`--relevance -1`） | cli.ts parse | S | `source list --min -1` 与现状等价 + 新负值用例 |
| M2-5 | usage 补 `db sql` / `job enable`；`stateInit` 决策执行（倾向删除） | cli.ts, tree.ts | S | `--help` 与实现一致 |
| M2-6 | package.json `files` 白名单 + `prepublishOnly` | package.json | S | `npm pack --dry-run` 仅含白名单内容 |
| M2-7 | demo.sh 增 round-trip 断言（export→import→再 export 语义等价，node 脚本比对） | examples/demo.sh | S | `pnpm test` 内生效 |

**依赖**：M2-1 → M2-7；其余并行。
**风险**：export 格式里 index 派生字段（topo_order 等）在 import 时必须忽略重建，比对脚本要排除 `id/created/built_at`——M2-1 实现时以白名单字段比对。

## M3 — 研究管线增强（0.4.0）

| # | 任务 | 涉及 | 规模 | 验收 |
|---|---|---|---|---|
| M3-1 | `source fetch <url>`：内置 fetch + title/meta/正文提取 + 走 sourceAdd 去重 + 失败不落库 | cmds/research.ts | M | 3 类页面（静态 html / 404 / 非 html）行为正确 |
| M3-2 | `kb promote` L1 生成改进（标题段/列表项优先，回落现状） | store.ts kbPromote | S | spec R6.2 验收（match 排第一） |
| M3-3 | `agent brief` 健康度 next_actions（存量重复行、脏索引） | cmds/agent.ts | S | 人工构造两类状态，brief 各给出对应提示 |
| M3-4 | README 更新至 0.4.0 命令面 | README.md | S | 新命令全部有文档 |

**依赖**：M3 全部依赖 M1/M2 完成；M3-1 独立于 M3-2/3。
**风险**：真实网页正文提取无依赖条件下质量有限——spec 已限定"非 JS 渲染站点"，提取失败时保存原始前 N KB 并标记 `needs_review` tag，不假装成功。

## 明确推迟（不进本计划）

- claim 仲裁工作流、query↔source 关联、markdown 批量导入、调度并发锁、npm 实际发布、单测框架——待 0.4.0 复盘再立项

## 完成定义（DoD，每里程碑通用）

1. `pnpm build` 零报错；`pnpm test`（build + demo 含新断言）全绿
2. 新行为有 demo 断言或可复现验证记录（命令 + 输出贴进提交说明）
3. README / usage 与实际命令面一致
4. 版本号推进 + git 提交（一个里程碑一个合并点，任务可多提交）
