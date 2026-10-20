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
| `harness2-dual-validation-plan.md`（方案） | harness2 双线验证（两席共识） | 需求侧不可或缺；外强于内；P1a 方差探针 + evaluator 协议先行；红线=单一裁判权 |
| `REVIEW-0.84.0.md` | 0.84 版本评审 | 判定落账与校准读出 |
| `REVIEW-webui-0.89.1.md` | WebUI 0.89.1 评审 | 视觉 token 与三视图骨架 |

## 与 plan 的关系

`docs/plan.md` 的执行记录按版本聚合「谁在 rNN 提了什么 → 修在哪」；本目录提供原文。两处若有出入，
以报告原文的**问题描述**为准、以 plan 的**修复结论**为准，并在 plan 里补勘误。
