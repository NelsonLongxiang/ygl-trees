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
| `REVIEW-0.84.0.md` | 0.84 版本评审 | 判定落账与校准读出 |
| `REVIEW-webui-0.89.1.md` | WebUI 0.89.1 评审 | 视觉 token 与三视图骨架 |

## 与 plan 的关系

`docs/plan.md` 的执行记录按版本聚合「谁在 rNN 提了什么 → 修在哪」；本目录提供原文。两处若有出入，
以报告原文的**问题描述**为准、以 plan 的**修复结论**为准，并在 plan 里补勘误。
