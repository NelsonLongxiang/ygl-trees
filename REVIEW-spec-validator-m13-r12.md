# M13 复核 r12：ee5150c（0.97.0）R1–R9 + 归档 / 递归自校验

评审对象：HEAD `ee5150c`（0.97.0，tag v0.97.0 指向它），R1–R9 落点（实际在 `b546674`/0.96.0）+ 新增归档面（`archive.ts` / `zip-store.ts` / 契约 §7）+ `verify self-check`（`selfcheck.ts` / 契约 §7.6）+ Cordis 评审自动化。
范围声明：`c9c32f5`（M13-1b Rust crate 起点）不在本次范围；canonical 双实现共用 `corpus/canonical/vectors.json` 的方向正确，M13-1b 正式请求后单独审。

## 0. 结论

**PASS（附条件）**。R1–R9 全部落位，归档与自校验作为 0.97.0 的新增面**接受**，契约 1.0 **未被本次改动破坏**（dispatch/report/shape 语义未变；`report.shape.txt` 删除 `verifier.binary_sha256:undefined` 与「undefined 键不进形状」口径一致，CHANGELOG 已记录）。
G1/G4 建议 0.99.0 前必修（各一行级）；G2/G3 顺手修；G5 二选一决定；G6 请本机确认环境 flake。

## 1. 我独立实测

| 项 | 结果 |
|---|---|
| verify-core 单测 | `vitest run packages/verify/core/tests` → **89 passed** |
| 全量 unit（gate 配置 `--maxWorkers=2`） | **369/370**，1 失败 = `packages/ops/tools/tests/webui.test.ts:244` P1-1 `TypeError: fetch failed / ECONNRESET` |
| 全量 unit（默认 workers） | **368/370**：同一 webui P1-1 + `packages/core/database/tests/pg-a.spec.ts:55` 20s 超时（日志含 `SQLite3Error: database is locked`） |
| 上两文件隔离跑 | **21/21 通过** → 判定为负载/环境 flake，非 verify 改动 |
| self-check（干净 home） | `ok:true` 六项：environment / canonical-vectors 12 / corpus-digest 129 files / shapes 2 / corpus-cases 33 case（743ms）/ archives **skip**（无目录） |
| self-check（4 个归档的 home） | `ok:true`，archives = `4 archive(s) re-verified` |
| self-check（空 archives 目录） | archives = `ok / no archived runs` ← **真空 ok，见 G3** |
| cordis-drift 端到端（temp home） | rc=0，`overall PASS` 5/5（V5 witness scanned=13/matched=13），生成归档；`verify archive verify` → `ok:true, items:5, problems:[], warnings:[]` |
| 同一 run 重复归档 | 无 `created` 时两次 `zip_sha256` 不同（`637051eb…` vs `3021ad4e…`，文件名 created `…2822Z`/`…2823Z`）；显式固定 `created` 时两次逐字节相同 → **G1** |
| 归档链核对 | 契约版本/corpus 版本/spec 版本/run_id 均比对（`archive.ts:352-354,371-373`）；`manifest.engine_version` 写入（`:229`）但从不比对 → **G5** |
| stderr | verify 命令（自校验/归档）会在 stderr 输出 `ExperimentalWarning: SQLite is an experimental feature`（stdout JSON 干净）；与「未触达 verify 的命令零 stderr」不冲突，但脚本若把 stderr 当错误面需知悉 |
| help | `apps/cli/src/bin.ts:133-138` verify 组仍只列 5 行，缺 `archive` / `self-check`（`llms.txt:190-202` 已列）→ **G2** |

## 2. R1–R9 逐条

| 项 | 落位 | 证据 |
|---|---|---|
| R1 三形态 | ✅ | `docs/verify-contract.md` §2.1：谓词形态 / 手写 sql+scope_sql / 手写 sql 无 scope → 构造 ERROR |
| R2 count·exists 手写 sql 限制 | ✅ | 文档 §2.1 + prepare P2 拒 `count/exists.sql`（`prepare.ts:239`） |
| R3 单次渲染 | ✅ | `engine.ts` scan 分支与 find 分支同用 `renderScan`（唯一渲染） |
| R4 谓词测试 | ✅ | `predicate.spec.ts` +2：`$50` 合法字面量 PASS、干净批次 PASS（`rows_scanned=2`） |
| R5 usageText | ⚠️ 部分 | 人读 help（`bin.ts:133-138`）补了 5 行但**缺 archive/self-check**（G2）；`llms.txt` 全 |
| R6 rc 口径 | ✅ | `docs/verify-contract.md:114-115`：ready rc=0；needs-material/error rc=1 |
| R7 快照 TTL | ⚠️ 部分 | `pruneSnapshots`（TTL 7 天）已落，但 run 结束不删 TEMP 副本，仍要等下次 prune（可接受，建议 finally unlink） |
| R8 死参 | ✅ | `minimalRedTeam(schema.ddl)`（`verify-cmds.ts:303`） |
| R9 import 版本校验 | ⚠️ 空转 | `verify-cmds.ts:500-509` 比对 registration 的 spec/engine/corpus 版本；但 `registrations/` **当前无写入方**（只有读，`archive.ts:212`），M13-1b/封包前该链不生效——文档已按「已实现」表述，需在 §7 注一句「登记由封包构建写入」 |

## 3. 归档面（契约 §7）对照

- 命名语法、包内布局（`manifest/report/spec/prepare?/trace?/materials/<id>/files/<sha12>-<name>`）、深度 ≤4 / 全 ASCII / 原名进 `items[].original_name`：与文档一致。
- store-only zip：条目按路径字节序、mtime 固定 1980-01-01、外部属性 0644、无 extra/comment，reader 校验 method/size/CRC：与文档一致；`archive.spec.ts:134`「同内容不同顺序 → 同一字节」覆盖条目级确定性。
- **报告不可变**：归档身份（archive_id/sha256）写侧车 `archives/<run_id>.json`，不改 report.json（否则 payload_sha256 自毁）——设计正确。
- 归档校验链（路径 → items 哈希 → archive_sha256 → 未声明条目 → payload → summary/overall 重算 → 版本/run_id → materials_sha256）：与 §7.4 一致；「判定结论不在归档校验里表达」正确。
- 默认动作 + `--no-archive`；归档失败：报告已写、rc=1 并带 `archive_error`（`verify-cmds.ts:403` 附近），与 §7.5 一致。
- `--with materials|snapshot|binary` 三档与 `trace` 复用 `prepare.json` 的 material_id：一致。

## 4. 发现（G 系列）

- **G1 归档确定性表述缺口（建议 0.99.0 前修，doc+一行代码）**：`archive.ts:219` `created = opts.created ?? new Date().toISOString()`；CLI 未钉 `created`，故「同一 run 再次归档」zip 字节必变，而 `docs/verify-contract.md:325` 写「同输入同字节，zip_sha256 跨平台可复算」。`created` 是 manifest 输入，重归档是否可复算应显式说明。修法：缺省从 `report.finished`（或 data_source.captured_at）派生，使同一 run 的归档名/字节稳定；或文档改「给定 manifest（含 created）时可复算」并加 `--created` 便于复现。已实测两种形态（见 §1）。
- **G2 help 面（一行）**：`bin.ts:133-138` 补 `archive <run-id|spec-id>` 与 `self-check` 两行；顺带 `prepare` 行补 `--candidates/--reviews/--db`（llms 已写）。
- **G3 真空 ok（一行）**：`selfcheck.ts:146` 空 archives 目录返回 `ok / no archived runs`；与「SKIP 不等于 OK」纪律不一致，改 `skip`（无目录与空目录都 skip）。
- **G4 build 期 fail-closed（一行级）**：`archive.ts:231` `report.payload_sha256 ?? payloadHash(report)` —— 无哈希的 report 会生成归档，但 `archive verify` 必拒（我用手工 report 复现：verify 报 `report says undefined`）。真实 CLI 流程 report 恒有哈希，但 `buildArchive` 是 cordis-drift/测试用公开 API；应在 build 时拒绝无 `payload_sha256` 的 report。
- **G5 死字段（二选一）**：`manifest.engine_version` 写而不比（`archive.ts:229` vs 校验链 352-354/371-373）。要么入链（report.verifier.engine_version === manifest.engine_version），要么从 manifest 删，避免「看似核对过」。
- **G6 环境 flake 确认（请开发线本机跑一次全量）**：我两次全量（默认 workers / gate 配置）均有 webui P1-1 ECONNRESET，隔离跑通过；若你本机 370/370 稳定，则记为 Windows/负载 flake 家族新增（`fetch` 无 content-type 的 POST 在服务端提前断连可致 ECONNRESET），建议测试侧容错或固定 `Expect: 100-continue` 关闭；若复现，应修测试而不是放任。**在复现前不能宣称 unit 370/370 为稳定门禁**。

## 5. 结论与建议

- 0.97.0 的 R1–R9 与归档/自校验：**PASS**；归档作为「产物可带走、校验器可被校验」的增量面方向正确，Cordis 自动化的端到端实证（HEAD PASS 5/5、注入漂移 FAIL 5/5 中仅 V1 失败）成立。
- 发布建议：G1 + G4 进 0.99.0 的收口清单（各一行），G2/G3 顺手，G5 二选一写进 §7.4，G6 出结论（真 flake 还是测试 bug）。
- M13-1b（`c9c32f5`）：canonical 共用冻结向量做跨实现 parity 的做法正确，等你的正式请求；建议 M13-1b 一开工就把 G4（build fail-closed）与 §7.4 版本链一起定死，避免 Rust 侧复制同一口径。

## 6. 0.97.1（`53cc599`）复核：G1–G5 闭环

开发线回执（task direct-60d7629e）称 G1–G5 修复并随 0.97.1 发布。独立验证结论：**PASS，r12 的 G1–G5 全部闭环**。

| 项 | 验证 |
|---|---|
| G1 | `archive.ts:223` `created = opts.created ?? (report.finished \|\| now())`；CLI 实测同一 run 两次 `verify archive` → `same_zip=true, same_name=true`（`zip 4753147599…`，名 `…20261019T172814Z-rc6e3b50c`）。契约 §7.3 已写明。残留 nit：`report.finished` 缺失时仍回退 `now()`（真实 run 恒有 finished；可顺手 fail-closed） |
| G3 | 空 archives 目录实跑 → `{"status":"skip","detail":"no archived runs in <dir>"}`；文档 §7.6 已同步「目录为空也 SKIP」 |
| G4 | 无 `payload_sha256` 的 report → `buildArchive` 抛 `refusing to archive an unverifiable report`（实跑） |
| G5 | `archive.ts:358-359` 比对 manifest/report `engine_version`，文档 §7.4 链已补 |
| G2 | `--help` verify 组 8 行（含 `archive` / `archive verify` / `self-check`） |

- 测试：定向 `archive.spec + selfcheck.spec + verify-core` → **106/106**；新增 archive ×3（确定性 / 无 payload 拒绝 / engine_version 点名）、selfcheck ×1（空目录 skip）。
- G6 更新：0.97.1 全量 unit（gate 配置）我第三次实跑 **373/374**，失败项变为 `packages/ops/tools/tests/ops-service.spec.ts:25` 20s 超时（隔离 5/5 通过，单跑 8.9s）；与 webui:244 `ECONNRESET`、pg-a:55 锁超时互不同项 → 定性为**共享环境/负载 flake 家族**，不阻塞 0.97.1。建议门禁对网络/临时目录类用例加「隔离重试或串行」标注，否则 CI 高负载下会随机红。
- R7（快照只做 TTL）/R9（registrations 写入方归 M13-1b）挂账同意。
