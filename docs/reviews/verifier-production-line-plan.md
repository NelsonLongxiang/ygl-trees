---
name: verifier-production-line-plan
description: 以《验证器协同规范》为基准，评审 ygl-trees verify 引擎与舰队五个验证器的差距，给出分期行动计划与机械验收口径
kind: 评审
---

# 验证器生产线化：差距评审与行动计划（方案）

> 评审席 Claude-OPS-5.5 · 2026-10-21 · 基线：ygl-trees `b9bfd54`（npm 0.110.0，契约 1.2；初稿基于 `f2f91de`，0.110.0 发布后逐条复核、行号重新钉过）＋ 舰队五个验证器仓库（见 §1）。
> 基准：《验证器协同规范（通用版）》，原文见附录 A。本文只做差距判定与行动建议，不改任何代码。

## 0. 结论

**判定这一半已经是生产级，生产这一半还没有开工。**

- 引擎侧：run、归档、逐字摘录、版本化已经满足铁律五的大部分判据。
- 定位冲突：规范说"验证器是生产线，不是检验台"，与 M13 现行设计直接冲突。`docs/spec-validator.md` 把"验证报告"定为交付给业务方的第一产物，而铁律二把"验证报告面向业务发出"列为红线。
- 舰队侧问题更具体：
  - 原料与机器态全部不入 git；
  - 判定散在探针里；
  - 通知手写；
  - 编排脚本五仓复制。

| 条款 | 引擎（ygl-trees verify） | 舰队（五个验证器仓库） |
|---|---|---|
| 一、定位 | **冲突**：设计终点是报告（spec-validator.md:21、:249） | 沿用同一定位 |
| 铁律一 执行面唯一 | 缺口：递归聚合、突变自检、结果契约都没有 CLI 动词 | **违例**：探针内做比较与分类；约 2,400 行编排脚本五仓复制 |
| 铁律二 产品即协同结果 | **冲突**：没有数据包、通知的概念 | 缺口：没有给业务的数据包；通知手写 |
| 铁律三 即时生产 | 缺口：没有加工管线原语 | **违例**：手工修补的好夹具；手工导出的 artifact |
| 铁律四 原料即采集数据 | 缺口：`--db` 接受任意路径，报告不记来源提交 | **违例**：`work/`、`state/` 全部 gitignore；`/tmp` 台账、跨仓绝对路径 |
| 铁律五 判定即证据链 | 基本符合；违例明细只采样 5 行，归档默认落仓外 | 缺口：冻结 spec、报告、归档都在未跟踪的 `state/` |
| §三 协同协议 | 缺口：没有 outbox、回执、重放队列 | 缺口：a2a 的 outbox 入 git，但手写，也无回执与重放 |
| §四 法定序列 | 只覆盖"验证"一步 | 有采集、加工、验证；缺转正、交付、通知 |
| §五 适应性 | 部分：有 `file` 检查器，P2 也放行，但 P4 红队跑不了（#18） | 引擎缺口被绕过：比较做在探针里，没有留 attempt |

行动计划分四期（§4）：

1. **P0 舰队止血**：不依赖引擎改动，可立即开工。
2. **P1 引擎小步**：来源入报告、全量违例明细、运行期 attempt 链、缺口登记、让 `file` 型能冻结。
3. **P2 引擎生产线原语**：tree / selfcheck / package / deliver / notify，先出设计稿交双评审。
4. **P3 舰队迁移**：迁移到引擎原语，并按成员定义产品。

## 1. 评审对象与方法

**引擎**：ygl-trees `b9bfd54`（= npm 0.110.0）。阅读范围：

- `docs/spec-validator.md`、`docs/verify-contract.md`、`docs/verify-contract-v1.2.md`；
- `packages/verify/core/src/{prepare,engine,contract}.ts`、`packages/ops/tools/src/verify-cmds.ts`；
- CLI `verify --help`。

**舰队**：五个以结果为导向的递归验证器。它们是各会话自有的本地 git 仓库，未公开，下文以 `仓库@提交:路径:行` 引用。

| 仓库 | 提交 | 目标 | 引擎钉版 |
|---|---|---|---|
| ygl-webui-verifier | e1b3848 | WebUI 交付结果 | 0.106.0 |
| ygl-design-verifier | 161d92e | 设计系统一致性 | 0.106.0 |
| ygl-review-verifier | c011018 | 与上游协作健康 | 0.106.0 |
| a2a-net-verifier | ef953c0 | dsh-open-a2a-net 候选验收 | 0.106.0 |
| ygl-fleet-verifier | b442db5 | 舰队聚合（读各成员 `latest.json`） | 0.106.0 |

**方法**：静态阅读加只读命令（`git ls-files`、`grep`、`wc`、`shasum`），每条判定都带出处。判定分三档，另加"冲突"：

- **符合**：判据今天成立；
- **缺口**：判据需要的能力不存在，但没有东西被违反；
- **违例**：判据今天被打破；
- **冲突**：设计文本与规范直接相反。

## 2. 术语对照（规范概念 → ygl-trees 现有物）

| 规范概念 | ygl-trees 现有物 | 吻合 |
|---|---|---|
| CLI run | `verify run <spec> --db <snapshot>` | 完全 |
| 冻结材料 | `verify submit`（文本 + 附件 sha256，`materials_sha256`） | 完全 |
| 断言逐字摘录 | prepare P1：`source_clause` / `anchor.quote` 必须逐字出现在材料中（prepare.ts:138–142） | 完全 |
| 断言版本 | `spec_version` 自增，旧版只读（spec-validator.md §6.5） | 完全 |
| 归档 hash chain | `verify run` 默认归档；`verify archive verify` 重算全链（verify-contract.md §7.4） | 完全；落点问题见 3.6 |
| attempt | prepare 未 ready 的尝试写 `specs/<id>/attempts/<ts>.json`（verify-cmds.ts:180–202） | 部分：只有构造期，没有运行期 |
| 违例明细（witness + 行级定位） | 报告 `witness` + `evidence.rows`（前 5 行）+ `rows_total`（engine.ts:229/283/435） | 部分：行级只采样 |
| 采集数据区 | 无。`--db` 接受任意路径；报告 `data_source {kind, sha256, source, captured_at}`（contract.ts:414） | 无 |
| 加工管线 | 无（舰队各自用 `probe.mjs` + `lib/snapshots.mjs`） | 无 |
| 数据包 | 无。§6.2 产物第一项是"验证报告" | 冲突 |
| 转正资产位 | 无。归档默认落 `$YGL_HOME/verify/archives`，文档写"仓库不会被污染"（verify-contract.md:492） | 冲突 |
| 交付 + 回读核验 | 无。最近的类比是封包回收：`verify report import` 校验 binary / spec_version / payload | 无 |
| 通知 / 溯源号 | 没有通知面；`run_id` / `archive_id` 可当溯源号 | 部分 |
| 形态白名单 | `file` 检查器（glob / min / require / sha256）在引擎可用；P2 实际放行，但 CLI 的最小红队（空快照）跑不了 `file`，prepare 停在 P4（#18；文档 verify-contract.md:147 仍写"P2 直接拒"） | 部分 |
| 历史封账件字节对拍 | `file` 型的 sha256、`archive verify` | 部分：没有"期望源 = 仓内 git 资产"的绑定 |
| 备用通道 / 重放队列 | `job add / tick` 是调度器，不是投递队列 | 无 |
| 引擎缺口留痕 | prepare `rejected[]`（带 stage 与原因）写进 attempts；0.110.0 起 `rejected_detail` 与只读的 `verify lint-candidates` 给出结构化拒绝明细 | 部分：逐次留痕，没有跨 spec 的缺口登记 |

## 3. 逐条评审

### 3.1 定位：报告是机器态，不是产品

**冲突（引擎设计）**：

- `docs/spec-validator.md:21` 的流程终点是"交付——> 验证报告"；
- `:249` 所在的 §6.2"产物（专家拿走的东西）"，第一项就是"验证报告"。

规范这边有三处说法与之相反：

- §一要求终点是"交付可信结果"；
- §三把"发报告"列为对业务的严禁项；
- 铁律二的判据是："任何'验证报告/结果单'面向业务发出即为违例"。

**影响**：这不是措辞问题。只要产品是报告，"加工 / 转正 / 交付 / 通知"四步就没有归属。舰队各仓也就只能把 `latest.json` 和报告当成果递出去。

**建议**：M13 设计文档补一节"生产线定位"：

- 报告、spec、归档归为工程侧机器态（§三第三行）；
- 对业务的产品改为"通过验证的数据包"；
- 对协作方的产品改为"由报告渲染的通知"。

这是产品决策，需要用户或开发席裁定（§5）。

### 3.2 铁律一 · 执行面唯一

**符合**：

- 判定只出自 `verify run`。舰队五仓的叶子与组节点都真跑 `verify run` 并归档，组节点还对子报告跑 `verify archive verify`。
- 材料 → 断言走 `material.md → build-specs → verify prepare`，改判据走新 spec 版本。例：ygl-webui-verifier@12755ba 把下限从 51 提到 81，只改了 material / candidates / reviews / defs。

**违例 1（舰队）：探针在做判定。**

判据只认 CLI run，但下列 0/1 列是探针算好的比较结论，CLI run 只核对"是否为 0"：

| 位置（ygl-review-verifier@c011018） | 列 | 探针做了什么 |
|---|---|---|
| probe.mjs:115–116 | `head_matches`、`evidence_matches` | 比较两个哈希是否相等 |
| probe.mjs:156–157 | `source_before_npm`、`tag_before_npm` | 比较两个时间的先后 |
| probe.mjs:146、:151 | `in_scope_order`、`in_scope_tag` | 按版本范围分类 |
| probe.mjs:184–185 | `cites_release`、`cites_repro` | 正则分类 |
| probe.mjs:85 | `uncovered_files` | 计数未被评审中 PR 覆盖的文件 |
| run.mjs:178 | `same_target` | 比较子报告的目标与本轮目标 |

其中 probe.mjs:146、:151 把**判据常量 `0.109.0`、`0.79.0` 写在探针里**，与 `specs/releases/material.md:5` 重复。改材料不会改变检查——这正是铁律五"防捏造判据"要拦的漂移。

根因一半在引擎：

- 钉版 0.106.0（契约 1.1）没有列对列比较。**0.107.0 起契约 1.2 已支持 `value:{col}`**，哈希相等、时间先后都能搬进 spec，舰队却仍钉 0.106.0。
- 正则分类和语义化版本比较至今写不出：op 闭集只有 `= != > >= < <= in between is null is not null`（verify-contract.md:119）。按 §五.4，这种情况应留 attempt 并推动引擎增强，而不是在探针里造判定。

**违例 2（舰队）：编排是五份手搓脚本。**

| 文件 | webui | design | review | a2a | fleet |
|---|---|---|---|---|---|
| `run.mjs` | 244 | 245 | 243 | 221 | 141 |
| `selfcheck.mjs` | 158 | 146 | 134 | 96 | 61 |
| `lib/common.mjs` | 81 | 83 | 81 | 78 | 81 |
| `specs/build-specs.mjs` | 60 | 60 | 60 | 60 | 60 |

- `specs/build-specs.mjs` 五仓**逐字节相同**（sha1 均为 `91e30091…`）。
- 递归聚合、同轮次核对（G3）、突变自检、`ygl-verifier-latest/1` 契约，都活在这些脚本里，而不在 CLI 里。

**违例 3（舰队）：通知手写。**

- a2a-net-verifier@ef953c0 的 `outbox/` 有 17 份入 git 的通报，但没有任何脚本引用 `outbox`（`grep -l outbox *.mjs lib/*.mjs` 为空）。
- 其余仓库的通知是会话消息，同样手写。

**缺口（引擎）**：递归树、突变自检、舰队结果契约都没有 CLI 动词。这是违例 2 的根因（见 P2.1、P2.2）。

### 3.3 铁律二 · 产品即协同结果

**冲突（引擎）**：见 3.1。引擎没有"数据包"与"通知"的概念。

**缺口（舰队）**：

- 对业务方（用户、上游维护者）没有可直接使用的数据包。各仓对外的是：
  - `latest.json`（机器态）；
  - 结果文件；
  - 会话消息与 GitHub 评论。
- 对协作线，最接近合规的是 a2a 的 outbox（例：`outbox/2026-10-21-review-9487c01a2355.md`）。它写明了：结论、被验提交、根 `run_id`、所需动作、回报三选一。但它：
  - 是手写的（违反铁律一）；
  - 没有"包在哪"——因为根本没有包。

各成员的业务产品与通知该是什么，见 P3。

### 3.4 铁律三 · 即时生产

**违例 1（舰队）：手工修补的好夹具。**

- ygl-review-verifier@c011018 的好夹具是手工修补过的真实测量。`tests/fixtures/good/meta.json` 的 `fixture_note` 写明："with the two real defects of that round repaired … cites_repro 0→1; … supported→contested"。
- 夹具是自检的字节期望源。就地修补它，正是"对已产出成品做就地编辑"。
- 对照：ygl-design-verifier@161d92e 把好夹具换成了一次真实的 root PASS 测量（见提交信息），这是合规做法。

**违例 2（舰队）：手工导出的 artifact。**

- ygl-design-verifier 的 `artifact/` 由维护者"用 Claude Code 的 Artifact read 重新导出到 `artifact/` 并提交"（README.md:59–60）。
- 这一步采集是手工的，不在管线里。

**缺口（引擎）**：没有"一次交付 = 原料 → 加工 → 验证 → 交付"的原语。`verify graduate` 能让检查常驻，但常驻的仍只是判定，不是生产（见 P2.3）。

### 3.5 铁律四 · 原料即采集数据

**违例 1（舰队，五仓一致）：数据区不入 git。**

- 五仓 `.gitignore` 都含 `work/` 与 `state/`；`git ls-files work state` 五仓均为 0 行。
- 于是原始测量 `work/raw/<round>/*.json`、快照、报告、归档都不入 git。规范要的"固定数据区（git 跟踪、可追溯）"并不存在。

**违例 2（舰队）：原料来自仓外。**

| 仓库 | 位置 | 仓外原料 |
|---|---|---|
| ygl-review-verifier | probe.mjs:36 | 默认台账 `/tmp/ygl-trees-kb.db`，正是判据点名的"临时目录" |
| ygl-review-verifier | `data/pr-verifications.json:3` | `evidence_dir` 指向另一仓库未跟踪的 `ygl-webui-verifier/work/results` |
| ygl-fleet-verifier | `fleet.json` | 用绝对路径读各成员未跟踪的 `work/results/latest.json`；其中 devenv 成员的仓库在本机不存在 |
| a2a-net-verifier | harvest.mjs 头注释 | 队友回传落 `work/inbox/`，未跟踪 |

**符合（可推广）**：

- ygl-design-verifier 的 `artifact/`（含记录版本号与 sha256 的 `SOURCE.json`）入 git；
- a2a 的 `ledger/ledger.sql` 入 git。

**缺口（引擎）**：

- `verify run --db` 接受任意路径；
- 报告的 `data_source` 只有 `kind / sha256 / source / captured_at`（contract.ts:414），不记来源仓库的提交、路径、是否被跟踪。

结果是：引擎既无法拒绝"临时目录里的原料"，也无法证明原料来自哪个提交（见 P1.1）。

### 3.6 铁律五 · 判定即证据链

**符合（引擎）**：

- **逐字摘录**：P1 拒绝非逐字的 `source_clause` 与 `anchor.quote`，并标为 "fabricated criterion"（prepare.ts:138–142）。
- **冻结不改**：
  - spec 版本自增、旧版只读（spec-validator.md §6.5）；
  - 报告不可变，`payload_sha256` 防手改（verify-contract.md §2）。
- **PASS 与 FAIL 都是产物**：
  - `verify run` 结束即归档，不分 verdict（verify-contract.md §7）；
  - fact 型的 witness 必填（§2）；
  - `archive verify` 重算全链（§7.4）。

**缺口**：

1. **引擎：违例明细只采样。** `evidence.rows` 只取前 5 行，另给 `rows_total`（engine.ts:229/283/435）。"行级定位"只覆盖前 5 条，整改却需要全量清单（见 P1.2）。
2. **引擎：运行期没有 attempt 链。** FAIL → 整改 → 重跑 PASS 是几次互不相关的 run，"整改的燃料"与"整改结果"无法机械关联（见 P1.3）。
3. **引擎：归档默认落在仓外。** 归档默认写 `$YGL_HOME/verify/archives`，文档还把"不污染仓库"当作优点（verify-contract.md:492）。而 §三 规定工程侧的通道是"验证器仓库（git+hash chain）"（见 P1.4）。
4. **舰队：机器态在 git 之外。**
   - 五仓的 `YGL_HOME` 都在 `state/home`，已被 gitignore；冻结 spec、报告、归档全在其中。以 ygl-review-verifier 为例：`state/` 25M、`work/` 368M。
   - 证据链有哈希，但不在 git 里：审计者从仓库历史看不到"这次结论用的是哪版 spec"。

### 3.7 §三 协同协议与通道阻断

**缺口（引擎与舰队）**：没有 outbox、投递回执、重放队列与时钟。

规范要求："产品降级落备用通道先行，正式通道入队列择期重放并挂时钟"。舰队已经真实遇到过通道阻断：

- 本评审席有一个会话回合卡在权限提示上约 4 小时；
- 期间上游合并了 #4、#5；
- 通知全靠会话消息，没有落地的队列。

**符合（可推广）**：a2a 的 outbox 入 git，按 `日期-review-<sha12>` 命名，是备用通道的雏形。

### 3.8 §四 法定序列（逐步对照）

| 步 | 引擎 | webui | design | review | a2a | fleet |
|---|---|---|---|---|---|---|
| 采集 | — | probe | probe + 手工导出 | probe | probe + harvest | probe |
| 加工 | — | snapshots | snapshots | snapshots | snapshots | snapshots |
| 验证 | `verify run` | ✓ | ✓ | ✓ | ✓ | ✓ |
| 转正（进 git 资产位） | — | ✗ | 部分（`artifact/`） | ✗ | 部分（`ledger.sql`、`outbox/`） | ✗ |
| 交付（落位 + 回读 + 目录复验） | — | ✗ | ✗ | ✗ | ✗ | ✗ |
| 通知 | — | 手写消息 | 手写消息 | 手写消息 | 手写 outbox | 手写消息 |

现有最接近"一条龙"的入口是 a2a 的 `cycle.mjs`：fetch → 探针 → 递归判定 → 自校验 → digest + latest，并带互斥锁。它可以作为 P2 的原型。

### 3.9 §五 适应性条款

1. **换域三件事**：舰队模板已覆盖"加工管线"与"spec 断言"（probe / snapshots / material），缺"采集数据区"的定义（见 3.5）。
2. **形态白名单**：
   - 舰队：`ygl-verifier-latest/1` 是唯一登记过的交付形态，舰队成员判据"按契约报到"在机械检查它——符合。业务数据包还没有形态，自然也没有白名单。
   - 引擎：`file` 检查器能判结构、命名、sha256。文档（verify-contract.md:147、doc-governance.md:46）说构造面 P2 不放行 `file`；实测 P2 放行（prepare `units:1`、`rejected:0`），但 CLI 的最小红队在空快照上跑不了 `file`，P4 判成"construction bug"（#18）。形态白名单真正缺的是 P4 对 `file` 的红队能力。
3. **历史封账件**：ygl-review-verifier 的 P2、P4 两条判据——合并时的 head = 放行提交、证据验的是同一提交——就是 40 位哈希的字节对拍。符合，可推广。
4. **引擎缺口**：舰队的做法是绕过，把比较放进探针（3.2 违例 1）；而不是把条款提交给 prepare，让 P2 拒绝并在 attempts 里留痕。

## 4. 行动计划

每一步都写明谁做、做完怎么机械地验收。验收口径刻意写成能直接收编为 spec 条款、或一条命令的形状——这份计划本身也应该由验证器来验。

### P0 · 舰队止血

不依赖引擎改动；各会话自理，监督席验收。

**P0.1 升引擎钉版。**
- 负责：各会话。
- 动作：五仓引擎钉版 0.106.0 → 0.110.0（契约 1.2），全部 spec 重新 prepare。这会产生新 spec 版本，不改旧版。
- 验收：五仓 `package.json` 钉 `0.110.0`；最新根报告的 `contract_version` 为 `1.2`；selfcheck rc=0。

**P0.2 把探针里的比较搬进 spec。**
- 负责：各会话，review 席先行。
- 动作：
  - 哈希相等、时间先后改用 `value:{col}`，例如 `head_sha != {col: verified_tip}`、`first_push_at >= {col: npm_published_at}`；时间先统一成 UTC `Z` 字符串。
  - `same_target`：子行带 `target_sha` 与本轮 `round_sha` 两列，在 aggregate spec 里比较。
  - 版本范围：探针只输出 `ver_major / ver_minor / ver_patch` 整数，范围写进 spec 的 `scan`。
- 验收：
  - 探针源码不含 material.md 里的任何判据常量，例如 `grep -nE "0\.79\.0|0\.109\.0" probe.mjs` 为空；
  - 探针输出中不再有"由两个测量值比较得来"的 0/1 列。

**P0.3 写不出的判据按 §五.4 留痕。**
- 负责：review 席。
- 动作：
  - 正则分类（`cites_repro`、`cites_release`）的条款照常写进 material.md 并 prepare，让 P2 拒绝，在 attempts 里留痕；
  - 同时向上游提引擎增强 issue；
  - 在此期间，探针只输出原文片段，不输出 0/1。
- 验收：`specs/<id>/attempts/` 下有对应的拒绝记录；上游有对应的 issue。

**P0.4 定义采集数据区。**
- 负责：各会话。
- 动作：
  - 每仓建 `collected/<round>/`（入 git），存原始测量与小型快照；
  - 大克隆（`work/target`）仍不跟踪；
  - 只提交产生新结论的轮次。
- 验收：`git ls-files collected | wc -l` 大于 0；结果文件记 `raw_commit`，且 `git show <raw_commit>:collected/<round>/meta.json` 可读。

**P0.5 清除仓外原料。**
- 负责：各会话；webui 与 fleet 由监督席负责。
- 动作：
  - 台账：由采集步骤把 ygl-trees 工作区台账导出进 `collected/<round>/ledger.json`（带 sha256）。
  - PR 放行证据：webui 验证器把结果转正进自己的 git 资产位；review 验证器按（仓库, 提交, 路径）读取并记 sha。
  - 舰队聚合：同理，按成员仓库的提交读取 `latest.json`。
  - a2a：`work/inbox/` 移进 `collected/`。
- 验收：五仓源码与数据文件中不再有 `/tmp/` 与 `/Users/` 绝对路径（`git grep -nE "/tmp/|/Users/"` 为空）。

**P0.6 好夹具可再生。**
- 负责：review 席。
- 动作：好夹具改为"入 git 的真实轮次 + 代码化的修补声明"，或像 design 席一样直接取一次真实的 root PASS 轮次。夹具要能由脚本从原始轮次逐字节再生。
- 验收：`meta.json` 记 `source_round` 与 `source_commit`；再生脚本的输出与入仓夹具 `cmp` 一致。

**P0.7 机器态转正。**
- 负责：各会话。
- 动作：每个交付轮次把冻结的 `spec.json`、`report.json`、归档 manifest 与 `zip_sha256` 写进入 git 的 `ledger/`（a2a 模式）；zip 本体按体量择存。
- 验收：`latest.json` 的 `root_run_id` 能在 `git ls-files ledger` 中找到；对入仓 zip 跑 `verify archive verify` 为 ok。

**P0.8 通知生成式。**
- 负责：各会话，a2a 模板先行。
- 动作：
  - 周期脚本从结果文件渲染通知，写进入 git 的 `outbox/`；内容为结论、包位置、`root_run_id` / `archive_id`、所需动作；
  - 附投递回执（渠道、时间）；
  - 渠道失败的条目保留待重放。
- 验收：每个 `root_run_id` 恰有一份 outbox 条目；超过约定时钟仍未投递的条目，由舰队验证器判红。

**P0.9 处理 devenv 成员。**
- 负责：监督席。
- 动作：补建仓库，或从 `fleet.json` 下线。
- 验收：`fleet.json` 里每个成员的仓库路径都存在。

**P0.10 把 P0 收编为判据。**
- 负责：监督席。
- 动作：把 P0.1–P0.9 写成舰队成员判据（`specs/member/material.md` 新版本），由舰队验证器机械验收。
- 验收：舰队根 PASS，即 P0 完成。

### P1 · 引擎小步

负责：上游开发席。每项都遵守契约纪律：字段增删 = `contract_version` 自增 + 语料 + Rust parity。

**P1.1 原料来源入报告。**
- 动作：
  - `verify run` 可以声明来源，例如 `--source-repo <dir> --source-path <rel>`，或在 spec 内写 `data_source.zone`；
  - 报告的 `data_source` 增加 `provenance {repo_commit, path, tracked, clean}`；
  - spec 声明了 zone、快照却不来自已跟踪且干净的路径时，报 ERROR，不静默。
- 验收：语料里"未跟踪 / 脏 / 路径不符"三个负例为 ERROR，正例 PASS；`archive verify` 覆盖新字段。

**P1.2 全量违例明细。**
- 动作：`verify report <run-id> --violations [--format json|csv]` 在留存快照上（先对质 sha）重放 `rendered.find_sql`，输出全部违例行。报告本身仍只带前 5 行，保持不可变。
- 验收：留存快照 sha 不符时 rc=1 并点名；导出行数等于 `rows_total`。

**P1.3 运行期 attempt 链。**
- 动作：`verify run --supersedes <run-id>`（同 spec、同来源）记录"整改后重跑"；`verify list --chain <spec>` 显示 FAIL → PASS 链。
- 验收：链上每一环 `archive verify` 都为 ok；跨 spec 的链接被拒绝。

**P1.4 归档转正。**
- 动作：`verify archive <run> --out <仓内资产位>` 已经可用。补 `verify.archive_dir` 配置项，并在文档里把"仓内资产位"写成生产线模式的推荐落点；工作区模式的默认值不变。
- 验收：配置之后，`verify run` 的归档落在该目录。

**P1.5 缺口登记。**
- 动作：`verify gaps [--json]` 汇总所有 attempts 里被 P2 拒绝的条款与原因，作为引擎增强的待办队列（§五.4）。0.110.0 的 `rejected_detail` 已是每次尝试的结构化原料，`gaps` 只需跨 spec 汇总。
- 验收：舰队 P0.3 的拒绝记录能在 `verify gaps` 中列出。

**P1.6 让 `file` 型能冻结。**
- 动作：
  - P4 红队为 `file` 型提供提交物根（或明确点名"红队不覆盖 file"），不再报"construction bug"；同时订正 verify-contract.md:147 与 doc-governance.md:46 关于 P2 的说法（#18）。这是形态白名单的前提。
  - 评估是否在契约 1.3 增加字面量包含类算子 `contains`（要能在 SQLite / PG 之间移植），与已排期的 `group_by/having` 同批。
- 验收：prepare 对合法的 `file` 型 VU 产出 `ready`；正则分类类判据可以由 spec 表达。

### P2 · 引擎生产线原语

先出设计稿交双评审，再实现。

**P2.1 `verify tree run <tree.json>`**（取代五仓 `run.mjs`）
- 后序遍历：叶子 = spec + 快照构造器；组 = 内置 aggregate spec。
- aggregate spec 检查四件事：子验证器全过、子报告归档自校验、同一轮测量、组非空。
- 输出树结果，可选写 `ygl-verifier-latest/1`。

**P2.2 `verify selfcheck --fixture <dir> --cases <cases.json>`**（取代五仓 `selfcheck.mjs`）
- 突变是声明式的：对原始测量的 JSON patch + 预期变红的叶子集合。
- 好夹具必须根 PASS；每个突变只翻预期的叶子。

**P2.3 `verify package`**（新增）
- 声明式加工管线：仓内 `pipeline.json`，步骤 = 仓内命令；沿用 `command` 型白名单，以及 r26 "报告是数据，不是命令"的纪律。
- 输出数据包到仓内资产位，再用登记过的形态 spec（`file` 型白名单）验包。

**P2.4 `verify deliver`**（新增）
- 落位到交付域 → 回读 sha256 → 在目标位置重跑形态 spec。
- 任一步失败，不发通知。

**P2.5 `verify notify`**（取代手写消息与手写 outbox）
- 从报告渲染通知：结论、包位置、`run_id` / `archive_id`、所需动作，写进 outbox。
- 记录渠道投递回执；投递失败的入重放队列并挂时钟，复用 `job tick` 作驱动。

**P2.6 文档**
- `docs/spec-validator.md` §2、§6.2 改为生产线定位：报告 = 机器态；产品 = 数据包 + 通知。
- `skills/ygl-trees-verify` 同步。

P2 完成后，一次交付就是一条命令链：

```
verify tree run   # 原料已在 collected/
→ verify package
→ verify deliver
→ verify notify
```

每一步都出自 CLI，都有报告与归档。

### P3 · 舰队迁移与各成员的产品定义

| 成员 | 业务产品（数据包） | 协作通知 |
|---|---|---|
| webui | 放行提交本身：PR 分支在放行提交上的 `git archive` / `npm pack` 包 + sha256 | PR 描述与监督席通报：放行提交、根 `run_id`、包位置 |
| design | DESIGN.md token 包 + 发布后的 artifact；交付后回读导出、对 `SOURCE.json` 字节对拍，取代手工导出 | 设计会话通报 |
| review | 上游协作健康数据包：已合并 PR × 放行提交、发布顺序表、issue 复核索引（CSV + manifest，按日期命名），给用户与维护者直接使用 | 监督席通报：根 `run_id`、红叶子与所需动作 |
| a2a | 候选验收数据包：叶子测量摘要 + 被验 sha | 现有 outbox 改为生成式 |
| fleet | 舰队状态数据包：成员 × 结论 × 时效 | 给用户的单条通报 |

**迁移顺序**：每个成员先完成 P0；P2 原语可用后，再把 `run.mjs` / `selfcheck.mjs` 换成 `verify tree run` / `verify selfcheck`，并删除复制的 `build-specs.mjs`。

**验收**：

- 五仓的 `run.mjs` 里不再有后序遍历与 aggregate 逻辑；
- `selfcheck` 由 CLI 执行，用例数不少于迁移前。

## 5. 需要裁定的事项

1. **定位变更**（3.1）：M13 的交付物由"验证报告"改为"数据包 + 通知"。这改的是 m11429"交付 = 真 + 产物"里的产物定义，需要用户裁定。
2. **P1 与发布冻结**：上游当前处于发布冻结，P1、P2 排在治理裁定之后。P0 不依赖引擎，可以立即开工。
3. **仓内体量**：P0.4、P0.7 让原料与机器态入 git，需要给每仓定体量预算：只提交产生新结论的轮次，zip 按需存。

## 6. 风险与边界

- **新的可执行面**：加工管线一旦允许跑仓内命令，就多了一个可执行面。必须沿用 `command` 型的显式白名单，以及 r26 "报告是数据，不是命令"的注入防线。
- **契约分叉**：P1.1、P1.3 新增的契约字段都是 `contract_version` 变更，必须同批交语料与 Rust parity，否则封包与 TS 引擎会分叉。
- **不新增"人裁"层**：规范与 m11558 一致，判定仍只来自 spec run。
- **不替代设计评审**：P2 的每个原语都需要单独的设计稿与双评审，再进实现。

## 附录 A · 《验证器协同规范（通用版 · 最强适应 × 最强铁律）》原文

> 适用：任何验证器体系、任何数据域、任何团队。工具名可替换，铁律不可裁剪。

### 一、定位（一切分歧的裁决基准）

**验证器是生产线，不是检验台。** 它的终点不是"出具报告"，而是"交付可信结果"。验证动作只是生产环节之一。

### 二、五层铁律（每条含判据，违者即红线）

**铁律一 · 执行面唯一**
验证器的开发、运维、使用，一切以验证器 CLI 为主，禁止临时编码执行。
- 开发=材料提交→断言收编（CLI 流程）；运维=采集器/管线仓内 git 演进；使用=判定只认 CLI run。
- 判据：任何"验证结论"若不出自 CLI run 产物，视为未验证。/tmp 脚本、inline 代码、手搓判定 CLI 一律无效。

**铁律二 · 产品即协同结果**
验证器的输出产物必须是交付给协同方的结果：业务同事→**产出的数据包**；协作方→**通知**。
- 判据：给业务的永远是可以直接使用的数据本身；给协作的永远是可行动的通报（包在哪、结论、溯源号）。任何"验证报告/结果单"面向业务发出即为违例。

**铁律三 · 即时生产**
交付结果必须是即时生产的：交付时点执行加工过程，而非维护历史冻结件。
- 判据：一次交付=一次完整生产循环（原料→加工→验证→交付）。对已产出成品做就地编辑（手术/打补丁）即为违例——所有加工逻辑必须活在管线里。

**铁律四 · 原料即采集数据**
即时生产指代的是加工数据的过程；采集数据已经完成了——**采集数据指验证器采集的数据**。
- 判据：产线原料必须来自验证器采集体系内的固定数据区（git 跟踪、可追溯），从仓外路径/临时目录手工指定原料即为违例。

**铁律五 · 判定即证据链**
判定只认 spec run；**通过与不通过都是产物**。
- 判据：PASS 产出 run 报告+归档（hash chain）；FAIL 产出 attempt/违例明细（witness+行级定位）——它们是整改的燃料。断言条款必须逐字摘录自冻结材料（防捏造判据）；断言冻结后不许改，发现采集器缺陷修采集器（git 演进）、发现基线演进走新断言版本——两者都不许动已冻结 spec。

### 三、协同协议（角色 × 产物 × 通道）

| 协同方 | 产物 | 通道 | 严禁 |
|---|---|---|---|
| 业务同事 | **数据包**（打开即用：数值就绪、命名合规） | 交付域（网盘/指定位置） | 发报告、发截图集、要求业务理解验证过程 |
| 协作线 | **通知**（结论+位置+溯源号+所需动作） | 消息通道（IM/通知位/索引） | 让对方翻验证档案找结论 |
| 工程侧 | 机器态（材料/spec/run/attempt/归档） | 验证器仓库（git+hash chain） | 把机器态当产品外发 |

通道阻断时（配额/网络）：产品降级落备用通道先行，正式通道入队列择期重放并挂时钟——**产品不因通道死而停摆，也不因绕道而失忆**。

### 四、一次交付的法定序列（一条龙）

```
采集（验证器采集数据——已完成的冻结态）
 → 加工（管线：原料→加工步骤集→打包，交付时点即时执行）
 → 验证（CLI run 即时判定；FAIL 则违例明细驱动整改后重跑）
 → 转正（产物进仓内资产位，git 跟踪——它同时是后续字节期望源）
 → 交付（云端落位+回读核验+目录规范复验）
 → 通知（业务取数指引 / 协作溯源通报）
```

任一步缺失即未完成交付；任何"跳到交付"（拿旧件直接传）即为违例。

### 五、适应性条款（怎么平移到新域）

1. **换域三件事**：定义该域的采集数据区 → 定义该域的加工管线（步骤集可增删，原料区规则不变）→ 定义该域的 spec 断言（走材料提交流程）。
2. **形态演进**：交付形态（包结构/命名/期次规范）以白名单断言登记——新形态必须先登记后交付，未登记即 FAIL。
3. **历史封账件**：已交付冻结件只做防篡改字节对拍（期望源=仓内 git 资产），不重生产、不就地改。
4. **引擎缺口**：断言写不出（算子不支持）时，材料冻结留痕+attempt 记录缺口，推动引擎增强——**禁绕过引擎造判定**。

---

**一句话总纲：CLI 是唯一执行面，数据包和通知是唯一产品，即时生产是唯一交付方式，验证器采集的数据是唯一原料，证据链是唯一裁判。**
