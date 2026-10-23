# 递归验证器契约 · `verify tree run`（A1，v1.1 · 历史草案；**已被 v1.2 取代**）

> **状态：历史草案 v1.1；已被 v1.2 取代。** v1.1 曾以 relayed-order 实现（主队席转发，无落章，见 §0.1 历史披露）；
> **2026-10-23 14:01 属主经 fdc757f6 会话直令落章**，Q1–Q13 + G8/G9 全文见
> [裁定单 v2](verify-tree-run-ruling-sheet.md) 与 [v1.2 定稿](verify-tree-run-contract-v1.2.md)。
> 本文件保留 v1.1 条文与 #59 订正的历史，不再作为现行依据；
> 依据：`docs/reviews/verify-tree-run-contract.md` v1.0 + 验证席 #59 审阅，两席复核后生效。 属主于 2026-10-23 01:05 前后下达「开始」，经主队席
> `dsh/e9a87677` 原样转发：Q1–Q7 照两席一致建议通过，charter §4.7 增补照裁定单草案文字定稿。
> **双席签署**：验证席 `dsh/ae07421e`（v0.3 四条意见）、发版席 `dsh/0672e341`（v0.4 正式签署）。
> 未收到属主个别项改判前，按本裁定执行。
> 语义节（S-1…S-7）与验收场景（V1…V10）来自主队席 `dsh/e9a87677` 的《A1 共同作者材料 v0.1》；
> 接口/CLI 形状由 ygl-trees 主开发线起草。开放点 §6 未裁定前，实现不得锁定行为。

日期：2026-10-22（v0.4 合入发版席 R-1/R-2 条件与 Q4 改法） ｜ 关联：charter §4.7（原语表）、#16（验证器生产线 P2/P3）、#35（身份判据 Q4/Q6/Q7）

## 0.1 Provenance 卡（2026-10-23，fdc 处置 0.1）

| 项 | 值 |
|---|---|
| 裁定人 | 属主（**未直接签章**） |
| 渠道 | 主队席 `dsh/e9a87677` A2A 转发，2026-10-23 ~01:05，文本「开始」+ Q1–Q7 照建议通过 |
| 证据形态 | 仅 A2A 转发文本；无签名、无裁定制品、无属主直接时间戳 |
| Q1–Q7 | 逐项来源=转发文本，**unverified**（不是逐项签章） |
| 结论 | 历史：曾未落章（relayed-order 实现）；**2026-10-23 14:01 属主落章，v1.2 定稿生效** |
| 处置 | 已完成：属主 14:01 直令裁 Q1–Q13 + G8/G9；Phase 2 会签 → 冻结线解除 → 0.115.0 |

## 0.2 冻结线（fdc 处置 0.2，2026-10-23 生效）

tree 面**停止实现** v1.1 已吸收但未裁定的语义：subject/stale/digest 投影/ERROR 规则/tree spec pinning
（其中同主体与 stale 两点吸收有误，先落码=锁定错误）。允许：P1/P2 修复、测试、纯文档订正（含暂去
「已裁定」措辞）。裁定落章后按 Phase 2 解除。

## 1. 范围与非目标

**范围**：新增 `verify tree` 命令族，把现有「单 spec → 单 run → 单 archive」的执行单元组合成可递归的
树形验证：组节点（group）聚合子判定，叶节点（leaf）复用既有七型检查器；每层真实 run + archive。

**非目标**：不引入任意表达式/脚本钩子（P4 闭包）；不改变现有 `verify submit/prepare/run/report/archive`
语义；不做并行调度器（本轮顺序后序即可，但契约要求**调度无关**的 digest 稳定性——V11，并行器后置）；
不碰 pi 依赖（WP-B 属 jf 仓）。

## 2. 递归语义（S-1…S-7，来自主队席材料）

- **S-1 树形任务描述**：组节点（group）与叶节点（leaf）两类；叶 = 可执行 spec（现有七型检查器）；
  组 = 聚合策略容器。树描述经 `verify tree prepare` 冻结（digest 血统），禁止手写绕过冻结。
- **S-2 后序遍历**：children 全判定后才判定父；父只读子报告的列，聚合算子限**封闭集**：
  `count_fail` / `all_pass` / `quorum(N)` / `min` / `max` / `and` / `or`（初始名单待裁定，见 §6-Q1）。
- **S-3 每层真实 run + 归档**：组节点不是逻辑视图——聚合层产真实 report + archive（`payload_sha256` 链）；
  子报告以**验签后的 `verdict_digest`** 引入判定；archive sha / 时钟 / 主机属审计层，不进入父判定
  digest（v1.1 #59-①）。
- **S-4 同轮次约束**：一次 tree run 全体叶共享轮次 id/时钟域；跨轮次引用旧报告必须显式
  `pinned`（archive sha256）并带 `stale` 判据。
- **S-5 失败面三分**：叶 FAIL → 按组策略聚合（默认 AND）；叶 ERROR（基础设施故障）≠ 判定失败，
  不入聚合，标 `infra-blocked`；环/悬空引用 → prepare 期拒绝（闭包 + 拓扑校验）。
- **S-6 归档验签失败** → 该子树整体 `NEUTRALIZED`（显式中性化，不静默丢弃）；NEUTRALIZED 阻断根层 PASS。
- **S-7 确定性与幂等**：同 tree spec + 同输入 digest → 同 verdict；判定 digest 只覆盖判定投影
  （节点 verdict / 聚合 / 子 `verdict_digest`），**不含 archive 字节或时钟**；重放按 archive 链去重
  （幂等键 = 轮次 id + spec digest）；全程 events 只增。

## 3. 接口草案（CLI / JSON / RC）

### 3.1 命令面（新增子组，命名沿用既有 kv 风格）

```bash
ygl-trees verify tree prepare <tree-material-id> [--draft] [--pinned <node>=<archive-sha256> ...] [--json]
ygl-trees verify tree run <tree-spec-id> [--db <snapshot.sqlite> | --db <node>=<snapshot.sqlite> ...] [--json]
ygl-trees verify tree report <tree-run-id> [--json]
ygl-trees verify tree trace <tree-spec-id> [--json]
ygl-trees verify tree archive <tree-run-id> [--json]
```

- `prepare`：读 tree material → 抽取树描述 → 拓扑/闭包校验（环、悬空引用、未知聚合算子、空组、深度上限）
  → **pinned 目标校验**（node 存在 + archive 验签）→ 冻结 `tree_spec`（`tree_spec_version`、
  `tree_spec_sha256`、每个叶的 `spec_id`/`spec_version`、pinned 表一并冻结）。**任何冻结期不合法 → rc=2**；
  运行期只能引用已冻结 pinned，出现未声明 pinned → rc=2。
- `run`：后序执行；每叶复用现有 `run` 引擎与 archive 格式；每组按聚合算子产独立 report + archive；
  根 verdict 写报告，**rc=0 表示执行完成，判定在报告**（与现有 `verify run` 一致）。
  **多快照绑定（v1.1 #59-③）**：`--db <snapshot>` 为全体叶默认；舰队树用重复
  `--db <node>=<snapshot>` 给叶子绑不同快照（也可在 tree spec 的 leaf 上冻结 `db` 路径，
  run 期显式 `--db` 覆盖）。未绑定默认且叶无冻结 `db` → prepare/run rc=2，不猜。
- 其余三命令为读面（`report/trace/archive`），沿用现有输出契约。

### 3.2 JSON 形状（冻结前先给形状，不带实现）

写命令成功 = 单对象：

```json
{
  "tree_run_id": "tr_…",
  "tree_spec_id": "ts_…",
  "tree_spec_sha256": "…",
  "round_id": "…",
  "verdict": "PASS | FAIL | NEUTRALIZED | INFRA_BLOCKED",
  "verdict_digest": "…",
  "audit": { "generated_at": "…", "host": "…", "duration_ms": 0 },
  "nodes": [
    { "node_id": "n1", "kind": "leaf", "spec_id": "spec_…", "report_id": "…",
      "archive_sha256": "…", "verdict": "PASS", "stale": false },
    { "node_id": "root", "kind": "group", "aggregate": "quorum(2)",
      "children": ["n1", "n2", "n3"], "report_id": "…", "archive_sha256": "…",
      "verdict": "PASS" }
  ],
  "pinned": { "n_onc": "…" },
  "events": "appended"
}
```

- **R-1（发版席条件）**：`verdict_digest` 只覆盖判定相关字段（节点 verdict/聚合结果/子报告 sha），
  **时钟/执行环境不进 digest**（同 0.113.1 provenance 先例）；`audit` 单列 `generated_at`/`host`/`duration_ms`。
  report/archive payload **禁止本机绝对路径**（T1 白名单投影纪律，0.114.0 先例）；路径一律 workspace 相对。
- 叶 ERROR → `verdict: "ERROR"`（单字段判据：**ERROR 即 infra-blocked**，不再另带布尔字段，避免双字段漂移）。
  **聚合顺序（v1.1 #59-②）**：任一子 NEUTRALIZED → 父 NEUTRALIZED；否则任一子 FAIL → 父 FAIL；
  否则任一子 PASS → 父 PASS；否则（全 ERROR）→ INFRA_BLOCKED。ERROR 不参与 PASS/FAIL 计票，
  但「有 ERROR 且其余全 PASS」→ 父 PASS（ERROR 只是缺证据，不是否定）；有 FAIL 时 FAIL 优先。
- `NEUTRALIZED` 为**独立 verdict**（推荐，见 §6-Q2），阻断根 PASS。

### 3.3 RC 契约（沿用全局）

| rc | 含义 |
|---|---|
| 0 | 执行完成（判定在 `--json` 对象/报告；**FAIL / NEUTRALIZED / INFRA_BLOCKED 均为 rc=0**，不可把中性化/基础设施阻塞当运行错误） |
| 1 | 仅基础设施自身故障（快照不可读、进程内部错误；归档验签失败属判定面，走 NEUTRALIZED + rc=0） |
| 2 | 用法/冻结错误（缺参、环、悬空引用、未知聚合算子、空组、超深度、未知 pinned 目标） |

### 3.4 事件与归档

- events 只增：`verify.tree.prepare` / `verify.tree.run` / `verify.tree.node`（每层）/ `verify.tree.archive`。
- 归档 payload 含：tree spec 摘要、轮次 id、节点报告引用（sha256）、verdict、pinned 表；
  archive 可被现有 `verify archive verify` 验签，也可作为其它树 run 的 pinned 输入。

## 4. 与既有原语的关系

- 叶 = 现有 `spec`：`prepare` 只锁定 spec id/version，不复制检查器逻辑。
- 组 report/archive = 现有 report/archive 格式 + `tree` 信封字段（additive；不改既有字段）。
- `report import` 的 payload/version 校验复用；树归档引入子报告走同一验签路径（V8）。
- `verify meta`（charter §4.1 R1–R3）不因树引入变化；树 spec 材料仍受 meta gate 约束。

## 5. 验收场景（V1…V10，机械可断言）

| # | 场景 | 断言要点 |
|---|---|---|
| V1 | 三层嵌套注入一叶 FAIL | 根 FAIL；逐层 report 存在；传播正确 |
| V2 | quorum 组 3 叶 1 FAIL + quorum=2 | 组 PASS、根 PASS；minority 留痕 |
| V3 | 叶 ERROR（缺 DB）注入 | 组 infra-blocked，非 FAIL；不入聚合 |
| V4 | pinned 旧子报告 | stale 标记生效 |
| V5 | 树含环 | prepare rc=2 拒绝 |
| V6 | 子归档改一字节 | 验签失败 → 子树 NEUTRALIZED；根不得 PASS |
| V7 | 同输入双跑 | **verdict_digest 逐字节相等**（只覆盖判定投影，子 sha 用子 `verdict_digest`）；audit 时钟/主机/archive 字节允许不同（R-1/#59-①） |
| V8 | 外部仓 archive 作为叶引入 | 与本地归档同验签路径 |
| V9 | 规模基线 4 层 × 64 叶 | bench 门内完成（阈值 §6-Q4） |
| V10 | 全程 events 留痕 | 只增；节点/轮次可追溯 |
| V11 | 并行确定性 | 叶任意调度序执行，全树 report digest 逐字节相同（调度无关） |
| V12 | 深度护栏 | 叶路径深度超上限（默认 16，见 §6-Q7）→ prepare rc=2 |
| V13 | 树 spec 血统 | 已冻结 tree spec 的修改走取代记录（old/new digest+理由，同 meta 重登记纪律）；旧 digest 的历史 run 仍可验 |
| V14 | 混合叶 | pinned 归档叶与现跑叶同树并存：pinned 走验签+stale 判据，现跑正常判定，聚合同路径 |
| V15 | 四态聚合矩阵 | 表驱动：NEUTRALIZED 优先；有 FAIL→FAIL（ERROR 不否决）；无 FAIL 有 PASS→PASS；全 ERROR→INFRA_BLOCKED；空组见 §6-Q6 |
| V16 | 未知聚合算子注入 | prepare rc=2（算子名单外，含大小写/参数形态变体） |
| V17 | 同轮 pinned 自引用 | pinned 指向本轮产物 → prepare rc=2（S-4 轮次边界） |
| V20 | 同主体查重 | 同 canonical tree（nodes+pinned+db 绑定）重复 prepare → 同 `tree_spec_id`（幂等，不产生第二冻结件）；pinned/db 变化 → 新 id |
| V21 | 舰队多快照 | 叶 `--db node=...` 绑定不同快照，聚合不串库；缺绑定 → rc=2 |
| V18 | 审计/判定分离 | 同判定、不同 audit 时钟 → verdict_digest 相同；改任一节点判定 → digest 必变 |
| V19 | 路径投影 | report/archive payload 无本机绝对路径（workspace 相对/逻辑路径） |

## 6. 开放点（定稿前必须裁定）

| # | 问题 | 草案建议 | 备注 |
|---|---|---|---|
| Q1 | 聚合算子初始名单 | 先 `count_fail` / `all_pass` / `quorum(N)` 三个，`min/max/and/or` 后置 | 封闭集宁小勿大 |
| Q2 | NEUTRALIZED 独立 verdict 还是 FAIL 子码 | **独立 verdict** | 阻断根 PASS 语义更清晰 |
| Q3 | 轮次 id 发行者 | CLI 在 run 发起时生成，写进所有层 archive | 与幂等键一致 |
| Q4 | V9 规模基线门（4 层 × 64 叶） | **进 ratchet 第四轴**（tree-run 耗时），显式 `--write` 认账 + 按机器实测；不设裸 180s | 发版席建议：沿用 cold start 棘轮纪律 |
| Q5 | 树 spec 描述格式（文本 DSL vs JSON） | JSON（可机械校验、可 digest） | 与 material 冻结一致 |
| Q6 | 空组节点处置 | prepare **拒绝**（rc=2） | 合法空跑会让「无子可聚合」变成隐藏 PASS；拒绝可裁定改 |
| Q7 | 叶路径深度上限 | 初始 **16**，超限 prepare rc=2 | 深度护栏防递归爆炸；数值按实测可调 |

## 7. 评审与裁定

1. 发布席 `dsh/0672e341`、验证席 `dsh/ae07421e` 评审本草案（接口/契约/失败面）；
2. 属主对 §6 五项与 charter §4.7 增补做裁定；
3. 裁定后本文件改为「已裁定契约」并落实现（A1 施工；A2 self-check 缺陷注入紧随）；
4. A3 发布门两段式（先 warn 后硬门）另立小契约，candidate 0.114.17。

**v0.2 增补（2026-10-22）**：主队席补充包 V11–V15 已收录；新增开放点 Q6（空组节点）/ Q7（深度上限）。

**v0.3 合入验证席评审（2026-10-22，验证席 ae07421e 签署通过 + 四条意见）**：
① ERROR 采用**单字段判据**（verdict=ERROR 即 infra-blocked，删双字段）；
② `--pinned` 前移到 **prepare 期**冻结并校验（node 存在 + archive 验签），运行期只允许引用已冻结 pinned；
③ 新增 **V16**（未知聚合算子 prepare rc=2）与 **V17**（同轮 pinned 自引用 prepare rc=2）；
④ Q1 三算子起步、Q2 NEUTRALIZED 独立 verdict、Q3 CLI 发行轮次 id、Q5 JSON 均获验证席同意；Q4 待机器基准。
裁定门不变：发布席评审 + 属主裁定 §6 后转已裁定契约。

**v0.4 合入发版席评审（2026-10-22，发版席 0672e341：通过，附 R-1/R-2 条件）**：
① R-1 确定性拆分——新增 `verdict_digest`（只覆盖判定字段）与 `audit`（时钟/主机单列），report/archive 禁本机
绝对路径；V7 改为 verdict_digest 相等，新增 V18（审计/判定分离）与 V19（路径投影）；
② R-2 rc 归属——**执行完成即 rc=0（含 FAIL/NEUTRALIZED/INFRA_BLOCKED）**，rc=1 仅基础设施自身故障；
③ Q4 改为 **ratchet 第四轴**（耗时基线显式认账），不设裸 180s；
④ Q1–Q3/Q5–Q7 发版席均同意。**两席签署状态：验证席已签；发版席签署条件 = R-1/R-2 入草案，本版已入，
待发版席确认。**

**本契约已裁定；实现按 V1–V19 验收。**

**v1.0（已裁定，2026-10-23）**：Q1 三算子起步 / Q2 NEUTRALIZED 独立 verdict / Q3 CLI 发行轮次 id /
Q4 ratchet 第四轴 / Q5 JSON / Q6 空组 prepare 拒绝 / Q7 深度上限 16；charter §4.7 增补按裁定单文字。
开工范围：A1（本契约）→ A2 self-check 注入 → A3 发布门两段式（先 warn 后硬门，@0.114.17 另立）。

**v1.1 审阅订正（2026-10-23，验证席 #59 四缺口；不改 Q1–Q7 裁定）**：
① V7/digest——`verdict_digest` 只覆盖判定投影（子节点用子 `verdict_digest`），archive sha/时钟进 audit；
② ERROR 聚合——按「NEUTRALIZED 优先 → FAIL → PASS → 全 ERROR=INFRA_BLOCKED」矩阵，ERROR 不否决 PASS；
③ 多快照——`run --db` 支持默认 + `node=path` 重复绑定，叶可冻结 `db`，缺绑定 rc=2；
④ 同主体查重——同 canonical tree 重复 prepare 幂等（同 id），pinned/db 变化即新 id（V20）。
