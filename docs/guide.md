---
name: guide
description: ygl-trees 情景教程——每种情况什么时候用、照着敲的完整命令、会看到什么、怎么收口、常见坑
kind: 参考
---

# ygl-trees 情景教程：什么时候用、怎么用

这份教程按「你遇到了什么情况」组织。每个情景都写了：什么时候该用、可以照着敲的完整命令、你会看到的输出、做完怎么检查，以及常见的坑。

- 想一页看完全部用途，先读第 0 节。
- 第一次用，按第 1 节装好，再挑一个情景照着做。
- 只想查命令，用 `ygl-trees --help`，或 `ygl-trees llms`（给 agent 的完整命令清单）。
- 各情景的「方法论」细节在 `skills/` 下的十二个技能里，文中会给链接。

> 本教程的命令和输出，都在 ygl-trees 0.121.0 上实跑过，用的是一个干净的临时工作区。如果你还在用 0.120.0 或更早的版本，请先升级（`npm install -g ygl-trees@latest`），或者先看 [1.1 节末尾的差异表](#11-安装)。
>
> ID 是 10 位十六进制，每次运行都不一样。照着做时，请换成你自己输出里的 ID。

---

## 0. 一页看懂：它是什么，什么时候用

**它是什么。** 一个给 AI agent（也给人）用的本地工作台。全部状态都在一个 SQLite 文件里，可以通过三种方式使用：命令行、MCP 工具，或网页。它帮你把这几类东西记下来，并且能追溯、能检查：

| 你要记的东西 | 对应的命令组 | 一句话 |
|---|---|---|
| 研究：问题、来源、原文摘录、判断 | `project` `research` `produce` | 每个结论都能追到原文 |
| 计划：目标拆成有依赖的节点 | `tree` `node` | 随时能问「下一步能做什么」 |
| 经验：笔记和可复用的技能 | `kb` `skill` `agent match` | 同一个坑不踩第二次 |
| 执行：任务、定时作业、巡检 | `task` `job` `patrol` | 进度看得见，异常有队列 |
| 规范检查：业务规则变成可复核的检查 | `verify` | 判定可重跑、可带走、可验签 |
| 把上面这些连起来 | `rel` | 节点挂证据、知识挂断言 |

**什么时候用：对号入座。**

| 你遇到的情况 | 去哪一节 |
|---|---|
| 要回答一个开放问题，结论必须说得出出处 | [情景 1](#情景-1回答开放问题结论要有出处) |
| 要系统研究一个开源项目，判断它下一步会做什么 | [情景 2](#情景-2研究一个开源项目) |
| 一个要做很多轮的目标，想随时知道下一步、进度到哪 | [情景 3](#情景-3把长期目标拆成科技树) |
| 某一步「做到没」只能靠判断，没有数字门槛 | [情景 4](#情景-4语义门槛让模型判做到没有) |
| 对未来下了判断，想到期知道准不准 | [情景 5](#情景-5立预测到期结算) |
| 踩过的坑、总结的做法，想下次自动想起来 | [情景 6](#情景-6把经验沉淀成知识和技能) |
| 有一串待办，要分配、推进、取消 | [情景 7](#情景-7跟踪任务) |
| 好几个 agent 或会话共用一个工作区 | [情景 8](#情景-8多个会话或-agent-共用一个工作区) |
| 一条业务规则（「订单金额不得为负」）要变成谁都能复核的检查 | [情景 9](#情景-9把业务规范变成验证器) |
| 有些事要定期自动跑，有些规则要一直盯着 | [情景 10](#情景-10定期自动跑作业与巡检) |
| 想让 Claude 或其他 agent 直接调用它 | [情景 11](#情景-11让-agent-通过-mcp-使用) |
| 要把成果给人看：报告、网页、笔记库 | [情景 12](#情景-12把成果给人看) |
| 担心数据丢失，或者工作区出了怪问题 | [情景 13](#情景-13体检备份恢复) |

**什么时候不该用它：**

- **代码和文档的版本管理**：用 git。ygl-trees 记的是「为什么这么做、依据是什么、做到哪了」，不记代码本身。
- **团队讨论、对外公告**：用 GitHub issue、PR 或聊天工具。ygl-trees 里的 claim、task 是你自己的账，不会通知别人。
- **密码、令牌、凭证**：不要写进 kb、evidence 或 task。唯一的例外是决策模型凭证，放在 `config` 里，专门标了机密。
- **实时监控和告警**：交给监控系统。`patrol` 适合按需或定期跑的数据规则检查，不适合秒级告警。
- **一问一答的小问题**：直接回答就好，不必建项目。只有当结论要留存、要复用、要被别人复核时，才值得落库。

判断要不要落库，问自己一句：**换一个会话、换一个人，还需要知道这件事吗？** 需要，就记进来。

---

## 1. 第一次用：安装与五分钟上手

### 1.1 安装

```bash
npm install -g ygl-trees      # 需要 Node.js 18 或更高
ygl-trees --version
```

在本仓库里开发时，不装全局也行：`pnpm install && pnpm build`，然后用 `node dist/bundle/bin.cjs` 代替 `ygl-trees`。

**npm 11 提示安装脚本没被允许。** 安装时可能看到 `better-sqlite3 … install scripts not yet covered by allowScripts`。

先跑一次 `ygl-trees doctor`。如果 `sqlite_driver` 一项是 ✓，就不用管（macOS arm64 上实测是这样）。如果这一项报错，就放行这个包的安装脚本，再装一次：

```bash
npm install -g --allow-scripts=better-sqlite3 ygl-trees    # 全局安装
npm install-scripts approve better-sqlite3 && npm install  # 装在某个项目里
```

全局安装不能用 `npm install-scripts approve`，npm 会报 EGLOBAL。

**还在用 0.120.0？** 本教程有几处用法是 0.121.0 才有的。用 npm 上的 0.120.0 把本教程全部命令重放一遍，差异如下：

| 教程里的用法 | 在 npm 0.120.0 上 |
|---|---|
| `task cancel`、`reopen`、`assign`、`stale`（情景 7） | 没有这些命令，报用法错误（退出码 2）。只有 `add`、`list`、`todo`、`doing`、`done` |
| `task add --owner`（情景 7） | 不报错，但不记录负责人 |
| `verify prune`（情景 9） | 没有：`unknown verify action: prune` |
| `job show`、`job retire`（情景 10） | 没有：`unknown job action` |
| `job add --replaces`（情景 10） | 不报错，但不生效，旧作业照旧保留 |
| `job add` 不给调度方式，或 `--every` 低于 60（情景 10） | 都能登记，没有这两道保护 |
| `doctor`（情景 7、13） | schema 是 v12；没有 `task_hygiene`、`job_health` 两项检查 |

### 1.2 工作区放在哪

- 默认工作区是 `~/.ygl-trees`，数据库文件是其中的 `ygl-trees.db`。
- 换一个工作区有两种写法：环境变量 `YGL_HOME=<目录>`，或在命令上加 `--home <目录>`。
- **建议一个项目或一类工作用一个工作区**，彼此不串。试验时一定要用临时目录，例如：

```bash
export YGL_HOME=~/tmp/ygl-try
ygl-trees db init
```

```text
  ✓ workspace ready: ~/tmp/ygl-try
  ✓ database:        ~/tmp/ygl-try/ygl-trees.db
  ✓ built-in skills:  12 imported in 0.0s (agent match ready)
```

### 1.3 每次开工先问一句「我在哪」

```bash
ygl-trees agent brief
```

它会告诉你：当前工作区、当前项目、各类数据有多少，以及建议的下一步（next actions）。刚初始化时，它会提示你先建项目：

```text
  next actions
  → ygl-trees project new <name> -q "<研究问题>"
```

### 1.4 三条约定，记住就不会踩坑

| 约定 | 内容 |
|---|---|
| **退出码** | `0` 成功（重复写入也算成功）；`1` 运行错误或找不到；`2` 用法错误（少参数、参数非法、没选项目） |
| **`--json`** | 任何命令都能加，放在命令组前后都可以（`ygl-trees --json research claim list`）。stdout 只输出一个 JSON；出错时也是 `{"error":"…"}` |
| **重复写入安全** | 同样内容再写一次，返回已有那一行（`! duplicate, kept existing`，退出码 0）。agent 重试不会写出脏数据。确实要保留重复时加 `--force` |

**ID 怎么拿。** 研究、知识、任务、作业这类 ID 都是 10 位十六进制（例如 `32c6b49af3`），验证器的 ID 带前缀（`mat_…`、`spec_…`、`run_…`），都不是 1、2、3 这样的序号。人工操作时从输出里复制；写脚本时用 `--json` 取，例如：

```bash
sid=$(ygl-trees --json research source add --title "…" --url "…" | jq -r .id)
```

---

## 情景 1：回答开放问题，结论要有出处

**什么时候用：** 你要回答的问题，结论将来会被追问「依据是什么」。比如技术选型、竞品判断、政策解读。

**流程：** 登记问题 → 收集来源 → 摘原文 → 立判断 → 把判断挂到证据上 → 人工确认 → 出报告。

下面用一个真实的小例子：「团队内部数据分析，要不要从 SQLite 换成 PostgreSQL？」

### 步骤 1：建项目，登记检索式

```bash
ygl-trees project new pg-choice -q "团队内部数据分析要不要从 SQLite 换成 PostgreSQL？"
ygl-trees research query add "SQLite 并发写 限制"
```

```text
  ✓ project created and selected: pg-choice
  ✓ query registered: 2f5bb47d05  SQLite 并发写 限制
```

`project new` 会同时选中这个项目。之后的研究命令都记在它名下。

### 步骤 2：收集来源

能联网时，直接抓网页（失败不会留下任何数据）：

```bash
ygl-trees research source fetch https://www.sqlite.org/whentouse.html
```

也可以手工登记。把原文放进 `--content`，后面摘录时会逐字核对：

```bash
ygl-trees research source add --title "SQLite: Appropriate Uses" \
  --url "https://www.sqlite.org/whentouse.html" --relevance 5 --confidence A \
  --content "SQLite supports an unlimited number of simultaneous readers, but it will only allow one writer at any instant in time."
ygl-trees research query attach 2f5bb47d05 32c6b49af3     # 记下：这个来源是这条检索式找到的
```

```text
  ✓ source added: 32c6b49af3  SQLite: Appropriate Uses  · project pg-choice
  ✓ attached: SQLite: Appropriate Uses → "SQLite 并发写 限制"
```

- `--relevance` 只收 0–5 的整数；`--confidence` 收 A、B、C。
- 同一个网址只记一次：再登记同一个 URL，返回的是已有的那条。同一页面的不同段落要当成不同来源时，在网址后面加锚点，比如 `…/whentouse.html#dbcklst`。
- 批量导入用 `--batch <file.jsonl>`（每行一个 JSON）。坏行会点出行号，整批拒收，一行都不写。

### 步骤 3：摘原文

```bash
ygl-trees research evidence add 32c6b49af3 \
  --quote "it will only allow one writer at any instant in time" \
  --note "写并发上限=1，多人同时写会排队" \
  --locator "§Situations Where A Client/Server RDBMS May Work Better"
```

```text
  ✓ evidence added: 510505c933  it will only allow one writer at any instant in t…  · project pg-choice
```

`--quote` 必须是原文，你的理解写进 `--note`。来源里存了原文时，摘录会逐字核对，对不上就拒收：

```text
  ✗ quote does not occur in stored source content: 32c6b49af3; use a literal quote or explicitly --unverified for paraphrase/translation
```

确实是翻译或转述时，显式加 `--unverified`，让读的人知道这不是原话。

### 步骤 4：立判断，挂证据

```bash
ygl-trees research claim add "团队只有 1-2 个进程同时写库时，SQLite 的单写者限制不构成瓶颈" --confidence B
ygl-trees research claim link c213518219 510505c933 --stance supports
```

```text
  ✓ claim added: c213518219  团队只有 1-2 个进程同时写库时，SQLite 的单写者限制不构成瓶颈  · project pg-choice
  ✓ linked; claim status now: supported
```

判断要写成**能被推翻的话**（「1-2 个写进程时不构成瓶颈」），不要写「SQLite 挺好的」。

挂上支持证据后，状态会自动变成 `supported`；挂反对证据用 `--stance refutes`。

### 步骤 5：人工确认，出报告

```bash
ygl-trees research claim show c213518219                 # 看判断和它挂的全部证据
ygl-trees research claim resolve c213518219 --as supported --note "单写者限制成立；我们实测峰值 2 个写进程"
ygl-trees produce report
ygl-trees produce export 483aa09b77 report.md            # 报告 ID 见上一条输出
```

报告是从库里的状态自动生成的，每条结论都带编号引用：

```text
## 主要结论

1. ✓ 团队只有 1-2 个进程同时写库时，SQLite 的单写者限制不构成瓶颈  [1]
   _置信度 B，状态 supported_

## 证据清单

[1] SQLite: Appropriate Uses · §Situations Where A Client/Server RDBMS May Work Better — it will only allow one writer at any instant in time
```

**命令说明：**

- `resolve` 是**人工仲裁**，结果可以是 `supported`、`refuted` 或 `contested`（有争议）。
- 仲裁错了，用 `research claim unresolve <id>` 退回待验证。
- 报告前想先看结构，用 `produce outline`。要补几段自己写的文字，用 `produce section <标题> --body "…"`。
- 同名段落再存一次，会记成新版本（v2）。但报告里 v1 和 v2 会同时出现，目前也没有删除段落的命令。所以段落写定了再存。
- 报告的「局限与未决问题」一节，只自动列出还没被支持的判断。设计上的取舍和代价，要自己用 `produce section` 写一段。

**做完检查：**
- `agent brief` 里的 `claims x/y verified` 是不是你预期的数。
- 每条 supported 的判断都至少挂了一条证据。可以把这条规则交给巡检盯着，见情景 10。

**常见坑：**
- 先写结论再找证据：证据会变成装饰。顺序是先摘原文，再立判断。
- 把转述当原文存进 `--quote`：将来没人能核对。
- 判断没有挂证据就 resolve：等于拍脑袋，巡检会抓出来。
- 判断的文字立下后就改不了，也删不掉。措辞想清楚再 `claim add`。

深入：[ygl-trees-research](../skills/ygl-trees-research/SKILL.md)。

---

## 情景 2：研究一个开源项目

**什么时候用：** 要判断一个开源项目「作者想解决什么、走到哪了、下一步大概率做什么」。比如选型前的尽调、竞品跟踪、决定要不要跟进上游。

**思路：** 证据还是走情景 1 的研究流程。在此之上，建一棵「作者意图树」：

| 层级 | 放什么 |
|---|---|
| 上层 | 作者要解决的问题（意图） |
| 中层 | 已经做成的机制（现状） |
| 末层 | 还没发生的下一步（预测） |

末层的每个节点，都配一条到期能结算的预测（见情景 5）。

```bash
ygl-trees project new acme-sdk -q "acme-sdk 作者要解决什么？下一步会做什么？"
ygl-trees research query add "作者想解决什么问题"         # 问题域
ygl-trees research query add "架构为什么这样选"           # 决策域
ygl-trees research query add "下一个版本会做什么"         # 预测域
ygl-trees research source fetch https://github.com/acme/acme-sdk/releases
# …按情景 1 摘录 README、发布记录、issue 讨论里的原话，立断言…

ygl-trees tree new acme-sdk-intent
ygl-trees node add intent-offline --name "离线优先" --tier 1
ygl-trees node add mech-sync --name "已有增量同步" --tier 2
ygl-trees node add next-crdt --name "下一步：CRDT 冲突合并" --tier 5
ygl-trees node link intent-offline mech-sync
ygl-trees node link mech-sync next-crdt
ygl-trees node index && ygl-trees node validate

ygl-trees research claim add "[预测·90天] 2027-02-05 前 acme-sdk 发布含 CRDT 合并的版本" --confidence 0.6 --channel repo-research
ygl-trees rel add node:next-crdt claim:<预测断言ID> --rel decided-by
```

**做完检查：** 意图、现状、预测三层都有节点。每个现状节点都挂了证据。每个预测节点都挂了一条带日期的预测断言。

**常见坑：**
- 只写现状、不下预测：这样的研究只能用一次，没法回头检验。
- 拿自己的推测当作者意图：意图层要有作者原话（README、ADR、issue 回复）作证据。

深入：[ygl-trees-repo-research](../skills/ygl-trees-repo-research/SKILL.md)。

---

## 情景 3：把长期目标拆成科技树

**什么时候用：** 一个要做很多轮的目标（产品上线、版本批次、重构、个人能力成长），想随时回答三个问题：

- 「下一步能做什么」
- 「离目标还差什么」
- 「这一步凭什么算做完」

**先记住方向：** `node link A B` 表示 **A 是 B 的前置**，先完成 A，B 才能解锁。（很容易写反：写反了之后，`node ready` 会把最终目标列成「现在就能做」。）

### 3.1 建树、加节点、连依赖

例子：上线一个内部数据看板。

```bash
ygl-trees tree new launch
ygl-trees node add schema    --name "数据表结构定稿"            --tier 1
ygl-trees node add etl       --name "每日导数任务跑通"          --tier 2
ygl-trees node add charts    --name "核心图表完成"              --tier 2
ygl-trees node add pilot     --name "试点团队验收"              --tier 3
ygl-trees node add pg-mirror --name "PG 镜像（可选，接 BI 用）" --tier 2
ygl-trees node add goal      --name "内部数据看板上线"          --tier 4

ygl-trees node link schema etl
ygl-trees node link schema charts
ygl-trees node link etl charts
ygl-trees node link charts pilot
ygl-trees node link pilot goal
ygl-trees node link pg-mirror goal --optional      # 可选前置：不挡路，只出现在提示里

ygl-trees node index && ygl-trees node validate    # 改完结构必跑：重建索引、查环和悬空边
```

```text
  ✓ linked schema → etl  [prereq/AND/必检]
  …
  ✓ linked pg-mirror → goal  [prereq/AND/可选]
  ✓ index rebuilt: 6 nodes, closure 17 rows
  ✓ no issues
```

- `tier` 是成熟度或里程碑的轴。索引会把它抬到比必检前置至少高一级，所以 `node list` 里看到的 tier 可能比你填的大。
- 连线默认是必检前置（prereq/AND）。还可以用：
  - `--mode OR`：任一前置完成即可。
  - `--rel excludes`：互斥，A 解锁后 B 被封死。

### 3.2 随时问「下一步」

```bash
ygl-trees node ready            # 现在能解锁哪些
ygl-trees node can goal         # goal 还差什么
ygl-trees node path goal        # 按什么顺序做到 goal
```

```text
Ready to unlock (2)
  pg-mirror  PG 镜像（可选，接 BI 用）  2
  schema     数据表结构定稿             1

can unlock: goal
  ✗ 不可解锁
  必检未满足
    - pilot (AND)
  可选未满足（不阻塞）
    - pg-mirror (AND)

Unlock order to goal
  1. pg-mirror
  2. schema
  3. etl
  4. charts
  5. pilot
  6. goal
```

### 3.3 加门槛：不只看前置，还要满足条件

```bash
ygl-trees node cond add pilot --name testers --kind resource --op ">=" --value 3
ygl-trees node index
ygl-trees node can pilot --state testers=2
```

```text
can unlock: pilot
  ✗ 不可解锁
  必检未满足
    - charts (AND)
    - testers >= 3
```

条件值通过 `--state k=v,k2=v2` 临时传入。条件也可以设成可选的打折项：加 `--optional --effect cost_mul --weight 0.8`。

### 3.4 做完一步：先确认，再解锁，再挂证据

```bash
ygl-trees node can schema                                          # 先确认能解锁
ygl-trees node unlock schema
ygl-trees rel add node:schema evidence:<证据ID> --rel evidenced-by   # 凭什么算做完
```

> **重要：`node unlock` 只是打标记，不会替你检查前置。** 前置没完成也能标成已解锁。所以解锁前先跑 `node can`。解锁后在同一轮里用 `rel` 挂上依据，不然以后没人说得清「凭什么算做完」。

想看这棵树是怎么长起来的：`ygl-trees node timeline launch`。

想在同一棵树上试不同方案，用 `--context <名字>`：每个名字有一套独立的解锁状态，互不影响。

**做完检查：**
- `node validate` 无问题。
- 每个已解锁节点都有 `rel` 挂的证据：用 `rel list --src node:<key>` 查。
- `agent brief` 和 `node ready` 给出的下一步，和你心里想的一致。

**常见坑：**
- 连线方向写反。
- 改了结构不跑 `node index`：`can`、`ready`、`path` 会按旧索引回答。
- 「心里解锁」：事情做完了却不 `unlock`，下个会话还以为没做。
- 只有三个节点的「演示树」：拆不出真实的依赖，就问不出有用的下一步。分解方法见 [ygl-trees-tree-building](../skills/ygl-trees-tree-building/SKILL.md)。

深入：[ygl-trees-techtree](../skills/ygl-trees-techtree/SKILL.md)，什么时候该动树见 [ygl-trees-lifecycle](../skills/ygl-trees-lifecycle/SKILL.md)。

---

## 情景 4：语义门槛，让模型判「做到没有」

**什么时候用：** 节点的完成标准是一句判断，没有数字可比。比如「试点团队是否书面确认看板数据与财务月报一致」。不要硬凑成 `level >= 3`。

三种题型：

```bash
# 是非题：模型判断「是」的概率 P
ygl-trees node cond add goal --name signoff --op eval \
  --value "试点团队是否书面确认看板数据与财务月报一致？"

# 选择题：判断「期望答案」的概率
ygl-trees node cond add pilot --name feedback --op eval-choice \
  --value "试点反馈总体倾向？" --options "good=愿意继续用,meh=无所谓,bad=不想用" --answer good

# 打分题：判断等级，允许 ±1 的灰带
ygl-trees node cond add charts --name quality --op eval-score \
  --value "图表可读性评分" --levels "看不懂,勉强,可用,好用" --min-score 2

ygl-trees node can goal --eval      # 把节点的上下文和挂的证据交给决策模型判
```

**判定规则：**

| 模型给出的 P | 结果 |
|---|---|
| ≥ 0.7 | 通过 |
| ≤ 0.4 | 不通过 |
| 两者之间 | 待判定（pending），留给人决定 |

阈值可以用 `config set eval.pass_threshold`、`config set eval.fail_threshold` 调整。

**没配凭证会怎样：** 不会判失败，只会停在待判定：

```text
can unlock: goal
  … 待判定（决策模型 pending）
    - signoff (P=- · no evaluator configured (set config decision_model_llm_token, or AI_GATEWAY_API_KEY / ~/.vercel.ai-gateway.env))
```

配凭证用 `ygl-trees config set decision_model_llm_token <令牌>`，或设置环境变量 `AI_GATEWAY_API_KEY`。令牌是机密，不要贴进聊天、issue 或 kb。强制离线用 `YGL_EVAL_OFFLINE=1`。

**有截止日的门槛：** 问题文本里写上 `YYYY-MM-DD`，用 `ygl-trees node cond --due --days 7` 列出 7 天内到期的条件。加 `--eval` 会逐条送去判。

**要记住：模型判定 ≠ 仲裁。** 判过了，仍然要人 `node unlock`；断言仍然要人 `claim resolve`。

**常见坑：**
- 用 eval 门去判事实性的里程碑（「v2 发布了没有」）：这种事有确定答案，应该挂证据加人工解锁，不该让模型猜。
- 把 pending 当成失败：pending 是「证据不够，模型拿不准」。该补的是证据，不是去改门槛。

深入：[ygl-trees-eval-gates](../skills/ygl-trees-eval-gates/SKILL.md)。

---

## 情景 5：立预测，到期结算

**什么时候用：** 你对未来下了一个可证伪的判断，比如「两周内 kb 会到 3 条」「对方 90 天内会发 CRDT 版本」，想到期机器可读地知道准不准，并长期看自己的校准度。

### 5.1 登记

格式固定为 `[预测·N天] <截止日> 前 <可观测的判据>`。`--confidence` 写成 0–1 的概率，`--channel` 写这条预测属于哪个渠道：

```bash
ygl-trees research claim add "[预测·7天] 2026-11-14 前 kb≥3" --confidence 0.7 --channel internal
ygl-trees research claim add "[预测·3天] 2026-11-05 前 kb≥1" --confidence 0.9 --channel internal
ygl-trees research predict list
```

```text
  claim       deadline    days  outcome  p    brier  brier_calc  check  settler  channel
  559faf959a  2026-11-14  7     未结算   0.7                                     internal
  5c2433f583  2026-11-05  -2    未结算   0.9                                     internal
```

判据要写原话，不要转述。引擎能自动测量的判据有两类：

- `树≥N`、`kb≥N`；
- 用 `--state` 绑定过的 `key≥N`。

其他写法会标成「需人工」（manual）。

### 5.2 到期回测

```bash
ygl-trees research predict audit
```

```text
  claim       horizon  deadline    判据  实测    判定     days
  559faf959a  7天      2026-11-14  kb≥3  kb=2/3  pending  7
  5c2433f583  3天      2026-11-05  kb≥1  kb=2/1  hit      -2
  → research claim resolve 5c2433f583 --as supported   # 2026-11-05 已到
```

`audit` 只报告，不改任何状态。

### 5.3 结算

```bash
ygl-trees research claim resolve 5c2433f583 --as supported --note "到期实测 kb=2 ≥ 1"
```

`supported` 记为命中（outcome=1），`refuted` 记为未中（0），`contested` 记为无法判定（ND）。Brier 分数由引擎自动算（`brier_calc` 列），不用手算。

想把结算人和观测依据也记进账，就登记一条观测证据，在备注**末尾**写固定的三段式，再挂到预测上：

```bash
ygl-trees research source add --title "kb 计数快照 2026-11-05" --content "kb_notes=2 (ygl-trees db stats)"
ygl-trees research evidence add <来源ID> --quote "kb_notes=2" \
  --note "到期实测满足判据 outcome=1, brier=0.01, settler=alice"
ygl-trees research claim link 5c2433f583 <证据ID> --stance supports
ygl-trees research predict list --all
```

```text
  5c2433f583  2026-11-05  -2    1        0.9  0.01   0.01               alice    internal
```

### 5.4 看自己准不准

```bash
ygl-trees research predict score --all      # 每个渠道的命中率、平均 Brier
ygl-trees research claim calibration --all  # 模型评级和人工仲裁差多少
```

**常见坑：**
- 判据写得没法观测（「大概会火」）：到期没法判，只能记 ND。
- 预测断言挂上证据，不会自动变成 supported：这是故意的。挂证据不等于仲裁，结算必须显式 `resolve`。
- 想定期提醒自己去回测：用 `job` 定期跑 `research predict audit`（情景 10）。

---

## 情景 6：把经验沉淀成知识和技能

**什么时候用：** 这件事换个任务还用得上。比如踩坑教训、选型结论、做法清单。沉淀下来，下次 agent 接到类似任务时能自动想起来。

### 6.1 记笔记，确认搜得到

```bash
ygl-trees kb add --title "SQLite 单写者：何时该换 PG" \
  --body "判断要不要从 SQLite 换 PostgreSQL，先数同时写库的进程数。≤2 个写进程时单写者限制不是瓶颈；要多人并发写、跨机器访问或接 BI 工具时再考虑 PG。" \
  --tags "sqlite,postgresql,选型" --confidence B
ygl-trees kb search "换 PG"
```

```text
  ✓ note stored: 7ed785aa95  SQLite 单写者：何时该换 PG
  id          title                       tags                    conf  reuse  score
  7ed785aa95  SQLite 单写者：何时该换 PG  sqlite,postgresql,选型  B     0      -2.00
```

还有两种入库方式：

- 批量导入一个目录的 markdown：`kb import <目录>`（读 frontmatter，重复导入不会出重复）。
- 把生成的报告收进 kb：`kb ingest <报告ID>`。

中文检索按二字词切分，长句也能搜到。

### 6.2 提升为技能：要过一道门

技能会被 `agent match` 自动推荐，所以提升前要有真材实料。两个条件满足其一即可：

- 笔记 frontmatter 里的 `cue`（适用场景）、`lesson`（做法）、`evidence`（依据）三项都非空；
- 或者笔记用 `rel` 挂到了真实的 evidence 或 claim 上。

两个都不满足，就会被拒：

```text
  ✗ kb promote refused; missing: cue, lesson, evidence; no rel to real evidence/claim. …
```

先挂证据，再提升：

```bash
ygl-trees rel add kb:7ed785aa95 evidence:510505c933 --rel evidenced-by
ygl-trees kb promote 7ed785aa95 --name db-backend-choice
ygl-trees agent match "要不要把数据库换成 PostgreSQL"
```

```text
  ✓ promoted to skill: db-backend-choice

Best skill for: 要不要把数据库换成 PostgreSQL
  db-backend-choice
  判断要不要从 SQLite 换 PostgreSQL，先数同时写库的进程数。…
  load L2:  ygl-trees skill show db-backend-choice
```

技能分三层，按需展开：

| 层级 | 内容 | 什么时候看到 |
|---|---|---|
| L1 | 一句话描述 | `agent match` 给出 |
| L2 | 正文 | `skill show` 给出 |
| L3 | 参考资料 | 用 `skill refs add` 挂上 |

外部写好的 `SKILL.md` 可以直接 `skill import <file.md>`。

**做完检查：** 换个说法用 `agent match` 问一次，看能不能命中你的技能。

**常见坑：**
- 只存不搜：从没被检索过的笔记等于没记。`kb list` 的 `reuse` 列能看出谁被用过。
- 攒一大批再总结：细节早忘了。踩坑当轮就记。
- 为了过门往 frontmatter 里填占位文字：门只查非空，不查质量，但这样做骗的是你自己。

深入：[ygl-trees-knowledge](../skills/ygl-trees-knowledge/SKILL.md)。

---

## 情景 7：跟踪任务

**什么时候用：** 有具体的待办，要能分配、推进、取消，并且留下痕迹。只在对话里说「回头做」的事，下个会话就没了。

```bash
ygl-trees task add "写 ETL 失败重试" --owner alice --note "每日导数偶发超时"
ygl-trees task doing <任务ID>
ygl-trees task done <任务ID>
ygl-trees task cancel <任务ID> --reason "试点用不到 BI"   # 取消必须写原因
ygl-trees task reopen <任务ID>                          # 重开，回到 todo
ygl-trees task assign <任务ID> bob
ygl-trees task list --status doing
ygl-trees task stale                                    # doing 超 14 天、todo 超 30 天的任务
```

```text
  ✓ task 201a33eb7e: todo → doing
  ✓ task 201a33eb7e: doing → done
  ✗ task cancel needs <id> and --reason "<why>"          ← 不写原因，退出码 2
  ✓ task 6f264349dd: todo → cancelled (试点用不到 BI)
```

任务属于项目。在别的项目下操作它，会报找不到，并告诉你它属于哪个项目。按提示加 `-p` 就行：

```text
  ✗ task not found: 5e760136a7  (it belongs to project 'pg-choice' — use -p pg-choice)
```

把任务挂到它推进的树节点上，节点和任务就能互相找到：

```bash
ygl-trees rel add node:etl task:<任务ID> --rel tracked-by
ygl-trees rel list --src node:etl
```

**做完检查：** `doctor` 的 `task_hygiene` 一项会检查有没有过期任务、完成的任务有没有挂到别处。

---

## 情景 8：多个会话或 agent 共用一个工作区

**什么时候用：** 好几个 agent 会话（或你开的几个终端）同时读写同一个工作区。

**会话身份：** 每个会话用环境变量 `YGL_SESSION` 区分。`project use`、`tree use` 只对当前会话生效，不影响别人。

**没选项目时会被拒（这是保护，不是故障）：**

```bash
YGL_SESSION=other ygl-trees research claim list
```

```text
  ✗ ambiguous project: 2 projects in workspace; pass --project <name> or run ygl-trees project use <name>; projects: okr-2027, pg-choice
```

退出码是 2。解决办法有两种：

```bash
ygl-trees -p pg-choice research claim list      # 这条命令钉住项目（推荐给 agent）
ygl-trees project use pg-choice                 # 当前会话以后都用它
```

树也一样：`-t <树名>`（或 `--tree <树名>`）钉住，或者用 `tree use`。

**规则：**
- 给 agent 写的命令，写操作一律带 `-p`（项目）或 `-t`（树），不要依赖「当前选中」。别的会话可能刚改过它。
- 定时作业由 `job tick` 跑，每次运行会自动带上 `YGL_SESSION=<父会话>/<作业ID>`，并发的作业互不干扰。
- 事后对账用审计流：

```bash
ygl-trees agent log                         # 最近的事件
ygl-trees db timeline --session other       # 按会话过滤；--actor <谁> 按执行者过滤
```

- `agent brief` 会提示最近 10 分钟内是否有别的会话改了选择。
- `doctor` 的 `selection_hygiene` 一项，会在多个会话共用默认身份时报警。

**常见坑：** 多个裸终端都没设 `YGL_SESSION`，共用同一个默认身份，互相改掉对方的选择。

---

## 情景 9：把业务规范变成验证器

**什么时候用：** 有一条业务规则，要变成**谁都能重跑、能带走、结论不靠人点头**的检查。比如「订单金额不得为负」「上线前必须有回滚方案」。验证器给的结论附带证据：扫描了多少行、命中了哪几行。

**流程：**

1. **冻结材料（submit）**：把规则原文存档。
2. **构造判据（prepare）**：给每条规则写检查器，并附上三问自审。
3. **在数据快照上跑（run）**：得出结论。
4. **归档（archive）**：打成可带走的 zip，可以复核。

下面是一个能完整跑通的例子。

### 9.1 准备三份文件和一个数据快照

`material.md`（规则原文。每条以 `S1`、`S2` 这样的编号开头）：

```markdown
# 订单数据规范（示例）

S1 订单金额不得为负。

S2 快照里至少要有 1 笔已支付订单。
```

`candidates.json`（每条规则配一个检查器，只接受谓词 AST，不接受手写 SQL）：

```json
{
  "candidates": [
    {
      "source_clause": "S1 订单金额不得为负。",
      "anchor": { "quote": "S1 订单金额不得为负。", "locator": "material.md#S1" },
      "checker": {
        "type": "sql",
        "predicate": { "from": "orders", "select": ["id", "amount"], "where": { "col": "amount", "op": "<", "value": 0 } },
        "fail_when": "rows>0"
      }
    },
    {
      "source_clause": "S2 快照里至少要有 1 笔已支付订单。",
      "anchor": { "quote": "S2 快照里至少要有 1 笔已支付订单。", "locator": "material.md#S2" },
      "checker": {
        "type": "count",
        "predicate": { "from": "orders", "select": ["id"], "where": { "col": "status", "op": "=", "value": "paid" } },
        "op": ">=",
        "value": 1
      }
    }
  ]
}
```

`reviews.json`（每条规则回答三问：`faithful` 忠实于原文、`decidable` 可判定、`not-vacuous` 不会空转通过。`verdict` 只能是 `ok`、`reject`、`unclear`）：

```json
{
  "reviews": [
    {
      "source_clause": "S1 订单金额不得为负。",
      "findings": [
        { "question": "faithful", "verdict": "ok", "reason": "逐字复读条款，扫描 amount<0 的违规行", "anchor": { "quote": "S1 订单金额不得为负。", "locator": "material.md#S1" } },
        { "question": "decidable", "verdict": "ok", "reason": "谓词 AST 可在快照上判定" },
        { "question": "not-vacuous", "verdict": "ok", "reason": "空表时给 NEEDS-MATERIAL，不会空转通过" }
      ]
    },
    {
      "source_clause": "S2 快照里至少要有 1 笔已支付订单。",
      "findings": [
        { "question": "faithful", "verdict": "ok", "reason": "status=paid 计数 ≥1", "anchor": { "quote": "S2 快照里至少要有 1 笔已支付订单。", "locator": "material.md#S2" } },
        { "question": "decidable", "verdict": "ok", "reason": "count 可判定" },
        { "question": "not-vacuous", "verdict": "ok", "reason": "空库 0<1 → FAIL" }
      ]
    }
  ]
}
```

`orders.sqlite` 是被验数据的**快照副本**（不要直接拿生产库）。示例里有 3 笔订单，其中一笔金额是 -15。

### 9.2 四步跑通

```bash
ygl-trees verify lint-candidates candidates.json --text material.md --reviews reviews.json   # 先自查
ygl-trees verify submit --title "订单数据规范 v1" --text material.md
ygl-trees verify prepare mat_70a53407f925 --candidates candidates.json --reviews reviews.json \
  --db orders.sqlite --as-of 2026-11-07
ygl-trees verify run spec_f9ec865ed62d --db orders.sqlite
```

```text
  coverage: 2/2 clause(s) covered, 0 exempt
  ✓ candidates lint ok: 2 checked
  ✓ material frozen: mat_70a53407f925  (49 chars)
  ✓ prepared & frozen: spec_f9ec865ed62d v1  (2 unit(s), 1 round(s))
  FAIL  run_fac37d75e04b0b20
  pass 1 · fail 1 · needs-material 0 · error 0
    ✗ V1 FAIL  S1 订单金额不得为负。  (scanned 3 / matched 1)
    ✓ V2 PASS  S2 快照里至少要有 1 笔已支付订单。  (scanned 3 / matched 2)
  archive: …/verify/archives/yglverify-…-rfac37d75.yglverify.zip  (arc_27a07c03d2de)
```

**注意几点：**

- **结论是 FAIL，退出码仍然是 0。** 退出码只表示「程序有没有出错」，判定结果看报告。
- `prepare` 必须给 `--as-of`，表示这份快照描述的是哪个时刻。这样同一份材料，换时间、换机器重做，冻结出来的都是同一个 spec。只是试跑时，用 `--draft` 不冻结。
- **同一材料第二次 `prepare` 成功会替换当前版本**（输出 `replaces spec_… vN`、JSON 带 `replaced`）：旧版的 spec/trace/prepare 三件**逐字节保留**在 `specs/<id>/versions/v<N>/`，`verify run/trace <id> --spec-version N` 可以读取旧版（#242）；归档按报告的版本取文件，不会拿新版判据解释旧结论。
- `run` 默认会打一个确定性的 zip 归档：同一次运行，两次归档逐字节相同。

### 9.3 看报告、复核归档

```bash
ygl-trees verify report run_fac37d75e04b0b20          # 加 --json 给机器读
ygl-trees verify archive verify <归档.zip>             # 重算整条哈希链
ygl-trees --json verify list                           # 全部 spec 和 run 概览
```

```text
  ✓ archive verified: arc_27a07c03d2de  (5 item(s), contract 1.2)
```

### 9.4 一直对，才算对：毕业成常驻检查

同一个 spec 版本连续 3 次 PASS，并且时间跨度满 30 天，就可以毕业成定时检查：

```bash
ygl-trees verify graduate spec_f9ec865ed62d                       # 只看够不够格
ygl-trees verify graduate spec_f9ec865ed62d --every 1440 --schedule --db <常驻快照路径>
```

**检查器选型（七种）：**

| 类型 | 用途 |
|---|---|
| `sql` | 扫描违规行，配 `fail_when: "rows>0"` |
| `count` | 数量门槛，如至少 N 行 |
| `exists` | 有没有 |
| `sql-pair` | 两表按键对账 |
| `file` | 附件文件检查 |
| `command` | 白名单里的命令，看退出码和输出 |
| `agent` | 语义自审，需要模型凭证，没有凭证判 ERROR |

完整说明见 `ygl-trees verify example --checker <类型>`。

**常见坑：**
- 「不得存在违规」用 `count == 0` 表达：空库也会通过，会被红队检查拒掉。正确写法是 `sql` 加 `fail_when: "rows>0"`。
- 自审文件里的 `source_clause` 和候选里的差一个空格：会报自审不完整。必须逐字节相同。
- 拿生产库直接跑：一律用快照副本。引擎本身也只用只读方式打开。
- 验证工作区越跑越大：`verify prune` 先试跑看清单，确认后加 `--apply` 清理。

深入：[ygl-trees-verify](../skills/ygl-trees-verify/SKILL.md)、[docs/spec-validator.md](spec-validator.md)。

---

## 情景 10：定期自动跑：作业与巡检

### 10.1 job：定期执行一条命令

**什么时候用：** 有命令要定时跑，比如每天出报告、每周回测预测、每天清理验证工作区。

```bash
ygl-trees job add "每日报告" --every 1440 -- "ygl-trees -p pg-choice produce report"
ygl-trees job add "一次性备份" --manual -- "ygl-trees db export backup.sql"
ygl-trees job list
ygl-trees job run "一次性备份"
ygl-trees job logs
```

```text
  ✓ job registered: ebb74aec83  每日报告
  command:  ygl-trees -p pg-choice produce report
  schedule: every 1440 min
  ✓ 一次性备份  ok  7ms
```

**规则：**

- **必须给调度方式**，三选一：`--every <分钟>`、`--at "YYYY-MM-DD HH:MM"`、`--manual`。
- **低于 60 分钟要显式声明**，否则会被拒（退出码 2）：

```text
  ✗ --every 5 is below job.min_every_minutes (60); pass --allow-frequent if this cadence is intended
```

- **作业要靠系统 cron 驱动。** 让 cron 每分钟调一次 `job tick`，它只跑到期的作业；重复执行和并发执行都安全：

```bash
# crontab -e
* * * * * YGL_HOME=$HOME/.ygl-trees ygl-trees job tick
```

- **连续失败 3 次会自动挂起**，用 `job enable <id>` 恢复。
- **作业要换新版本**时，用 `--replaces <旧作业>`；不再需要的作业用 `job retire <id> --reason "…"`（历史记录保留）。
- **作业的命令里要带 `-p` 或 `-t`**，不要依赖「当前选中」。

### 10.2 patrol：边界断言，加处置队列

**什么时候用：** 有一条规则要一直成立，比如「已证实的断言必须挂证据」「金额不得为负」。违反时要进一个待处理队列，处理完能留下记录。

```bash
ygl-trees patrol add claim-without-evidence --severity S1 --desc "已证实的断言必须挂证据" \
  --sql "SELECT c.id, c.text FROM claims c WHERE c.status='supported' AND NOT EXISTS (SELECT 1 FROM claim_evidence ce WHERE ce.claim_id=c.id)"
ygl-trees patrol run
```

```text
  claim-without-evidence  [S1]  violations: 1  (new 1 · reopened 0 · auto-fixed 0)
  ⚠ open findings: 1 — patrol findings (disposition: patrol ack|fp|fix <id>)
```

SQL 查出的每一行就是一条发现（finding）。处置方式三选一：

| 命令 | 含义 |
|---|---|
| `patrol ack <id>` | 知道了，暂不处理 |
| `patrol fp <id>` | 误报，加进放行名单 |
| `patrol fix <id> --note "…"` | 已修复 |

```bash
ygl-trees --json patrol findings --status open
ygl-trees patrol fix <发现ID> --note "已撤回仲裁，等实测"
ygl-trees patrol run
```

```text
  ✓ 8c1c163ce1 → fixed  · 已撤回仲裁，等实测
  claim-without-evidence  [S1]  violations: 0  (new 0 · reopened 0 · auto-fixed 0)
  ✓ all clear — open findings: 0
```

> 已知问题（0.121.0 仍有，下一版修复）：`patrol list`、`patrol findings`、`verify list` 的人类表格把数据行打成了空行。请暂时加 `--json` 查看。

要定期巡检，就把 `patrol run` 登记成 job。

**job 和 patrol 怎么选：**

| 你要的 | 选哪个 |
|---|---|
| 执行一件事 | job |
| 检查一条规则，并管理违规清单 | patrol |
| 检查要能带走、复核、验签 | verify（情景 9） |

深入：[ygl-trees-ops-patterns](../skills/ygl-trees-ops-patterns/SKILL.md)。

---

## 情景 11：让 agent 通过 MCP 使用

**什么时候用：** 让 Claude Code、Claude Desktop 或其他支持 MCP 的 agent 直接调用 ygl-trees，而不是自己拼命令行。

`ygl-trees mcp` 启动一个 stdio MCP 服务，提供 4 个工具：

| 工具 | 做什么 |
|---|---|
| `read` | 读：`domain` 选领域，`action` 选动作，例如 `{domain:"agent", action:"brief"}` |
| `write` | 写：动作是封闭清单，管理类操作不在里面；同样内容重写返回已有行 |
| `verify` | 验证器相关 |
| `doctor` | 体检 |

MCP 客户端配置示例（各客户端的键名以它自己的文档为准，语义如下）：

```json
{
  "mcpServers": {
    "ygl-trees": {
      "command": "ygl-trees",
      "args": ["mcp"],
      "env": { "YGL_HOME": "/path/to/your/workspace", "YGL_SESSION": "claude-main" }
    }
  }
}
```

- **每个 agent 用自己的 `YGL_SESSION`**，理由见情景 8。
- **出错时** MCP 返回 `isError:true`，正文是 `{rc, error}`，退出码的语义和命令行一致。
- **CLI 和 MCP 的对应关系**，各技能文件里都有「MCP 等价面」表，例如 `node add <key>` 对应 `write {domain:"tree", action:"node-add", key:"…"}`。
- **在 DSH 里接入**，见 [docs/mcp-dsh-connector.md](mcp-dsh-connector.md)。

---

## 情景 12：把成果给人看

| 想要 | 命令 |
|---|---|
| 一份带引用的研究报告 | `produce report`，然后 `produce export <ID> report.md` |
| 需求说明或设计记录 | `produce spec <标题> --body …`、`produce design <标题> --design-type ui-ux\|arch\|decision --body …`（写法见 [ygl-trees-design-capture](../skills/ygl-trees-design-capture/SKILL.md)） |
| 交互式网页：树视图、时间轴、报告 | `ygl-trees webui serve --port 8642`，打开 http://127.0.0.1:8642/ ，按 Ctrl+C 停止 |
| 网页数据的离线快照 | `webui export --out snapshot.json` |
| 导成 Obsidian 笔记库 | `db obsidian <目录>` |
| 工作区每天长了什么 | `db timeline` |
| 一棵树的成长过程 | `node timeline <树名>` |
| 临时查一个数 | `db sql "SELECT status, count(*) AS n FROM claims GROUP BY status"` |

`db sql` 能执行任何语句，包括会改数据的。查询之外的用法要格外小心。

---

## 情景 13：体检、备份、恢复

### 13.1 体检

```bash
ygl-trees doctor          # 十几项检查，具体数目随版本和工作区里的内容变化
ygl-trees doctor --fix    # 自动做安全修复：脏索引、死进程留下的锁、幻影写入对账
```

```text
Doctor — 16 pass · 2 warn · 0 fail
  ✓ schema_version: v13 (latest)
  ✓ index_freshness: all tree indexes clean
  ✓ selection_hygiene: selection resolves via session
  ✓ patrol_queue: all clear across 1 check(s)
  ! job_health: 2 job(s): 1 never ran: 每日报告; …
  …
```

`warn` 不一定是故障。上面这个例子只是新登记的作业还没跑过。每条警告后面都给了处理办法。

**数据库被锁住**（报错里会回显持有锁的那条命令）：用 `ygl-trees db unlock`。持有者进程已经死了就直接清；还活着就拒绝，并告诉你是谁。

### 13.2 备份和恢复

```bash
ygl-trees db export backup.sql             # 全部数据表；--lean 跳过可重建的派生表
sqlite3 restored.db < backup.sql           # 恢复成一个新库
ygl-trees --db restored.db doctor          # 检查恢复出来的库
```

**什么时候一定要先备份：**

- 批量 `node import --merge`；
- 大批改写节点；
- 跑会改数据的 `db sql`；
- 升级大版本之前。

### 13.3 PostgreSQL

默认、也推荐用 SQLite。需要接 BI 工具或团队 SQL 分析时，有两种做法：

```bash
YGL_PG_URL=postgres://… ygl-trees db sync pg      # 单向全量镜像，可以反复刷新；SQLite 仍是主库
YGL_PG_URL=postgres://… ygl-trees db migrate pg   # 一次性完整迁移，迁完让 PG 独立持有
```

两边永远不会同时写。连接串放在环境变量里，不要写进命令历史。详见 [docs/pg-compat.md](pg-compat.md)。

---

## 一轮工作的节奏

| 时机 | 做什么 |
|---|---|
| 开工 | `agent brief`。它给了 next actions，就照着做 |
| 改了树结构 | 同一轮就跑 `node index && node validate`，不要留到下一轮 |
| 解锁节点、仲裁断言 | 同一轮用 `rel` 挂上依据 |
| 得出可复用的结论 | `kb add`。和树相关的，用 `rel` 挂上 |
| 收工 | `doctor`，按提示修。结构动过的，再跑一次 `node index` |
| 大改之前 | `db export` 备份 |
| 很久没碰这个工作区 | 先 `agent brief` 加 `doctor` 对一遍账，再决定要不要动 |

每次动手前问五个问题：

1. 换一个会话，这个状态还成立吗？只有写进库的才成立，所以要落库。
2. 这条边或条件，是必检还是可选？答不上来就先别建。
3. 这个节点有依据吗？没有，就先当成假设，不要解锁。
4. 改完以后，索引还干净吗？不确定就跑 `node index && node validate`。
5. 这件事是「我在想」，还是「已经发生了」？前者写进 `--note`，后者才 `unlock`、`resolve` 或 `done`。

详见 [ygl-trees-lifecycle](../skills/ygl-trees-lifecycle/SKILL.md)。

---

## 常见报错速查

| 看到的报错 | 原因 | 怎么办 |
|---|---|---|
| `ambiguous project: 2 projects in workspace` | 当前会话没选项目 | 命令加 `-p <项目>`，或 `project use <项目>` |
| `query not found: 1` | ID 不是序号 | 用输出里的 10 位十六进制 ID |
| `quote does not occur in stored source content` | 摘录和来源原文对不上 | 改成原文；确实是转述就加 `--unverified` |
| `kb promote refused; missing: cue, lesson, evidence` | 笔记没有依据 | 用 `rel` 挂到真实证据，或补齐 frontmatter |
| `task cancel needs <id> and --reason` | 取消没写原因 | 加 `--reason "…"` |
| `--every 5 is below job.min_every_minutes (60)` | 作业太频繁 | 确实需要就加 `--allow-frequent` |
| `as_of is required` | prepare 没给时间点 | 加 `--as-of <ISO 日期>`，试跑用 `--draft` |
| `no evaluator configured` | 决策模型没配凭证 | `config set decision_model_llm_token …`；不配就停在待判定 |
| `node ready` 把最终目标列为可做 | 连线方向反了 | `node link <前置> <后续>`，前置写在前面 |
| 节点没满足前置却显示已解锁 | `unlock` 只是打标记 | 解锁前先 `node can` |
| 表格只有表头、数据行是空的 | 已知的显示缺陷 | 加 `--json` |
| 用 `task cancel`、`reopen`、`assign`、`stale` 时只回 `usage: task add …` | 装的是 0.120.0 或更早，还没有这些命令 | 升级到 0.121.0，或见 1.1 节末尾的差异表 |
| `unknown verify action: prune`、`unknown job action: retire` | 同上 | 同上 |
| 退出码 2，提示用法 | 少参数或参数非法 | 看提示，或 `ygl-trees --help` |

---

## 深入阅读

| 想深入的方向 | 去读 |
|---|---|
| 按用途的抽象走法目录（六场景、三种树） | [docs/scenarios.md](scenarios.md) |
| 冷启动、退出码、备份、调度 | [ygl-trees-quickstart](../skills/ygl-trees-quickstart/SKILL.md) |
| 研究流程 | [ygl-trees-research](../skills/ygl-trees-research/SKILL.md) |
| 知识与技能 | [ygl-trees-knowledge](../skills/ygl-trees-knowledge/SKILL.md) |
| 科技树命令 | [ygl-trees-techtree](../skills/ygl-trees-techtree/SKILL.md) |
| 怎么拆树 | [ygl-trees-tree-building](../skills/ygl-trees-tree-building/SKILL.md) |
| 什么时候该动数据 | [ygl-trees-lifecycle](../skills/ygl-trees-lifecycle/SKILL.md) |
| 关联：什么时候挂什么 | [ygl-trees-relating](../skills/ygl-trees-relating/SKILL.md) |
| 语义门槛 | [ygl-trees-eval-gates](../skills/ygl-trees-eval-gates/SKILL.md) |
| 设计记录 | [ygl-trees-design-capture](../skills/ygl-trees-design-capture/SKILL.md) |
| 验证器 | [ygl-trees-verify](../skills/ygl-trees-verify/SKILL.md) |
| 自动运维 | [ygl-trees-ops-patterns](../skills/ygl-trees-ops-patterns/SKILL.md) |
| 开源项目研究 | [ygl-trees-repo-research](../skills/ygl-trees-repo-research/SKILL.md) |
| 写插件扩展命令 | [docs/plugin-authoring.md](plugin-authoring.md) |
| 研究结论怎么交给执行系统 | [docs/graduation-protocol.md](graduation-protocol.md) |
