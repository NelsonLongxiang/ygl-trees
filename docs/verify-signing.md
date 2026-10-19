# 封包签名（ed25519 · footer v1）

> 本文件是签名批的**运维口径**：密钥表怎么管、验签认什么、信任到什么程度。
> 形状与字节布局以 [verify-contract.md](./verify-contract.md) §5 为准；这里是"怎么用、出问题怎么办"。

## 1. 它解决什么，不解决什么

- **解决**：交付物（封包二进制）与它的规范字节、引擎字节在发布之后被改动时，能被机械发现并点名；
  报告能带出"这份报告是哪个签名构建跑出来的"（`verifier.signature` / `signing_scheme` / `public_key_fingerprint`）。
- **不解决**：不能防"构建侧自己作恶"——签名只能证明"这个字节是持私钥的人签的"，不能证明"这个规范是对的"。
  判定正确性靠 material 逐字锚点 + 盲审 + 语料 + 报告可重算，不靠签名。
- **不解决**：签名不等于信任。真正的信任锚是**带外登记的 `binary_sha256`**（`verify register` 落在 `$YGL_HOME/verify/registrations/` 的那一行），
  签名只是让"这个哈希属于谁"可核对。两者缺一，都不应把报告当成发布证据。

## 2. 字节与签名输入

```
[engine 字节][spec json (JCS)][footer json (JCS)][footer_len: u32 LE]
footer = { magic:"YGLVF1", format_version:1, spec_offset, spec_length,
           spec_sha256, engine_sha256, build_sha256,
           engine_version, corpus_version,
           sig_alg:"ed25519", key_id, sig }
```

- **签名输入 = `JCS(去掉 sig 字段的 footer)`**：`sig_alg` 与 `key_id` 在签名输入内，`sig` 不在。
  签名的是文件里的原始 footer 字节（校验时还要求 `raw == JCS(parse(raw))`，非规范 footer 直接拒）。
- `key_id = sha256(32 字节原始公钥)` 的小写 hex（不是 base64、不是 PEM）。
- 产签方：`yglverify seal --spec <spec.json> --out <file> --key <seed-file>`。
  种子文件是 32 字节原始或 64 字符 hex；**私钥永不进仓库**（本仓库只在 `tests/` 用 RFC 8032 §7.1 的公开测试种子）。
- 跨实现口径：同一 spec、同一引擎字节、同一种子 → TS `signFooter` 与 Rust `seal` 产出的 `signature` 逐字节相同
  （`packages/verify/core/tests/seal-parity.spec.ts` 机械断言；ed25519 本身是确定性的）。
- 旧封包（0.98.0 及以前，footer 无 `format_version`）按 **unsigned** 读取：不假称已验证，登记里 `signature.signed=false`。

## 3. 密钥表（`docs/verify-signing.md` 即表，认表不认报文）

```json
{
  "scheme": "ed25519",
  "keys": {
    "80a978faf42e13605148a9a2ff38de14b3b693b23547756db95419f43b8e3632": {
      "public_key": "32e9eb5b205d4b7c30338dfcd44ef51c242670b315269304f9b0c8b211dd8327",
      "created": "2026-10-20",
      "label": "ygl-trees release key #1"
    }
  }
}
```

> 首签记录（2026-10-20）：key #1 签发封包 `yglverify`（spec `spec_efb9a6a40450` v3，Cordis 漂移守卫 5 判据），
> `binary_sha256 = sha256:0e6859cb6e7431b116fac203daf54ba7c44d8e7c35084eba0968c53c2206c973`；
> `verify signature` rc=0 → `verify register` 落 `registrations/0e6859cb….json` → 封包直跑 `run_first_signed`
> （overall PASS 5/5，报告 `verifier.{signature,signing_scheme:ed25519,public_key_fingerprint}` 齐）→
> `verify report import` `imported:true` → `verify archive --with binary`（`arc_8b717422ca3a`，6 项）→
> `verify archive verify` `{ok:true}`。私钥在本机 `$YGL_HOME/verify/keys/production.seed`（0600），不进仓库。

- 验签**只认这张表**：`key_id` 必须命中且未 `retired_at`，签名必须能验过；任一条不满足即拒绝。
  **公钥不得只从报告/封包自带材料自证**——那等于让被验方自己出证词。
- 轮换纪律：**只增不换**。新密钥追加一行；旧密钥标 `retired_at` 而不是删除（旧构建的报告还要能复核）。
- 表的位置（实现口径）：显式 `--keys <file>` 或环境变量 `YGL_VERIFY_KEYS` 优先；否则读
  `$YGL_HOME/verify/keys/signing-keys.json`。仓库里这张表是**运维资产**（发布负责人维护），
  不随发行包分发；CI 里把表缓存下来用 `--keys` 指过去即可。
- 验签命令：`verify signature <sealed-binary> [--expect-key <hex|file>] [--keys <file>]`
  - `--expect-key` 用于带外钉死（只认这一把公钥，不查表）；
  - 两者都不给且 `$YGL_HOME/verify/keys/signing-keys.json` 不存在 → rc=1，`problems` 说明「没有可信表」；
  - 退出码：0 = 验过；1 = 验不过 / 不是封包 / 表不可用；2 = 用法错误。**判定在输出对象里，rc 只表达过程**。

## 4. 验签顺序（fail-closed，各自点名）

1. 尾部结构与 footer 能否解析（不是封包 → `not a sealed yglverify binary`）；
2. `format_version` 支持（1；无字段 = legacy unsigned）；
3. `raw footer == JCS(footer)`（非规范 → 拒绝，避免验签输入两边错位）；
4. `spec_sha256`（内嵌规范被改）、`engine_sha256`（引擎被改）、`build_sha256 = H(engine||spec)`（两段任一被改）；
5. `sig_alg == "ed25519"`；
6. `key_id` 在表内且未退役；
7. ed25519 验签。

任何一步失败都点名到具体项（`sealed spec_sha256 mismatch` / `signature does not verify against the published key` / `key <id>… is retired`）。
**失败不回落开放模式**：尾部像封包就按封包处理，rc=1，不降级。

### 4.1 字段拼写与「run 不验签」

- footer 字段名是 **`sig_alg`**（不是 `alg`）、**`key_id`**、**`sig`**；报告侧对应
  `verifier.signing_scheme` / `verifier.public_key_fingerprint` / `verifier.signature`（contract 1.1）。
- **`run` 只验完整性，不验签名**：封包 `run` 打开时校验布局/规范性/三条哈希（spec/engine/build），
  不需要密钥表，因此离线可跑；**真伪性**（谁签的、能不能信）走 `verify signature` / `register` / `report import` 链。
  换句话说：`run` 过了只证明「这份报告确实是这个封包的字节产的」，不证明「这个封包来自可信构建方」。

## 5. 登记与归档里的签名

- `verify register <sealed>`：先走上面 1–7，再写 `registrations/<binary_key>.json`，其中
  `signature: { signed, verified, scheme, key_id }`、`format_version`、`binary_sha256`。
  签名的封包**没有可信表就拒绝登记**（rc=1）；unsigned 旧封包按 `signed=false` 登记。
- `verify report import`：登记的构建若 `signed=true`，会**重新**从工作区 `binaries/<key>.bin` 验一遍签，
  并核对报告 `verifier.public_key_fingerprint === footer.key_id`；验不过 → `imported:false`。
  - 因此 import 一台**可信密钥表**是必需的（`--keys` / `YGL_VERIFY_KEYS` / `$YGL_HOME/verify/keys/signing-keys.json`），
    否则签名构建的报告只能重算 payload、无法完成身份链。
  - 工作区二进制还会做**内容身份**核对：`sha256(binaries/<key>.bin) === report.verifier.binary_sha256`；
    文件名相同但字节被换过 → `binary identity mismatch`。
  - `verify register --no-copy` 不写 `binaries/<key>.bin`，此后签名构建的 import 会因「拿不到字节复验」失败——
    要保留可复核能力就别用 `--no-copy`（或用 `--keys` + 重新 register）。
- `verify archive --with binary`：把登记 + 二进制副本收进归档，`archive verify` 重算全链时一并核对。

## 6. 事故处置

| 现象 | 处置 |
|---|---|
| 报告 `signature` 与封包 footer 不一致 | 报告不是这个构建产的（或被人改过）→ 以封包为准重跑，不采信报告 |
| `key_id` 不在表内 | 构建方没按纪律登记公钥；补表（新行，不覆盖旧行）或拒绝该构建 |
| 私钥疑似泄露 | 立即在表里给该 key 标 `retired_at` + 换新 key，并在 CHANGELOG 记「从某日期起旧 key 不再被接受」；已发出的报告可重签构建 |
| `format_version` 不支持 | 用与封包同代的验签器；跨代验签一律拒绝，不做"尽力解析" |
| 归档 `archive verify` 签名项不过 | 归档包里的二进制副本被改过 → 从发布渠道重取二进制，重签登记 |

## 7. 非目标（写清楚，避免误读）

- 不做 PKI / 证书链 / 时间戳服务；key 表是仓库里的明文表 + code review。
- 不签报告、不签 `data_source`、不签材料——这些各自有 `payload_sha256` / `sha256` 入链，签名只覆盖交付物。
- 签名的替代不是"不签"，而是"带外登记 + 可复现构建 + 语料"三条外部锚。签名是其中最便宜的一条。
