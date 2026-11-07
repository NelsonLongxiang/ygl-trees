# M13-1b 进度复核 r13（评审线 · 2026-10-19/20）

对象：开发线 M13-1b 进度（commit 27e9b89 执行面 / 9bc0c2b 封包形态 / 9371aa3 文档实测；另有 4bc908b 0.98.0 在途）。
任务：task direct-1e374c4d。方法：读 Rust 全部源 + 实跑双引擎对比 + TS 端到端登记/导入 + 跨引擎 payload 复算。

## 0. verdict

**骨架与方向 PASS（可以继续），但 P1×4 必须先修才能进入「整份报告 parity → 签名 → 登记/分发表」。**
即：先补整份报告 parity，再 ed25519 + 登记/分发表。理由见 §4。

## 1. 已验证通过（实测）

1. `pnpm test:rust` 25/25（cli 7 / sealed 4 相关 / 语料 2 / parity 8 / 谓词 3 / canonical 向量 1）。
2. 语料 33 例（30 判定 + 3 throw）passed；谓词渲染 6 向量逐字节；canonical 12 向量一致。
3. 跨引擎 payload 一致（关键正向）：Rust 产出的 open 报告（tmp/rust-e2e/report.json，声明 `sha256:3ce6efc7…`）与封包报告（tmp/cordis-e2e/report.json，`sha256:cf1d3c6f…`）的 `payload_sha256`，用 TS `payloadHash` 复算**逐字节相同**——canonical 化与 payload 算法两实现已对齐。
4. 封包端到端闭环（TS 侧）：`verify register tmp/cordis-e2e/yglverify-cordis.exe` 能读 Rust footer（布局兼容），落 registration `461818cb…`（spec_id=spec_efb9a6a40450、engine 0.1.0、corpus 1.0）；`verify report import` 该封包报告 rc=0、spec_restored；open 形态 Rust 报告 import rc=0。
5. 封包形态与自校验：layout `[engine][spec][footer][u32]` + YGLVF1、`build_sha256=H(engine||spec)`、篡改→rc=1、封包上 `--spec`→rc=2 均在 tests 与实跑中成立；cordis 试炼场 PASS 5/5、witness 与 TS 一致（V1 150/0、V2 23/23、V3 3/0、V4 3/0、V5 13/13）。
6. schema_fingerprint 两实现同式（`name:归一 ddl` 排序拼接 sha256，UTF-8 字节数），实测同值 `sha256:4302bcf3…`；witness/sources/evidence 基础形状与 SQL 语义（sql/sql-pair/count/exists/file）与 TS 对齐；sql-pair 同族守卫、谓词渲染/占位 `$vu:` 拒绝、scope_sql 三守卫均在。

## 2. P1（阻塞：整份报告 parity / 签名前必须修）

### P1-1 count/exists 空范围语义分歧（实证，最重要）
- 实测（tmp/r13probe/{count,exists}.json，空表 `bills`）：
  - TS `runVerify` → **NEEDS-MATERIAL**（witness.rows_scanned=0，evidence `{degraded_from:"PASS", reason:"zero rows scanned — cannot assert PASS (vacuous prevention)"}`）。
  - Rust `yglverify run` → **PASS**（witness.rows_scanned=0，无降级）。
- 根因：TS 有装配期全局守卫（`packages/verify/core/src/engine.ts:959-963`：PASS 且 witness.rows_scanned=0 且非 command/agent → NM）；Rust 的 NM 只在各检查器内部实现（sql predicate n==0、sql 手写 scanned==0、sql-pair、file 空目录），**count/exists 没有**（rust/yglverify/src/engine.rs count 分支约 465-520、exists 约 520-560 直接按 op/expect 出 PASS/FAIL）。
- 影响：封包二进制会把「空范围」判成通过——与契约 §2.1/「绝不落 PASS」直接冲突；33 例语料未覆盖该形态，所以 parity 全绿。
- 修法：Rust 在报告装配处补同一守卫（逐字复刻 degraded_from/reason，保持 evidence 一致），或 count/exists 检查器内补 NM；同时加 2 例对偶语料（count 空范围 `op:==0`、exists 空范围 `expect:false`）。

### P1-2 报告形状未达契约 §5（parity 面）
同 spec 同库 TS vs Rust 报告 diff（sql-find-violation 例）：
- `artifacts`：TS `{"attachment_sha256":[]}`，Rust 整个缺失（契约 §5 有该字段）。
- `exceptions`：TS 对 FAIL 单元给 `{vu,severity,row_count}` 样例；Rust 恒 `[]`（未实现）。
- `vu[].guard`：TS 给 `{leniency_checks:[...]}`；Rust 缺失。
- `evidence`：Rust 只有 `rows_total/violations`，缺 `rows`（失败样例，canonical 排序）与 `sort`。
- `reason` 口径三处不一致：Rust `"1 unit(s) failed"` / TS `"V1(S1) FAIL"` / 契约示例 `"V2/V3 FAIL (S1)"`——需钉成一条规则（建议按契约示例 `<ids>/<verdict> (<S-max>)` 或明确 TS 现式）。
- 说明：payload_sha256 因这些字段差异而不同（各自自洽），所以「整份报告一致」当前不成立；报告形状就是签名对象，必须先定。

### P1-3 Rust CLI 报告缺 `data_source`
- TS CLI（`packages/ops/tools/src/verify-cmds.ts:383`）在 snapshot 运行时补 `data_source:{kind:"sqlite-snapshot",sha256,source,captured_at}`；Rust `engine.rs:937` 恒 `data_source: None`，CLI 未补。
- 影响：Rust 产出的报告无 data_source → archive `--with snapshot` 无法保留快照副本（归档链 §7.4 需要sha256），且与 TS 报告形状不一致。
- 修法：Rust run 在有 `--db` 时计算 db sha256 并写 `data_source`（captured_at 用 `--now` 或实际时间，与 TS 口径一致）。

### P1-4 R7：登记写入路径缺失
- `verify register` 只接受已存在封包；`seal`/`emit` 不写 registration（开发线已认账为 R9 闭环点）。封包交付链缺「产出即登记」的一环。
- 建议：CLI 侧 `verify emit <spec> --out <bin>` 内部 seal 后直接调用 registration 写入（同一 workspace 账本、幂等），sealed 二进制保持无状态；`verify register` 保留给外部产物；自检可对分发表/注册表做存在性校验（`--expect`）。

## 3. P2（可随后，不阻塞 parity）

1. 封包命令面：`--command-allow` 在封包模式开放执行（否则 allowlist 无注入途径），但 Rust `std::process::Command` **无超时**（TS spawnSync 30s），且 docs §5 说「runner 钩子不放开封包 allowlist」易误读——建议文档写清「唯一入口是 CLI flag，属信任扩展」并补 timeout kill + 环境变量策略。
2. `--now` 缺省时 Rust `started` 回退 1970（finished 同值），TS 用真实时间；parity 测试需固定 `--now`（TS 用 `nowIso`，已支持）。
3. agent 的 ERROR 文案提到 `--with-review`，但 Rust 无此 flag（grep 仅 engine 文案）——改为「fact-only binary 不支持 review 层」或真的加 flag（后者与「封包不开 review」冲突，建议只改文案）。
4. `scan`/`where` 形状错误信息差（我误写 scan={from,where} 时只得到 `missing field op`）——建议对 `scan`/`where` 做显式形状校验并报「scan 必须是 {op, conditions} 组」。
5. `walk_files` 跟随符号链接目录（std read_dir + is_dir）有环风险；Windows 少見，建议加 visited 去重。
6. `tmp/seal-e2e` 等试炼场产物未入 git（正常），但 `.gitignore` 里 `*.yglverify.zip` 之外可考虑忽略 `*.yglverify.seal` 前缀产物。

## 4. 顺序裁定（回答「先 parity 还是先签名」）

**先整份报告 parity，再 ed25519 + 登记/分发表。**
1. 签名对象是报告身份（payload_sha256 覆盖报告形状）；形状里还有语义缺口（P1-1），现在签 = 给「空范围 PASS」背书。
2. 签完再改形状 → 已签报告、registration、归档链（§7.4 自报告回收）全部失效，返工面远大于先补 parity。
3. parity 的补法很轻：P1-1 一处守卫 + P1-2 四个字段 + 一条 reason 规则 + P1-3 data_source，然后 corpus parity 从「投影比较」升级为「整份报告比较」（`--now` 钉时间戳、run_id 固定、canonicalStringify 后比较；payload 应完全相等）。
4. ed25519 随后：测试固定密钥签名/验签、self-check 验签、错签名→rc=1 用例；登记/分发表最后（CLI emit 写账本 + 注册表查询）。

## 5. 验收闸门建议（M13-1b 收尾）

- G1 语义：count/exists 空范围 NM 与 TS 一致（含 degraded_from/reason 逐字）；sql/sql-pair/file 已有。
- G2 形状：同 spec/同 db/同 `--now`/同 run_id，TS 与 Rust 报告 canonicalStringify 后**全等**（含 artifacts/exceptions/guard/evidence.rows/sort/reason/data_source）。
- G3 封包：篡改/换 spec/--spec 拒绝/无签名拒绝/登记未命中拒绝/self-check 验签与分发表。
- G4 交付链：`verify emit` 一条命令产出封包并登记；`verify report import` 回放 Rust 报告 rc=0；archive 对 Rust 报告（含 data_source）`--with snapshot` 成功。
- G5 文档：契约 §5 报告字段逐项、§5 封包命令面、R7 关闭方式、命令 allowlist 信任说明、--now 时间语义。

## 6. 证据路径

- Rust 报告：`tmp/rust-e2e/report.json`、`tmp/cordis-e2e/report.json`（payload 复算用）。
- 探测：`tmp/r13probe/{count,exists,sql,spec}.json`、`rust-count.json`、`rust-exists.json`、`db.sqlite`；隔离 home `tmp/r13home`（registration 461818cb…）。
- 源：`rust/yglverify/src/{engine.rs:465-560,937,652}`、`packages/verify/core/src/engine.ts:959-963`、`packages/ops/tools/src/verify-cmds.ts:383`。
