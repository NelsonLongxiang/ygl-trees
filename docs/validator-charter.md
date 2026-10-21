# 验证器生态根规范（charter v1）

> 起草：评审席 GLM-5.3（fdc757f6），2026-10-21；开发席（ygl-trees 引擎线）按属主令固化入档。
> 属主令：「验证器的开发与运维以及使用的规范，一切必须以 ygl-trees CLI 为主，禁止临时编码执行」。
> 定位：本规范是**元验证器之上、契约（[verify-contract.md](verify-contract.md)）之外**的治理层根规范——
> 元验证器是它的执行机制，不是全部。契约细节仍以 verify-contract 为准，本规范只引用不重复。

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
| 元规格规则集（验证器仓库准入）：见 §4.4（R1–R3 首版；R4 缓行） | `verify meta`（v1 排 0.111.0；v2 挂 submit/prepare 接受面，FAIL=拒收） |
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
  不得 PASS**（#22：SKIP ≠ OK）；
- **R3（S1）** 无散落可执行验证件——**全树扫描**（#22：不只 root+docs）：`docs/**` 无
  `*.mjs`/`*.js`/`*.sh`；仓库根无游离脚本；工具/构建目录白名单（`scripts`/`benchmarks`/`examples`/`rust`/
  `vendor`/`node_modules`/`dist`/`tmp`/`.git` 等）之外不得有散落可执行件——即 **P2 的静态面**；
- **R4（S2，缓行 0.113+）** 干净检出可复现——command 型需 `git` 进 meta 运行面 allowlist 且输出入
  evidence（注意隐私：`git status` 安全，build 输出要筛）。

元规格规则以 `spec_meta_*` 版本化，冻结走 digest 血统纪律。

### §4.5 违约处置

P2 违约（临时编码执行）由元规格静态面（R3）+ 评审复核抓；P3 违约由 §4.2 闸门直接拒收；
治理违约走事故流程（复盘入 plan）。

### §4.6 落地对账（2026-10-21）

- `verify meta` 在 0.105.x **未落地**（实测 `unknown verify action: meta`；verify-cmds/verify-contract 无
  meta 章节）。0.105.x 实际落地的是 `verify self-check` 递归门。**本节曾把 self-check 误记为 meta，
  已在入档时更正**；0.111.0 起 v1 属新增，不是补对账。

## §5 与现行文件的关系

- 本规范 → 本文件（`docs/validator-charter.md`）；生效依据=属主令 2026-10-21 13:18（即本规范的发起令），
  提交时 CHANGELOG 引用该令；属主任何时候可以改（文档治理纪律兜底）。
- 元规格规则 → 随元验证器版本化（`spec_meta_*`，digest 血统同语料纪律）。
- 契约细节仍在 [verify-contract.md](verify-contract.md)（charter 引用不重复）。
- 仓库发布/隐私纪律见 [release.md](release.md) 与 [doc-governance.md](doc-governance.md)。
