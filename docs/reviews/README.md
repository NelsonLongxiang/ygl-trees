# 评审证据链索引（docs/reviews/）

本目录保存外部评审席（A2A 协作节点）对 spec-validator M13 全线的**逐轮评审报告原文**——它们是
`docs/plan.md` 执行记录里「评审 302cb119 rNN / fdc757f6 裁定」这类引用的**一手证据**，不是过程
垃圾：每条 P 级问题后来都对应到一处代码/文档修复，回看报告能还原「为什么这么改」。

## 约定

- 文件名 = `REVIEW-<主题>-m13-r<轮次>.md`（`r` 后缀是轮次）；`REVIEW-spec-validator-m13.md` 是最早的
  设计级评审，`REVIEW-0.84.0.md`、`REVIEW-webui-0.89.1.md` 是早期版本评审。
- 报告**原文不改写**（含评审席的措辞与当时的误判）；修复结论写进 `docs/plan.md` 与 CHANGELOG，
  勘误也记在 plan 里，避免"改报告让它看起来对"。
- 新增评审报告直接放本目录并在此登记；不另建目录、不放进 `docs/` 根（根目录只留稳定文档）。
- 跨席共识的方案稿（非逐轮评审）也放本目录，文件名用描述性命名并在索引注明「方案」，例如
  `harness2-dual-validation-plan.md`。

## 索引

| 文件 | 主题 | 结论要点 |
|---|---|---|
| `REVIEW-spec-validator-m13.md` | M13 设计评审（首轮） | 零人工确认、判据可机读、语料黄金化 |
| `REVIEW-spec-validator-m13-r2.md` – `r6.md` | 设计细化（契约/封包/盲审/P0–P5） | 契约形状、封包 footer、open-world 议题 |
| `REVIEW-spec-validator-m13-r7.md` – `r9.md` | 引擎实现评审 | compare 语义、predicate AST、corpus 冻结 |
| `REVIEW-spec-validator-m13-r10.md` – `r12.md` | 引擎与封包 | witness 语义、报告形状、Rust parity 起步 |
| `REVIEW-spec-validator-m13-r13.md` – `r15.md` | Rust 单二进制 / 签名 | 逐字节 parity、ed25519 封包、认表不认报文 |
| `REVIEW-spec-validator-m13-r16.md` | 签名链复核 | legacy 语义、import 身份、密钥表自检 |
| `REVIEW-spec-validator-m13-r17.md` | 0.99.1 复核 | P1/P2 修复实证通过 |
| `REVIEW-spec-validator-m13-r18.md` | 0.100.0 复核 | **CHANGES**：P1 路径穿越 + P2 端点缺失 + P3 三项 |
| `REVIEW-spec-validator-m13-r19.md` | 0.101.0 复核 | PASS；N1–N5 非阻塞项（计数订正、坏报告 WONTFIX、tgz ignore、评审入库、413 用例） |
| `REVIEW-spec-validator-m13-r20.md` | 0.101.1 复核 | PASS：N1–N5 落点属实 + blob 并发热修实证；D1/D2 文档返工、D3 并发 flake 样本 |
| `REVIEW-spec-validator-m13-r21.md` | 0.102.0/0.102.1 复核 | **PASS**：HTTP 作业面三条不变量 + ready 路径与 CLI 逐字段一致；P2-1（allowlist 空串）已修、P2-2（非 ready 构造审计落盘）待定 + P3×7 → **0.102.2 已收口**（attempts 追加、as_of 入口、门形态） |
| `REVIEW-spec-validator-m13-r22.md` | 0.102.2 三问收口复核 | **PASS**：attempts 只追加/ready 记录逐字节不变、as_of 入口、门形态实证通过（unit 445/445、contract 100、demo/readme rc=0）；P3×4（as_of 双侧校验、specDetail 暴露 attempts、命名碰撞、CLI JSON record） |
| `REVIEW-spec-validator-m13-r23.md` | 0.102.3 复核 | **PASS**：r22 四条（as_of 双侧校验、attempts 投影、命名续号、CLI record）实测通过（unit 454/454、contract 100、demo/readme rc=0）；**P2-1**：`verify-contract.md` §4.7 的 `--reviews` 示例仍是旧嵌套形状（照文档永远拿不到 ready，实测复现）+ P3×5（as_of 无时区/非法日历静默归一、HTTP 校验次序、prepare.json 不可变措辞、record 路径前缀、wx 原子占位）→ **0.102.4 已收口** |
| `REVIEW-spec-validator-m13-r24.md` | 0.102.4 复核 | **PASS**：r23 六条（as_of 严格 ISO、校验次序、wx 原子续号、文档形状、措辞、±hh 说明）全部收口（unit 463/463、contract 100、demo/readme rc=0）；两问答复——接受面仅剩「纯日期 / 小数秒截断 / ±23:59 偏移」三个有意宽容边界（建议文档化），跨进程固化测试不需要（EEXIST 分支与进程数无关）；P4×3（`file` 的 basename 措辞、HTTP body `record` 基准未写、小数秒截断未写） |
| `REVIEW-spec-validator-m13-r25.md` | 0.103.0 毕业通道复核 | **CHANGES**：资格/记录/调度三段拆成立、两问判断确认；P2×3（`--min-runs 1` 跨度闸门真空、HTTP blob 源 `job_command` 死命令且 `--schedule` 登记必败作业、§9「`--patrol` 会 `patrol add`」未兑现）+ P3×4（`--schedule` 缺 `--every` 先落盘、duplicate 回请求阈值与作业周期、版本升级后重毕业文案、窗口跨度右移语义）；unit 475/476（唯一失败为 webui ECONNRESET 环境 flake，隔离 17/17 过）、contract 100、demo 128、readme 54 |
| `REVIEW-spec-validator-m13-r26.md` | 0.103.0 毕业通道收口复核 | r25 的 P2×3/P3×4/两问全过（定向 44/44）；**CHANGES：P1 安全**——`job_command` 内插报告 `data_source.source` 且 `job tick` 走 shell，crafted report → import → graduate → 任意命令执行（端到端实证）；修法=路径白名单+拒绝 schedule；Q1 不建议查存在性（补 db_exists warning）、Q2 `--db` 不改资格/记录/patrol 但需同防注入 |
| `REVIEW-spec-validator-m13-r27.md` | 0.104.0 候选复核（r26 P1 收口 + 语料行尾/门禁） | **PASS（P1 收口成立）**：注入链端到端关闭（schedule rc=1、`jobs` 无新行、合法路径可用、`source_warning` 只出声）；语料 LF 重冻 digest `ee1a0a1d…` 与 `freeze --check` 一致；干净树门禁 unit 494/494、contract 首跑 99/100（`project new` 二次加载 flake）复跑 100/100、ratchet held。**P2×3 发布前修**：`--db` 对已存在作业 retarget 静默 no-op、尾随分隔符 usable 但命令崩（`node: bad option: --db`）、白名单拒中文/`#`/`+` 路径；P3×4（`job_command_rejected` 保留 40 字符与「原文不回显」矛盾、`--test-timeout=20000` 覆盖配置 60s、Rust parity 未进 `pnpm test`、ratchet 基线 median-of-5 与 min-of-7 错配）+ P4×2 → **0.104.0 已收口** |
| `REVIEW-spec-validator-m13-r28.md` | 0.104.0 复核（r27 P2×3/P3×4 收口） | **PASS**：r27 七项全部实证落位（retarget 同 id 改写 jobs、尾随分隔符/中文路径判定、掩码只描述形状、timeout 旗标删除、Rust 交接 31/31、ratchet method、source_warning 投影）；干净树 `814a7c3` 门禁 unit 497/497、contract 100/100、ratchet held（余量 1118B）。**P3×1**：denylist 未含 `$`，POSIX sh 会展开路径变量 → 可能静默验证另一个库；**P4×4**：文档称拒 `{}` 实现放行、CHANGELOG「基线不动」与同版重烘矛盾、基线早于最终提交、同 subject 提交残留。两问裁定：干净树复现已由本轮覆盖、无需重复；**同意加 `job_target`**（origin/写入时机/不变性/隔离/读面 五条规则） → **0.104.0 已收口** |
| `REVIEW-spec-validator-m13-r29.md` | 0.105.0 复核（批九增补单 + r28 收口，事后） | **发布物 BLOCK / 代码 CHANGES**：0.105.0 tarball 含 4×`workspace:~` → `npm install` 报 `EUNSUPPORTEDPROTOCOL`（独立实测；**0.105.1** 修：pack-repro 以 pnpm 产物为源 + 拒绝残留 + 5b 加 npm 真装探针）；代码 P2×2（`evidence_fts` 影子未删、node move 重试非幂等）→ **0.105.2** 修；P3×3/P4×2（空白 `--db` origin 误标、cascaded 类型、CLI Q2 断言同义反复）→ **0.108.2** 修/记账。r28 的 `$` denylist 与 `job_target` identity 边界复核通过；Q2 答「带 tree_id 的 5 张表无遗漏」；Q3 答「预测断言保状态与 predict 纪律一致」。仍开放：`updated_at` 未变也刷新、非预测 unlink 可覆盖人工仲裁 → **已闭环**（0.105.1/0.105.2/0.108.2）；Q1（`updated_at` 仅变更时刷新）/Q3（仲裁锁：resolve 后链接增删保持状态、unresolve 解锁）/`db init` 冷启动（实测 85s，12 技能逐事务导入 → 批量单事务候选）转 0.110 候选 |
| `verifier-sdk-plan.md`（方案） | 验证器 SDK：边界、现状评审与日程 | charter 定形：SDK = CLI 原语 + 声明式格式 + 输出契约 + 脚手架 + 一致性套件，非可 import 判定库；SDK-0 契约与发布面 → SDK-1 init/snapshot → SDK-2 tree run → SDK-3 selfcheck → SDK-4 collect → SDK-5 package/notify/import-report，每期 A/B 迁移 |
| `verifier-production-line-plan.md`（方案） | 验证器生产线缺口评审与行动计划（PR #16，fdc 条件合并） | 方案：判定面已生产级、定位冲突、`file`/P4 缺口（#18 已于 0.110.2 修复）、舰队五仓编排重复~2400行；计划 P0 舰队硬化→P1 引擎小步（provenance/violations/supersedes/gaps）→P2 生产线原语→P3 舰队迁移；§5 决策点**未裁定待属主**（业务交付面扩张），report/archive 证据层按 charter P5 不降级 |
| `taste-extraction-plan.md`（方案） | 验证器的品味提取：#27 五席意见 + 属主侧讨论汇总与行动计划 | 验的是品味判断的证据结构，不是品味本身；品味须先成为人工认定的数据（案例→统计→认定→冻结→执行→推翻回流→复审）；五处订正（count 无 DISTINCT、VU 无 channel 字段等）；六项裁定 D1–D6；九个工作流 T1–T8，T1/T2/T7a 可即并行，实现由属主另行安排会话；**勘误 2026-10-22**：推翻得新 spec_id（留痕记 old_spec_ref → new_spec_ref），「已登记」按冻结谱系核对 |
| `project-selection-review.md`（方案） | 项目选择机制评审：为何一定要 `project use`？ | `project use` 非必需（`-p` / `YGL_PROJECT` 皆可，m07308 以 `--project` 为第一推荐），帮助里看不到才被误以为必需；创建类命令需要选择，`claim link` 要求选择却不使用、`rel add` 零门槛；真风险是共享 `default` 桶被 `project new` 静默改指向且 `--json` 无信号（#44）；D1–D5 待属主裁定 |
| `verifier-pack-plan.md`（方案） | 验证器包：命名、标记与工作流组合 | 稳定钉住的验证器打包为**纯数据**的验证器包（不是 R14 代码插件：与 charter P1/P2/P4 冲突）；规格 × 绑定 = 节点，节点 + 预设模式 = 工作流；集合模块管命名（`ygl-v-<name>@semver` + spec_id@version 钉版）、三轴标记（领域 / 业务 / 受控的工作流模式）与 6 种已在舰队实证的预设（gate / patrol / tree / release / construct / loop）；证据：9 仓约 1.19 万行编排、`aggregate` 规格 6 种抄本；安装位置：项目根 `.ygl-trees/plugins`，全局 CLI 按清单激活子命令（执行体为内建模式，不跑包内代码）；工作流持久化为项目根 JSON 图文件（节点 + 接面 + 连线，类 ComfyUI，布局与语义分离）；分期 VP-0..4 挂在 SDK 路线上，VP-3 依赖 `tree run`；D1–D6 待属主裁定 |
| `pg-write-backend-plan.md`（方案） | 单一 PG 写库：现状评审与日程（重新立项 pg-compat §5 L2） | 每个工作区恰好一个写库（SQLite 默认 / PG 可选），永不双写；写路径已异步 ORM、PG-A 接缝在但无生产调用方；主要成本是 ≈195 处同步裸 SQL 读；verify 仍只判 SQLite 快照（PG 工作区经 `db snapshot`）；分期 B0 裁定 → B1 读路径异步化（B2 schema 单一权威 / B3 检索可并行）→ B4 并发语义 → B5 运维面 → B6 双后端门禁矩阵；D1–D5 待属主裁定 |
| `harness2-dual-validation-plan.md`（方案） | harness2 双线验证（两席共识） | 需求侧不可或缺；外强于内；P1a 方差探针 + evaluator 协议先行；红线=单一裁判权 |
| `REVIEW-0.84.0.md` | 0.84 版本评审 | 判定落账与校准读出 |
| `REVIEW-webui-0.89.1.md` | WebUI 0.89.1 评审 | 视觉 token 与三视图骨架 |

## 与 plan 的关系

`docs/plan.md` 的执行记录按版本聚合「谁在 rNN 提了什么 → 修在哪」；本目录提供原文。两处若有出入，
以报告原文的**问题描述**为准、以 plan 的**修复结论**为准，并在 plan 里补勘误。
