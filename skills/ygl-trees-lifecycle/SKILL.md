---
name: ygl-trees-lifecycle
description: >-
  ygl-trees 更新时机与维护节奏（何时动数据，而非怎么动）：事件→动作触发表——树侧（何时
  node unlock / add / link / cond / index）、研究资产侧（何时 source / evidence / claim /
  resolve / kb / promote / task / produce / rel）；节奏纪律（改结构后必 index+validate、
  解锁后必挂证据、会话收口前必 brief+doctor、周期性 export 备份）；该不该动的判定口诀；
  漂移反模式。机制细节见各专职技能，本技能只回答「什么时候」。
  触发词：更新时机、什么时候更新、何时解锁、何时该动、何时挂、维护、节奏、cadence、
  keep in sync、同步、漂移、stale、脏索引、收口、会话结束、下次做什么、lifecycle。
version: 0.115.1
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
2. **结构变了** → 立刻重建索引。任何 `node add/link/rm` 之后：`node index`（闭包+拓扑）+ `node validate`（环/悬空/脏索引）。
3. **写了判断** → 同轮挂证据。`node`/`claim`/`design` 出来后，`rel` 把依据挂上；没有证据的节点是待验证假设，
   不是结论。

## 1. 事件 → 动作触发表（树侧）

| 触发事件 | 立刻做 | 别做 |
|---|---|---|
| 一个里程碑/能力**真正达成**（有可指认的证据） | `node unlock <key>` + `rel add node:<key> evidence:<id>` | 只在心里认为"算做到了"，不 unlock |
| 发现领域里还有**未建模的子能力** | `node add <child>` + `node link <parent> <child>`（先判定必检 or `--optional`） | 用 payload/备注描述层级关系（关系必须进 `node_edges`） |
| 发现两条路线**互斥** | `node link a b --rel excludes --mode NOT`（或同父 XOR） | 靠文档写"这两个不能同时选" |
| 出现**语义门槛**（"做到 X 才算过"，无客观阈值） | `node cond add <key> --name <cond> --op eval --value "<判定问题>"`（判据题型见 eval-gates 技能） | 把主观判断硬凑成 `kind=level --value 3` |
| 依赖**方向变了** | 先加新边 → `node index` → `node validate` → 再 `node unlink <parent> <child>`；**两次索引之间不要跨会话** | 直接删旧边（中间态可能成环，validate 会拦但状态已脏） |
| 同一能力被**重新拆解** | 新节点先建、挂到父、`node index` 通过后再 `node unlink` 下线旧边 | 先删后建（树上出现空洞，后续会话看到断裂） |
| 重复 `node link` 同一 (父,子,rel) | 幂等：原地更新并回执 `duplicate: true`（rc=0），**改 `--mode/--optional` 重连即改属性** | 以为重复 link 会新建边而反复确认（不会） |
| 改了 tier/cost/kind 等**定义** | 一般无需重建索引；改的是 `node_state` 才需要留意 | 把定义改动误当结构改动而反复 index（无害但浪费） |
| **解锁判定被质疑** | `node can <key> --state ...` 复算，看 `missing_required` / `blocked_by` / `cost_multiplier` | 凭印象回答"应该能解锁了" |

## 2. 事件 → 动作触发表（研究资产侧）

| 触发事件 | 立刻做 |
|---|---|
| 开始一个新研究问题 | `project new <name> -q "<question>"`（选定）；拆出的检索式 `research query add "<text>"` |
| 找到外部依据（网页/文档/记录） | `source add`（`--url`/`--title`）；由检索式找回的额外 `query attach <qid> <sid>` |
| 从原文里看到**关键句** | `evidence add <sid> --quote "..."`（**quote 必须是原文**，`--note` 放你的解读） |
| 形成**一个可被反驳的判断** | `claim add "<text>"` + `claim link <cid> <eid> [--stance supports|refutes]` |
| 判断**稳定下来**（支持/反对够了） | `claim resolve <cid> --as supported|refuted|contested`（人工仲裁，模型不代替） |
| 需要**可交付结论** | `produce outline` → `section` → `report`（或 `export` 落盘） |
| 需要**固化需求/设计** | `produce spec`；设计用 `produce design --design-type ui-ux|arch|decision` |
| 出现**可复用知识**（换任务还有用） | `kb add` / `kb ingest <artifactId>`；成模式再 `promote <note>` 成 skill |
| 出现**行动项** | `task add "<title>"` → `task doing <id>` → `task done <id>`（不建 task 的"待办"只活在本轮上下文） |
| 资产与树节点**有关系了** | `rel add node:<key> <type>:<ref> --rel <词>`（词汇表与"何时挂"决策树见 relating 技能） |

## 3. 节奏纪律（cadence）

| 时机 | 必做 |
|---|---|
| **每轮会话开场** | `agent brief`（我在哪、有什么、下一步）→ 有 `next_actions` 就照做 |
| **每轮会话收口前** | `doctor`（9 项）；有脏索引/重复/孤儿按其提示修；`node index` 若结构动过 |
| **改树结构后**（同一轮内） | `node index` + `node validate`——**绝不留到下一轮** |
| **解锁任何节点后** | 同轮 `rel` 挂依据；否则验尸时无法回答"凭什么解锁" |
| **claim 状态变化后** | 建议 `produce report` 重生成（报告是状态的投影，不是手写副本） |
| **一轮工作有结论** | `kb add` 沉淀；结论若与树相关，`rel` 双向挂上 |
| **长时间未动（跨多轮）** | `agent brief` + `doctor` 先对账，再决定动不动树（避免基于过期认知改结构） |
| **周期性**（可选） | `job add ... --every <min>` + `job tick`（cron 驱动）；`db export <file.sql>` 做完整备份 |
| **结构性风险动作前**（批量 import、大批节点改写） | 先 `db export` 备份——`db import` 的替换语义会整表重写 |

## 4. 该不该动：五个自问

1. **这个状态换一个会话还成立吗？** 只有库里写着的成立 → 要落库。
2. **这条边/条件是必检还是可选？** 答不出就别建——必检会阻塞解锁，可选只影响提示与折扣，语义不同。
3. **这个节点有依据吗？** 没有就先补 `rel` 或把它降级为假设（不 unlock）。
4. **改完索引还干净吗？** 不确定就跑 `node index && node validate`。
5. **这属于"我在想"还是"已发生"？** 前者写 `--note`/`payload`，后者才 `unlock`/`resolve`/`done`。

## 5. 反模式（漂移的六种长相）

1. **心内解锁**：能力做完了但不 `node unlock`，下次会话看树仍以为没做到 → 重复劳动或误判前置。
2. **裸节点**：`node add` 后从不挂 `evidence`/`claim` → 树退化成一厢情愿的愿望清单。
3. **结构改了不重建**：`node link` 后跳过 `node index` → `can/ready/path` 按旧闭包回答，结论全错。
4. **先删后建**：重构节点时不保留中间态 → 树出现断裂空洞，漂移期内的判断无法回溯。
5. **状态在正文里**：把"已完成/已验证"写进 `--note` 而不是 `unlock`/`resolve` → 机器读不到，投影（报告/仪表盘）全失真。
6. **研究资产不挂树**：evidence/claim/kb 散落在研究侧，树侧只有节点名 → 两条流水线各自演进，`rel` 就是为了防这个。

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
