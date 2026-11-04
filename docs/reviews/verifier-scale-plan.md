---
name: verifier-scale-plan
description: 千级验证器的根治方案——定义（包）/ 实例（绑定）/ 证据（运行）三分；实例是登记表里的行而不是 git 仓库，节点是执行者而不是宿主；身份按内容寻址（重复创建即幂等），生命周期带过期与回收；git 只是包的分发手段之一
kind: 评审
---

# 千级验证器：登记、执行与回收（方案）

> 监督席 Claude-OPS-5.5 · 2026-11-04 · 基线：ygl-trees `2e53f79`（npm 0.120.0）＋ 2026-11-04 全盘盘点（至少 6 个节点、10 个独立验证器仓库，其中 8 个没有远端）。
> 依据：属主 2026-11-04——「agent 构建了大多数杂乱的验证器，如何根本性解决」「git 是一种手段，但不是唯一，太多仓库我们也很难管理，如果有上千个验证器又该如何」。
> 承接：`verifier-pack-plan.md`（定义层：纯数据包、命名、三轴标记、预设模式，持闸 APPROVE）、`verifier-sdk-plan.md`（SDK-0..5 原语路线）、charter §4.4（R1–R6）与 §4.7（原语闭集）。
> **本文是方案：§8 的 D1–D5 已于 2026-11-04 由监督席依属主授权（「继续，由你独立完成」）裁定，属主可随时推翻；各期以 issue 立项，按 §7 的判据验收。** 立项：#205（跟踪）、#206（S0 登记表与入口）、#207（S1 legacy 桥接）、#213（全局 / 项目两层，严格方案）；S2–S5 在前一期推进时再立。

## 0. 结论

1. **乱的根源是「一个验证器 = 一个 git 仓库」这个单元选错了。** 仓库同时承担了四件事：定义（判据）、绑定（验谁）、执行（编排脚本）、证据（ledger）。四件事绑在一个可随手复制的目录里，于是每个 agent 都能造一个、拷一份、改几行，规范只能靠自觉。10 个仓库已经难以管理，到 1000 个时根本无法管理。
2. **改成三类对象，各管一件事：**
   - **包（Pack，定义）**：判据材料、冻结 spec、树、夹具。纯数据，不可变，按内容寻址，数量少（几十个）。直接沿用 `verifier-pack-plan.md` 的 `ygl-verifier-pack/1`。
   - **实例（Instance，绑定）**：包@版本 × 被验对象 × 负责人 × 节奏。是**登记表里的一行**，不是仓库，数量多（成百上千）。
   - **运行（Run，证据）**：报告 + 归档。按内容寻址，只追加不修改，数量最多。
   1000 个验证器 ≈ 几十个包 × 几十个被验对象，要管的只是一张表。
3. **节点是执行者，不是宿主。** 节点从登记表领取实例的租约，跑完把报告交回登记表，本机不留常驻验证器目录。`latest.json` 和舰队聚合仓都退化为一条查询。
4. **身份按内容寻址，复制就不可能产生副本。** 实例 id = hash(包@版本 + 规范化绑定)。同样的东西再创建一次，返回 `duplicate:true`，和写入幂等契约同一口径。
5. **只有一个入口，规则在入口执行。** 实例只能经 `verify instance create` 进入登记表，入口检查包是否通过一致性套件、绑定是否完整、负责人是否存在、是否超出配额。手搭目录不被登记，也就不被调度、不进任何汇总，自然边缘化。
6. **生命周期带过期与回收。** 草稿有 TTL；长期无运行、无负责人的实例会被标记、转派，最后归档。量到上千时，靠的不是有人去清理，而是过期的东西自动退场。
7. **git 只是包的一种分发手段。** 包可以通过 npm（pack 方案 D4）、git 或 portable 件（0.120.0 的 `verify export --portable` / `verify import`）分发。实例和运行都不需要 git。登记表本身的备份走 `db export` 或 PG 镜像，不依赖每个验证器各自有远端。

## 1. 现状证据（2026-11-04 盘点）

| 现象 | 数量 / 例证 | 背后的单元问题 |
|---|---|---|
| 验证器散在磁盘各处，靠全盘扫描才找得全 | 至少 6 个节点，10 个独立仓库 | 没有登记处；仓库能随手建在任何地方 |
| 历史只存在于本机 | 10 个仓库里 8 个没有远端 | 证据和定义绑在本机目录里 |
| 副本、scratch 克隆、跨机器拷贝 | taste-pilot 的 latest 与 target 路径都指向另一台机器的 `/Users/jun/...` | 目录可复制，复制出来的东西没有身份 |
| 暂存了却没提交的入账 | webui、fleet、issue27 三个仓共 7 个暂存目录（11-03），其中 1 个已被索引引用、本身却没提交 | 证据靠每个仓自己的编排去 commit，失败了也没人知道 |
| 同一概念各仓手工重写 | pack 方案 F2：9 个仓约 1.19 万行编排，`aggregate` 规格有 6 份抄本 | 定义无法跨仓复用 |
| 结构漂移 | review 仓缺 `registration.json`、`.DS_Store` 被提交；outbox/tests/fixtures/data 各仓有的有、有的没有 | 规范只在准入时检查仓内，建仓本身不受约束 |
| 引擎版本漂移 | taste-pilot 停在 0.114.9（舰队已到 0.119.0） | 钉版分散在各个仓的 package.json 里 |

## 2. 对象模型

```text
Pack（定义）          Instance（绑定）                       Run（证据）
ygl-v-<名>@<semver>  ──<  id = hash(pack@ver + binding)  ──<  run_id、报告、归档 zip
  specs[] 钉 spec_id     binding: target {kind, repo, rev | db}    payload_sha256（内容寻址）
  @version + sha256      owner（负责人 / 节点池）                  verdict、judged_at
  nodes[]（树）           schedule（on-push | every N | manual）    target_sha（实测）
  fixtures               mode（来自包：gate/patrol/tree/…）        executor（哪个节点、引擎版本）
  不可变、可签名          state（draft→active→…，见 §5）           只追加
```

- **Pack** 沿用 `ygl-verifier-pack/1`，本文不改它的形状，只追加一条：包可以从登记表按 `name@version` 解析，不要求先装到项目根。这是对 pack 方案 D4 的补充，不是替代：项目根安装仍是本地开发的入口，登记表是舰队与生产的入口。
- **Instance** 的绑定要先规范化（JCS），再取哈希。哈希里只放决定判定的字段：包@版本、target 的 kind/repo/rev 规则、参数。负责人和节奏属于可变属性，不进身份，所以换负责人不会产生新实例。
- **Run** 复用现有的报告与归档（契约 1.2/1.3 不变），新增的只是「这次运行属于哪个实例、在哪个节点、用哪个引擎版本跑的」这层索引。

### 2.1 两层：全局规范与项目包（严格方案，#213）

> 属主 2026-11-04：「一种是全局的验证器规范，还有一种是项目级别的」「按你最严格的方案处理」。

| 层 | 管什么 | 放在哪里 | 谁能改 |
|---|---|---|---|
| **全局** | 所有验证器都要守的规矩：报到与包契约（`ygl-verifier-latest/1`、`ygl-verifier-pack/1`）、元验证 R1–R6、登记规则（D2–D4）、生命周期（D3）、全局包名单；以及平台维护的通用包（聚合、PR 门、发布审计） | **只在 ygl-trees**：源码（`GLOBAL_PACKS`、入口检查）、技能、本方案 | ygl-trees PR + 独立评审 |
| **项目** | 只属于一个项目的判据（如 webui 六视图、设计 tokens、a2a 运行面） | 项目自己的仓库 `verify/packs/<名>/`，一个项目一个目录 | 项目负责人，但必须满足全局层才能登记 |

规则（入口机械执行，不靠自觉）：

- **G1 全局规范只有一份。** 项目仓不复制、不改写全局规则；出现本地副本即视为漂移，巡检点名。
- **G2 不带作用域的名字是保留字。** `ygl-v-<名>` 只给全局包，名单写在 ygl-trees 源码 `GLOBAL_PACKS`，首批即 pack 方案 §4 的三个官方包：`ygl-v-core-aggregate`、`ygl-v-pr-gate`、`ygl-v-release-audit`。名单外的无作用域名字 → `verify instance create` rc2。
- **P1 项目包只验自己的项目。** 项目包写作 `@<项目>/ygl-v-<名>`；target 是 git 仓时，`<项目>` 必须等于目标仓名（小写），否则 rc2。全局包可以绑任何目标。
- **P2 项目包定义放在项目里。** `<项目仓>/verify/packs/<名>/`，是纯数据（清单、判据材料、树、夹具），不带编排脚本；不再新建独立验证器仓库（D4：不登记、不调度、不进汇总）。
- **P3 legacy 实例是项目级的过渡态。** 作用域 = 目标仓名；目标归不到 GitHub 项目（`path:`/`ref:`）的不导入（rc1）。S4 落地 30 天后关闭桥接，之后仍活跃的 legacy 实例由巡检点名。
- **作用域派生、不入库。** 由包名（或 legacy 目标）推出，`scope` = `global` 或项目名，随每个实例输出，`verify instance list --scope <s>` 按层筛；不加列，v13 表结构不变。

S4 之前（包还不能从登记表解析执行）：项目包的数据先按 P2 落在项目仓；执行暂用引擎原语链（`verify submit → prepare → run`，YGL_HOME 用项目仓 `tmp/`），**不得为此新建验证器仓库**；运行结果回交登记表随 S2（`verify run --instance`）接入。

## 3. 登记表（单一真源）

- **放在哪里**：一个 ygl-trees 工作区，后端为 PG。#176 的 PG 单写后端正好提供多节点共享同一份数据的能力；单机试点阶段可以先用 SQLite，见 §8 D1。
- **按期新增四张表**（加表要走九触点，见 conventions §一）：S0 建 `verifier_instances`、`verifier_runs`；`verifier_leases` 随 S2、`verifier_packs` 随 S4 再建，不提前建没人用的表：
  - `verifier_packs`：name、version、manifest_sha256、engine、contract_version、tags（domain/business/mode）、signature、状态。
  - `verifier_instances`：id（内容寻址）、pack_name、pack_version、binding_json、owner、schedule、state、created、updated、last_run_id、last_verdict、last_judged_at。
  - `verifier_runs`：run_id、instance_id、executor、engine_version、target_sha、verdict、payload_sha256、archive_sha256、judged_at。报告和归档的字节仍放在内容寻址的 blob 仓，表里只存指针。
  - `verifier_leases`：instance_id、node、expires_at。领取或续约时写入，过期自动释放，保证同一实例同一时刻只有一个执行者。
- **对外的面**：
  - CLI：`verify instance create | list | show | retire`、`verify lease claim | renew | release`、`verify run --instance <id>`（跑完自动回交）。
  - MCP / HTTP：只读查询默认开放；写入面默认关闭，与现有 HTTP 作业面同一口径。
- **`latest.json` 怎么办**：变成登记表上的一条查询（`instance show --json`）。过渡期由适配器把现有 `latest.json` 导入为运行记录，见 §6。
- **舰队聚合怎么办**：变成按 owner/tags/state 的分组查询。舰队验证器的 M1–M10 判据改为对登记表的 SQL 判据，不再挨个读成员仓库。

## 4. 节点：执行者

1. 节点按能力声明（引擎版本、能跑哪些 mode、能访问哪些 target）领取租约。
2. 领到之后，在临时工作区（`tmp/`，用完即删）里取包、取被验对象、执行。
3. 跑完把报告交回登记表：经 `verify report import` 的同一套校验（payload、归档、版本），只追加不修改。
4. 节点本机不留常驻验证器目录。重跑只需要包@版本和绑定，二者都在登记表里，所以任何具备能力的节点都能接手。单机损坏不会丢历史，因为历史在登记表里，不在节点上。

## 5. 生命周期与回收（规模化的关键）

| 状态 | 进入条件 | 退出条件 |
|---|---|---|
| `draft` | `instance create --draft`（试验） | 转为 `active`；超过 TTL（默认 7 天）未转正 → `archived` |
| `active` | 创建通过入口检查 | 连续 N 轮 PASS 且跨度达标 → `graduated`（复用 `verify graduate` 的资格口径） |
| `graduated` | 稳定，改为低频巡检节奏 | 出现 FAIL → 回到 `active` |
| `stale` | 超过 SLA 没有运行，或负责人不在 | 有人认领或重新调度 → `active`；超过宽限期 → `orphaned` |
| `orphaned` | 负责人消失、宽限期已过 | 被转派给池负责人 → `active`；否则 → `retired` |
| `retired` | 显式退役，或被同包更高版本取代 | 只读；超过保留期 → `archived` |
| `archived` | 运行记录按保留策略压缩 | 永久只读（报告和归档的 sha 仍可验） |

- **保留策略**：每个实例保留最近 K 次运行、每次结论翻转的那一次、以及每个发布对应的那一次，其余运行只留 sha 指针。字节因为内容寻址天然去重。
- **配额**：每个节点、每个负责人有活跃实例的上限，超出时入口拒收，并点名去哪里退役旧实例。量的增长必须伴随退场，否则表本身也会腐烂。

## 6. 迁移现有约 10 个仓库（不中断现有结论）

1. **桥接（不改任何仓）**：适配器读各仓的 `latest.json`，登记为 `kind: legacy-repo` 的实例，状态由导入的运行记录给出。舰队聚合先从登记表读，同时保留现在的读法做对照。
2. **抽包**：每个仓的 `specs/` + `tree.json` + 夹具 → 一个项目包 `@<项目>/ygl-v-<名>`，放回被验项目的 `verify/packs/<名>/`（§2.1 P1/P2）；跨项目通用的部分（如 aggregate）才进全局包，走 ygl-trees PR（pack 方案 VP-1/VP-2）。仓里的编排脚本在对应原语交付前留在原仓，作为 legacy 执行器。
3. **换绑**：用 `instance create` 为每个（包 × 被验对象）建实例，与 legacy 实例并跑 K 轮（与 SDK 计划的 A/B 口径一致）。结论连续一致后，legacy 实例转 `retired`。
4. **收仓**：原仓库只读归档（或作为包的源仓继续维护判据）。编排脚本随 §4.7 原语交付，按 sunset 退场。

## 7. 分期与验收判据

| 期 | 交付 | 验收（机器可检查） |
|---|---|---|
| **S0 登记表与入口** | `verifier_instances` + `verifier_runs`（schema v13，SQLite 与 PG 的 DDL / 升级步骤同步落地）+ `verify instance create/list/show/retire`，以及 `--json` 契约；内容寻址身份。按 D1，S0 只在 SQLite 工作区上开放，PG 模式下该命令 rc2 | 同一绑定创建两次 → 第二次 rc0 且 `duplicate:true`；缺 owner/target → rc2；表结构过九触点；`pnpm test` 全绿 |
| **S1 桥接** | legacy-repo 适配器：现有 `latest.json` → 运行记录；舰队聚合双读对照 | 舰队现有成员全部有实例，登记表上的聚合结论与现有舰队验证器连续 K 轮一致 |
| **S2 执行者** | 租约 claim/renew/release + `verify run --instance` 自动回交（复用 report import 校验） | 两个节点同时 claim 同一实例 → 只有一个成功；租约过期后另一节点可接；回交报告的 payload_sha256 与本地一致 |
| **S3 生命周期** | 状态机 + TTL + 保留策略 + 配额 + stale/orphaned 巡检 | 注入「过期草稿 / 无运行实例 / 负责人消失」三种夹具，各自只翻对应状态；超配额时入口 rc1 并点名 |
| **S4 包接入** | 从登记表解析 `ygl-v-*@ver`（pack 方案 VP-1/2/3），新实例只能绑已登记的包 | 未登记或未签名的包 → 入口拒收；包钉版与 spec sha256 不符 → 拒收 |
| **S5 收仓** | 现有仓库全部换绑为 pack 实例，legacy 实例退役；编排脚本随原语交付退场 | 登记表中 `kind: legacy-repo` 的活跃实例数为 0；舰队 M 判据全部由登记表计算 |

S0–S1 不依赖任何未交付的原语，可以立即开工；S2 起与 SDK-2 的 `tree run`、SDK-4 的 `collect` 并行推进。

## 8. 裁定事项

> **2026-11-04 监督席裁定**（属主同日授权「继续，由你独立完成」）：D1–D5 均按下表「本席建议」执行；属主可随时推翻，推翻时改本表并同步各期 issue。


| # | 事项 | 本席建议 |
|---|---|---|
| D1 | 登记表后端：中央 PG，还是单机 SQLite 起步 | S0 用单机 SQLite 试点，放在监督席所在主机；S2 起切到 PG（#176 已具备单写后端） |
| D2 | 登记表的唯一写者：谁能 create/retire | 入口命令对所有节点开放，但需负责人身份；retire 他人实例需要池负责人或属主口令 |
| D3 | 草稿 TTL、stale SLA、保留 K 值、配额 | TTL 7 天；SLA 为节奏的 3 倍；K = 20；每个负责人 50 个活跃实例 |
| D4 | 未登记的手搭验证器如何处置 | 不封禁执行，但不调度、不进汇总、巡检时点名；30 天后在舰队报告里列为待清理 |
| D5 | 登记表本身的备份 | `db export` 每日一次 + PG 镜像；不要求每个包或实例各自有远端 |

## 9. 风险

- **登记表成为单点**：S2 起用 PG 并开启镜像；节点在登记表不可用时只能跑已领取的租约，不能新建实例，宁可停也不分叉。
- **桥接期双轨口径不一**：S1 的验收要求两边结论连续 K 轮一致，不一致即停在 S1。
- **配额误伤**：配额只限制活跃实例；草稿与退役实例不计入；超额时点名具体实例，而不是笼统拒绝。
- **包质量不稳**：入口强制 `pack lint`（pack 方案 §4.3）与签名，不符即拒，与 0.113.0 的 meta 硬拒收同一做法。
