---
name: ygl-trees-verify
description: >-
  ygl-trees spec-validator 验证器（M13，0.96→0.116）：把「业务规范」变成可执行、可复核、零人工确认的验证器——
  业务方交一段话+附件（submit 冻结材料）→ agent 构造判据（prepare P0–P5：提取/盲审/红队/守卫，出 spec）
  → 引擎在数据库快照副本上跑七型检查器（sql/sql-pair/count/exists/file/command/agent）出报告（run）
  → 归档成可带走的确定性 zip（archive，默认必做）+ 封包签名（ed25519，认表不认报文）+ 递归自校验（self-check）。
  触发词：验证器、spec-validator、yglverify、submit、prepare、run、report、trace、archive、
  self-check、sealed、封包、签名、ed25519、黄金语料、corpus、contract_version、NEEDS-MATERIAL、
  P0-P5、红队、盲审、判据、检查器、witness、报告看板、WebUI 三视图、verify:run。
version: 0.118.0
tags: ygl-trees,verify,spec-validator,sealed,archive,corpus,signature
---

# ygl-trees spec-validator（验证器）

## MCP 等价面（AI agent 用 verify 代替 CLI verify 命令组）

| CLI 命令 | MCP 调用 |
|---|---|
| `verify submit --title t --text f` | `verify {action:"submit", a:"t", b:"<file>"}` |
| `verify prepare <mat-id> --candidates c --reviews r --db d` | `verify {action:"prepare", a:"<mat-id>", b:"<cand>", c:"<rev>", db:"<db>"}` |
| `verify run <spec-id> --db d` | `verify {action:"run", a:"<spec-id>", b:"<db>"}` |
| `verify report <run-id>` | `verify {action:"report", a:"<run-id>"}` |
| `verify archive verify <file>` | `verify {action:"archive", a:"<file>"}` |
| `verify meta <repo>` | `verify {action:"meta", a:"<repo>"}` |
| `verify tree prepare/run/report/trace` | **无 MCP 路由**（CLI-only；C 类路由缺口） |

## 1. 何时用

- 要把一条**业务规范**（"报销单必须……"、"上线前必须……"）变成**可机器执行、可复核**的验证器；
- 要复核别人给的验证结论：报告是"谁在哪台机器跑出来的"必须可证（跑 → 归档 → 验包 → 认签名）；
- 要在自己的工作区里验证"这个工作台/这份数据"是否满足一批判据。

**不适用**：需要人工拍板的决策（判定链上**没有**确认按钮，这是设计）、纯文本检查（用 `kb`/`claim`）。

## 2. 一条链（每步都可单独重跑）

```bash
ygl-trees verify submit --title "报销规范 v1" --text ./规范.md
# → material_id（正文+附件各带 sha256 冻结；同内容重跑幂等返回同一 id）
ygl-trees verify submit --title t --text - --attach ./样本.csv      # 附件走 blob 仓 {sha256} 引用

ygl-trees verify prepare <material-id> --candidates <c.json> --reviews <r.json> --db <snapshot.sqlite> --as-of <ISO-8601>
                                                # rc=0 仅当 ready；P1/P2 阻断、灰带进 open
ygl-trees verify prepare <material-id> --candidates <c.json> --reviews <r.json> --db <snapshot.sqlite> --draft
                                                # 无损试跑：照构造但**不冻结** spec 版本
ygl-trees verify trace <spec-id>                # 构造追溯：清单/判据↔检查器表/盲审与红队结论（只读）

ygl-trees verify run <spec-id> --db snapshot.sqlite   # FAIL 也是 rc=0，看 overall/summary
ygl-trees verify report <run-id>                # 人类可读；--json 机器读
ygl-trees verify list                           # 工作区全部 spec/run 概览
```

- **退出码**：`run` 只用 rc 表达**过程错误**；`overall=FAIL` 仍 rc=0（判定不是程序失败）。
  `prepare` 用 rc 表达"能不能跑"：`ready=false` → rc=1，用法错 → 2。
- **零人工确认**：`trace` 是审计面不是审批面。想改判据 = 改材料重新 submit → 新 spec → 新 run。
- **快照纪律**：`run --db` 指向**副本**；引擎只读打开（`PRAGMA query_only`），不碰源库。
- **--db 重复给值**（0.116.0/#91）：单库命令**末值胜**（`lastFlagOf`——`db stats --db a --db b` 读 b）；
  仅 `verify tree run` 保留多 `--db` 分叶绑库的数组形。

```bash
ygl-trees verify:run   # 组合入口：submit → prepare → run 串接（rc 只表达过程错误）
```

## 2c. 递归验证器（verify tree，0.115.0 / A1 v1.2）

一条树 = 多个叶 spec 的**后序递归执行**（叶真跑+归档，父按算子聚合）。材料正文是 tree JSON：

```json
{
  "tree_spec_id": "ts_x", "tree_spec_version": 1, "title": "口径树", "root": "agg",
  "target": { "kind": "sqlite-snapshot", "id": "ledger-a" },          // Q8：冻结进 canonical
  "subject": { "repo": "r1", "commit": "c1" },                        // Q8：同上（不校验实况）
  "engine_version": "0.115.0",                                        // G8：版本 pin（prepare 期与实况不符 → rc2）
  "nodes": [
    { "id": "leaf1", "kind": "leaf", "spec_id": "spec_a" },
    { "id": "agg", "kind": "agg", "op": "all_pass", "children": ["leaf1"] }
  ]
}
```

```bash
ygl-trees verify tree prepare <material-id> [--pinned leaf1=sha256:…]   # 环/空/深度/算子检查后冻结
ygl-trees verify tree run <tree-spec-id> --db snap.sqlite [--db node2=…] [--no-archive]
ygl-trees verify tree report <tree-run-id>     # 五值报告（nodes[] 带 per-node verdict）
ygl-trees verify tree trace <tree-spec-id>     # 构造追溯
ygl-trees db snapshot                          # 快照产物（sha256+脱敏来源；B5）
```

**五值全序**（`report.overall` 叶仍是四值 + `report_verdict`；树面是五值）：
`NEUTRALIZED > STALE > FAIL > INFRA_BLOCKED > PASS`
- **cap-on-PASS**：任一子 ERROR/INFRA_BLOCKED 只**封顶 PASS**（不降级 FAIL）——`FAIL+ERROR=FAIL`
- quorum 分母只计 PASS+FAIL；STALE 沿父链传播并阻断 PASS
- ERROR/NEEDS-MATERIAL 的叶映射为 `INFRA_BLOCKED`（不泄漏进 nodes[].verdict 的 FAIL 语义）

**pinned 叶**（引用已完成 run 的归档，不重跑）：
- 必须来自**本 workspace 已完成的 run**：`Q13-A` 跨 workspace 拒绝、找不到时点名两条指引 → rc2
- `Q12-B` 同轮自引用拒绝：归档 created ≥ 本轮 start → rc2（防自证）
- pinned 报告参与 target/spec_version 比对（Q8/Q9）；缺字段 fail-closed STALE

**常见 tree 报错**：`same-round self-reference`（Q12-B）/ `cross-workspace`（Q13-A）→ rc2；
`G8: tree spec pins …`（版本不符）→ rc2；`pinned target mismatch` / `spec_version drift` → 该叶 STALE。

## 2d. 验证器仓库布局与多验证器组织

> **新建验证器不再建仓库（#205 / #213，严格）。** 验证器分两层：
> - **全局规范只在 ygl-trees**（契约、R1–R6、登记规则、生命周期、全局包名单）。项目仓不复制、不改写；不带作用域的 `ygl-v-<名>` 只给全局包（`ygl-v-core-aggregate`、`ygl-v-pr-gate`、`ygl-v-release-audit`），新增全局包走 ygl-trees PR。
> - **项目判据写成项目包** `@<项目>/ygl-v-<名>`，放在**项目自己仓库**的 `verify/packs/<名>/`（一个项目一个目录，纯数据：清单、判据材料、树、夹具，不带编排），再用登记入口（verify instance create，#210 起提供）登记成实例。target 是 git 仓时作用域必须等于目标仓名——项目验证器只验自己的项目。
> - S4 之前包还不能从登记表执行：执行暂用 `verify submit` → `verify prepare` → `verify run`（YGL_HOME 用项目仓 `tmp/`），**不为此新建验证器仓库**。
>
> 下面的独立仓库布局只描述**现存 legacy 仓**（S1 桥接、S5 收仓的过渡态），用于维护它们，不得照着新建。

```text
<项目仓>/verify/packs/<名>/      项目包（包名 @<项目>/ygl-v-<名>）
├── pack.json                    清单 ygl-verifier-pack/1：钉 spec_id@spec_version + sha256、引擎、tags
├── specs/<叶名>/                material.md + candidates.json + reviews.json
├── tree.json                    叶子组织
└── fixtures/good/               已知良好夹具（selfcheck 用）
```

legacy 验证器仓（现存的，一个独立 git 仓库，舰队惯例 `~/workspace/<名>-verifier`）只放材料、构造输入、探针与编排，不放被验对象。
规则来源：硬规则 = `docs/validator-charter.md` §4.4（R1–R6，`verify meta` 机械检查）；目录惯例 = 舰队各仓现行一致形态。

```text
<名>-verifier/
├── AGENTS.md                    【R1 硬】仓库根必须有
├── package.json                 引擎 = npm 精确钉版的 ygl-trees（不 vendor/fork 引擎：R6⑦）
├── verify/
│   ├── meta.json                【R2 硬】唯一索引：meta_index_version、specs、orchestration[]、tooling[]（v3 加 kind）
│   ├── registration.json        编排/工具登记表（人工维护、随 commit 评审）；门禁脚本据此算 sha256 写 meta.json
│   ├── specs/*.yglverify.json   现行冻结 spec 的导出件（重冻后再导出，不手改）
│   └── orchestration/           【R3/R5a 硬】所有驱动验证的脚本只能在此，逐条登记 sha256 + replaced_by + sunset
├── specs/
│   ├── index.json               叶名 → 标题/领域
│   └── <叶名>/                  material.md（逐条带条目号的判据）+ candidates.json + reviews.json
├── tree.json                    仓内递归结构（组节点 + 叶节点）
├── tools/                       构造面与索引门禁脚本（登记为 tooling[]，不得产出验证判定）
├── tests/fixtures/good/         selfcheck 的已知良好夹具
├── ledger/  collected/  outbox/ 入账：结论变了才提交（冻结 spec、节点报告、归档 zip 与 zip_sha256）
├── work/results/latest.json     对外结果（gitignored），契约 ygl-verifier-latest/1
└── state/home/                  本仓 YGL_HOME（gitignored）——不碰个人 ~/.ygl-trees
```

**硬规则要点**（`verify meta` 判，FAIL = submit/prepare 拒收）：
- **R3**：已跟踪的可执行文件（`.mjs/.js/.cjs/.sh/.ps1/.py/.ts/.mts/.cts`）必须属于以下之一：gitignored 的 `tmp/`（探索区唯一白名单）、依赖根（`node_modules/`、`vendor/`）、`orchestration[]`、`tooling[]`，或 `verify/meta.json` 的 `source_roots[]` 声明的**具名产品源码子目录**（只能是具名子目录，禁 `.`、空串、绝对路径、`..`；仓库**根级**文件不受任何 source_root 覆盖，仍要逐个登记）。有真实产品源码的仓库用 `source_roots[]` 声明源码根，不要把源码逐文件登记或挪进编排目录。列有 spec 的仓库里，**`tooling[]` 文件不得驱动 verify run/prepare/submit/archive**——驱动验证的代码只能登记在 `orchestration[]`。
- **R5a**：`orchestration[]` 每条的 `replaced_by` 必须是 charter §4.7 第二列的 CLI 原语之一，`sunset` 为完整 semver（尚未交付的原语暂记远值，如 99.0.0）。
- **R6（只对 v3 索引执行）**：v3 必须声明 `kind`；验证器仓库属 **consumer** 档——引擎钉版不低于契约下限、仓内不 vendor 引擎、**`orchestration[]` 也不得再驱动 verify**（须改用引擎原语）。现行舰队仓都是 v2 索引，R6 不执行，编排登记后仍可调用 verify；升 v3 前先完成迁移。
- 改了登记过的文件：先刷新索引（或按仓内门禁脚本重登记），再提交。判红归属：**tooling 文件**正文与登记 sha256 不符 → R3（`registered tooling sha256 mismatch`）；**orchestration 文件**正文与登记不符 → R5a；手改索引导致形状或谱系不符 → R2。

```bash
ygl-trees verify meta .                  # 本仓 R1–R6 准入自检（仓库根执行；YGL_HOME 指向 state/home）
ygl-trees verify lint-candidates specs/<叶名>/candidates.json --text specs/<叶名>/material.md --reviews specs/<叶名>/reviews.json
```

### 多验证器：两层组合

**① 仓内多叶子**（一个领域内拆多份 spec）：
- 每份判据一个 `specs/<叶名>/`，一份材料冻结成一个 spec；`tree.json` 把叶子组织成树，组节点复用同一份 aggregate spec。
- **同一份 spec 可挂多个节点**，用 `params` 区分绑定（如同一 `unit` 叶分别跑默认检出与 CRLF 检出）：规格 × 绑定 = 节点。
- 注意两种树不是同一格式：仓内 `tree.json`（`id`/`children`/`spec`/`params`，由仓内编排后序聚合）≠ 引擎 `verify tree` 材料（`nodes[]`/`kind`/`op`/`root`，见 §2c）。迁到引擎树前，两者不可混写。

**② 跨仓（舰队）**：
- 每个工作会话持有**自己的**验证器仓；仓与仓之间只通过 `work/results/latest.json` 交换结论，不互相读内部文件。
- 契约 `ygl-verifier-latest/1`：`{contract, verifier, repo, goal, target{repo,rev,sha}, overall, root_run_id, judged_at, archive, result_file, selfcheck{cases,pass,base}, checked_at?}`；`goal` 必须一句话写明目标，`checked_at` 只用于目标未变的比对轮次。
- 聚合仓（如 ygl-fleet-verifier）用 `fleet.json` 列成员（id、verifier、owner、latest 的相对路径），用**一份 member spec 挂所有成员**，逐成员判：报到、根结论 PASS、时效、根归档自校验、自检、目标、测的是被验分支当前提交、引擎钉版、元验证。根 = 全舰队合取。
- 引擎 `verify tree` **不跨 workspace**（`cross-workspace` → rc2），跨仓引入外部报告的原语（import-report）仍是 unshipped；所以跨仓聚合目前由聚合仓的编排读 latest.json 完成，并用 `verify archive verify` 校验成员根归档。

**新建一个验证器的最小清单（#213 起）**：先定层——通用于所有项目的，提 ygl-trees PR 进全局包名单；否则是项目包 → 在被验项目仓建 `verify/packs/<名>/`（清单 + `specs/<叶名>/` 三件 + 树 + 好夹具）→ 用登记入口 verify instance create 登记（包名 @<项目>/ygl-v-<名>@<semver>，target 写 git:<owner>/<项目>，必填负责人）。**不建新仓库**。

**维护现存 legacy 仓的清单**（只用于已有的仓）：AGENTS.md → `package.json` 钉引擎 → `verify/meta.json` + `verify/registration.json` → `specs/<叶名>/` 三件 → 编排进 `verify/orchestration/` 并登记 → 好夹具与 selfcheck → `ygl-trees verify meta .` PASS → 每轮写 `latest.json` → 交聚合仓登记到 `fleet.json`，并由 S1 的桥（verify instance import-latest）导入登记表。

## 3. 检查器七型与 witnesses

| 类型 | 判据 | witness 看点 |
|---|---|---|
| `sql` | 结果集断言（`compare` 八型：eq/ne/gt/gte/lt/lte/in/empty…） | `rows_scanned`/`rows_matched` + 比较值 |
| `sql-pair` | 互斥/一致性（keys 与 violations 两查） | `keys` 数与 `violations` 数 |
| `count` | 聚合计数（别名 `agg_alias`） | 计数值与期望 |
| `exists` | 行存在性 | 命中行数 |
| `file` | 文件集断言（`root` 白名单 + `ignore` glob 排除集） | 命中文件清单 |
| `command` | 白名单命令（`commandAllowlist`，超集拒绝） | stdout/rc |
| `agent` | 需网关的语义判定（无凭证 → `ERROR`，不当 PASS） | 判定原文 |

SQL 三种写法统一：单语句 SELECT/WITH 走 `SqliteRunner.query`；`sql-pair` 拆两查；`agent` 只经网关。

## 2b. 构造输入 schema（prepare 的 candidates / reviews）

`prepare` 只吃**谓词 AST 候选**，不是 `verify example` 打印的 spec VU。最小候选：

```json
[
  {
    "source_clause": "S1 订单金额不得为负。",
    "anchor": { "quote": "S1 订单金额不得为负。", "locator": "material.md#S1" },
    "checker": { "type": "count", "predicate": { "from": "claims", "select": ["id"] }, "op": ">=", "value": 1 }
  }
]
```

- 候选字段推荐 `anchor: {quote, locator}`；`expected_from` 是冻结 spec / `verify example` 的 VU 形状（p1 现接受它作别名，但 `verify example` 的 `candidates[]` 已是 `anchor`，照抄 `vu` 仍可能带 raw `sql` 而被 P2 拒）。`id`/`vu_id` 不要自己写，prepare 生成 `C1..`。
- 检查器只收 predicate AST：`count`/`exists` 用 `predicate`，`sql` 用 `predicate` + `fail_when`（`rows>0` 找违规）；**不收手写 SQL**（`sql` 字符串、`sql` 字段、`authored` 都会被拒）。
- 零违规断言不要写 `count == 0`（空库 0==0 会被 P4 红队判 vacuous pass）：用 `sql` + `fail_when:"rows>0"` 扫违规行（空库得 NEEDS-MATERIAL）；正整数用 `count` + `op:">="`。
- 先探：`verify lint-candidates <candidates.json> --text <material> --reviews <reviews.json> [--db snapshot.sqlite] --json`；失败看 `issues[].reason`（P1 逐字/定位、P2 schema、P4 红队方向）。

reviews 最小形状：

```json
{
  "reviews": [
    {
      "source_clause": "S1 订单金额不得为负。",
      "findings": [
        { "question": "faithful", "verdict": "ok", "reason": "逐字复读", "anchor": { "quote": "S1 订单金额不得为负。", "locator": "material.md#S1" } },
        { "question": "decidable", "verdict": "ok", "reason": "predicate AST 可判定" },
        { "question": "not-vacuous", "verdict": "ok", "reason": "空库 0<1 → FAIL" }
      ]
    }
  ]
}
```

- `question` 闭集：`faithful` / `decidable` / `not-vacuous`（缺一即 P3 fail）。
- `verdict` 闭集：`ok` / `reject` / `unclear`——没有 pass/approve/clear；写别的报「unknown verdict」。
- 每条 finding 必须有 `reason`；`faithful` 必须带 `anchor`（quote 与材料逐字一致）；`vu_id` 由 prepare 注入，不要写。
- `source_clause` 与候选**逐字节相同**（fileReviewer 用 `===` 查找；差一个空格就「self-review incomplete」）。

## 4. 归档与封包（可复核性的载体）

```bash
ygl-trees verify archive <run-id|spec-id>            # 默认必做；--no-archive 才关
ygl-trees verify archive <run-id> --snapshot db.sqlite   # 跨实现复跑需要快照
ygl-trees verify archive <run-id> --with materials       # 带上材料字节（附件从 blob 仓按 sha 取）
ygl-trees verify archive verify <file.zip>           # 全链重算：footer→文件树→报告哈希
ygl-trees verify list --unarchived                   # 找漏归档的 run
```

- 归档 = **确定性 zip**（store-only、无时间戳/无权限位）+ 报告 + spec + 清单；同一 run 两次归档**逐字节相同**。
- 报告**不可变**：归档身份写侧车 `$YGL_HOME/verify/archives/<run_id>.json`，不改报告本体。
- 边车键：`$YGL_HOME/verify/registrations/<sha256>.json`（register 时写入）。

### 保留策略（#222）：别让验证工作区无限长

每次 `verify run` 都会留下报告、归档 zip 和快照，默认永不清理；高频跑的验证器一个月就能涨到几十 GiB，大头是自检注入用例这类非结论运行。`verify prune` 是通用解：任何节点装了 ygl-trees 就能用，不需要先 `db init`；它在 CLI 启动工作区之前执行，不打开、不新建、不迁移任何数据库（本工作区的登记表只以只读方式读 run id，库坏了就 rc=1 报错，绝不当成「没有钉住」）。

```bash
ygl-trees verify prune                                   # 本工作区试跑：只列保留/删除计数与可腾出的字节，不动任何文件
ygl-trees verify prune --repo <verifier-repo>            # 验证器仓库试跑（可写多个 --repo，一次看完本节点所有验证器）
ygl-trees verify prune --repo <verifier-repo> --apply    # 认可清单后真删；每个仓库在 verify/prune-log.jsonl 追加一行摘要
ygl-trees verify prune --keep-last 20 --keep-flips 0     # 每个 spec 留最近 20 份，不额外保留结论翻转
ygl-trees verify prune --keep-runs-in <pins-file>        # 额外钉住某个文件/目录内容里出现的每个 run id
```

- **保留规则**（任一成立就留）：最近 N 份（`--keep-last`，默认 10）、最近 F 次结论翻转的两侧（`--keep-flips`，默认 10，0 = 不留）、每个 `spec_version` 的首份、被钉住（`--keep-runs-in` 的文件/目录——任何文件类型都扫，SQL/数据库/zip 里的 run id 也算，粘着更多十六进制的 id 按 16/12 位前缀认、毕业记录、树报告、读不懂的报告里出现的 id、登记表 `verifier_runs`）、**被引用**（保留运行的快照里点名的运行——汇总的子运行——传递地保留）、`--min-age-minutes` 内刚跑完的（默认 60，护住正在跑的探针）、读不懂的报告（永不删）。
- **删什么**：被删运行的报告、归档侧车、侧车列出的 zip（**真实路径**——解开符号链接/junction 后——必须在 `archives/` 里；任何仍留着的侧车（含读不懂的报告与无主侧车）还列着的 zip 不删）、删完报告后磁盘上已无报告引用的快照（报告删失败时它的快照留着，重跑接着收）。无主快照只计数不删。
- **`--repo` 认的仓库形状**（舰队约定）：`state/home/verify`（被清理的 verify 根）+ `work/results/latest.json`（契约 `ygl-verifier-latest/1`）+ 可选 `ledger/`。钉住来源是**整个仓库**：`state/`、`.git/`、`node_modules/` 之外的每个文件，任何类型（`ledger.sql`、账本库、`data/` 里的记录、结果、账本 zip 都算）；只排除自检的工作副本（`work/` 下 `selfcheck-*` 目录）和自检历史。自检历史 `work/results/selfcheck-<用例>--run_<id>.json` 每个用例留最新一份，其余一并列为可删。形状不对 rc=2，`latest.json` 契约不对 rc=1，都在删任何东西之前。
- **钉住要钉对**：`--keep-runs-in` 扫的是文件内容里的 `run_…`，目录只扫文本扩展名；路径不存在 rc=2（打错路径会让本该钉住的运行被删，所以按用法错误先拒）。
- 先试跑看清单，再 `--apply`；`--apply` 会同步 `verify list` 索引。

**节点落地三步**（任何机器、任何操作系统同样适用）：
1. 装上含 `verify prune` 的 ygl-trees 版本，对本节点每个验证器仓库各带一个 `--repo` 试跑一次，看清单；
2. 节点属主认可后加 `--apply` 清一次存量；
3. 常驻：每轮编排收尾跑一次 `verify prune --repo . --apply`，或登记成作业 `ygl-trees job add verify-prune --every 1440 -- "ygl-trees verify prune --repo <verifier-repo> --apply"` 再由 `job tick` 驱动。源头上，自检注入用例的 `verify run` 加 `--no-archive`（它们不是结论，latest.json 也不收），归档就不会再按用例数翻倍。

### 跨机器回装冻结件

`verify export` 默认只导出裸 spec；需要在新工作区继续验证时必须加 `--portable`：

```bash
ygl-trees verify export <spec-id> --portable --out frozen.yglverify.json
ygl-trees verify import frozen.yglverify.json
```

便携件包含冻结 spec、prepare 记录、材料与附件；导入按清单逐项核对内容哈希，保留原 `spec_id`、`spec_version`、`as_of`，不是重新 prepare。重复导入返回 rc0 与 `duplicate:true`；同标识冲突字节 rc1、不覆盖原件；裸 spec 不能替代便携件。CLI 支持这两条命令；本节不声明 MCP 已开放对应路由。完整运行仍需相应业务快照。

## 5. 封包 + 签名（认表不认报文）

```bash
# 可信密钥表由发布负责人维护（运维资产，CLI 不生成）：--keys <file> > $YGL_VERIFY_KEYS >
# $YGL_HOME/verify/keys/signing-keys.json；格式与轮换见 docs/verify-signing.md
ygl-trees verify signature <sealed-binary> [--keys <file>] [--expect-key <hex|file>]
ygl-trees verify register <sealed-binary>  # footer 链 → registrations/ + binaries/
```

- 封包二进制 = 正常入口 + **ed25519 footer**（`sig_alg`/`key_id`/`sig` + 载荷哈希）。签名覆盖
  **二进制本体 + 载荷**；验签只认**工作区密钥表**（不信任报文里自报的 key）。
- **发布物应要求 `signed` 登记**：`legacy`（无签名）= 可跑但不构成"可信发布"；报告里 `signature.sealed`
  如实写 `signed|legacy`。0.98 及以前的 legacy 产物按 legacy 语义放行（`--expect-key` 不参与）。
- 换密钥 = 新 key_id + 双签过渡期；旧 run 的签名仍可验（密钥表保留历史公钥）。

## 6. 递归自校验（发布门禁）

```bash
ygl-trees verify self-check                  # 六环：environment → canonical 向量 → 语料摘要 → 形状
                                            #      → 语料实跑（33 例）→ 归档重算
ygl-trees verify self-check --corpus <dir>   # 发布产物无语料时显式 skip 并提示
ygl-trees verify self-check --no-cases       # 只跑前四环（无内核环境时）
```

**SKIP ≠ OK**：跳过的环在输出里写 `skip` 并给原因，绝不冒充通过。语料摘要（`corpus_version`）与
`contract_version` 是跨实现一致性的钉：改判据形状/封包形状就要 bump 版本，TS 与 Rust 同时改。

## 7. WebUI 三视图（0.100+）

`ygl-trees webui serve` 后开 `/verify`：

- **材料提交**：标题 + 一段话 + 附件上传（`PUT /api/verify/blob` 内容寻址；上传门**默认关**，
  serve 回环显式开；`0.0.0.0` 暴露需 `YGL_VERIFY_ALLOW_UPLOAD=1`）。
- **构造追溯**：只读审计（清单/材料原文/构造结论/判据↔检查器表）。
- **报告看板**：FAIL 与 NEEDS-MATERIAL 置顶为处置清单；坏报告**静默跳过是显式决定**（单条诊断走
  `verify report <run>`）——将来加"N 条损坏"脚注走旁路计数。

**作业式 prepare/run（0.102.0，默认关）**：`webui serve --enable-verify-jobs` 才开，否则 403。
`POST /api/verify/prepare` 收 `{material_id, candidates, reviews, snapshot_sha256, draft?, as_of?}`（`as_of`=构造方钉的时点；0.102.4 起**严格 ISO**——纯日期或带显式时区才收，归一 `toISOString()`（`+08` 转 UTC），无时区/空格/非法日历 HTTP 400 / CLI rc=2，不落盘不耗版本）；
`POST /api/verify/run` 收 `{spec_id, snapshot_sha256, no_archive?}`。三条铁律：请求体**不带可执行面**
（夹 `submission_dir` 直接 400；command 白名单由 serve 注入 `YGL_VERIFY_ALLOW_CMD`——**未设置才默认
`node`，设空串 = 显式空表**，所有 command 型 VU 判 ERROR，fail-closed）、
快照**只能内容寻址**（先 PUT blob 再传 sha）、run **只碰副本**（报告 `data_source.source = blob:<sha12>`）。
状态码只表达过程（400/404/405/413/415/422），PASS/FAIL 都是 200；归档失败记 `archive_error`。
网关边界如实：jev 只回布尔概率、不产锚点引文，喂不进 `ReviewRunner`——agent 型 VU 在 HTTP 面仍
ERROR/NEEDS-MATERIAL，要 agent 型就自己实现带引文的 reviewer 走 CLI 注入。

## 7b. 毕业通道（0.103.0）

一次性验证只证明「当时对」，常驻检查才证明「一直对」。`verify graduate` 把资格冻结 + 绑定调度：

```bash
ygl-trees verify graduate spec_xxx                            # 只看资格（默认 3 份连续 PASS、跨度 ≥30 天）
ygl-trees verify graduate spec_xxx --min-runs 5 --min-span-days 14
ygl-trees verify graduate spec_xxx --every 1440 --schedule    # 真的登记作业（每天跑一次）
ygl-trees verify graduate spec_xxx --patrol                   # 仅当被验库 == 工作区库
```

- 资格：同一 `spec_version`、最近 N 份报告全 `overall=PASS`、首末跨度 ≥ M 天。**跨版本不算连续**；拒绝时逐条点名（rc=1，不落盘）。
- 冻结：`$YGL_HOME/verify/graduations/<spec_id>.json`；同核心重跑 `duplicate:true`（保留首次 `created`），不同形状**拒绝覆盖**（要改必须显式删文件）。
- 执行：`job_command` 固定 `ygl-trees verify run <spec> --db "<source>" --no-archive`，`<source>` 取毕业报告 `data_source.source`；`--schedule` 才登记，默认只打印。
- `--patrol` 只在「被验库 == 工作区库」放行——patrol 跑工作区库、VU 判被验快照，库不对源时生成半对的检查更危险。
- 历史摘要：记录与 JSON 带 `history {reports_same_version, non_pass, last_non_pass}`——资格只看最近 N 份（历史 FAIL 不否决），但审计者能看到它曾失败。
- 来源可执行性：报告 `data_source.source` 是 `blob:<sha12>` 时**不能当 `--db`**——`--schedule` 会拒绝登记，需要 `--db <file>` 显式指定常驻库。

## 7c. 验证器登记表（verify instance，#206 · 规模化 S0）

验证器实例 = 登记表里的一行（包@版本 × 被验对象 × 参数），**不是一个 git 仓库**；新建验证器走这里，不手搭目录。
方案见 `docs/reviews/verifier-scale-plan.md`（包 / 实例 / 运行三分）。

```bash
ygl-trees verify instance create --pack ygl-v-core-aggregate@1.0.0 --target git:owner/repo --rev origin/master --owner <who> [--param k=v] [--schedule on-push] [--draft]
ygl-trees verify instance create --pack @repo/ygl-v-webui@1.0.0 --target git:owner/repo --rev origin/master --owner <who>   # 项目包：作用域 = 目标仓名
ygl-trees verify instance list --owner <who> --state active
ygl-trees verify instance list --scope global
ygl-trees verify instance show <instance-id>
ygl-trees verify instance retire <instance-id> --reason "superseded by 2.0.0"
```

- **身份按内容寻址**：`identity_sha256` = sha256(JCS{pack, version, target, rev, params})，`id` = `vi_` + 前 24 位。同一绑定再建 → rc0 `duplicate:true`（参数顺序无关）；`--owner` / `--schedule` 不进身份，换了就原地更新，`updated` 点名。
- 包名硬性 `ygl-v-` 前缀，版本必须完整 semver；target 写成 `<kind>:<ref>`（如 `git:owner/repo`、`sqlite:<path>`）。
- **两层（#213，严格）**：不带作用域的 `ygl-v-<名>` 只给全局包，名单写死在 ygl-trees 源码里（`ygl-v-core-aggregate`、`ygl-v-pr-gate`、`ygl-v-release-audit`），名单外 rc2；其余一律是项目包 `@<项目>/ygl-v-<名>`，target 是 git 仓时 `<项目>` 必须等于目标仓名（小写），对不上 rc2——项目验证器只验自己的项目。全局包可绑任何目标。
- 每个实例带 `scope`（`global` 或项目名，从包名推出、不入库）；`verify instance list --scope <项目|global>` 按层筛。
- `show` / `list` 带 `last_run_id` / `last_verdict` / `last_judged_at`（来自运行记录；还没跑过为 null）；`show` 另带 `runs`：最近 20 轮（新在前）。
- 退役不删行：`retire` 后仍可读；重复退役 `duplicate:true`。
- 用法错误一律 rc2 单 JSON，先于开库（子命令不读的旗标也算，如 `create --state`）；**PG 模式下 S0 不开放**（rc2），PG 随 S2 落地。

**旧验证器仓库的桥（#207 · S1）**：已经在跑的仓库式验证器不用改，把它写出的 `latest.json` 导进登记表即可：

```bash
ygl-trees verify instance import-latest ../ygl-webui-verifier/work/results/latest.json --owner <who>
```

- 只收 `ygl-verifier-latest/1`：`contract`、`verifier`、`target.repo|repo_url`、`target.rev`、`target.sha`、`overall`（PASS/FAIL/NEEDS-MATERIAL/ERROR）、`root_run_id`（`run_<hex>`）、`judged_at`（ISO）缺一项就 rc1、逐项点名、**不写入**。
- 实例 `kind: legacy-repo`、`pack` = 验证器名、`pack_version: legacy`；target 先认 GitHub 上游（`repo_url` → 本地检出的 `.git/config` origin），没有上游才落 `path:`，所以不同机器、不同检出路径的同一验证器落到同一实例。
- 运行 id 就是 `root_run_id`：同一轮再导入 rc0 `duplicate:true`；这个 id 已挂在别的实例下 → rc1。
- legacy 实例属于项目级，`scope` = 目标仓名；target 归不到 GitHub 项目（落成 `path:`/`ref:`）→ rc1、不写入（#213 P3）。桥是过渡态：S4 包登记落地 30 天后关闭。
- 归档 / 结果文件存在就现算 sha256；找不到时 `archive_ok:false` 照样导入（如实标出，不拒收）。相对路径按 latest.json 里的 `repo` 解析。

## 8. 常见坑

| 现象 | 原因/处理 |
|---|---|
| `verify list` 越来越慢 / `$YGL_HOME/verify` 或验证器仓库 `state/home` 几十 GiB | 报告/归档/快照默认永不清理；先 `verify prune`（验证器仓库用 `--repo <verifier-repo>`）试跑看能腾多少，认可后 `--apply`（§4 保留策略） |
| `prepare` rc=1 但没说错在哪 | 看 `--json` 的 `open[]`/`blocking[]`；P1/P2 阻断会点名字段 |
| `run` 报 `no such table` | 快照库不对/没建表——`--db` 要给**真快照**不是主库 |
| 报告 `overall=ERROR` 且 agent 检查器全错 | 网关凭证没配：环境变量 `AI_GATEWAY_API_KEY` 或 `~/.vercel.ai-gateway.env`（config 键 `decision_model_llm_token` 也会被读，但不推荐存凭证，见 eval-gates §5） |
| 归档两次不同字节 | 报告里有非确定性字段（时间/路径）——先跑 `self-check` 的归档环 |
| `verify archive verify` 失败 | 先看是 footer 链、文件树哈希还是报告哈希断；`--json` 给逐环 |
| WebUI 上传 403 | 上传门没开（非回环地址），显式设 `YGL_VERIFY_ALLOW_UPLOAD=1` 或走 CLI `--attach` |
| 附件 400 点名 sha | blob 仓里没有该 sha——先 PUT blob 再带 `{sha256,name}` 引用 |
| 作业端点 403 | 没开执行面：`webui serve --enable-verify-jobs`（默认关是设计，不是 bug） |
| 作业端点 422 `run rejected` | 引擎硬拒（契约版本/时间函数/scope 同表守卫）——先 `verify prepare` 出合规 spec |
| 未 ready 的构造去哪了 | `$YGL_HOME/verify/specs/<spec_id>/attempts/<ts>.json`——`prepare.json` 只存最后一次 ready 的记录，不会被失败补跑覆盖 |
| `prepare --as-of` 报 as_of 错 / 作业端点 400 `as_of` | 时间串不合严格 ISO：用纯日期 `2026-10-24` 或带时区 `2026-10-24T08:00:00+08:00`（`+0800` 也收）；无时区/空格分隔/`2026-02-30` 这类非法日历一律拒（服务端不猜本机时区）。CLI rc=2 先于 material/db I/O |
| `needs-material`：`no candidate survived…` 但 reviews 明明写了 | `--reviews` 必须是**对象数组** `[{source_clause, findings:[三问]}]`，`source_clause` 与候选逐字相同；写成旧嵌套 `[[{vu_id…}]]` 一条都匹配不上（vu_id 由 prepare 生成，不要自己写） |
| prepare `error` + `[P1c] clause S3 is not covered` | 子句 = 匹配 `^([A-Z]+[0-9]+) `（或 submit `--clause-pattern` 冻结的模式）的材料行，标题/散文不算；每条都要有候选认领（`anchor.locator: "material.md#S3"` 或 `source_clause` 含整行），或 `--coverage-exempt` 按 `{id\|text, reason}` 具名豁免（reason 必填，不认行号）。先跑 `verify lint-candidates <c> --text <material> --reviews <r>` |
| `[P1c] no clause lines matched pattern …` / lint `coverage_skipped:true` | 材料没有 `<id> <text>` 编号行，覆盖被**跳过**（不是通过）；编号判据，或 `verify submit --clause-pattern '<含一个捕获组的正则>'` 声明 |
| `[P1] … names clause "S9", which the frozen material does not declare` | `#<片段>` 先按子句 id 解析（`#S1`/`#L2` 是 id 不是行号）；引用物理行写 `#line=<n>`；编号约定不同在 `verify submit --clause-pattern` 声明（随材料冻结） |
| prepare `error` + `[P3] orphan review` | 评审文件里有条 `source_clause` 没有任何候选携带（判据被删或改名）——候选与评审要 1:1 |
| `verify meta` R3 把当前目录 git 仓库的脚本判 stray | meta 门默认扫 **cwd 所属仓库**（含 `AGENTS.md`/`verify/` 标记即 hard）；submit/prepare 加 `--meta-repo <verifier-root>` 指定准入根，或在中性目录运行；`verify meta <repo>` 可先单独看该仓的 R1–R3 |
| 空 `YGL_HOME` 报 `no database`（#18） | verify 构造面缺工作区是**运行条件 rc=1**（实测 `verify submit` rc=1）；非 verify 命令 rc=2（实测 `kb add`）。`verify example/lint-candidates/probe` 免 DB（实测 rc=0、无 ygl-trees.db 残留，缺库回落 `:memory:`）——要落库先 `db init` |
| 改了 `verify/meta.json` tooling[] 登记的文件后 `meta-tooling --audit` 判红 | 登记时序（0.116.0/#92）：先 `node scripts/meta-tooling.mjs --reregister <path> --reason "<为何变>" --actor <谁>` **再 commit**（或同提交携带记录）；`--audit --against-git` 按变迁提交时刻核验，**事后补登判红**；多次编辑一次提交合法（账本链式可达） |
| 想知道这次尝试落哪个文件 | CLI `prepare --json` 的 `record`（相对 verify 根）；`GET /api/verify/spec` 载荷带 `attempts:[{file,created,verdict}]` 投影 |
| 作业端点 400 `submission_dir` | 请求体不许带路径/argv；file 型检查器走 CLI `--submission` |
| command 型 VU 全 `ERROR` 且 reason 含 `allowlist` | 不是 bug：`YGL_VERIFY_ALLOW_CMD` 为空/不含该 argv[0]；显式列白名单（逗号分隔） |
| `graduate --schedule` 报 `shell-unsafe` | 报告的 `data_source.source` 含引号/`&`/`\|`/`!` 等字符（`verify report import` 只校验 payload 自洽，可被伪造）——不拼 shell 命令是设计；用 `--db <真实快照路径>` 指定常驻目标，冻结记录仍记被验源 |
| `graduate --db` 有什么用 | 只换常驻作业的目标库，不改资格判定/冻结记录/patrol；与报告 source 不同时会点名 |

- `verify graduate` 报 `not eligible ...` → 不是 bug：资格不够（缺报告/N 份里有 FAIL/跨度不足），按它点名的条件补跑几次真实 `verify run`，别去改报告文件。
- `--schedule` 报「needs --every」→ 调度必须给分钟数；不给 `--schedule` 时只打印命令串，不登记作业。
- prepare 报 `column "x" is not in <table>` 但对得上表结构 → 0.104.0 起列探针走快照库 `PRAGMA table_info`（含 `ALTER TABLE` 加的列）；仍报错说明列真不存在，别去改 DDL 文本。
- `--patrol` 报「needs the verified database to be the workspace database」→ 被验的是快照文件、工作区库是另一份；毕业成 job 即可，patrol 化留给定库同源的场景。

## 9. 契约速查

- `tree_contract_version`：递归树契约（与 `contract_version` 分开钉）；五值全序+cap-on-PASS 是 v1.2 语义。
- `contract_version 1.2`：spec/report 形状（1.2 新增「右值可引用列」两形态：同表 `{col}` 列对列 / `count.against` 单值标量；1.1 spec 兼容运行）；`corpus_version 1.2`：黄金语料摘要（44 例）。
- 报告字段 snake_case；witness 必带 `rows_scanned`/`rows_matched`（或 `compared`）——**没有 witness 的 PASS 不算证据**。
- 一切写路径事务化；读端点只读；`--json` 失败也是单对象 `{"error": "..."}` + rc 承载类别。
