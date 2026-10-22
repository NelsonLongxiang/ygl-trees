# verify 契约状态日志（冻结附录）

> 2026-10-23 文档预算治理：由 `docs/verify-contract.md` §6 状态 移出，内容未改动；现行契约见 [../verify-contract.md](../verify-contract.md)。

## 状态日志

- **v1.5（2026-10-21）**：`contract_version` 升 **1.2**、`corpus_version` 升 **1.2**——新增「右值可引用列」两形态（同表 `{col}` 列对列 / `count.against` 单值标量，`agg` 必填）、`evidence.spec_error` 封闭码表、`compared_rows`/`compared_total`/`compared` 观测面；1.1 spec 兼容运行，1.1 声明携带 1.2 形态 → `version_shape` 入口拒跑；语料 33→44 例（digest `ee1a0a1d…`→`683766f1…`）。
- **v1.4（2026-10-20）**：`contract_version` 升 **1.1**、`corpus_version` 升 **1.1**——报告 `verifier` 增 `signature` / `signing_scheme` / `public_key_fingerprint` 三个可选字段；封包 footer 增 `format_version` / `engine_sha256` / `sig_alg` / `key_id` / `sig`（语义布局与字节布局合一，§5）。TS 与 Rust 各自实现 ed25519，固定种子下签名逐字节一致（`seal-parity.spec.ts`）；五向篡改矩阵（spec 字节 / engine 字节 / 非规范 footer / 签名字节 / 未知或退役 key / format_version）全部点名拒绝。语料 digest 因 33 份 spec 的 `contract_version` 升版而变：`4cac21b4f5bc…`（差异仅版本字段，见 `packages/verify/core/CHANGELOG.md`）。
- **v1.3（2026-10-20）**：双实现 parity 从「投影一致」升级为「整份报告逐字节」——`rust-parity.spec.ts` 33 例剥 `data_source` 后 `canonicalStringify` 全等，且把环境锚注入 TS 侧后两边重算的 `payload_sha256` 三方相等；Rust 侧补齐 `data_source`、`guard`、`artifacts`、`exceptions`、`evidence.rows`/`rendered`、`reason` 折叠文案与真实 `started/finished`（`--now` 可钉）。`contract_version` 仍 1.0（Rust 追平 TS，不是形状变更）。
- **v1.2（2026-10-20）**：Rust `yglverify` 补封包形态（§5 实现形态：`seal` / 内嵌 spec / 拒绝 `--spec` / 双哈希篡改检测 / `self-check` 的 `sealed-spec` 行）；`contract_version` 仍 1.0（交付形态，不是 spec/report 形状变更）。
- **v1.1（2026-10-20）**：新增 §7 归档包（命名语法 / 包内目录 / 确定性 zip / 校验链 / 侧车登记），`verify run` 默认归档；`contract_version` 仍 1.0（归档是命令面能力，不是 spec/report 形状变更）。
- **v1.0（冻结，2026-10-19）**：v0.5 之后并入 r10 评审 F1–F6（prepare sql 分支 `$vu:` 收窄、window 的 `±hh` 偏移归一、M13-1 拒 agent 型 + `sealed.review=false`、as_of 必由调用方给、canonical 拒非纯对象、数字口径改 ES 形态并写明三条相对 RFC 8785 的有意偏离）；引擎入口加契约版本守卫（1.0 引擎只跑 1.0 spec）；报告增 `spec_id` / `data_source` 两个可选自描述字段。**冻结**：`contract_version = "1.0"`、`corpus_version = "1.0"`；此后形状变更走 1.0→1.1 升版，不得静默改 1.0 内文。
- v0.5：r9 评审 E1–E5 落文与修复（sql-pair 谓词侧键名/同族守卫、空批聚合对 NEEDS-MATERIAL、sql/count/exists 禁 agg、±hh 偏移归一、prepare P2 白名单与 schema 全量校验、`$vu:` 收窄、附件 sha256 进 spec、P3/P4 配置错误归 `error`）+ JCS canonical 落地实现与跨实现向量 + §1.6 prepare 五阶段规则表。
- v0.4：评审 R7–R13 落文（CompareSpec 单一形状 + ε 规则 / 零匹配按型 / task 副作用统一 / JCS canonical + 方言相关指纹 / as_of 时间函数构造期拒绝）+ 实现缺口 a–f 修复（source 失败级联 ERROR、`$vu:` 命名空间、schema 漂移 ERROR、glob 根目录、无 assert 拒绝、witness 口径重写）。
- v0.3：评审 302cb119 R1/R2/R3/R4 契约面落文（witness 语义表 / count from-sql 互斥 / attachments 新表裁定 / VuResult witness 类型强制）。
- v0.2：已并入 fdc757f6 D0 快检三条（sql-pair 互斥 / 命令名统一 / 七型形状齐为冻结前置）与 302cb119 B1/B2/B3/B5 契约面（overall+severity / witness / footer+登记 / CompareSpec+as_of）。**未冻结**。
- 冻结动作：上述冻结条件三条满足后，`contract_version` 钉 `1.0` + CHANGELOG 记录 + 双评审收尾回执。
