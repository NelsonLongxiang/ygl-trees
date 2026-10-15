# ygl-trees 下一阶段调研报告

日期：2026-10-15 ｜ 调查人：DSH 会话（初始调查 + 修复轮延续）｜ 状态：定稿，供 spec.md / plan.md 引用

## 1. 调研方法

- **全量代码盘点**：`src/` 17 个文件（约 3600 行）全部读完，含全部 CLI 命令层与两个 Store 层
- **动态验证**：每个疑点在独立 `YGL_HOME` 临时工作区实测复现，不凭推断下结论
- **回归基线**：`examples/demo.sh` 端到端（7 阶段）+ 本轮新增的 `node path` 断言
- **外部对标**：本轮搜索工具因搜索端点余额问题不可用，未做逐产品对比；能力面差距分析基于工具自身定位（"面向 AI Agent 的本地研究工作台"）与通用类别知识（参考管理器 / PKM 工具 / agent memory 框架），不引用未经核实的具体产品数据

## 2. 项目现状

| 维度 | 现状 |
|---|---|
| 架构 | 单二进制 CLI；`cli.ts` 解析分发 → `cmds/*` 命令层 → `store.ts`（研究/知识域）+ `tree.ts`（科技树域）→ `db.ts`（node-sqlite3-wasm 封装） |
| 数据 | 单 SQLite 文件，schema v2，30+ 张表（含 4 个 FTS5 虚表、闭包表、拓扑索引） |
| 质量 | tsc 零报错；demo 全过；无单测，`pnpm test` 仅 `--help` |
| 版本控制 | git 已初始化（master，首个提交 `30037e3` 含两处缺陷修复） |
| 已修复 | `node path` 顺序缺陷（改为对 `node_edges` 后序 DFS）；`agent brief` skill 描述缺失（SELECT 补列） |

## 3. 缺陷清单（按严重度，均实测确认）

### P0-1 `db export` 静默丢失全部科技树数据

`cmds/db.ts` 的导出表清单只有 17 张非树表；`trees / nodes / node_edges / node_closure / node_conditions / node_state / node_index` 的 **CREATE TABLE 进了 dump 但数据行没有**。实测：含 2 节点 1 边的树，dump 中 nodes INSERT 为 0 条。备份/迁移场景下，项目自称的"核心"特性数据全丢，且无任何警告。

### P0-2 写入操作普遍不幂等（Agent 重试必踩）

`shortId` 含随机盐，同内容重复插入不会撞主键，而是**静默产生重复行**。实测：

- `claim add "同样的断言"` ×2 → 2 条相同 claim
- `kb ingest <同一 report>` ×2 → 2 条相同笔记

仅 `source add` 有 `(project_id, url_hash)` 去重。`claim add / evidence add / query add / kb add / kb ingest / job add` 全部裸插。对"失败重试是常态"的 Agent 驱动用法，这是数据污染的主通道。

### P1-1 `node export` 有出无回

`node export --out tree.json` 输出结构化 JSON（节点/边/条件/索引），但**没有对应 `node import`**。树数据出得去、回不来，跨库/跨机器迁移不成立。

### P1-2 `kb promote` 的 L1 描述生成过于粗糙

取正文第一个非标题行截 300 字符当 L1 description。研究报告正文首行往往是普通句子，导致 `agent match` 命中质量差——而 L1 命中正是整个 skill 闭环的入口。

### P1-3 `query done` 静默成功

对不存在的 id 执行 `query done` 仍报 `✓`（UPDATE 无命中不报错）。同类问题：多处 `rm/enable/disable` 命中 0 行也无提示。

### P2（健壮性/文档，择要）

| # | 问题 | 位置 |
|---|---|---|
| P2-1 | `--relevance -1` 被解析为 boolean + 位置参数，负数必须写 `--relevance=-1` | cli.ts parse |
| P2-2 | job 无 stuck-run 检测：进程被杀时 runs 行永久悬空 | job.ts / store.ts |
| P2-3 | `db sql`、`job enable` 已实现但未列入 usage | cli.ts USAGE |
| P2-4 | `stateInit` 定义未调用（死代码），node_state 全量初始化语义未接线 | tree.ts:435 |
| P2-5 | `validate` 只查必检边成环；可选 prereq 环靠 `link` 写入时拦截兜底，`db sql` 直写可绕过 | tree.ts:644 |
| P2-6 | package.json 无 `files` 白名单、无 `prepublishOnly`，npm 发布面未准备 | package.json |

### 观察（非缺陷，记录用）

- FTS 影子表在 upsert/delete 路径同步齐全（skillUpsert / sourceDel / skillDel）
- `link/unlink` 即时重建闭包，门控环（含可选边）在写入时被拦；`ready` 在索引脏时降级为逐节点独立判定，正确性不受影响
- `pathTo` 修复后不再依赖派生索引，索引过期不影响路径正确性

## 4. 能力面差距（相对"Agent 工作台"定位）

1. **采集靠手工**：`source add` 需要人贴 abstract/content，没有 `source fetch <url>` 自动入库（Node 18+ 自带 fetch，零依赖约束不冲突）
2. **断言仲裁缺失**：claim 状态由证据链接自动推导（supported/refuted/contested），但 contested 之后没有任何"如何收尾"的工作流
3. **query 生命周期太扁**：pending/done 两态，检索式与实际召回的 source 之间没有关联
4. **agent 入口是静态快照**：brief 只汇总计数 + 固定 next_actions 模板，不感知重复数据、脏索引等问题（P0/P1 修完后可顺手接入）
5. **批量导入缺失**：markdown 目录 → kb / SKILL.md 批量导入没有
6. **调度并发不安全**：两个 `job tick` 并行会双跑同一到期任务（无锁）
7. **发布链路未打通**：见 P2-6

## 5. 结论（输入 spec）

下一阶段的主题应是**"把地基修到 Agent 敢用"**，优先级排序：

1. 数据完整性（P0-1 导出丢数据）与写入幂等（P0-2）——决定这个库能不能当唯一事实源
2. 可移植闭环（node import、导出校验）——决定数据能不能搬
3. 小修集合（P1-3 / P2 全部）——低成本清障
4. 能力增强（source fetch、promote L1 改进、agent brief 感知健康度）——在干净地基上做

对应需求编号与验收标准见 [spec.md](spec.md)，排期与任务分解见 [plan.md](plan.md)。
