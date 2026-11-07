# M13 复核 r14：d4f5eb9（r13 P1×4 修复 + 整份报告 parity）

评审对象：`d4f5eb9`（HEAD，父 `6c44433`），开发线任务 `direct-83f58398`。
评审线方法：源码/契约核对 + 双引擎实跑探针（TS `dist/` core 与 Rust release）、封包链 E2E、归档链 E2E、逐字节报告对比。

## 0. 结论

**PASS（有条件）。** r13 的 P1×4 与「整份报告 parity」主张经实测成立：全量 unit **61 文件/378 测试全绿**（148s，exit 0）、verify-core 91/91（含 33 例双引擎 parity）与 `cargo test` 25/25 全绿；同一 spec+db+`--now`+run-id 下，两引擎报告剥 `data_source` 后 canonical 逐字节相等，`payload_sha256` 两边重算一致。封包 register→import→archive 与篡改判定主链可用。

但 3 项须在 **M13-1b 收口/0.98.0 发布前** 闭合：

- **R1（阻塞归档链）** `data_source.sha256` 格式不一致：Rust 写 `sha256:<hex>`，TS `snapshotCopy` 写裸 hex；`archive --with snapshot` 直接拿该字符串拼文件名 → **Rust 报告的 snapshot 归档必失败**（实测），与开发线「断链已接」表述不符。
- **R2（阻塞 parity 门可信度）** parity 门两处弱于声明：`rust-parity.spec.ts:97` 只断言 `tsPayload===rustCore` 与 `typeof rustPayload==="string"`，**未断言 `rustPayload===rustCore`**；`hasRust=false` 时整组 `skip`（无 release 产物即静默绿）。
- **R3（fail-open 分类）** 封包篡改判定：footer JSON 语法被坏或 magic 字节被坏时 `looks_sealed()` 返回 false → `read_sealed_file()` 返回 None → 二进制按**开放模式**运行并要求 `--spec`（rc=2 用法错误），而不是 rc=1 点名篡改。实测：spec 字节篡改 → rc=1 ✓；magic 字节篡改 → rc=2（降级）；footer JSON 字节篡改 → rc=2（降级）。

## 1. 已核实的 P1×4

### 1.1 Rust 装配守卫（r13 P1-1）
- 同一 spec+db（count/exists 对空表）：TS 与 Rust 均 `NEEDS-MATERIAL`，evidence 逐字一致：`{"count":0,"op":"==","expected":0,"degraded_from":"PASS","reason":"zero rows scanned — cannot assert PASS (vacuous prevention)"}`（键序不同，canonical 相同）。
- 守卫与 parity 均按 `mode` 无关的方式实现，`command/agent` 排除逻辑正确（命令/审查单元无 witness）。

### 1.2 整份报告 parity（r13 P1-2）
同一 `sql-find-violation` 语料、同一 db、`--now 2026-10-19T00:00:00.000Z`、同一 run-id：
- 剥 `data_source` 与 `payload_sha256` 后 `canonicalStringify` **相等 true**；
- Rust `payload_sha256=sha256:587f628b…`，`payloadHash(rust)` 重算同值；TS 注入 `data_source` 后重算同值（TS 原生报告因无 `data_source` 而异值，符合约定）；
- `guard`（leniency_checks）、`exceptions`（`{vu,severity,row_count}`，仅 assert FAIL/NM）、`artifacts.attachment_sha256`、`evidence`（`rows/rows_total/violations`）、`reason`（`V1(S1) FAIL`）全部对齐；
- Rust report 键集：`as_of, contract_version, exceptions, finished, overall, payload_sha256, reason, run_id, spec_id, started, summary, verifier, vu`；open 模式无 `verifier.binary_sha256`（`skip_serializing_if`），sealed 模式有。

### 1.3 data_source 锚（r13 P1-3）
- `--now` 钉住 `captured_at`；`sha256` 为运行前 `--db` 字节的摘要（实测与 `sha256sum` 一致，`bd8cd5ea…`）；
- `source` 保留原始路径；Rust 侧在 open 前读字节，锚语义正确。

### 1.4 R7 登记闭环
- `verify register <sealed.exe>` → 写 `registrations/<hex>.json` + `binaries/<hex>.bin`（`binary_sha256=sha256:cdbdd3ed…`）；
- `verify report import`（sealed 报告）→ rc=0，`spec_restored` 成功；
- `verify archive <run> --with binary` → items 4，成功。

## 2. R1 细节与修法（必须）

实测：
```
Rust data_source.sha256 = "sha256:48516646…"   （main.rs:175 `format!("sha256:{}", …)`）
TS  data_source.sha256 = "34319abe…"           （verify-cmds.ts:148 snapshotCopy → 裸 hex）
archive 查找 = snapshots/<report.data_source.sha256>.sqlite   （archive.ts:207-209）
→ archive --with snapshot: "snapshot sha256:48516 is not retained in the workspace"
对照 TS 报告（裸 hex）→ archive --with snapshot 成功（items 3）
```
修法（建议）：契约统一 `sha256:<hex>` 形式（与 `binary_sha256`、`schema_fingerprint` 一致），并在 `retainSnapshot`/`archive` 落文件名时 `stripShaPrefix()`；或反向统一裸 hex。二者择一 + 常量与契约文档同步。补一条 33 例外的 E2E：sealed 报告 → 手工 retain → `archive --with snapshot` 成功；再加一条 **Rust 报告 parity** 断言 `data_source.sha256` 格式（当前 parity 门把它剥掉了，格式差异正是被剥掉的字段造成的盲区）。

## 3. R2 细节与修法（必须）

`packages/verify/core/tests/rust-parity.spec.ts`：
- L97：`if (tsPayload !== rustCore || typeof rustPayload !== "string")` —— 应加 `|| rustPayload !== rustCore`（开发线声称的三方相等目前没有断言）。
- L20/L34：`hasRust=false` 时 `it.skipIf(!hasRust)` → 整个 parity 组 skip；在 CI 里没有 `cargo build --release` 的流水线会**静默跳过** M13-1b 的核心证据门。建议：`YGL_REQUIRE_RUST=1` 时 `hasRust===false` 直接 fail；CI 与发布门禁必须设置该变量（或 gate 脚本先检查产物存在）。

## 4. R3 细节与修法（建议本批）

`sealed.rs::looks_sealed()` 用 `serde_json::from_slice::<Footer>(…)` 解析成功且 `magic===MAGIC` 才算封包候选。任何破坏 footer JSON 语法、或破坏 magic 字段值的篡改都会落入「未封包」分支：
- `read_sealed_file` → `Ok(None)` → `run` 走开放模式 → 要求 `--spec`（rc=2）。
- 语义后果：**「封包拒绝 --spec」与「启动自校验」在本地篡改面前不是 fail-closed**；被封包形态就不再成立（虽然攻击者本来也能截断尾部——封包是 tamper-evidence 而非防改造，但这属于「应报错却降级」的分类错误）。

修法：判定改为「结构性证据」——trailer 的 4 字节小端长度指到窗口内、该窗口以 `{` 开头或包含 `YGLVF1` 子串、或窗口可解析为含 `magic` 键的 JSON 对象，任一成立即视为封包候选；候选校验失败一律 rc=1（`sealed binary is corrupted — …`）。文档 §8.5.1 同步「本地可截断 ⇒ 只承诺 tamper-evidence；损坏必须响亮失败」。

## 5. 签名裁定（ed25519；回答开发线问题）

**覆盖面**：签名对象 = 域分隔串 `"YGLVERIFY-SEAL-v1\0"` + `u32le(footer_len)` + `JCS(footer_without_sig)`。

理由与要求：
1. **JCS，不是 serde 字段序**：footer 由 Rust 序列化，键序是结构体序；签名必须对规范化字节（复用 `canonical.rs` 的 JCS 子集），否则跨实现/跨版本不可复验。
2. **带域分隔**：防止同一密钥在不同用途（登记的 binary_sha、报告）间交叉重放。
3. **footer 必须新增 `format_version` 与 `engine_sha256`**：`build_sha256=H(engine||spec)` 不绑定切分点；虽然 `spec_offset/spec_length` 已签可间接绑定，`engine_sha256` 让引擎身份可独立登记/分发，且为后续引擎兼容矩阵留锚。现在加，比签名格式冻结后再加便宜。
4. **签名输入不含 `sig` 字段**；footer 增 `sig_alg:"ed25519"`、`key_id`、`sig`（base64 或 hex，择一并写进契约）。`signed_at` 不签（或单独作元数据），避免时钟依赖。
5. **信任锚**：`key_id` → 工作区 `registrations/` 或分发表；`--expect-key <path>` 提供带外通道；**禁止用封包内嵌公钥自证**（攻击者可同时替换公钥与签名）。`self-check` 仅在提供信任源时验签，否则只报「signature present, key <id>」。
6. **验证顺序**：解析 footer → 校验 raw 字节 == JCS(parse)（拒绝非规范字节/重复键）→ 重算 `spec_sha256`/`build_sha256` → 验签 → 才信任字段。`register` 写登记前验签；`report import` 校验登记签名 + `binary_sha256`。验签失败 rc=1（`sealed binary signature invalid`），**不回落开放模式**。
7. **覆盖范围**：不签报告/`data_source`/材料——它们各自以哈希入链（`payload_sha256`、`data_source.sha256`、`materials_sha256`），§8.5.1 写清「签名保护的是引擎+规范+footer 元数据」。
8. **实现顺序（我的判断）**：先落 R1/R2/R3（小改，减少签名矩阵的变量），再上签名；签名与 `format_version`/`engine_sha256` 一起定型，然后 M13-1b 收口、0.98.0 打包。

## 6. 覆盖缺口（建议补，不阻塞）

- **`artifacts.attachment_sha256` 无语料**：33 例均无 `spec.attachments`，parity 门对该字段是空对空；建议加 1 例带 embedded attachments 的语料（顺带覆盖 `witness.sources` 的 attachments 路径）。
- **`data_source` 两种 `captured_at` 语义**（TS 真实时刻 / Rust `--now`）已在 parity 中被剥；契约需写明这是环境锚，不参与双实现字节等价。
- **`--command-allow` 在封包模式仍可运行时开放**：建议文档写明（封包内 command 单元必须显式 allowlist 才执行；默认 ERROR），避免「封包不放开执行面」的误读。

## 7. 证据索引

- `rust/yglverify/src/sealed.rs:111-160`（looks_sealed/read_sealed_file）、`:48-77`（footer 字段）。
- `rust/yglverify/src/main.rs:160-186`（data_source sha 前缀）、`:175`。
- `packages/ops/tools/src/verify-cmds.ts:148-156`（snapshotCopy 裸 hex）、`:383-385`（TS 报告 data_source + payload 重算）。
- `packages/ops/tools/src/archive.ts:52`（short = slice(0,12)）、`:204-210`（snapshot 查找）、`:410-416`（retainSnapshot 文件名）。
- `packages/verify/core/tests/rust-parity.spec.ts:20-21,34,88-102`（skip 与 payload 断言）。
- 实跑：全量 unit 378/378（61 文件，exit 0）；verify-core 91/91（11 文件，含 rust-parity 33 例）；`cargo test` 25/25；`pnpm build` 干净；封包链与归档链探针见 tmp/r13probe、tmp/r13home。
