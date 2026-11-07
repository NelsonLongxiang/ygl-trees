# M13 复核 r16：0.99.0 封包签名批（ed25519 · footer v1）

评审对象：commit `f18e7e4` / tag `v0.99.0`（HEAD），契约 `contract_version 1.1` + `corpus_version 1.1`。
方法：源码核对（signature.ts / sealed-binary.ts / verify-cmds.ts / sealed.rs / main.rs）+ 独立密钥与封包 E2E（探针 `tmp/r16/probe*.cjs`）+ 定向门禁复跑。
立场：只审实现是否兑现声称；不重开签名方案。

## 0. 结论

**PASS（签名核心成立），附 1 个 P1 兼容缺陷 + 2 个 P2 加固项 + 4 个 P3 口径项。**

①–⑥ 的主体全部实测兑现。唯一与承诺不符的是「legacy unsigned 读取」：真实的 0.98.0 封包被 0.99.0 判为「非规范 footer」直接拒读（根因与单测缺口见 P1）。这不是签名安全问题（fail-closed），但文档与 commit message 的兼容承诺是错的，且旧构建的登记/归档链在 0.99 CLI 下不可用。

## 1. 实测通过（独立复现，非引用单测）

| 声称 | 证据 |
|---|---|
| footer v1 字段与布局 | Rust `seal --key` 产 footer：`build_sha256, corpus_version, engine_sha256, engine_version, format_version, key_id, magic, sig, sig_alg, spec_length, spec_offset, spec_sha256`；`magic=YGLVF1`、`format_version=1`、`sig_alg=ed25519`、`key_id=21fe31df…`（RFC 8032 §7.1 test-1 指纹） |
| ② 签名输入 = JCS(去 sig footer) | `verify signature` 对正常封包 rc=0；非规范 footer（插空格）rc=1 `sealed footer is not canonical` |
| ⑤ 跨实现逐字节一致 | 用 TS `signFooter(canonical, seed)` 复算 → 与 Rust footer.sig **逐字节相同**（`Y7QvBHTlLM5j…`）；`fingerprintOfRawPublicKey === key_id` |
| ③ 认表不认报文 | `--expect-key` rc=0；`--keys` rc=0；无表 rc=1 `no signing key table`；错键 rc=1 `is not in the repository key table`；退役键 rc=1 `was retired at …` |
| ⑥ 篡改矩阵（TS 侧七向） | engine 字节→`build_sha256 mismatch`；spec 字节→`spec_sha256 mismatch`；sig 字节→`signature does not verify`；未知版本→`format_version 2 is not supported`；非规范 footer→`not canonical`；未知 key→`not in the repository key table`；退役 key→`retired`。全部 rc=1 且点名，均不回落开放模式 |
| ④ register 先验签再登记 | 篡改 sig/engine/alg 的封包 register 全部 rc=1，未写登记；正常封包登记 `signature {signed:true,verified:true,scheme:ed25519,key_id}` |
| ④ 报告签名身份 | sealed run 报告 `verifier.mode=sealed`、`signature === footer.sig`、`signing_scheme=ed25519`、`public_key_fingerprint === key_id`、`binary_sha256` 命中登记 |
| ④ import 重新验签 | 带 `--keys` → `imported:true`（二次幂等）；翻转工作区二进制副本字节 → `imported:false` 且点名 `build_sha256 mismatch`；**无表 → fail-closed**（`no signing key table`） |
| archive --with binary | items=4、`archive verify {ok:true}` |
| unsigned v1（seal 无 --key） | `verify signature` signed=false + warning；register 成功 `signed:false`；run 报告不带签名三字段；import `imported:true` |
| 语料/契约 1.1 | manifest digest `4cac21b4f5bc3edd…`（129 文件）；33 份 spec diff 仅 `contract_version` 一行；self-check `contract 1.1 · corpus 1.1 · 33 cases ok` |
| 门禁 | verify-core 100/100；cargo **30**/30（声称 28）；ops 套件 215/216——唯一失败是既有 webui `ECONNRESET` 环境 flake（单跑 17/17 过，与签名无关） |

## 2. P1：legacy 0.98.0 封包被「非规范 footer」拒读（承诺破灭）

- 实证：`tmp/r15/sealed.exe`（0.98.0 产物）footer 为 `magic,spec_offset,…`（serde 字段序，非 JCS）→ `canonical:false`；`verify signature` 与 `verify register` 均 rc=1：
  `not a sealed yglverify binary: sealed footer is not canonical (raw != JCS(parse)) — refusing to trust a non-canonical footer`。
- 与文档冲突：`docs/verify-signing.md:32`「旧封包（0.98.0 及以前）按 unsigned 读取…登记里 signature.signed=false」；`docs/verify-contract.md:325`「无 format_version = legacy unsigned」；verify-cmds.ts:765 注释同口径。
- 根因：`sealed-binary.ts:72` 对**所有** footer 强制 `raw == JCS(parse(raw))`，未按 `format_version === undefined` 豁免；0.98.0 的 serde 字段序必然非 JCS。
- 单测为什么没抓到：`sealed-signature.spec.ts` 的 `craftSealed({format_version:null})` 仍用 `canonicalStringify` 落 footer（且带 0.98 版没有的 `engine_sha256`），造出来的是「规范形 legacy」——真实字节从未进测试。
- 修法（一行级）：`legacy = footer.format_version === undefined` 时跳过 canonical 断言（仍做 magic/布局/哈希链校验；无签名输入要构造，故无歧义风险）；补一个真实 0.98.0 字节 fixture（可复制 `tmp/r15/sealed.exe` 的 footer 序）或逐字节等价副本；`docs/verify-contract.md:110` 补一句「legacy footer 豁免 JCS」。

## 3. P2：import/archive 信任「文件名即哈希」，工作区二进制可替换

- 实证（`tmp/r16/probe4.cjs`）：把 `$YGL_HOME/verify/binaries/<report_binary_sha256>.bin` 换成**同 key 签名的另一个封包**（不同 spec，实测 h2 `d71b3bc0…`）→ `report import` 仍 `imported:true`。
- 根因：verify-cmds.ts:602 用 `report.verifier.binary_sha256` 拼路径后只做 `readSealedBinary` + 验签 + 比对指纹，**没有把文件字节 hash 回比 `report.verifier.binary_sha256` / `registration.binary_sha256`**。签名成立（同一把 key），但报告自述的构建与工作区字节脱钩。
- 修法：读入后先断言 `sealed.binary_sha256 === "sha256:"+binaryKey(期望)`（或 `sha256(bytes) === binaryKey(bin)`），不一致点名 `binary bytes do not match the recorded binary_sha256`；`archive --with binary` 同样在入包前 hash 回比（现在直接 `readFileSync(bin)`）。
- 影响面：需工作区写权限 + 一张合法签名的另一构建；属加固，不改签名方案。

## 4. P2：密钥表缺自一致性校验

- `verifyAgainstTable` 以 `keys[footer.key_id]` 取 `public_key` 验签，但不校验 `sha256(entry.public_key) === key_id`。表是人维资产，一行贴错（把 A 的公钥放在 B 指纹下）会让「签名验过但 key_id 与公钥不对应」，provenance 陈述变成运维笔误的产物。
- 修法：`loadKeyTable` 载入时逐行校验 64 hex + 指纹自洽，坏行直接 rc=1 点名；文档 §3 加一句「表载入即自检」。

## 5. P3 口径项

1. **「两侧点名拒绝」表述过宽**：Rust 侧只做密封/结构/哈希链（`sealed.rs` 无验签路径，验签全在 TS）；签名/key/退役/format 的矩阵是 TS 单侧。commit message 与 docs §5 建议改「TS 侧七向 + Rust 侧结构/哈希四向」。
2. **Rust 测试数**：实测 30 passed（声称 28），门禁记账对不上（多出来的是新增 sealed 用例？核对并改数）。
3. **注释漂移**：`engine.rs:34`、`sealed.rs:10-11` 仍写 `alg/key_id/signature`，实际字段是 `sig_alg/key_id/sig`。
4. **import 依赖可信表未写明**：§5 只说「重新从工作区验签」，没说 signed 登记 import 还需要 `--keys`/`YGL_VERIFY_KEYS`/`$YGL_HOME/verify/keys/signing-keys.json`，缺表时是 fail-closed（实测）；同时 §6「报告 signature 与 footer 不一致」目前无机械检查（import 只比 `public_key_fingerprint`）——建议顺手加 `report.verifier.signature === footer.sig` 的比对，否则删掉该行。
5. **`register --no-copy` 陷阱**：不复制二进制后，signed 报告 import 必失败（`binary not found in the workspace`）。fail-closed 正确，但文档应写明该旗标只适合「不留副本」场景。
6. **corpus_version 双源**：manifest/self-check 是 1.1，但 33 份 spec 的 `verifier.corpus_version` 仍是 `"1"`，footer 记录的是后者（实测 register 输出 `corpus_version: "1"`）。若是刻意（spec 要求的最小语料版本），文档注明；否则统一。

## 6. 结论与后续

- 签名方案与实现**可以采信**：字节布局、签名域、跨实现确定性、认表不认报文、fail-closed 全部成立；未发现可绕过验签的路径。
- P1（legacy compat）建议 0.99.1 修（条件豁免 + 真实字节 fixture）；P2×2 与 P3 文档项可同批。
- 未做（明确）：生产密钥仪式与首签（挂账，与开发线声明一致）；Rust 侧独立验签实现（当前设计是 TS 验签，Rust 产签）。
