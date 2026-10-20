# @ygl/verify-core changelog

本文件记录 **契约版本** 与 **语料版本** 的演进差异。ygl-trees 主仓 CHANGELOG 记产品版本；这里只记「验证器语义」的变更，
因为报告的可重放性依赖这两个版本号，而它们与产品版本不是同一根时间轴。

## contract_version 1.2 + corpus_version 1.2（2026-10-21，右值可引用列）

- **形状变更（可选，向后兼容）**：
  1. `PredicateCondition.value` 新增 `{ "col": "<column>" }` —— **同表**列对列比较；跨表引用在构造期拒绝
     （`spec_error: "cross_table_col"`，指路 `sql-pair`）；`is null` / `is not null` 不接受 `{col}`
     （`null_rhs_for_null_op`）。
  2. `count` 新增 `against: { from, col, agg }` —— 右值取另一张表的**单值标量**；`agg` **必填**
     （`max|min|sum|count`，缺省 → `missing_agg`）。理由是「spec 有效性只许依赖 schema，不许随数据漂移」：
     默认 max 会在策略表意外多行时静默取值，而「多行才拒绝」是数据依赖判据。`agg` 作用在空表/全 NULL 上
     → 右值 NULL → `ERROR`；**`count` 是 agg 家族里唯一不会产 NULL 的**（空表 → 0）。
  3. 构造期错误统一走新设 `evidence.spec_error` 封闭码表：
     `cross_table_col` / `missing_column` / `missing_agg` / `null_rhs_for_null_op` / `version_shape`。
     四值 verdict 骨架**不变**——新增第五值会破坏报告消费者、WebUI、Rust parity 与 evaluator 协议。
  4. 观测面：形态一的逐行两侧值进 `evidence.compared_rows`（采样 ≤5 行 `{left,right}`，渲染带
     `ORDER BY rowid` 保证确定性）+ `evidence.compared_total`（**无条件出现**，消费者可区分「3 行」与
     「3/N 采样」）；形态二进 `evidence.compared: {left,right}`。`ScopeWitness` 四字段不变。
- **版本闸**：1.1 spec 在 1.2 引擎下行为不变；声明 1.1 却携带 1.2 形态 → 入口 `version_shape` 拒跑。
  `report.contract_version` 取 `spec.contract_version`（1.1 spec 的报告仍写 1.1）。
- **双实现**：Rust `contract.rs` / `predicate.rs` / `engine.rs` 同版实现；`rust-parity.spec.ts` 与
  `corpus_parity.rs` 对 44 例整份报告逐字节 parity 全绿。
- **语料差异**：33 例 → **44 例**（+8 正向/行为例：`count-against-pass/fail`、`col-ref-pass/fail`、
  `against-null`、`type-mixed`、`agg-variants`、`count-against-missing-agg`；+3 构造拒绝例：
  `red-cross-table-col`、`red-null-rhs-for-null-op`、`red-version-shape`）。digest
  `ee1a0a1d6dddcfcd…`（129 文件）→ `683766f1077bb2c0…`（173 文件）。
- **gate 内生效的形状校验**：`selfcheck` 的契约/语料版本期望同步 1.2；`corpus-freeze` 断言新 manifest。

## contract_version 1.1 + corpus_version 1.1（2026-10-20，封包签名）

- **形状变更（可选字段，向后兼容）**：报告 `verifier` 增 `signature`（base64）/ `signing_scheme`（`"ed25519"`）/
  `public_key_fingerprint`（`sha256(32 字节公钥)` 小写 hex）。字段缺省表示该构建未签名（open 模式或 legacy 封包）。
  因为「字段集合冻结」的机械守卫（`tests/shape.spec.ts`）认报告形状，新增字段必须升 `contract_version`——升到 `1.1`。
- **封包 footer 扩展**：`format_version` / `engine_sha256` / `alg` / `key_id` / `signature`；无 `format_version` 的旧封包
  按 legacy unsigned 读。签名输入 = `JCS(去掉 signature 的 footer)`（`alg`/`key_id` 在输入内）。
- **语料差异**：33 份 `cases/*/spec.json` 的 `contract_version` 由 `"1.0"` 升 `"1.1"`（语义零变化），
  digest `388604230680f9…` → `4cac21b4f5bc3edd…`（129 文件）。

| 时点 | digest | 说明 |
|---|---|---|
| v1.0 冻结 | `388604230680f9606635caf1d55403703347097ef0337a1aba8337fdaaa076f0` | 129 文件，spec `contract_version: "1.0"` |
| v1.1（本次） | `4cac21b4f5bc3edd…` | 129 文件，逐文件仅 `contract_version` 字段 1.0→1.1；案例与语义零变化 |
| v1.2（本次） | `683766f1077bb2c0…` | 173 文件：+11 个 1.2 案例（8 行为/构造 + 3 红队），33 个既有案例逐字节不变；契约与语料版本同步升 1.2 |
| v1.1（0.104.0 重冻，LF 基） | `ee1a0a1d6dddcfcd…` | 同上 129 文件；**行尾规范化**——该清单此前在 `core.autocrlf=true` 的工作树上冻结（`cases/**` 为 CRLF 字节），与脚本直写 LF 的 `canonical/vectors.json` 混在同一清单里，导致 LF 检出（CI/Linux/新 clone）`corpus-digest` 必红。0.104.0 起 `.gitattributes` 固定语料 `eol=lf`，本行取代上一行的 digest 权威性（内容语义未变，`corpus_version` 仍 1.1）。 |

## contract_version 1.0 + corpus_version 1.0（2026-10-19，冻结）

冻结依据：docs/verify-contract.md 顶部三条冻结条件全部满足——① 评审席 fdc757f6（direct-30389fca）与 302cb119
（direct-7510b90f）两轮意见收敛至 PASS；② 七型 checker 形状齐且 corpus 每型 ≥1 案例（129 文件 / 33 案例）；
③ contract_version 钉 1.0 并在此记账。fdc757f6 于 direct-fbb67580 持闸放行（独立复跑 79/79、digest 三方一致、
篡改探针红→绿）。

### 相对 v0.5 的语义变更（不兼容项）

1. **契约版本守卫**：`runVerify` 入口拒绝 `contract_version !== "1.0"` 的 spec（`unsupported contract_version`）。
   旧 0.4 spec 不再"大概能跑"——形状变了必须升版重出。语料内 33 个 spec.json 同批把 `contract_version` 从 `"0.4"` 升到 `"1.0"`。
2. **`sealed.review` 默认 false**：M13-1 冻结的是 fact 层，agent 复核随 M13-1b 进入；prepare 不再硬编码 true。
3. **prepare 拒 agent 型**：M13-1 闭集为 fact 五型（sql / sql-pair / count / exists / file），agent 型在 P2 直接拒绝
   （`agent checkers are out of scope for M13-1 (fact-only closed set)`），`requires_execution` 一并拒绝。
4. **`as_of` 必由调用方给**：PrepareOptions.asOf 变必填，不再回退 `now()`（快照口径容不得"现在"）。
5. **window 偏移归一**：`toEpochMs` 走 `withOffsetMinutes`，`+08` / `+0800` / `+08:00` 三种写法同一结论（r10 F2）。
6. **canonical 只接受纯对象**：`Date`/`Map`/类实例直接抛错（此前会静默序列化成 `{}`，r10 F6）。
7. **谓词形态新增 `scan`（扫描域）**：`where` 只描述判据、只进 find；`scan` 描述「看哪一批」、进 find 与 scope 两侧。`witness.rows_scanned` 口径随之定为**域内检查过的行数**（此前 find 与 scope 共用同一 WHERE，干净批的扫描面恒为 0，fact 型 PASS 被空洞守卫打成 NEEDS-MATERIAL——端到端实测暴露）。`scan` 是**新增可选字段**，不写它的既有 spec 语义不变（扫描面 = 整表）。
8. **数字口径写明为 ES `Number::toString` 形态**（含 `1e+21`/`1e-7`），并明确三条相对 RFC 8785 的有意偏离：
   字符串 NFC 归一、对象 `undefined` 整键省略、只接受纯对象（r10 F4）。

### 语料 digest 差异（须可追溯）

| 时点 | digest | 说明 |
|---|---|---|
| 0c03d01（v0.5 快照） | `74659809c8939dc313dcf9fd202a9c0acf33e3af5fb20f9b6ad03f94a629feea` | 129 文件，spec 内 `contract_version: "0.4"` |
| v1.0 冻结 | `388604230680f9606635caf1d55403703347097ef0337a1aba8337fdaaa076f0` | 129 文件，逐文件仅 `contract_version` 字段 0.4→1.0；**案例数与案例语义零变化** |

改判依据：语料冻结守卫按文件哈希比对（`corpus/freeze.mjs`），任何字段微调都会改 digest——所以版本钉定必须配一张
"差在哪儿"的表，否则后人只看到两个哈希，不知道是"语义变了"还是"版本号写了进去"。

### 记账纪律

- `corpus/` 只增不改：新增案例随时可以；改已冻结案例 = 必须升 `corpus_version` 并在此记差异。
- `freeze.mjs --write` 只在作者席执行；评审席与 CI 只跑校验（`node corpus/freeze.mjs`，有漂移 rc=1）。
- 契约形状变更（字段增删/语义翻转）走 `contract_version` 1.0 → 1.1；只改文档表述不改哈希的不升版，但要在此记一行。
