# scenarios — 一协议 × 三树主 × 六场景（权威目录）

> **一个产品四面**。四条主推线（业务科技树 / 开源项目研究 / 人类能力树 / 研究预测测试验证流程）共享同一引擎：**证据先行的研究 → 可回测的预测 → 测试验证 → 校准修正**。本目录把产品拆成两层：上层是「三树主」——三种树原型各自怎么消费这套协议；下层是「六场景」——按用途对号入座的走法手册。先选树主定基调，再按场景走最小序列。

## 三树主（tree archetypes）——同一条协议，三种吃法

| 树主 | 吃协议的姿势 | 入口技能 | 实战锚点 |
|---|---|---|---|
| **① 业务树**（agent 工作自动运维） | 研究产出 SOP 候选 → 协议保证「supported 才毕业」→ 执行归执行系统；采纳用遥测门度量（`cond --op telemetry`） | `ygl-trees-ops-patterns` | .157 跨境电商全链路（bill-audit/proc-gov 等八树在产运转）；毕业通道见 docs/graduation-protocol.md |
| **② 仓库树**（开源项目研究） | 把外部项目建构成「作者意图树」：意图/现状/机制三层断言 + 对 t5 未来节点下可回测预测 | `ygl-trees-repo-research` | mp-skills 深读首例（2026-10-18） |
| **③ 能力树**（面向人类的能力成长） | agent 代录证据、人只做仲裁与解锁；灰带（必检未满足）是成长态不是不及格；tier=熟练度轴 | human-capability 模式（探针已验证，技能 0.94+ 提炼） | human-agent-eng 树（11 节点，2026-10-19 落地） |

**协议本身**（研究→预测→测试→验证→校准）就是场景 1-4 的串联：调研立证（场景 3）→ 预测落账（场景 2）→ 工程迭代兑现（场景 1）→ 教训复利（场景 4）。场景 5/6 是横切面：治理保证多 agent 不乱，采纳保证成长诚实。

---

## 六场景走法手册

> 按用途选路：先在这里对号入座，再按「最小命令序列」走。每条走法五件套：入口（什么任务该走）→ 最小命令序列 → 出口（产物如何落账）→ 验收判据 → 常见反模式。demo §N = examples/demo.sh 对应段落（回归面）；「工作区实战」= 本仓库 30+ 轮狗粮验证（无 demo 断言时如实标注）。

## 1. 长周期工程迭代（engineer the work）

- **入口**：一个要持续多轮的工程目标（版本批次/重构/修复链），需要「下一步该干什么」始终可问、进度可巡检。
- **最小命令序列**：`agent brief` 定位下一步 → `task add` 落任务 → 干活 → `task doing/done` 推进 → `node unlock`（树里程碑）→ `doctor` 收口 → `kb add` 沉淀教训。
- **出口**：任务状态机落账（artifacts kind=task）、树节点解锁带证据、教训入 kb、事件流可审计。
- **验收判据**：brief 的 next_actions 不空转（每条对应真实缺口）；doctor 全绿；每轮收口有事件可查。
- **常见反模式**：只写代码不落任务（进度不可见）；解锁节点不挂证据（漂移）；攒批沉淀教训（丢失细节）。
- demo：§11 task 状态机 + produce · §10 telemetry · §6 树模型 · §2 技能注册。

## 2. 预测回测（predict & settle）

- **入口**：对未来可证伪的事下断言（版本节奏/外部指标/行为承诺），到期要机器可读地结算。
- **最小命令序列**：`research claim add "[预测·N天] <日期> <判据>" --channel <通道>` → `node cond add`（eval 门，可选）→ 标记节点 + `rel` → 到期 `research predict audit` → 结算 evidence note 尾部三段式 `outcome=1|0, brier=…, settler=…` → `research claim calibration --all` 看偏差。
- **出口**：predictions 投影（`research predict list`）里 outcome/brier/settler 三列可 SQL 直出；校准曲线有基线快照。
- **验收判据**：判据登记 verbatim（禁止转述）；结算行三段式格式固定；快照后 events 只增不洗。
- **常见反模式**：claim link 抢跑仲裁（0.82.1 护栏已拦截）；标记节点与断言终态不同步；事实性里程碑挂 eval 门（门型错配，模型必 fail）。
- demo：§5e predict audit · §5j 生命周期护栏 · §5j2 投影+结算 · §5l 校准读出 · §6a eval 门。工作区实战：predictions-2027q1 全序列。

## 3. 证据先行调研（research with evidence）

- **入口**：要回答一个开放问题，结论必须可追溯（谁说的、原文在哪、我信到什么程度）。
- **最小命令序列**：`research query add` 登记检索式 → `research source add/fetch` 采集 → `research evidence add <sid> --quote` 摘原文 → `research claim add` 立断言 → `research claim link --stance` 挂证据 → 人审 `research claim resolve` → `produce report`。
- **出口**：证据链六环闭合（query→source→evidence→claim→判定→落账）；报告每个论断带引用。
- **验收判据**：断言可证伪；证据是 verbatim 引文非转述；无主断言不 resolve。
- **常见反模式**：先写结论再找证据；evidence 存转述；claim 无证据直接 resolve。
- demo：§3 source→evidence→claim · §5d 仲裁 · §4 produce。

## 4. 知识复利（compound knowledge）

- **入口**：同一个坑不想踩两次；研究报告要让下次任务自动命中。
- **最小命令序列**：`kb add`（或 `kb import` 批量）→ `kb search` 验证可检索 → `kb promote` 提升为技能 → `agent match` 验证命中 → `rel` 挂到树节点。
- **出口**：kb 条目带 tags/confidence；promote 后技能可被 match 命中；教训与树节点互链。
- **验收判据**：新任务 agent match 能召回正确技能；kb 无重复（幂等探测）；复利可见（同一类问题第二次直接命中）。
- **常见反模式**：笔记只存不检索（死库）；一次性总结不 promote；教训不挂节点（树上看不见）。
- demo：§5 kb · §5b 幂等 · §5c promote→match · §9 rel 织物。

## 5. 多 agent 协作治理（multi-agent governance）

- **入口**：多个会话/席位并行干活，需要派单-回执-对账不出乱子。
- **最小命令序列**：写命令一律 `--project` 钉住 → 会话内 `project use`（多项目工作区不选择即拒绝）→ 树侧同理 `-t`/`--tree` 钉住或会话内 `tree use`（各自 session 键，别依赖共享指针）→ 定时作业交给 `job tick`（0.106.0 起每次运行注入 `YGL_SESSION=<parent>/<job-id>`，并发 worker 不再共享选择命名空间，`YGL_JOB_ID` 可回指作业）→ 事件流 `agent log`/`db timeline` 审计（`actor`=真实 session，树域事件 payload 带 `via` 说明授权层）。
- **出口**：每工单一回执；挂账由监督对账清零；选择来源（flag/env/session）处处可查。
- **验收判据**：未选择时读命令 rc=2 单错误对象；跨项目操作 404/点名；锁与并发互不踩（busy_timeout + 钉住）。
- **常见反模式**：裸 shell 共用 default 会话键互踩（`doctor` 的 `session_identity` 会先报警）；挂单不回执；依赖全局指针。
- demo：§5f/5g 并发防护 · §5m 会话选择。工作区实战：A2A 六席位 30+ 工单全链路（无 demo 断言，席位面在宿主侧）。

## 6. 成长采纳追踪（adoption tracking）

- **入口**：把外部目标（用户增长/目录收录/内容发布）反推成行动树，逐叶用真实证据解锁。
- **最小命令序列**：`tree new` 行动树 → `node add` 叶=外部动作 → 动作完成 → `research source add` + `evidence add` 落证 → `rel evidenced-by` → `node unlock`。
- **出口**：每片叶要么解锁（带证据）要么锁定（带原因/阻塞证据）；树进面对外可读（tree show）。
- **验收判据**：解锁判据=真实外部事件（人审裁定，eval 门过≠解锁）；诚实复位（判据未满足时回锁）。
- **常见反模式**：自家冷跑当真用户证据；目录提交未 live 就解锁；一次动作重复计叶。
- demo：§6b round-trip · §1 冷启动。工作区实战：adoption 树 3/6 叶（issues-channel/npm-seo/showcase-gif 已解锁，4 叶外部依赖中）。

---

**产品面索引**：`ygl-trees --help` 命令面 · `ygl-trees agent brief` 每轮入口 · `ygl-trees llms` LLM 友好全览。新场景入本目录须同时补：产品面一行 + demo 断言或工作区实战记录。新树主入本目录须同时补：入口技能 + 一个实战锚点 + 一条与协议的接缝说明（它消费协议的哪一段）。
