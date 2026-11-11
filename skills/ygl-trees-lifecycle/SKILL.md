---
name: ygl-trees-lifecycle
description: >-
  ygl-trees 更新时机与维护节奏（何时动数据，而非怎么动）：事件→动作触发表——树侧（何时
  node unlock / add / link / cond / index）、研究资产侧（何时 source / evidence / claim /
  resolve / kb / promote / task / produce / rel）；节奏纪律（加删节点/删边/改条件后 index+validate、
  解锁后必挂证据、会话收口前必 brief+doctor、周期性 export 备份）；该不该动的判定口诀；
  漂移反模式。机制细节见各专职技能，本技能只回答「什么时候」。
  触发词：更新时机、什么时候更新、何时解锁、何时该动、何时挂、维护、节奏、cadence、
  keep in sync、同步、漂移、stale、脏索引、收口、会话结束、下次做什么、lifecycle。
  事件触发（#233）：刚 unlock、刚解锁、刚 link、刚加节点、刚删节点、导入后、node import、
  会话开始、会话结束、next_actions、node_evidence、没挂证据。
version: 0.118.0
tags: ygl-trees,lifecycle,cadence,maintenance,timing
---

# ygl-trees 更新时机与维护节奏

专职技能回答「**怎么动**」（命令机制）与「**动成什么样**」（方法论）。本技能只回答
「**什么时候动**」——这是 agent 用这套工具时最容易漏的一层：机制全会，却在该动的时刻不动，
于是树和研究变成两条各自漂移的流水线。

## 0. 核心判据：什么时候必须动

三条铁律，任何一条成立就必须落库（不是"记在心里"）：

1. **状态变了** → 落库。能力达成、判断成形、任务推进、结构改变，都必须在**同一轮工作内**写下去；
   下一轮会话只读得到库里的东西，脑内状态等于不存在。
2. **结构变了** → 同轮收干净索引。闭包（`node_closure`）每次写入都在同一事务里重算，`can/ready/path`
   不会读到旧闭包；但 `node add`、`node unlink`、`node rm`、`node move`、`node cond add/rm` 会把
   **派生索引**（拓扑序/tier）标脏——`doctor` 报 `index_freshness` warn、`ready` 退回无序扫描。
   `node link` 会顺带重建索引，`node unlock/lock` 不碰索引。改完跑 `node index && node validate`
   （`node validate` 本身也会重建索引）；以 `tree list` 的 dirty 列为准。
3. **写了判断** → 同轮挂证据。`node`/`claim`/`design` 出来后，`rel` 把依据挂上；没有证据的节点是待验证假设，
   不是结论。

## 1. 事件 → 动作触发表（树侧）

| 触发事件 | 立刻做 | 别做 |
|---|---|---|
| 一个里程碑/能力**真正达成**（有可指认的证据） | `node unlock <key>` + `rel add node:<key> evidence:<id> --rel evidenced-by`（不带 `--rel` 会落成弱关联 `related`）。节点背后什么都没有时，unlock 回执的 `next_actions` 会点名这一步 | 只在心里认为"算做到了"，不 unlock |
| **导入**了一棵整体模型（`node import`；从 `db export` 的备份整库恢复同理） | `node import` 看回执里的 `unlocked_without_evidence`；整库恢复之后跑 `doctor`，看 `node_evidence`。找得到依据，就同轮 `rel add node:<key> source:<id> --rel evidenced-by`；找不到，就 `node lock <key>` 回到未解锁，等有证据再 unlock。确实要保留解锁态，就 `kb add` 一条「未核实模型」说明，并挂到根节点 | 把导入带来的解锁态当成已经验证过的事实 |
| 发现领域里还有**未建模的子能力** | `node add <child>` + `node link <parent> <child>`（先判定必检 or `--optional`） | 用 payload/备注描述层级关系（关系必须进 `node_edges`） |
| 发现两条路线**互斥** | `node link a b --rel excludes --mode NOT`（或同父 XOR） | 靠文档写"这两个不能同时选" |
| 出现**语义门槛**（"做到 X 才算过"，无客观阈值） | `node cond add <key> --name <cond> --op eval --value "<判定问题>"`（判据题型见 eval-gates 技能）；加完同轮 `node index`（改条件会标脏索引） | 把主观判断硬凑成 `kind=level --value 3` |
| 依赖**方向变了**（a→b 改成 b→a） | 先 `node unlink a b [--rel <rel>]` → 再 `node link b a` → `node index && node validate`，三步在同一轮内做完 | 先加反向新边（写入时环守卫直接拒绝：`cycle rejected`，rc=1）；或拆在两轮会话之间（中间态树上没有这条依赖） |
| 同一能力被**重新拆解** | 新节点先建、挂到父，再 `node unlink`/`node rm` 下线旧结构，最后 `node index && node validate` | 先删后建（树上出现空洞，后续会话看到断裂） |
| 重复 `node link` 同一 (父,子,rel) | 幂等：原地更新并回执 `duplicate: true`（rc=0），**改 `--mode/--optional` 重连即改属性** | 以为重复 link 会新建边而反复确认（不会） |
| 同一 (父,子) 间有多种 rel | `node unlink <p> <c>` 默认只删 `prereq`；其它关系要 `--rel <rel>` 指名 | 以为一次 unlink 清掉了所有关系 |
| 改了 tier/cost/kind 等**定义**、或 `node unlock/lock` | 不标脏索引，无需重建 | 把定义改动误当结构改动而反复 index（无害但浪费） |
| **解锁判定被质疑** | `node can <key> --state ...` 复算，看 `missing_required` / `blocked_by` / `cost_multiplier` | 凭印象回答"应该能解锁了" |

## 2. 事件 → 动作触发表（研究资产侧）

| 触发事件 | 立刻做 |
|---|---|
| 开始一个新研究问题 | `project new <name> -q "<question>"`（选定）；拆出的检索式 `research query add "<text>"` |
| 找到外部依据（网页/文档/记录） | `research source add --url <url> --title "<t>"`；由检索式找回的额外 `research query attach <qid> <sid>` |
| 从原文里看到**关键句** | `research evidence add <sid> --quote "..."`（**quote 必须是原文**，`--note` 放你的解读） |
| 形成**一个可被反驳的判断** | `research claim add "<text>"` + `research claim link <cid> <eid> [--stance supports|refutes]` |
| 判断**稳定下来**（支持/反对够了） | `research claim resolve <cid> --as supported|refuted|contested`（人工仲裁，模型不代替） |
| 需要**可交付结论** | `produce outline` → `section` → `report`（或 `export` 落盘） |
| 需要**固化需求/设计** | `produce spec`；设计用 `produce design --design-type ui-ux|arch|decision` |
| 出现**可复用知识**（换任务还有用） | `kb add` / `kb ingest <artifactId>`；成模式再 `kb promote <noteId> --name <skill>` 成 skill |
| 出现**行动项** | `task add "<title>" --owner <谁>` → `task doing <id>` → `task done <id>`（不建 task 的"待办"只活在本轮上下文；负责人进字段，不写进标题） |
| 任务**做完了** | `task done <id>` 同轮 `rel add task:<id> <产出/证据>`——done 却没有任何关联，doctor `task_hygiene` 会点名 |
| 一件事**不做了**（换方案、被取代、放弃） | `task cancel <id> --reason "<为什么>"`——不要硬标 done，也不要留在 todo 挂账；要捡回来用 `task reopen <id>` |
| 任务**换人** | `task assign <id> <owner>` |
| 资产与树节点**有关系了** | `rel add node:<key> <type>:<ref> --rel <词>`（词汇表与"何时挂"决策树见 relating 技能） |

## 2b. 事件 → 动作触发表（作业 job，#220）

| 触发事件 | 立刻做 |
|---|---|
| 新增周期作业 | `job add <title> --every <min> -- <cmd>`；确实没有调度就显式 `--manual`；每小时以内要 `--allow-frequent`（默认下限 60 分钟） |
| 作业**升级**（换命令、换版本） | `job add <新> --every <min> --replaces <旧> -- <cmd>`：同一步退役旧的（同族新登记不带 `--replaces` 会被拒，确实要并存才用 `--force`） |
| doctor `job_health` 报 failing / suspended | `job show <id>` 看 `last_error` → 修命令后 `job enable <id>` 重新上岗，或 `job retire <id> --reason …`；tick 连续失败 3 次会自动暂停（suspended），别让它一直红着 |
| 一次性作业 | `--at "YYYY-MM-DD HH:MM"`；跑完自动 done + 停用，无需手动收 |
| 运行记录堆积 | `job prune-runs --keep 50` 先看清单（默认只列不删），确认后加 `--apply` |

## 3. 节奏纪律（cadence）

| 时机 | 必做 |
|---|---|
| **每轮会话开场** | `agent brief`（我在哪、有什么、下一步）→ 有 `next_actions` 就照做 |
| **每轮会话收口前** | `doctor`（含 `node_evidence` / `task_hygiene` / `job_health`）；有脏索引、重复、孤儿、没挂证据的解锁节点，按它的提示修（`doctor --fix` 可安全修脏索引） |
| **每周**（或巡检时） | `task stale --all`：停滞的 doing（默认 ≥14 天）推进或取消，挂账的 todo（≥30 天）认领或取消；`job list` 里 failing / overdue / manual 逐条有处置 |
| **加删节点/删边/改条件后**（同一轮内） | `node index` + `node validate`——别把脏索引留给下一轮 |
| **解锁任何节点后** | 同轮 `rel` 挂依据；否则验尸时无法回答"凭什么解锁" |
| **claim 状态变化后** | 建议 `produce report` 重生成（报告是状态的投影，不是手写副本） |
| **一轮工作有结论** | `kb add` 沉淀；结论若与树相关，`rel` 双向挂上 |
| **长时间未动（跨多轮）** | `agent brief` + `doctor` 先对账，再决定动不动树（避免基于过期认知改结构） |
| **周期性**（可选） | `job add ... --every <min>` + `job tick`（cron 驱动）；`db export <file.sql>` 做完整备份 |
| **结构性风险动作前**（`node import --merge`、大批节点改写、`db sql` 手改） | 先 `db export <file.sql>` 备份（恢复：`sqlite3 new.db < file.sql`）——`node import --merge` 按 (tree,key) 覆盖已有节点 |

### 会话边界钩子（#233）

「开场 brief、收口 doctor」靠 agent 自己记，最容易漏。可以交给宿主的钩子去做。Claude Code 的写法（`.claude/settings.json`）：

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "ygl-trees agent brief" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "ygl-trees doctor --json > \"$HOME/.ygl-doctor-last.json\" 2>&1 || true" }] }]
  }
}
```

- SessionStart 的输出会进入会话上下文，`next_actions` 一开场就能看到，包括没挂证据的解锁节点和脏索引。
- SessionEnd 的输出 agent 看不到，所以落盘留档。下次开场的 brief 会再点名还没处理的项。
- 别的宿主照同样的两个时刻挂钩子。DSH 用它自己的会话事件。

## 4. 该不该动：五个自问

1. **这个状态换一个会话还成立吗？** 只有库里写着的成立 → 要落库。
2. **这条边/条件是必检还是可选？** 答不出就别建——必检会阻塞解锁，可选只影响提示与折扣，语义不同。
3. **这个节点有依据吗？** 没有就先补 `rel` 或把它降级为假设（不 unlock）。
4. **改完索引还干净吗？** 不确定就跑 `node index && node validate`（或看 `tree list` 的 dirty 列）。
5. **这属于"我在想"还是"已发生"？** 前者写 `--note`/`payload`，后者才 `unlock`/`resolve`/`done`。

## 5. 反模式（漂移的七种长相）

1. **心内解锁**：能力做完了但不 `node unlock`，下次会话看树仍以为没做到 → 重复劳动或误判前置。
2. **裸节点**：`node add` 后从不挂 `evidence`/`claim` → 树退化成一厢情愿的愿望清单。
3. **结构改了不收尾**：`add/unlink/rm/cond` 后不跑 `node index` → 拓扑序/tier 过期、`ready` 退回无序扫描、
   `doctor` 长期挂 `index_freshness` warn，真正的新告警被淹没。（判定本身不受影响：闭包每次写入都重算。）
4. **先删后建**：重构节点时不保留中间态 → 树出现断裂空洞，漂移期内的判断无法回溯。
5. **状态在正文里**：把"已完成/已验证"写进 `--note` 而不是 `unlock`/`resolve` → 机器读不到，投影（报告/仪表盘）全失真。
6. **研究资产不挂树**：evidence/claim/kb 散落在研究侧，树侧只有节点名 → 两条流水线各自演进，`rel` 就是为了防这个。
7. **只开不关**：task 只增不收（doing 停一个月、todo 挂账、放弃的任务假装 done）；job 只加不退（升级一次多一份、失败了没人看）→ doctor 看起来全绿，清单却早已失真。用 `task cancel` / `job retire` 收口，`task stale` / `job_health` 盯住。

## 6. 与专职技能的分工

| 要回答的问题 | 去哪 |
|---|---|
| 什么时候动（本技能） | 这里——触发表 §1/§2、节奏 §3、判定 §4、反模式 §5 |
| 命令怎么用 | `ygl-trees-techtree`（树机制）、`ygl-trees-research`（研究管线）、`ygl-trees-knowledge`（kb/skill） |
| 树该长成什么样 | `ygl-trees-tree-building`（分解法、tier 语义、≥30 节点自检） |
| 该挂什么关系 | `ygl-trees-relating`（rel 词汇表 + 何时挂决策树） |
| 语义门槛怎么判 | `ygl-trees-eval-gates`（三题型、灰带、离线安全） |
| 设计怎么沉淀 | `ygl-trees-design-capture`（DESIGN.md / ADR） |
| 全局契约与入口 | `ygl-trees-quickstart` |
