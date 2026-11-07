# M13 复核 r11：683d60d（verify 命令面 + F1–F6 + 契约/语料钉 1.0）

评审对象：`683d60d`（`0c03d01` → `d452a65` → `683d60d`），契约 v1.0 / corpus v1.0。
评审方式：逐提交 git 核验、实跑测试、bundle E2E、freeze digest 复算、源码行级核对、临时探针实验。

## 0. 结论

**PASS。** r10 的 F1–F6 修复实测全部成立；verify 命令面（submit/prepare/run/list/report/trace/export）与 1.0 钉版（contract 1.0 + corpus 1.0 + shapes 快照 + freeze digest）自洽。**接受 `scan` 作为 1.0 定稿**，附接受条件 R1–R9（R1–R4 为标 1.0 定稿前必修，R5–R9 收口修；全部不动契约文本/哈希/语料期望，可在同一提交内闭环）。

## 1. 实测证据

- **测试**：10 文件 87/87 绿，连跑 4 次全绿。唯一异常：00:06:06 首跑出现 1 例失败（`1 failed | 86 passed`），随后 4 次复跑未复现——记 flake 观察，建议确认 verify 套件是否已进已知 flake 家族台账（并行负载下 SQLite/临时目录类）。
- **bundle 纯净**：`node dist/bundle/bin.cjs verify list --json` → rc=0、stderr 0 字节（ExperimentalWarning 消失，`sqlite-bindings.ts` 的惰性 require 生效）。
- **freeze 复算**：`node packages/verify/core/corpus/freeze.mjs` 得 `3886042f749f85dba79de4fb346e4bdf…`，与 `manifest.json` 一致；`--version=` 参数与「未提供则沿用上一版」的回退（freeze.mjs:47-50）都落位，不会静默降版。
- **F1**：`packages/verify/core/src/prepare.ts:197` 与 `:240` 均为 `text.includes("$vu:")`，`$50` 类金额字面量不再被误拒。
- **F2**：`packages/verify/core/src/compare.ts:53` 已改为 `Date.parse(withOffsetMinutes(t))`；`r8.spec` 的「+08 不再 NaN」「同一批数据带偏移与带 Z 结论一致」两测实跑通过。
- **F3**：`prepare.ts:257` 直接拒 agent（"agent checkers are out of scope for M13-1"）、`:253` 拒 `requires_execution`、`:419` `sealed: { review: false }`。
- **F5**：`prepare.ts:85` `asOf: VerifySpec["as_of"]` 必填、`:414` `as_of: opts.asOf`（无 now() 回退），`prepare.spec` 注释钉条件④。
- **F6**：`canonical.ts:43` 非纯对象抛错（"canonical JSON rejects non-plain object"），`canonical.spec` 的「非法 JSON 值直接拒绝」通过。
- **F4**：docs 规范化 bullet 已改为 ECMAScript `Number::toString` + 三处相对差异（NFC / undefined / 纯对象）✓。
- **scan 实现**：`contract.ts:85-88` `scan?: PredicateGroup`；`engine.ts:725-729` find = `select`+`from`+`(scan ∧ where)`、scope = `count(*)` over 同域；`engine.ts:779-786` 两式单次渲染（无拼接空隙）；sql 谓词路径（`engine.ts:135-186`）agg 拒、`fail_when=rows>0` 需 where、scope 单行单列非负整数、空域 → NM；P2 已把 `pred.scan` 列纳入 schema 探针（`prepare.ts:171`）且时间函数检查覆盖 `scanSql`（`:243`）；`predicate.spec` 断言两式文本。
- **CLI**：`verify-cmds.ts` 545 行，submit 物化冻结材料（text+files 双 sha256）、prepare 注入文件版 reviewer/redteam + `minimalRedTeam` 真空规约核验、run 快照 copy 并记录 `data_source{kind:"sqlite-snapshot",sha256,source,captured_at}`、report import 先结构/封包校验再 payload 校验、list/trace/export JSON 纯净；6 个 CLI 测试（含 rc=2 用法、未知 spec rc=1）全绿。
- **1.0 钉版内容**：CHANGELOG 记冻结理由（两评审线独立收敛、79/79 独立复算）、8 条语义变更、digest 变更表（`74659809…` → `3886042…`，仅 `contract_version` 字段）、四条纪律（只增不改 / `--write` 仅作者席 / 升版走 1.1 / 文档表述不升版要记行）。

## 2. 为什么接受 scan 作为 1.0 定稿

1. **语义正确**：判据（violations）与域（scope）分离；find/scope 同源渲染，scan 直接进入 find 的 WHERE 前缀，不存在「scope 与 find 看到的行集不同」的拼接空隙。
2. **空转防线是真的**：域为空（0 行）→ NEEDS-MATERIAL 而非 PASS；空 where 构造期被拒；错批号（scan 命中 0 行）→ NM，不会冒充「无违规」；干净批 → find 0 行 → PASS 且 `scanned=域内行数>0`，可与「没查」区分。
3. **代价明确**：scan 只能防「域为空」这类空转；`where` 自身写错列（表内静默 PASS）的残余面仍靠 prepare 构造守卫 + 语料红队，文档 §2.1 已如实写边界。作为 1.0 定稿可接受，残余面进 1.1/R 项。

## 3. 接受条件

**R1（文档矛盾，必修）** `docs/verify-contract.md` §2.1 表 `sql` 行仍写「scanned=`scope_sql` 行数；无 scope_sql 时回退源表行数」，与同节新 bullet 及引擎（谓词形态 scanned = 域内检查行数）矛盾。按三种形态改写：手写 sql + scope_sql（scope_sql 行数）/ 谓词（域内行数，scan 计入）/ source（不参与折叠）。

**R2（已知局限，须写进 1.0 文本说明）** count/exists 的谓词形态 `witness.scanned` 仍取源表行数（`engine.ts:405-409` / `:441`），不是 scan 域；`count` 期望 0 或 `exists expect=false` 时，错批号（scan 0 行）仍可能 PASS——属 §2.1 已承认的「0 是合法计数」语义。1.1 再收紧，本次不改引擎与期望。

**R3（代码卫生）** `engine.ts:775` 注释「find 与 scope 共享同一 where 子句字符串」已失真（scope 用 `scanSql`）；`renderPredicate` 内 `renderScan` 被调用两次，合并为一次。

**R4（测试缺口）** F1 的 `$50` 放行与「scan 干净批 → PASS」均无单测/语料；补 engine 级 scan 测试（本批无违规 → PASS、错批号 → NM），语料按 1.1 增例后再冻。

**R5（CLI）** 人类 `--help` 横幅未列 verify 组（`bin.ts` 帮助模板只有 research/…/patrol），`ygl help` 看不到新命令；补一行。

**R6（CLI 口径）** prepare 非 ready（needs-material/error）返回 rc=1；与「rc 只表达过程」的组内口径不一致。请明示为「CI 需失败即 rc=1」或改 rc=0 + JSON verdict。

**R7（CLI）** run 的快照临时库 `%TEMP%/ygl-verify-snapshots` 无清理（`verify-cmds.ts:123-131`），长跑会积；try/finally 删除。

**R8（CLI）** `minimalRedTeam` 首参 `null as never` 为死参（函数内不用 spec），删参。

**R9（CLI）** report import 只校验 binary 登记的 `spec_version`（`verify-cmds.ts:398-406`），建议同时校验 `engine_version`/`corpus_version`（封包 footer 已带）。

另：`verify run` 未显式 close 快照连接（进程退出即释放，可留）；prepare 的 schema 探针对畸形 db 的失败路径建议统一走 `verifyError`。

## 4. 下一步

- 按 §1.6 进 **M13-1b**（Rust 执行面 + 黄金语料双实现逐字门禁）：先落 R1–R4，再进行双实现 parity；G4 以 freeze digest + shapes 快照为唯一真值。
- M13-2 前补：agent review 的凭证注入与离线降级 E2E、NEEDS-MATERIAL 自动开 task（仅 import 侧）、1.1 count/exists witness 收紧。
