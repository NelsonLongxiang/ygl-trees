---
name: verifier-sdk-plan
description: 验证器 SDK 的边界、现状评审与分期日程——在 charter P1/P2 之下，SDK 是 CLI 原语 + 声明式格式 + 输出契约 + 脚手架 + 一致性套件，不是可 import 的判定库
kind: 评审
---

# 验证器 SDK：边界、现状评审与日程（方案）

> 评审席 Claude-OPS-5.5 · 2026-10-21 · 基线：ygl-trees `c9cee4d`（npm 0.112.0）＋ 舰队 6 个验证器仓库。
> 承接：PR #16（生产线差距评审，P2 原语清单）、PR #23（charter v1.1：声明式编排过渡例外 + §4.7 原语路线）。
> 本文只做现状判定与日程建议，不改代码。

## 0. 结论

**验证器 SDK 应当提上日程，而且它的形状已经被 charter 定死了**：
- P1 规定 CLI 是唯一执行面；
- P2 禁止直调 `runVerify()`；
- P4 规定判据语言封闭。

所以 SDK **不能**是一个可 import 的判定库。它只能是五层东西：

| 层 | 内容 | 现状 |
|---|---|---|
| L0 CLI 原语 | `verify init` / `snapshot build` / `tree run` / `selfcheck` / `collect` / `package` / `notify` / `import-report` / `meta index` | 全部缺；舰队用约 8,500 行脚本顶替 |
| L1 声明式格式 | tree / collect plan / snapshot map / mutations / package manifest / outbox / 结果契约，各带 JSON Schema 与版本号 | 无；每仓自定 |
| L2 输出契约 | 每个 `verify` 动词的 `--json` 形状（JSON Schema）+ 退出码表 | 只有 report 有契约；其余散在 CHANGELOG |
| L3 脚手架 | `verify init`：生成过 `verify meta` 的验证器仓库骨架 | 无 |
| L4 一致性套件 | 原语的黄金语料 + 一个入仓的示例验证器仓库，进 contract-audit | 无 |

日程见 §3：SDK-0（只补契约与发布面，不加原语）→ SDK-1 脚手架与快照 → SDK-2 `tree run` → SDK-3 `selfcheck` → SDK-4 `collect` → SDK-5 `package` / `notify` / `import-report`。

每一期都拿舰队的一个真实验证器做 A/B 并跑：新原语与旧编排连续 K 轮结论一致，旧编排才删。

## 1. 边界：什么是、什么不是

**是**：
- 让任何一个会话用**声明 + CLI** 搭出 charter 合规的递归验证器所需的全部东西；
- 判定唯一出自 `verify run`；
- 编排的每一项职责都有对应的 CLI 动词。

**不是**：
- **可 import 的引擎 API**：P2 明文禁止"直接调用 `runVerify()`"。
- **第二个判定层**：P4 判据语言封闭，§3 写明不引入第二个语义裁判。
- **舰队专用的脚本库**：SDK 进上游，舰队仓库只放材料、声明与原始数据。

**可选**：由 L2 schema 生成的类型化客户端。它只以子进程执行 `ygl-trees` 命令，符合 charter v1.1 P2 例外的第 2 条"只经 CLI"。它不是必需品，不进首期。

## 2. 现状评审（带证据）

### F1 发布面没有正式接口，P2 只靠自觉

- `package.json:23` 的 `"main": "dist/apps/cli/index.js"`。`require("ygl-trees")` 能加载，导出的是
  `{ main, usage, loadBundle, repoRoot, appVersion, HOME }`，也就是 CLI 的内部函数，不是对外接口。
- 包里没有 `exports`，也没有 `types`。发布包还带着整棵 `dist/packages/**`：
  `require("ygl-trees/dist/packages/verify/core/src/engine.js").runVerify` 实测可用（npm 0.112.0，类型为 function）。
- 影响：charter P2 禁止的直调在技术上完全敞开，违约只能靠评审发现。SDK 的第一件事是声明受支持的面，并把其余的关掉。

### F2 输出没有机器可读的契约，退出码按动词各不相同

除报告外，各命令的 `--json` 形状只写在 CHANGELOG 与 help 文案里，包里没有任何 schema 文件。舰队每个仓库都自己写解析代码。退出码口径各不相同：

| 动词 | rc 语义 | 出处 |
|---|---|---|
| `verify run` | 0 = 跑完（FAIL 也是 0） | `apps/cli/src/bin.ts:167` |
| `verify prepare` | 0 只在 ready；未 ready 为 1 | `bin.ts:166`、`verify-contract.md:151` |
| `verify meta` / `verify probe` | 镜像 verdict（0 PASS / 1 FAIL） | `bin.ts:178`、CHANGELOG 0.111.0 / 0.112.0 |
| `verify lint-candidates` | 0 = 跑完，结论在载荷 | `verify-contract.md:30` |
| `verify archive verify` | 1 = 链断 | `verify-contract.md` §7.5 |

每一种单看都有道理，合在一起，SDK 的使用方就必须逐个动词记口径。L2 要把这张表与 schema 一起发布并冻结。

### F3 舰队在用脚本顶替原语

以 2026-10-21 实测的已跟踪 `*.mjs` / `*.js` 计：

| 仓库 | 文件 | 行数 | 引擎钉版 |
|---|---|---|---|
| ygl-webui-verifier | 11 | 1,532 | 0.111.1 |
| ygl-design-verifier | 10 | 1,503 | 0.111.1 |
| ygl-review-verifier | 8 | 1,437 | 0.110.0 |
| a2a-net-verifier | 12 | 1,601 | 0.109.1 |
| ygl-fleet-verifier | 9 | 663 | 0.111.1 |
| workbench-market-review-verifier | 9 | 1,760 | 0.109.1 |

- 合计约 8,500 行，钉了三个不同的引擎版本。
- 重复的职责每一项都对应 §3 的一个原语：
  - 引擎调用与 `--json` 解析（`lib/common.mjs`，含 `db init` 原生模块失败的容错）；
  - JSON → SQLite 快照（`lib/snapshots.mjs`）；
  - material → candidates（`specs/build-specs.mjs`，五仓逐字节相同）；
  - 后序聚合（`run.mjs`）；
  - 突变自检（`selfcheck.mjs`）；
  - 转正与入账（`ledger.mjs`）；
  - 通知（`notify.mjs`）；
  - 跨仓证据导入（解归档、读快照 meta）。

### F4 元规格索引只能手写

R2 要求 `verify/meta.json` 与 spec 文件双向一致、带 sha256，但 CLI 不提供生成命令。舰队目前由编排在转正时生成索引（例如 ygl-review-verifier 的 `run.mjs` 转正步骤）。这本应是 CLI 的一个动词（`verify meta index --write`），而不是每仓各写一遍。

### F5 准入的静态面仍按目录名放行

0.112.0 的 R3 改成了全树扫描，但 `REPO_TOOLING`（`packages/verify/core/src/meta.ts:151`）按顶层目录名整目录放行。验证器仓库把编排挪进 `scripts/` 就能通过。实测见 #22 在 0.112.0 上的复核，PR #23 提议改为登记制 `tooling[]`。

SDK 的脚手架（L3）必须生成登记制的布局，否则新仓库从第一天就踩在缺口上。

### F6 只读的入门命令也要先建工作区

`verify example`、`verify lint-candidates` 在空 `YGL_HOME` 上返回 rc=2 `no database`，见 #18 ③，0.112.0 仍未处理。SDK 的入门路径从第一条命令起就要求 `db init`。

## 3. 日程（每期都给可机械执行的验收）

**纪律**：
- 每个原语先出契约草案、交双评审，再实现（charter §1）。
- 每期以 ygl-review-verifier 为首个接入方。迁移协议：新原语与旧编排 A/B 并跑，连续 K 轮（建议 K = 5，跨至少一次上游发布）根结论、各叶子结论、spec 哈希都一致，才删除对应编排，并把 charter v1.1 的 `sunset` 定在下一个次版本。

### SDK-0：契约与发布面（不加原语，下一个次版本即可）

内容：
- 为现有每个 `verify` 动词的 `--json` 输出发布 JSON Schema（包内 `schemas/`，带 `schema_version`）；
- 发布 rc 表（F2）；
- `package.json` 增 `exports`，只开 `.`（CLI 元信息）、`./schemas/*`，关闭 `dist/**` 深层 import（F1）；
- `verify meta index --write` 生成 R2 索引（F4）；
- 只读动词不再要求 `db init`（F6）。

验收：
- contract-audit 用 schema 校验每个动词的真实输出；
- `require("ygl-trees/dist/packages/verify/core/src/engine.js")` 返回 `ERR_PACKAGE_PATH_NOT_EXPORTED`；
- 空 `YGL_HOME` 下 `verify example --json` rc=0；
- 对任一验证器仓库，`verify meta index --write` 之后 `verify meta` 的 R2 为 PASS。

### SDK-1：脚手架 + 声明式快照

内容：
- `verify init <dir>`：生成以下骨架：
  - AGENTS.md 模板；
  - `verify/meta.json`（含 `orchestration[]` / `tooling[]` 空表）；
  - `verify/tree.json`；
  - `specs/<leaf>/material.md`；
  - fixture 目录；
  - `.gitignore`（`state/`、`work/`）。
- `verify snapshot build --map <map.json>`：JSON path → 表/列，不开任意代码。

验收：
- `verify init` 出来的空仓库 `verify meta` 为 PASS；
- 同一输入两次 `snapshot build` 字节相同；
- ygl-review-verifier 的 `lib/snapshots.mjs` 被 map 文件取代，A/B 连续 K 轮快照 sha 相同。

### SDK-2：`verify tree run`

内容：
- 后序遍历；
- 组节点内建聚合：子报告 overall、归档自校验、同轮次、非空；
- 每层都是真实 run + 归档；
- 输出结果契约（今天的 `ygl-verifier-latest/1`）。

验收：
- ygl-review-verifier 删除 `run.mjs` 的遍历与聚合部分；
- A/B 连续 K 轮根结论、叶子结论一致；
- 组节点报告的判据与今天的 aggregate spec 逐条对应。

### SDK-3：`verify selfcheck`

内容：声明式缺陷注入（`mutations.json`：改某表某行某列，加上预期变红的叶子集合）。

验收：ygl-review-verifier 现有的 48 个用例全部改写成 `mutations.json`，结果逐例一致后删除 `selfcheck.mjs`。

### SDK-4：`verify collect`

内容：
- 命令型采集步骤：沿用 `command` 型 allowlist 与 r26 "报告是数据，不是命令"的注入防线；
- 输出内容寻址进快照仓，记来源提交与 sha256。

验收：逐叶迁移，每迁一叶删一段 `probe.mjs`；全部迁完后 R3 不再需要该仓的 `orchestration[]`。

### SDK-5：`verify package` / `verify notify` / `verify import-report`

内容：
- 交付轮次打包（spec / report / manifest / zip_sha256）；
- outbox 渲染与回执重放；
- 按 payload_sha256 引入外部子报告：验签、验归档、时效判据，取代今天"解归档、读快照 meta"的编排。

验收：舰队聚合仓库用 `import-report` 读成员结论，`ledger.mjs` / `notify.mjs` 退场。

## 4. 风险与边界

- **范围膨胀**：SDK 只收舰队已证实重复的职责（F3 表），其余不收。
- **新的可执行面**：`collect` 与 `notify` 会执行命令或投递，必须沿用 `command` 型白名单与 r26 防线。L1 格式里任何字段都不能拼进 shell。
- **契约纪律**：L1 / L2 的 schema 与 `contract_version` 同样处理——字段增删就升版本、配语料，并说明 Rust parity 是否覆盖（原语多属编排面，是否进 parity 由两席裁定）。
- **关闭深层 import 是行为变化**：它从未是文档化的接口，但仍应在 CHANGELOG 里显式记账。
- **不新增人裁层**，也不新增第二个判定器。

## 5. 需要裁定的事项

1. SDK 的对外命名与发布形态：随 `ygl-trees` 主包发布，还是另起一个包——由用户和开发席裁定。本文默认随主包发布，因为 CLI 是唯一执行面。
2. SDK-0 关闭深层 import 的时点：建议与 0.113.0 的 meta 硬拒收同版落地，让"禁止直调"和"准入闸"同时变硬。
3. A/B 迁移的 K 值，以及是否允许跨引擎版本累计轮数。
