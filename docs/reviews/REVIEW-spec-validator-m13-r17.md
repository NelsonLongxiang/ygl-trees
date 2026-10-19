# M13 复核 r17：0.99.1（首签实证 + r16 P1/P2 修复）

复核对象：commit `a373fda` / tag `v0.99.1`，npm latest=0.99.1。
复核方式：源码 diff 审阅 + 真实 0.98.0 字节复读 + r16 攻击复跑 + 首签身份链独立复核（生产表与归档只读访问）。

## 0. 结论

**PASS。** r16 的 P1/P2 三项修复用真实字节与真实攻击复验有效；首签身份链（签名→登记→封包运行→报告导入→归档→归档校验）独立复现成立，生产密钥表自洽、私钥未入仓。附 4 条 P3 补强（测试覆盖/文档措辞），不阻塞。

## 1. r16 P1：legacy 0.98.0 按 unsigned 读回（实测）

- 真实 0.98.0 产物 `tmp/r15/sealed.exe`（4,781,808 B）：`verify signature` → `{format_version:null, signed:false, verified:false, problems:[]}` rc=1（是「未签名」而非「不可读」）；`verify register` rc=0，登记 `corpus_version:"1"`（legacy footer 原值）。
- 代码：`packages/ops/tools/src/sealed-binary.ts:72-76` 仅对 `!legacy` 做 footer 规范形断言、`:100-102` 仅对 `!legacy` 做 spec 规范形断言；magic/布局/`spec_sha256`/`build_sha256`/（有则）`engine_sha256` 全部保留。legacy 判定 = footer 无 `format_version`。
- 用例 `packages/ops/tools/tests/sealed-signature.spec.ts:138-160` 用 `JSON.stringify` 字段序 + 缩进 spec + 无 `format_version`/`engine_sha256`，与真实字节同族（比 r16 的「规范形 legacy」正确）。
- 残余观察 O3（P3，非缺陷）：从 signed v1 封包删除 `format_version`/`sig_alg`/`key_id`/`sig` 后即成为可登记的 unsigned legacy（我实测 `downgraded.exe` register rc=0）。这是 legacy 容忍的派生面：字节与 sha 都变，注册记录 `signed:false`；若消费方拿错原始约定就会误当「同物」。建议 `docs/verify-signing.md` §2 加一句：unsigned legacy 仅表示「完整性可验」，发布物应要求 signed 注册。

## 2. r16 P2①：工作区二进制内容身份（实测）

- 复跑 r16 攻击（同 key 签的另一封包替换 `binaries/<sha>.bin`）：`report import` → **rc=1** `binary identity mismatch: workspace copy is sha256:958f4… but the report names sha256:0868b…`；恢复后 rc=0 `imported:true`。r16 时该攻击 `imported:true`。
- `verify archive --with binary` 同守卫（`packages/ops/tools/src/archive.ts:235-242`）：替换后 `archive failed: workspace binary … has different bytes … refusing to archive` rc=1；恢复后归档成功。
- 代码位置：`packages/ops/tools/src/verify-cmds.ts:606-617`（import 侧，文件名之外再比 `probe.binary_sha256 === report.verifier.binary_sha256`）。
- 缺口（P3-1）：archive 侧新分支**无测试覆盖**（`grep "refusing to archive"` 仅源码），建议补一条 CLI 用例。

## 3. r16 P2②：密钥表自检（实测）

- 坏表（`key_id=000…0`、`public_key=111…1`）→ rc=1 `cannot read signing key table …: key table inconsistency: entry 000000… carries a public key whose fingerprint is 02d449a3…`（`verify-cmds.ts:232-243`，逐键校验 64 hex + `fingerprintOfRawPublicKey(pub)===key_id`）。
- 正常表（生产表）验签 rc=0，无误伤。

## 4. 首签实证（独立复核，只读）

- 生产密钥表 `$YGL_HOME/verify/keys/signing-keys.json`：`key_id=80a978faf42e1360…b8e3632`，`public_key=32e9eb5b205d4b7c…11dd8327`；`sha256(pub)` 复算 = `80a978fa…` ✓（认表前提自洽）。私钥 `production.seed` 在 home、未入仓（`git ls-files` 无 seed）。
- 封包二进制 `0e6859cb6e7431b116fac203daf54ba7c44d8e7c35084eba0968c53c2206c973.bin`（4,935,163 B）：
  - `verify signature` rc=0 `verified:true`；`--expect-key 32e9…` 同样 rc=0（离线单键通道可用）。
  - footer `sig` === 报告 `verifier.signature`；footer `key_id` === 报告 `verifier.public_key_fingerprint`；`sig_alg=ed25519`，`format_version=1`。
  - 报告 `run_first_signed`：overall PASS / summary pass=5、spec `spec_efb9a6a40450` v3、`mode=sealed`、`corpus_version=1.1`。
- 登记 `registrations/0e6859cb….json`：`signature:{signed:true, verified:true, scheme:ed25519, key_id:80a978fa…}`、`platform win32/x64`、size/build/spec 哈希齐。
- 归档 `yglverify-cordis-cordis-v3-20261020T043000Z-rfed.yglverify.zip`：sha256 `ad3e732b…`（= 侧车 `zip_sha256`）；`archive verify` → `{ok:true, archive_id:arc_8b717422ca3a, items:6}`；包内 `report.json` 带签名身份，`verifier/binary/yglverify` 4,935,163 B 与登记一致；`--with binary` 六个 manifest 项齐。
- 侧车 `archives/run_first_signed.json` 与文档 §3 记录一致（`arc_8b717422ca3a`、`zip_sha256 ad3e732b…`、created 2026-10-20T04:30Z）。

## 5. corpus_version 收口

- `packages/verify/core/src/contract.ts` 导出 `CORPUS_VERSION="1.1"`；`prepare.ts:427` 默认值与 `verify-cmds.ts:389` CLI 传参都改用它；grep 无残留 `corpus_version "1.0"` 硬编码。历史 spec 按自身 `verifier.corpus_version` 进报告/归档，版本链自洽。
- 缺口（P3-2）：`tests/prepare.spec.ts` 无 `corpus_version` 断言，`CORPUS_VERSION` 默认值无回归保护；建议加一行。

## 6. 门禁实测

- `cargo test`：**31/31**（含新增 `seal_accepts_seed_file_with_trailing_newline`）。
- verify-core + ops 定向（17 文件）：**140/140**。
- `pnpm test:unit` 全量：见终报（后台运行，开发线声称 398）。
- npm `view ygl-trees version` = **0.99.1**；tag `v0.99.1` 指向 HEAD。

## 7. P3 补强建议（非阻塞）

1. `archive.ts` 内容身份分支补 CLI 用例（替换字节 → 归档拒绝）。
2. `prepare.spec.ts` 断言新建 spec 的 `verifier.corpus_version === CORPUS_VERSION`。
3. `docs/verify-signing.md` §2 补「unsigned legacy = 完整性可验、身份未证；发布物要求 signed」，并说明 strip 签名后的字节是另一个 sha（降级不保留身份）。
4. `docs/verify-signing.md:101/111` 的「archive verify 签名项」措辞：archive verify 不重验证签名（无密钥表输入），它核的是归档内二进制/登记与 manifest 的哈希链；建议改为「签名登记项一致性」并指向 `verify signature` + 可信表。
