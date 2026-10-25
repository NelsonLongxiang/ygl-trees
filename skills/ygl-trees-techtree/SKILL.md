---
name: ygl-trees-techtree
description: >-
  用 ygl-trees 科技树数据模型建依赖图：节点与父子关联（node add/link，rel=prereq|unlock|
  excludes|enables × mode=AND|OR|XOR|NOT）、必检与可选条件（node cond）、闭包与拓扑索引
  （node index/validate 环检测）、解锁判定（can/ready/path）、状态与导入导出 round-trip
  （node unlock/export/import）。
  触发词：科技树、技能树、依赖图、DAG、tech tree、skill tree、解锁、unlock、前置、
  prerequisite、拓扑、闭包、closure、互斥、节点、node。
version: 0.115.1
tags: ygl-trees,techtree,dag,unlock,gate
---

# 科技树节点模型

`node_edges` 邻接表是唯一事实源；`node_closure`（祖先/后代闭包）与 `node_index`（拓扑序）
是派生索引——`node index` 重建，遇到必检环直接报错。

> **什么时候动这些命令**（时机而非机制）见 `ygl-trees-lifecycle` 技能。

## MCP 等价面（AI agent 用 write / read 代替 CLI）

| CLI 命令 | MCP 调用 |
|---|---|
| `tree new <name>` | `write {domain:"tree", action:"tree-new", tree:"..."}` |
| `node add <key>` | `write {domain:"tree", action:"node-add", key:"..."}` |
| `node link <a> <b>` | `write {domain:"tree", action:"node-link", key:"<a>", child:"<b>"}` |
| `node unlock <key>` | `write {domain:"tree", action:"node-unlock", key:"..."}` |
| `node index` | `write {domain:"tree", action:"node-index"}` |
| `node list` | `read {domain:"tree", action:"state"}` |
| `node can <key>` | `read {domain:"node", action:"can", key:"..."}` |
| `node ready --all` | `read {domain:"node", action:"ready", all:true}` |

## 1. 建树

```bash
ygl-trees tree new demo
ygl-trees node add mining --cost 5 --tier 0
ygl-trees node link mining smelting                      # prereq/AND/必检（默认）
ygl-trees node link bronze steel --optional              # 可选：不阻塞，进 missing_optional
ygl-trees node link bronze iron --mode OR                # 任一父解锁即可
ygl-trees node link a b --rel excludes                   # 互斥分支：父解锁则子被封死
ygl-trees node move stray --to other-tree                 # 跨树搬节点：树内还有边则拒绝（先 unlink），状态行随迁（0.105.0）
ygl-trees node rm stray                                   # 删节点：FK 级联边/条件/状态
ygl-trees node cond add steel --name lab_level --kind level --value 3       # 必检门槛（add 动作词 0.81）
ygl-trees node cond add steel --name has_eng --kind flag --op has --optional \
            --effect cost_mul --weight 0.8                                 # 可选打折
ygl-trees node cond rm steel --name lab_level                              # 按自然键删除（0.81）
# 语义型门槛（决策模型三题型 boolean/choice/score）→ 见 ygl-trees-eval-gates 技能
ygl-trees node index && ygl-trees node validate
```

## 2. 判定与导航

```bash
ygl-trees node can steel --state "lab_level=3,has_eng=1"   # 三类失败分开列+成本系数
ygl-trees node can a b c --state-file bags.json            # 批量：一进程测 N 节点（探针 1s×N → 1s）
ygl-trees node ready                                        # 当前可解锁集合
ygl-trees node ready --all                                  # 跨树扫描（无需逐树 tree use）
ygl-trees node cond --due [--days 30]                       # 临期 eval 门槛（问题文本带 YYYY-MM-DD 期限）
ygl-trees node cond --due --eval                            # 到期逐条送判定模型（只报告不仲裁）
ygl-trees node path steel                                   # 解锁顺序+累计成本（目标恒最后）
ygl-trees node ancestors bronze                             # 闭包索引直查，depth=1 是直接父
ygl-trees node unlock mining && ygl-trees node lock mining
```

- 写入时环守卫：门控边（prereq/unlock）成环当场拒绝
- `node can` 输出：missing_required（阻塞）/ blocked_by（被排斥）/ missing_optional（不阻塞）
- `--state-file` 两种形状：扁平 `{"y_imported":40}` 全节点共享；按节点 `{"a":{"y_imported":40}}` 各取各袋；多键 `--json` 返回数组（0.79.1）
- `ready --all` / `cond --due` 前置于树解析：无当前树也能跑，跨树巡检一条命令（0.82）
- `cond --due` 提取 eval 问题文本中的 `YYYY-MM-DD`；默认 7 天窗口（含逾期），`--eval` 判定后仍需人工 resolve/unlock——判定 ≠ 仲裁（0.82）
- **`--tree <t>` 长旗标（0.83）**：node 组树选择别名（与 `-t` 等价）——并发会话互踩 current_tree 时钉住目标；例外：`node import --tree <name>` 是导入目标树名，不是选择器
- **`can --eval` attachments 快照（0.83）**：`--json` 增 `eval_attachments[]`、人类视图 `attachments ×N:`——本次判定吃了哪些 rel 证据一目了然，P 值复现不必翻库

## 3. 迁移与保真

```bash
ygl-trees node export --out tree.json
ygl-trees node import --file tree.json --tree copy        # 严格校验+事务，坏文件零副作用
ygl-trees node import --file tree.json --merge            # 按 (tree,key) upsert 进已有树
```

round-trip 语义等价有 demo 断言守护；同名树默认拒绝（防覆盖）。

## 4. Agent 姿势

改结构后必跑 `node index` + `node validate`（`agent brief` 也会提示脏索引）；
解锁判定用 `can` 而不是自己遍历 parents——mode 组合语义（AND/OR/XOR/NOT）在 canUnlock 里。
