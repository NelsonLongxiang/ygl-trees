# ygl-trees （猿光 · 科技树）

面向 AI Agent 的命令行工作台：**研究 → 产出 → 知识应用**，外加一套完整的**科技树节点数据模型**。

- 单一 SQLite 文件就是全部状态，没有 sidecar JSON，没有"用 git 当数据库"
- 依赖面（0.8.0 起引入 TypeORM 查询层）：`node-sqlite3-wasm`（纯 WASM 免编译）+ `typeorm` / `better-sqlite3` / `reflect-metadata`（TypeORM 栈，better-sqlite3 走 prebuild 免编译）+ 可选 `pg`（仅用 PostgreSQL 镜像/迁移时）
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
ygl-trees node validate     # 环（含可选边）、悬空边、自环、脏索引、缺阈值的必检条件
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
ygl-trees node import --file tree.json --tree copy  # 严格校验、事务导入
```

`node import` 校验失败（引用缺失、枚举非法、必检条件缺阈值、门控环）即整体拒绝、零副作用；同名树默认拒绝，`--merge` 按 (tree, key) upsert。

`node can` 的输出把三类失败分开列：**必检未满足 / 被排斥 / 可选未满足（不阻塞）**，外加成本系数。

**决策模型布尔判定（0.14.0，spec R8）**：语义型必检条件（"任务完成了吗"）可用 `--op eval` 声明，`node can <key> --eval` 会把**节点元数据 + 直接父（关联）+ 祖先链（闭包索引）+ 条件组 + 已解锁集 + --state 袋**组装为上下文包，交给评估模型（TypeSafe jev，经 Vercel AI Gateway）做确定性布尔判定 P(true)：

- P≥0.7 通过 · P≤0.4 未通过 · **0.4<P<0.7 灰带 pending**（过程态，禁作终态，单列不阻塞也不放行）
- **离线安全**：未配置凭证（`AI_GATEWAY_API_KEY` 或 `~/.vercel.ai-gateway.env`）时该条件回落 pending、rc=0——评估器是增强不是依赖；`YGL_EVAL_OFFLINE=1` 可强制离线（测试用）
- 判定留痕 events（`eval.gate`），`--json` 输出附加 `evaluated[]` 与 `pending[]` 字段
- **`node ready --eval`（0.16.0）**：仅被 eval 门槛阻塞的节点每节点**一次多题请求**（协议原生批量）批量判定——全过者提升进 ready 列表（标 `eval_verified`），其余进 `eval_pending` 单列（逐题带 P）；离线全部 pending、rc=0；留痕 `eval.ready`

**退出码**：`0` 成功（含"重复已存在"）、`1` 运行错误（含 404：`query done` / `job enable|disable` / `source rm` 命中不存在的 id）、`2` 用法错误。Agent 可放心按 rc 分支。

---

## 二、研究 → 产出 → 知识应用

### research：证据先行

```
query add       登记检索式
query attach    检索式 ↔ 来源关联（query list 显示召回数）
source add      收来源，按 (project, url_hash) 去重；--query 顺带关联
source fetch <url>  直接抓取网页入库：title/meta description/去标签正文；15s 超时、非 html 拒收、失败零副作用，正文过薄自动打 needs_review
evidence add    从来源摘原文片段，带 locator（页码/章节）
claim add       写下断言
claim link      断言 ↔ 证据，自动算 supported / refuted / contested
claim resolve   人工仲裁出口：--as supported|refuted|contested，事件留痕；后续新证据链接会重新推导
```

**JSON 纪律**：写命令在 `--json` 下 stdout 只有一个 JSON 对象（重复时带 `duplicate: true`），Agent 可直接 `JSON.parse` 全量输出。

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
kb import <dir|file.md>   批量导入 markdown（frontmatter：title/tags/confidence/url；按内容 hash 幂等）
kb search "<q>"           中文可用（CJK 二元切分）
kb promote <note>         把笔记提升为可复用 skill（L1 自动从正文提炼，含来源标注）
agent match "<task>"      Agent 靠 L1 描述命中该 skill
agent brief               状态 + 建议动作 + 健康度（脏索引、存量重复数据会提示修复命令）
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

### 数据安全（schema v5）

- **写入幂等**：`claim / evidence / query / kb / job` 的写命令按内容 hash 判重，重复执行返回已存在行（`! duplicate, kept existing`），Agent 重试不产生脏数据；`--force` 显式保留重复（job 用标题序号后缀）
- **完整备份**：`db export <file>` 覆盖全部数据表（含七张科技树表）并输出逐表行数摘要；dump 自带 `PRAGMA foreign_keys` 开关，可直接重放恢复。`--lean` 跳过闭包/拓扑等派生表数据
- **PostgreSQL 镜像/迁移**：`db sync pg <url>` 把整库单向全量镜像到 PG（可刷新，供 SQL 工具/团队分析）；`db migrate pg <url> [--fresh]` 一次性完整保真迁移（FK/UNIQUE/索引约束齐全，目标库可独立持有）。两者都不做双后端同写，中文检索在 PG 侧用 tsvector+GIN 等价召回（详见 docs/pg-compat.md）。url 可走环境变量 `YGL_PG_URL`；`pg` 为可选依赖，不用 PG 则零影响
- **TypeORM 查询层**（0.8.0 起，研究域试点 `project show`）：实体是 schema v5 的类型化快照（`synchronize` 永久 false，迁移权威仍在 user_version 轨道；FTS5/PRAGMA 路径保持裸 SQL）。依赖 typeorm + better-sqlite3 + reflect-metadata
- **重复可见**：`db dups` 列出同内容多行（含迁移前存量重复）
- **自动迁移**：v2 老库首次打开自动升级 schema v3（补 content_hash 列 + 回填 + 唯一索引），无人工介入

---

## 四、调度

```bash
ygl-trees job add "nightly" -- "ygl-trees produce report" --every 1440
ygl-trees job tick          # cron 每分钟调它，只跑到期的任务
ygl-trees job logs
```

`job tick` 幂等，重复执行安全；并发安全（mkdir 锁，活锁跳过、>15 分钟陈旧锁自动抢占），并回收被杀进程留下的悬空 run（>30 分钟，rc=126）。

---

## 五、给 Agent 的入口

```bash
ygl-trees agent brief      # 我在哪、有什么、下一步做什么
ygl-trees agent match "…"  # 这个任务该用哪个 skill
ygl-trees agent log        # 审计事件流
```

`agent brief --json` 直接给出结构化状态和建议动作序列，Agent 可以照着执行。

## 五b、开发与运维工具

```bash
pnpm test          # 三段制回归：unit (vitest) + build (tsc) + demo (8 组断言)
pnpm bench         # 性能基准七席（startup/写路径/检索/索引重建），结果落 tmp/bench-results.json
pnpm smoke:bun     # Bun 运行时探针（Windows 当前受阻，见 docs/bun-compat.md）
ygl-trees doctor   # 工作区健康检查（7 项：schema/索引/FTS/重复/孤儿/config/锁）
ygl-trees webui serve  # 活数据仪表盘（http://127.0.0.1:8642/，Ctrl+C 停）
```

---

## 六、环境变量、路径与配置

- `YGL_HOME`：工作区根目录，默认 `~/.ygl-trees`
- 数据库：`$YGL_HOME/ygl-trees.db`
- `--db <file>` 可指定其他库；`--json` 全局机器输出
- `ygl-trees config list|get|set|reset`：**用户可调配置**（schema v6 `config` 表，注册表默认值 + 覆盖；写入即校验并留痕 events）。现有键：`eval.pass_threshold`/`eval.fail_threshold`/`eval.offline`、**`decision_model_llm_token`/`decision_model_llm_api_base`**（决策模型凭证与端点，**优先于**环境变量与默认网关；api_base 给主机名自动补标准路径）、`fetch.timeout_ms`/`fetch.user_agent`、`search.limit`、`default_confidence`、`job.stale_minutes`——都真实接线到对应行为
- `YGL_PG_URL`：PostgreSQL 连接串（`db sync pg` / `db migrate pg` 可用，凭证不进 shell 历史）
- `AI_GATEWAY_API_KEY`（或 `~/.vercel.ai-gateway.env`）：Gate 决策模型布尔评估的凭证（0.14.0 / spec R8——op=eval 的必检条件经评估模型判定 P(true)，灰带阈值可用 config 调整；未配置时该类条件安全回落 pending）；`YGL_EVAL_OFFLINE=1` 强制离线（优先于 config 的 eval.offline）

## 七、专属 Skills（Agent 学习/使用入口）

五个技能覆盖工具全域，位于 `skills/<name>/SKILL.md`（frontmatter L1 + 正文 L2，可被本工具 `skill import` 直接导入，也可被宿主 Agent 的技能系统发现）：

| 技能 | 覆盖 |
|---|---|
| `ygl-trees-quickstart` | 冷启动、退出码/--json 契约、备份、PG 镜像/迁移、调度、tmp/ 规范 |
| `ygl-trees-research` | 证据先行研究管线（query/source/evidence/claim/produce） |
| `ygl-trees-knowledge` | 知识复用闭环（kb/skill/promote/agent match） |
| `ygl-trees-techtree` | 科技树建模（rel×mode、必检/可选、索引、can/ready/path） |
| `ygl-trees-eval-gates` | 决策模型布尔门槛（op=eval、三态、灰带、离线安全） |

`.agents/skills/` 下为指向 `skills/` 的目录联接（Windows junction，不入库）。克隆到新机器后一行重建：

```bash
node -e 'const fs=require("fs"),p=require("path");fs.mkdirSync(".agents/skills",{recursive:true});for(const s of fs.readdirSync("skills"))fs.symlinkSync(p.resolve("skills",s),p.join(".agents/skills",s),"junction")'
```

## 八、文档地图

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | **Agent 常驻守则**（仓库布局、命令、契约、开发规则——入口文件） |
| [CHANGELOG.md](CHANGELOG.md) | 逐版本聚合 |
| [docs/research.md](docs/research.md) | 初始调研与差距分析（历史归档） |
| [docs/spec.md](docs/spec.md) | 需求规格与验收标准（R1–R8） |
| [docs/plan.md](docs/plan.md) | 开发计划与逐版本执行记录 |
| [docs/conventions.md](docs/conventions.md) | 数据模型应用规范（加表九触点、幂等决策树、FTS 纪律、TypeORM 边界、tmp/ 规范） |
| [docs/pg-compat.md](docs/pg-compat.md) | PostgreSQL 兼容方案（镜像/迁移；L2 双后端已取消） |
| [docs/layout.md](docs/layout.md) | 项目目录层级规划与设计 |
| [docs/webui-design.md](docs/webui-design.md) | WebUI 可视化方案（零依赖：静态 HTML 导出 + `webui serve` 活数据仪表盘） |
| [docs/bun-compat.md](docs/bun-compat.md) | Bun 目标运行时兼容方案（Windows 受阻：fs.openSync O_CREAT 上游缺陷 + 迁移清单） |

## 九、许可

MIT
