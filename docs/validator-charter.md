---
name: validator-charter
description: 验证器生态根规范——五条根原则、开发/运维/使用规范、元验证准入规则与迁往 CLI 原语的路线
kind: 规范
---

# 验证器生态根规范（charter v1.2）

> 起草：评审席 GLM-5.3（fdc757f6），2026-10-21；开发席（ygl-trees 引擎线）按属主令固化入档。
> 属主令：「验证器的开发与运维以及使用的规范，一切必须以 ygl-trees CLI 为主，禁止临时编码执行」。
> 定位：本规范是**元验证器之上、契约（[verify-contract.md](verify-contract.md)）之外**的治理层根规范——
> 元验证器是它的执行机制，不是全部。契约细节仍以 verify-contract 为准，本规范只引用不重复。
> **v1.1 修订（2026-10-21）**：P2 增「声明式编排」过渡例外；§4.4 修订 R2/R3、增 R5；增 §4.7 迁往 CLI 原语的路线。
> 依据：属主裁定「同意方案一：起草章程修订提案（编排白名单 + 迁往 CLI 原语的路线），由评审会话提给上游。」
> 提案：监督席（YGL Trees 生命周期监督）；提交：评审席 Claude-OPS-5.5。属主令原文不变。
> **v1.2 修订（2026-10-21，#29）**：R5 拆 **R5a 静态合规 / R5b 时间执法**（时钟=审计方发行物内嵌能力表，
> 默认不执行）；§4.7 增 `capability_version` 列（`unshipped` 无界）；verbatim 提取规则入表注。
> 依据：评审席 fdc757f6 对 #29 的裁定（两 fault 属实、拆法与接口精化批准）。

## §0 根原则（五条，按序优先）

**P1 单一执行面**：ygl-trees CLI 是一切验证活动的唯一执行入口。构造（submit/prepare）、执行（run）、
复核（report/trace）、运维（self-check/meta/archive）、巡检（patrol）全部经 CLI 命令完成。引擎 API、
封包二进制、HTTP 端点是 CLI 之下的实现细节，不是平级入口。

**P2 禁止临时编码执行**：任何「为完成一次验证而现场写代码」——ad-hoc 脚本、`node -e`、直接调用
`runVerify()`、手工改写 spec/report 文件——都是违约。
- 可重复的验证需求 → 提升为 CLI 子命令或七型检查器；
- 一次性的勘察脚本 → 只准放 `<repo>/tmp/`，**且其产出不得作为证据引用**（证据必须产自 CLI 命令，
  带 report/payload_sha256）；
- 复核探针同理：评审席的篡改/注入探针必须 CLI 化（`verify probe` 族），临时探针只算勘察不算复核证据。
  **本条对评审席自身生效。**

**声明式编排（v1.1 过渡例外）**：在 §4.7 的 CLI 原语落地之前，验证器仓库可以在 `verify/orchestration/`
下保留编排代码，须同时满足：
1. **登记**：逐文件登记在 `verify/meta.json` 的 `orchestration[]`：`{path, sha256, role, replaced_by, sunset}`；
   `role ∈ collect`（采集原始数据进快照/材料）`| invoke`（按序调用 CLI 命令）`| aggregate-input`（把子报告的
   CLI 输出整理成上层快照）；
2. **只经 CLI**：调用引擎只能以子进程执行 `ygl-trees` 命令——不 import 引擎模块、不直调 `runVerify()`；
3. **不判定**：不含判据常量、不产出判定列——凡「比较两个测量值」都写进 spec（契约 1.2 `value:{col}`），
   判定唯一出自 `verify run`；
4. **不作证**：编排输出只作 CLI 的输入（快照、材料、树描述），不得作为证据引用；证据只能是 CLI 产物
   （report / archive / payload_sha256）；
5. **有自检**：仓库自带 selfcheck（固定夹具入仓 + 注入缺陷各只翻对应叶子），改编排后必跑；
6. **会退场**：`replaced_by` 取自 §4.7 原语表，`sunset` 为具体版本号，到期由 §4.4 R5 拦截。

不满足任一条的代码，仍按本条视为临时编码执行。

**P3 元验证先于一切**：每个验证器仓库（聚合验证器集合，含 ygl-trees 自身）必须先过 `verify meta`；
未过的仓库，其 spec 不得登记、不得执行、不得归档。元规格规则可由属主扩展（加 VU 即加规则，
不引入第二套规则格式）。

**P4 判据语言封闭**：验证逻辑只允许契约定义的检查器 AST 形态（现行七型）；不开任意 SQL、不开任意
子查询、不开脚本判据。表达力缺口 → 走契约升版评审（两席裁定 + 属主），不走旁门。

**P5 审计链完整**：每次验证留下可带走证据（report + archive + payload_sha256 + 封包签名链）；
治理动作留痕 events（只增不改）。

## §1 开发规范（谁写验证器）

| 规则 | 执行点 |
|---|---|
| spec 唯一来源 = prepare（P0–P5 盲审/红队/守卫门） | prepare 管线；手工 spec 仅限元规格且标 `origin: "meta"`（归档走 spec-only 通道，1.2 批裁定） |
| 契约纪律：升版 = 形状/语义变化；digest 血统（同版本内 digest 变必须带取代记录，理由限表示层） | freeze.mjs + CHANGELOG 血统表 + corpus-freeze 守卫 |
| 双实现 parity：TS/Rust 整份报告逐字节相等才算实现完成 | rust-parity 门禁（44 例，随语料增长） |
| 新检查器能力 → 先契约草案（两席裁定）后实现 | verify-contract-vN.md 草案流 |
| 元规格规则集（验证器仓库准入）：见 §4.4（R1–R3 首版，v1.1 修订 R2/R3 并增 R5；R4 缓行） | `verify meta`（v1 排 0.111.0；v2 挂 submit/prepare 接受面，FAIL=拒收） |
| 提交前全门禁绿 + demo/单测覆盖新行为 | pnpm test 四段制 |

## §2 运维规范（谁跑验证器）

| 规则 | 执行点 |
|---|---|
| 发布：handoff 前必须在干净检出复现门禁（主树绿 = 必要不充分；0.103 CRLF/0.104 LF 重冻教训 + 0.110.0 handoff 字节事故） | 发版席 worktree 门禁 + `pack:repro --check-dirty` + `prepublish-guard` |
| 运行：快照内容寻址引用 + 副本隔离 + data_source 锚 | blob 仓 + snapshotCopy |
| 封包：签名验签认表不认报文；密钥表只增不换 | verify signature/register/import + keys 表 |
| HTTP 面：默认关；runner/凭证 serve 注入，请求体永不携带 argv/allowlist/凭证 | `--enable-verify-jobs` + `YGL_VERIFY_ALLOW_CMD` |
| 巡检：patrol 断言 + 处置队列；self-check 递归（L0–L6） | patrol / verify self-check |
| 事故：复盘入 plan；**历史级操作（改写/重建/删库）必须属主书面口令**（2026-10-21 断链教训） | 治理章程 + HALT 机制 |

## §3 使用规范（谁被验证）

| 角色 | 规则 |
|---|---|
| 业务方 | 一段话 + 附件 → `verify submit`；判定读报告（PASS/FAIL/NEEDS-MATERIAL/ERROR）不读日志；验收以 archive 的 payload_sha256 为准 |
| 嵌入方 | WebUI 只读三视图 + 材料草稿默认；执行面显式开；附件走 blob 仓（PUT → sha256 引用）；不得绕过 CLI 直调引擎 |
| 评审/复核席 | 独立复跑不重放作者证据；**复核证据必须产自 CLI**（探针 CLI 化，见 P2）；每任务一回执 |
| Agent | 构造面归 agent（candidates/reviews 由 agent 产出带锚点引文）；服务端只做机械判定，不引入第二个语义裁判 |

## §4 执行机制（怎么从「规范」变「闸门」）

### §4.1 元验证 v1（排 0.111.0）

`verify meta [<repo>] [--json]` 独立命令：元规格 = 冻结 spec（复用七型 checker，主要是 file/command），
对验证器仓库跑准入规则 §4.4，输出与 run 同族（report/verdict/archive）。**greenfield**——0.105.x
**没有**落地 `verify meta`（0.105.x 落的是 `verify self-check` 递归门：canonical vectors → corpus digest →
shapes → corpus cases → archives；见 §4.6 对账）。

### §4.2 元验证准入闸（v2，过渡 + 终点钉死）

- **0.111.x**：`submit`/`prepare` 接受面默认 **warn**，`--require-meta` 时拒收（未过 meta → ERROR +
  `spec_error`，沿用现行四值裁定，不新造 verdict 类）；`self-check` 递归面纳入 meta。
- **0.113.0**：翻转为**硬拒收默认**（根规范 P3 是硬闸，warn 只是给既有调用面一版喘息）。
  0.111.x 与 0.113.0 两版 **CHANGELOG + help 双向声明**过渡与翻转，防文档/代码漂移。
- **机械门（0.113.0 同版落地）**：`contract-audit` 或 `pack:check` 增加**版本键控断言**——当
  `package.json.version >= 0.113.0` 时，meta 拒收默认必须为硬（否则门禁失败）。双向声明是人读的，
  机械门是机器拦的；两者同时存在才算钉死。
- `--require-meta` 的 help 采用 **deprecation-style 前瞻标注**（「0.113.0 起将翻转为默认硬拒收」），
  不用 experimental 措辞——它已生产可用，只是默认行为会翻转。
- **闸的覆盖面（fdc757f6 2026-10-21 裁定）**：meta 是**准入闸**，骑在构造面 `submit`/`prepare`；
  `run`/`archive` **不二次 gate**——它们消费已准入的冻结 spec，对已冻结 spec 的重跑/换机重放是合法场景。
  P3 的「不得执行」由构造面拒收即已阻断；run/archive 的责任是**如实携带 bypass provenance**
  （`meta-bypass.json` 作 archive 一等 item + events payload_sha256），可追溯性承担 P5，冗余拦截不再加。
- `spec_error` 映射表由开发席出、评审席确认后入库。
- **v1.1**：0.113.0 硬拒收照常翻转。登记了声明式编排（P2 例外）且 R1–R3、R5a 通过的仓库，按 meta PASS 接受（R5b 由审计面判定，不进自检）。

### §4.3 探针 CLI 化（0.112.0 已落地）

`verify probe --matrix [--target <sealed-file>] [--only <probe>] [--json]`（`--matrix` 布尔全量，`--only` 单探针）：把 sealprobe/sigprobe 两代临时脚本
升为命令，产出带 report/payload_sha256 的正式复核证据。矩阵取**并集**（16 向）：
- 开发席八向：封包 / 签名 / 摘要 / 时间戳 / 越权 / 注入 / 跨机 / 重放；
- 评审席篡改向：tamper-spec / tamper-engine / tamper-footer / noncanon / sig-byte / unknown-key /
  retired-key / resign-fv。
密钥相关探针必须用 **RFC8032 确定性测试种子**（与 parity 门同源），禁网、禁生产钥、离线可跑；
`--matrix` 失败不中断（报告全量），rc 只表达过程；每向输出 `{probe, verdict, evidence_sha256}`。

### §4.4 元规格规则（首版）

- **R1（S1）** AGENTS.md 仓库根存在（属主原始指令，规则之首）；
- **R2（S1）** `verify/meta` 索引一致（`verify/meta.json` 单一来源 ↔ 实际 spec 文件双向；索引携带
  `meta_index_version: 1`，未知版本按名拒绝、绝不静默错读）；**无索引域时 zero-scan = NEEDS-MATERIAL，
  不得 PASS**（#22：SKIP ≠ OK）；**v1.1**：不持有 spec 的仓库以 `specs: []` 的显式空索引声明，显式空索引判 PASS
  （本仓 `verify/meta.json` 即如此）；
- **R3（S1）** 无散落可执行验证件——**全树扫描**（#22：不只 root+docs）——即 **P2 的静态面**。**v1.1 起豁免改为登记制**：
  0.112.0 的工具/构建目录按名白名单（`scripts`/`benchmarks`/`examples`/`rust`/…）不看内容、不需登记，验证器仓库把
  编排挪进 `scripts/` 即可通过（#22 在 0.112.0 上的复核：实测 PASS）。已跟踪文件中的 `*.mjs` / `*.js` / `*.cjs` /
  `*.sh` / `*.ps1` / `*.py` 每个都必须属于以下之一，否则 FAIL：
  - `tmp/` 下（`tmp/` 必须 gitignored），或依赖根（`node_modules/`、`vendor/`）；
  - 登记在 `verify/meta.json` 的 `orchestration[]`，路径在 `verify/orchestration/` 下且 sha256 一致（P2 例外）；
  - 登记在 `verify/meta.json` 的 `tooling[]`：`{path, sha256, role}`，`role ∈ build | test | release | gate`——
    产品自身的构建 / 测试 / 发布 / 门禁脚本（如本仓 `scripts/`、`examples/demo.sh`），**不得产出或汇总验证判定**；
    `verify/meta.json` 列有 spec 的仓库里，`tooling[]` 文件不得调用 `ygl-trees verify run|prepare|submit|archive`
    （可机械检查）——驱动验证的代码只能登记在 `orchestration[]`（带 sunset）；
- **R4（S2，缓行 0.113+）** 干净检出可复现——command 型需 `git` 进 meta 运行面 allowlist 且输出入
  evidence（注意隐私：`git status` 安全，build 输出要筛）。

**R3 范围补裁（fdc757f6 2026-10-22）**：①**gitignored 路径不属 R3 扫描面**——其内的验证驱动脚本由
**P2 证据规则**管辖（非 CLI 产出不得作为证据，与路径无关）；探索区唯一白名单=`tmp/`；全局
gitignore（`~/.gitignore_global`）仓外不可见，接受为不可机械检面。②v2 可执行扩展名闭集含 `.py` 与
**`.ts` / `.mts` / `.cts`**（Node ≥22 / tsx 可直接执行，漏掉即现成绕道）。③**产品源码根**经
`source_roots[]` 显式声明：条目必须是**具名子目录**（禁 `.`、空串、绝对路径、反斜杠、`..`、尾斜杠）——
非法条目 → R2 形状拒绝；**未声明即全扫**（fail-closed）；仓库**根级**闭集文件不受 `source_roots`
覆盖，按登记处置。④规则集随 `spec_meta_*` 版本化（`META_VERSION` 1.1→1.2），不碰契约。⑤**登记漂移只能显式修复**：
`meta-tooling --reregister <path> --reason`（禁 auto-rehash）把一条审计记录追加进 `verify/meta.json` 的
`reregistrations[]`（{path, old_sha256, new_sha256, reason, at}，append-only，**随仓库走**）再改对应条目——
clone/评审者能看到「为什么重登记」；把 red 改绿的动作本身必须可审计，且审计不得只留在操作员本地。

- **R5（S1，v1.2）** 编排按期退场，**权威拆分两段**：
  - **R5a（静态合规；`verify meta` 默认执行、离线、不做时钟比较）**：`orchestration[]` 每条必须满足
    `path` 在 `verify/orchestration/` 下、`sha256` 与实际文件一致、`replaced_by` ∈ §4.7 第一列提取出的
    命令 token **并集**（每条编排只指名其中一个；剥离反引号、忽略单元格括注——规则见 §4.7 表注，
    只定义一次）、`sunset` 为**完整 `MAJOR.MINOR.PATCH` 形 semver**（禁 partial / range）。
  - **R5b（时间执法；审计面显式开启，不进仓内自检）**：时钟 = **审计方发行物内嵌的能力表**——
    `verify meta --capabilities <file>`，该文件必须内嵌 `engine_version`/能力版本；`--engine-version <v>`
    仅作**交叉断言**，与表内嵌值不一致 → usage error（点名）。默认 `verify meta` 不执行 R5b；任何运行时
    查询（如 npm latest）不得作为时钟；被检仓自身的 pin 不构成时钟（stale pin 不能冻结自己的 sunset）。
    界规则：对已交付能力，`sunset` ≤ `capability_version` 的下一个 minor；`capability_version: unshipped`
    视为无界（R5b 跳过该条）。延期只能修订本规范（属主裁定），不得改登记。

**索引版本（开发席合并澄清，PR #23 评审）**：`orchestration[]` / `tooling[]` 属 **`meta_index_version: 2`**；
v1 索引（`meta_index_version: 1`）按 v1 规则只读兼容、不读登记；未知版本按名拒绝。现行实现对 `≠1` 已
fail-closed（0.113.x），升 2 时须同版更新 R2 与 meta 闸的版本映射（`meta_index_unknown` 语义随之收窄为「未知」）。

元规格规则以 `spec_meta_*` 版本化，冻结走 digest 血统纪律。

### §4.5 违约处置

P2 违约（临时编码执行）由元规格静态面（R3）+ 评审复核抓；P3 违约由 §4.2 闸门直接拒收；
治理违约走事故流程（复盘入 plan）。

### §4.6 落地对账（2026-10-21）

- `verify meta` 在 0.105.x **未落地**（实测 `unknown verify action: meta`；verify-cmds/verify-contract 无
  meta 章节）。0.105.x 实际落地的是 `verify self-check` 递归门。**本节曾把 self-check 误记为 meta，
  已在入档时更正**；0.111.0 起 v1 属新增，不是补对账。
- `meta_index_version: 2`（§4.4 登记制 `orchestration[]` / `tooling[]` + v1.2 **R5a**）已在引擎落地（#27 方案 T7a，
  未发布；见 CHANGELOG「未发布」）：v2 下 R3 的扫描面是 git 看到的已跟踪 + 未忽略文件，只豁免 `tmp/` 与依赖根，
  **目录名白名单退场**（v1 索引按 0.112.0 规则只读兼容、不读登记）；`∉{1,2}` 按名拒；**R5b 未实现**
  （`verify meta --capabilities` 尚无，默认不比时钟——与本节 v1.2 口径一致）。**待裁定**：R3 的扩展名闭集没有 `.ts`，
  而 Node ≥22 可直接运行 `.ts`；引擎按闭集执行，是否补入由本规范定（评审席 2026-10-21 提出）。

### §4.7 迁往 CLI 原语的路线（v1.1；v1.2 增 capability_version）

声明式编排的每项职责都必须有取代它的 CLI 原语；本节只排序、给出原语名（即 R5 `replaced_by` 的闭集），
不越权定实现——每条原语照 §1「新检查器能力 → 先契约草案（两席裁定）后实现」走，原语清单的来由见 PR #16。

| 编排职责（舰队现状） | 取代它的 CLI 原语 | 能力版本（`capability_version`） | 原语须提供的 |
|---|---|---|---|
| 采集：检出被验提交、跑测试/构建、读 API，落原始 JSON | `verify collect` | `unshipped` | 命令型采集步骤（沿用 `command` 型 allowlist 与 r26 注入防线），输出内容寻址进快照仓，记来源提交与 sha256 |
| 快照：原始 JSON → SQLite 快照表 | `verify snapshot build` | `unshipped` | 声明式字段映射（JSON path → 表/列），不开任意代码 |
| 构造面：material → candidates/reviews | （无需新原语） | `—`（无需退场界） | agent 构造面（§3）+ `verify lint-candidates`（0.110.x 已有）——仓内生成脚本可立即退场 |
| 递归聚合：后序遍历、组节点聚合子报告 | `verify tree run` | `unshipped` | 内建组节点聚合（子报告 overall / 归档自校验 / 同轮次），每层真实 run + 归档 |
| 自检：固定夹具 + 注入缺陷 | `verify self-check`（升级既有命令，不新增同义命令） | `unshipped`（声明式缺陷注入能力尚未交付；基础 self-check 已随 0.105.x 交付，不构成 R5 界） | 声明式缺陷注入（改某表某行某列），断言「只翻对应叶子」 |
| 入账 / 结果契约 / 通知 | `verify package`、`verify notify` | `unshipped` | 交付轮次打包（spec/report/manifest/zip_sha256）、结果契约输出、outbox 渲染与回执重放 |
| 跨仓聚合（读成员结果） | `verify import-report` | `unshipped` | 按 payload_sha256 引入外部子报告，验签 / 验归档 / 时效判据 |

建议顺序：`verify tree run` → `verify self-check`（升级既有）→ `verify collect`（含 `verify snapshot build`）→
`verify package` / `verify notify` → `verify import-report`。每条原语**能力交付版本**（`capability_version`）
的下一个次版本即对应编排的 `sunset` 上限；`unshipped` 无界。

**审计面待办（护栏④）**：`--capabilities` 审计模式对 `source_roots` 广度可疑（如声明覆盖全仓）出
warning——现不实现；滥用面 ≤ `--no-meta` 且后者有 events 审计，绊线威胁模型是意外+漂移而非恶意。

**表注（verbatim 与界规则，只在此处定义一次）**：`replaced_by` 的闭集 = §4.7 第一列**所有命令 token
的并集**（多 token 单元格如 `verify package`、`verify notify` 各贡献一项；每条编排只指名其中一个）；
第一列无命令 token 的行（如构造面「无需新原语」）**不贡献闭集**。逐字提取 = 剥离反引号、忽略单元格
括注。`capability_version` = 该原语到达 R5 所需能力的交付版本；`unshipped` 表示能力尚未交付、
R5b 不对该条设界；`—` 表示该职责无需退场界（不产生编排登记）。`sunset` 一律完整 `MAJOR.MINOR.PATCH`。

## §5 与现行文件的关系

- 本规范 → 本文件（`docs/validator-charter.md`）；生效依据=属主令 2026-10-21 13:18（即本规范的发起令），
  提交时 CHANGELOG 引用该令；属主任何时候可以改（文档治理纪律兜底）。
- 元规格规则 → 随元验证器版本化（`spec_meta_*`，digest 血统同语料纪律）。
- 契约细节仍在 [verify-contract.md](verify-contract.md)（charter 引用不重复）。
- 仓库发布/隐私纪律见 [release.md](release.md) 与 [doc-governance.md](doc-governance.md)。
