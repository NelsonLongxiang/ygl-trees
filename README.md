# ygl-trees （猿光 · 科技树）

面向 AI Agent 的命令行工作台：**研究 → 产出 → 知识应用**，外加一套完整的**科技树节点数据模型**。

- 单一 SQLite 文件就是全部状态，没有 sidecar JSON，没有"用 git 当数据库"
- 零运行时依赖（除 `node-sqlite3-wasm`，纯 WASM，免编译）
- 全部命令支持 `--json`，方便 Agent 直接解析

```bash
pnpm install
pnpm build          # tsc -> dist/
node bin/ygl-trees.js db init
```

---

## 一、科技树节点数据模型（核心）

要求：**父子节点、每个节点可存在的关联与索引、必检与可选条件**。schema 四张表分头承担：

| 关注点 | 表 | 说明 |
|---|---|---|
| 节点定义 | `nodes` | key（存档用的稳定 ID）、kind、tier、cost、payload |
| 父子 + 关联 | `node_edges` | 邻接表，**唯一事实来源** |
| 传递索引 | `node_closure` | 祖先/后代闭包，`depth` 区分直接父与远祖 |
| 派生索引 | `node_index` | 拓扑序、tier 分桶、入度表 |
| 非结构条件 | `node_conditions` | 资源/等级/任务等，必检或可选 |
| 运行时 | `node_state` | 按 context（存档槽）存 locked/available/unlocked |

### 父子与关联：四种 rel × 四种 mode

`node link <parent> <child>` 可指定：

- `--rel` 关联语义
  - `prereq` 前置依赖（默认）
  - `unlock` 父节点揭示子节点
  - `excludes` 排斥，父已解锁则子被封死
  - `enables` 软关联，只做提示/加成
- `--mode` 多个父节点如何组合
  - `AND` 全部满足（默认）
  - `OR` 任一满足
  - `XOR` 恰好一个满足
  - `NOT` 父必须**未**解锁

### 必检 vs 可选

这是模型里最容易糊掉的界线，两处都显式区分：

- **边级**：`node_edges.required`（`--optional` 置 0）
  - 必检：不满足即无法解锁
  - 可选：不阻塞，但会进入 `missing_optional`，可作为"本可打折"的提示
- **条件级**：`node_conditions.required` + `effect`
  - `gate`（必检）：资源/等级/任务门槛
  - `cost_mul`（可选）：满足条件则成本打折，`weight` 即系数

```bash
ygl-trees node cond steel --name research_lab_level --kind level --value 3          # 必检
ygl-trees node cond steel --name has_engineer --kind flag --op has \
           --optional --effect cost_mul --weight 0.8                                # 可选，打八折
```

### 索引：查询不再递归

- `node_closure` 让 `ancestors` / `descendants` / `reaches` 走 O(1) 查表
- `node_index.topo_order` 让 `node ready` 单次拓扑序扫描搞定，不必反复 DFS
- `node index` 重建两者；**遇到环直接报错**，坏数据在构建期暴露，而不是运行时

```bash
ygl-trees node index        # 重建闭包 + 拓扑序
ygl-trees node validate     # 环、悬空边、自环、脏索引、缺阈值的必检条件
```

### 完整一组命令

```bash
ygl-trees tree new demo
ygl-trees node add mining && ygl-trees node add smelting
ygl-trees node link mining smelting                 # 必检 AND
ygl-trees node link bronze steel --optional         # 可选，不阻塞
ygl-trees node link bronze iron --mode OR           # 任一即可
ygl-trees node link a b --rel excludes              # 互斥分支
ygl-trees node can steel --state "research_lab_level=3,has_engineer=1"
ygl-trees node ready                                # 当前可解锁集合
ygl-trees node path advanced-alloy                  # 到目标的最省顺序 + 累计成本
ygl-trees node ancestors bronze                     # 闭包索引，直接父 depth=1
ygl-trees node export --out tree.json               # 可移植 JSON
```

`node can` 的输出把三类失败分开列：**必检未满足 / 被排斥 / 可选未满足（不阻塞）**，外加成本系数。

---

## 二、研究 → 产出 → 知识应用

### research：证据先行

```
query add       登记检索式
source add      收来源，按 (project, url_hash) 去重
evidence add    从来源摘原文片段，带 locator（页码/章节）
claim add       写下断言
claim link      断言 ↔ 证据，自动算 supported / refuted / contested
```

断言的状态**由证据链接自动推导**：有支持有反对 → `contested`，只有支持 → `supported`，都没有 → `unverified`。

### produce：从证据生成报告

```
outline   按 claim 状态自动生成骨架
section   写章节
report    组装：摘要 → 主要结论（带证据编号）→ 章节 → 证据清单 → 来源 → 局限
export    落盘 markdown
```

报告里每条结论后跟引用编号，未获支持的断言会进"局限与未决问题"，不会伪装成结论。

### kb：让研究产生复利

```
kb ingest <artifactId>    报告入库
kb search "<q>"           中文可用（CJK 二元切分）
kb promote <note>         把笔记提升为可复用 skill
agent match "<task>"      Agent 靠 L1 描述命中该 skill
```

闭环：**报告 → 笔记 → skill → 下次自动命中**。

### skill：L1/L2/L3 渐进披露

- L1 `description`：常驻上下文，写"做什么 + 何时触发 + 同义词"
- L2 `body`：激活才加载
- L3 `skill_refs`：按需读取

`skill import <SKILL.md>` 直接解析 frontmatter。

---

## 三、为什么用 SQLite 而不是文件

| 需求 | 文件的做法 | 数据库的做法 |
|---|---|---|
| 来源去重 | 扫全目录比对 | `UNIQUE(project_id, url_hash)` |
| 断言溯源 | 手工维护引用 | `claim_evidence` 联结表 |
| 祖先查询 | 递归遍历 | 闭包表一次查 |
| 全文检索 | grep | FTS5 + CJK 二元切分 |
| 调度状态 | 标记文件 | `jobs` / `runs` 表 |
| 审计 | 翻日志 | `events` 表 |

CJK 检索是个坑：FTS5 默认 `unicode61` 会把整句中文当成一个 token。这里在写入时把中文按字切二元组（`科技树` → `科技 技树`），再逐 token 匹配并按命中数排序，长句也能召回。

### 数据安全（v3）

- **写入幂等**：`claim / evidence / query / kb / job` 的写命令按内容 hash 判重，重复执行返回已存在行（`! duplicate, kept existing`），Agent 重试不产生脏数据；`--force` 显式保留重复（job 用标题序号后缀）
- **完整备份**：`db export <file>` 覆盖全部数据表（含七张科技树表）并输出逐表行数摘要；dump 自带 `PRAGMA foreign_keys` 开关，可直接重放恢复。`--lean` 跳过闭包/拓扑等派生表数据
- **重复可见**：`db dups` 列出同内容多行（含迁移前存量重复）
- **自动迁移**：v2 老库首次打开自动升级 schema v3（补 content_hash 列 + 回填 + 唯一索引），无人工介入

---

## 四、调度

```bash
ygl-trees job add "nightly" -- "ygl-trees produce report" --every 1440
ygl-trees job tick          # cron 每分钟调它，只跑到期的任务
ygl-trees job logs
```

`job tick` 幂等，重复执行安全。

---

## 五、给 Agent 的入口

```bash
ygl-trees agent brief      # 我在哪、有什么、下一步做什么
ygl-trees agent match "…"  # 这个任务该用哪个 skill
ygl-trees agent log        # 审计事件流
```

`agent brief --json` 直接给出结构化状态和建议动作序列，Agent 可以照着执行。

---

## 六、环境变量与路径

- `YGL_HOME`：工作区根目录，默认 `~/.ygl-trees`
- 数据库：`$YGL_HOME/ygl-trees.db`
- `--db <file>` 可指定其他库；`--json` 全局机器输出

## 七、许可

MIT
