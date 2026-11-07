# M13-2 第三批评审（r21）：作业式验证面 HTTP prepare/run

评审对象：`8848cad`（0.102.0，tag `v0.102.0`，npm latest + Gitee release `1220447`）＋ `a1378b8`（0.102.1 热修，tag `v0.102.1`，远端 tag `2721cdaf`，评审时 npm/Gitee release 尚未发布）＋ `162bbc8`（技能文档）。
评审席：评审线 lx；开发线 dsh/ec4ce7f8（任务 `direct-e3927d27`）。日期：2026-10-20。
复核环境：HEAD=`a1378b8`，工作树仅评审侧未跟踪文档；隔离 home `tmp/r21home`、`tmp/r21home2`、`tmp/r21cli`；探针 `tmp/r21-probe.cjs`（A）、`tmp/r21-probe2.cjs`（B）、`tmp/r21-run.sh`、`tmp/r21-parity.sh`。

## 0. 结论

**PASS。** 作业式执行面实现方式正确：与 CLI 共用 `verify-cmds` 原语、无第二实现；三条不变量（请求体无执行面 / 快照内容寻址 / run 只碰副本）全部成立；ready 路径的 `spec.json`/`prepare.json`/`trace.json` 与 CLI **逐字段一致**（仅时间戳不同）；run 报告与 CLI 投影一致；默认关闭、非 JSON 415、非 POST 405、超限 413、缺 blob 404、非法 sha 400、快照不可读 422 均实测命中；agent/file 型在 HTTP 面 fail-closed。
发现 **1 项已修 P2**（`a1378b8` 空串 allowlist fail-open，复验通过）与 **1 项待定 P2**（非 ready 构造的审计落盘与 CLI 不一致）+ **7 项 P3**。均不阻塞 0.102.x 发布，但 P2-2 与 P3-2/P3-4 建议在 0.102.1 发布前落一句文档或一行守卫。

## 1. 已核验事实

- 版本/发布：HEAD=`a1378b8`（父 `162bbc8`←`8848cad`）；`v0.102.1` 已推送远端（`2721cdaf`）；npm registry `latest=0.102.0`、无 `0.102.1`；Gitee release `1220447`=`v0.102.0`（assets `.zip`/`.tar.gz`）；`v0.102.1` 无 Gitee release、无 npm 包——**发布态与 tag 不一致，需开发线确认 0.102.1 是否在发布中**。
- npm 包：`ygl-trees@0.102.0` tarball 实测 **1,249,806 B**（与开发线声明逐字节一致）。
- 门禁（HEAD `a1378b8`）：`pnpm test:unit` **442/442**（69 文件，122.8s）；`demo` rc=0（128 断言）；`contract:audit` **100/100**；`readme:verify` **54/54**；`verify-jobs.spec.ts` 17 例（0.102.0 的 16 + 热修 1）。注：08:48 首次全量跑也是 442，但当时工作树含未提交的热修用例（树在移动），以 HEAD 复跑为准。
- 0.102.0 门禁声明「unit 441」与 CHANGELOG 同段「442（+1）」矛盾：0.102.0=441 / 0.102.1=442 才对（见 P3-5）。

## 2. 动态探针（HTTP 作业面）

隔离 home 启动 `webui serve --enable-verify-jobs --port 18690`，另一 home 起未开作业面的 `--port 18691`：

| 探针 | 结果 |
|---|---|
| 未开作业面 POST prepare | 403 `verify jobs are disabled: start serve with --enable-verify-jobs` |
| GET /api/verify/prepare | 405（unit 覆盖） |
| 非 JSON `content-type` | 415（unit 覆盖） |
| 70 KB body | 413 `{"error":"request body too large (limit 65536 bytes)"}` |
| PUT blob（`biz.sqlite` 12,288 B） | 200，`sha256:02c771f0…`，size 12,288 |
| POST material | 200 `mat_1fdc48fc7b84` |
| prepare v1（候选=「账单金额不得为负」sql 找违规） | 200 `verdict=ready` `spec_id=spec_d38b2307dab5` `spec_version=1` `written=true`，三件套齐全 |
| prepare 第二次 | `spec_version=2`（同 spec 目录内递增） |
| prepare `draft:true` | `verdict=ready` `written=false` `spec_version=3`，不落盘 |
| prepare 非 ready（红队打回） | 200 `verdict=needs-material` `written=false` `spec_id=null`；**不落任何文件**（见 P2-2） |
| POST run（同 spec + snapshot） | 200 `overall=PASS`，`archive=true`（`arc_de366276c82d`），`archive_error=null` |
| 报告 `data_source` | `{kind:"sqlite-snapshot", sha256:"sha256:02c771f0…", source:"blob:02c771f01c31", captured_at}` |
| file 型 VU over HTTP | ERROR `file checker requires --attachments <dir>`（fail-closed，与 CLI 无 `--submission` 同义） |
| command 型 VU over HTTP | PASS；`evidence.stdout` = `D:\workspace\ygl-trees\n["API_TIMEOUT_MS"]`（见 P3-3） |
| agent 型 VU（无 reviewer） | ERROR `review layer not available in fact-only mode`（engine.ts:501-503，fail-closed） |
| 运行后 `archive --with snapshot` | rc=0，`archive_id=arc_30a04a73840f`，`items=5`，`with:["snapshot"]` |

## 3. HTTP 与 CLI 对等性（逐字段比对）

- **prepare（ready 路径）**：同一 material（`mat_1fdc48fc7b84`）+ 同 candidates/reviews + 同 snapshot，HTTP 与 CLI 各自产出的 `spec.json` 仅 `created` 时间戳不同（diff 只有 `created`）；`prepare.json`、`trace.json` 去掉 `created/as_of/spec_version` 后 **完全相等**。`spec_id` 同为 `spec_d38b2307dab5`（= `spec_<sha12(materialId)>`）。→ 「形状与 CLI 完全一致」成立。
- **prepare（非 ready 路径）**：CLI 在 `!draft` 时**总是**写 `prepare.json`（`verify-cmds.ts:425-435`）；HTTP 只在 `!draft && verdict==="ready" && res.spec` 才写（`verify-jobs.ts:129-149`）。CLI 非 ready 实测在 `spec_d77685b6e168/prepare.json` 留下 `{verdict:"needs-material", rounds:3, rejected:3, diagnostics:[P1-P3…]}`；HTTP 同一 material 的目录**不存在**。→ 审计面差异（P2-2）。
- **run**：同 spec + 同 db，HTTP 与 CLI 报告投影（`overall`/`summary`/每 VU `verdict`/`witness`/`evidence`）相等（探针 `parity.http_vs_cli=true`）；`data_source.source` 按设计不同（`blob:<sha12>` vs 快照文件名），`sha256` 相等。HTTP 报告 `verifier.mode="open"`、`contract_version/corpus_version` 与 CLI 同；`payload_sha256` 重算一致。

## 4. 边界与 fail-closed 复核（符合声明）

- 请求体无执行面：`submission_dir`/`submission` 出现即 400（`verify-jobs.ts:171-174`）；HTTP 无 argv/allowlist 入口。
- 快照内容寻址：`snapshot_sha256` 必须 64 位小写 hex（400），blob 不存在 404 并点名 `PUT /api/verify/blob`；`snapshotPath` 不猜路径。
- run 只碰副本：`snapshotCopy` 到 `TEMP/ygl-verify-snapshots` 后 `SqliteRunner`；`retainSnapshot` 失败只影响归档侧车，不改判定；报告 `data_source` 记录 `source:"blob:<sha12>"` 后重算 payload。
- 归档失败不 500：语料 spec 缺 `prepare.json` → `archive_error` 携因、报告照写（unit 用例覆盖）。
- command 白名单：`argv[0]` 不在表 → VU `ERROR` 不执行（unit 覆盖）；空串意图在 `a1378b8` 后 = 显式空表（全禁），不再回落 `node`。

## 5. 发现

### P2-1（已在 a1378b8 修复，复验通过）allowlist 空串 fail-open
`0.102.0` 用 `String(process.env.YGL_VERIFY_ALLOW_CMD || "node")`：`YGL_VERIFY_ALLOW_CMD=""`（意图=全禁）被 `||` 折叠成 `node`，操作员意图无法表达且 fail-open。`a1378b8` 改 `??`（`webui.ts:292`），空串 → `split/filter` → `[]` → 任何 `argv[0]` 判 VU `ERROR`；新增回归 `verify-jobs.spec.ts:270-296`（临时服务、空串、command VU → ERROR）。我复跑 unit 442/442 含该用例，代码/语义核对通过。**建议**：此修复已进 0.102.1，发布说明点名「空串=全禁」。

### P2-2（待定）非 ready 构造的审计落盘与 CLI 不一致
- 事实：CLI `verify prepare` 在 `!draft` 时先写 `prepare.json` 再决定是否写 spec/trace（`verify-cmds.ts:425-445`）；HTTP 只在 ready 时写（`verify-jobs.ts:129-149`）。实测同一 NH 材料：CLI 目录有 `prepare.json`（verdict/rounds/rejected/diagnostics），HTTP 目录不存在且响应 `spec_id=null`。
- 影响：`构造追溯视图`/NEEDS-MATERIAL→补充材料 task 的回溯链在 HTTP 路径丢失「这次构造为什么没过」的**持久**证据（响应体有 `diagnostics/rejected`，但不入库）。CHANGELOG 明确写「只有 ready 且非 draft 才落三件套」，所以不是虚假声明，但与 CLI 的审计语义不一致。
- 建议（二选一）：①镜像 CLI——非 draft 一律写 `prepare.json` 到 `spec_<sha12(material_id)>` 目录（注意会覆盖既有 ready prepare.json，需产品决定）；②新增 `attempts/<ts>.json`（`{material_id, verdict, rounds, rejected, diagnostics, at}`）并把 `spec_id` 可空响应补 `attempt_path`。推荐②（不覆盖成功记录）。再在 §7 端点表加一句「HTTP 非 ready 构造默认不落盘」。
- 不阻塞：构造面在 agent，机械判定链不受影响。

### P3-1 `as_of` 无 HTTP 入口
CLI 支持 `--as-of`（`verify-cmds.ts:215/398-399`，默认冻结时刻），HTTP prepare 恒用服务端 `now()`（`verify-jobs.ts:124`）。同材料不同时刻构造的 `spec.as_of` 不同，复现/对齐需 CLI。建议 body 增加可选 `as_of`（ISO 校验）或文档写明「HTTP 构造不钉 as_of」。

### P3-2 作业面只由 flag 把门，未随绑定地址收紧
上传门按 host 判定（`verify-web.ts uploadAllowed`：回环才默认开，`YGL_VERIFY_ALLOW_UPLOAD` 显式开/关）；作业面只看 `--enable-verify-jobs`（`webui.ts:580-590`）。若操作员 `serve --host 0.0.0.0 --enable-verify-jobs`，LAN 客户端可 POST prepare/run（对已存在 blob 的 spec 反复跑/归档，CPU 与磁盘 DoS；不能上传新快照）。建议与上传门同构：非回环默认拒作业面，`YGL_VERIFY_ALLOW_JOBS_REMOTE=1` 显式开；或至少在 docs 写明「flag 打开的是 serve 所绑定接口上的执行面」。

### P3-3 command 型 VU 继承 serve 的 cwd/env
实测 `evidence.stdout` 含 `process.cwd()`=`D:\workspace\ygl-trees` 与环境变量**键名**（该环境无 token 类键；生产 env 若有则键名会进报告/归档）。`spawnSync` 用 `stdio pipe`、`cwd`=submissionDir（HTTP 无 → 进程 cwd）、env 默认继承。建议：command VU 传 `env:{}`+最小 `PATH`（或白名单 env 键）并显式 `cwd`；至少在 §7 写明 command 型在 HTTP 面继承 serve 环境，生产环境应隔离。

### P3-4 快照 blob 上限 64 MiB 隐含约束
`BLOB_LIMIT=64 MiB` 同时约束附件与快照；业务库快照 >64 MiB 时 HTTP run 无法进行（CLI 不受限）。docs:290 只写了「超 64 MiB 回 413」。建议 §7 明确「HTTP run 的快照上限 64 MiB；更大库走 CLI 或调高上限」。

### P3-5 CHANGELOG 0.102.0 测试计数自相矛盾
同段出现「测试 unit 442（+1）」与「测试：unit 441（+16）」；实测 `8848cad` 为 441（0.102.0）、`a1378b8` 为 442（0.102.1），README 442。建议 0.102.0 条目改回 441，0.102.1 条目写 442（+1）。

### P3-6 specDir 不分版本（已记 backlog）
`a1378b8` 提交消息已记：同 `spec_id` 低 `spec_version` 可覆写 `spec.json`（HTTP body 可传 `spec_version`，CLI `--spec-version` 同）。操作员可信模型下可接受；若日后开放多操作员，建议 `spec_version < latest` 直接 400（或按版本分目录）。

### P3-7 发布态与 tag 不一致
`v0.102.1` tag 已推到远端，但 npm latest 仍 `0.102.0`、无 `0.102.1` 包/Gitee release。请确认：0.102.1 是待发布（发布窗口）还是已放弃；若发布，P2-2/P3-5 建议随说明一起出。

## 6. 与 CLI 能力差异（HTTP 面）

| 能力 | CLI | HTTP 作业面 |
|---|---|---|
| prepare 候选/盲审输入 | `--candidates/--reviews` 文件 | 请求体数组（同一 P0–P5） |
| 非 ready 构造落盘 | 写 `prepare.json` | 不写（P2-2） |
| as_of | `--as-of` 可钉 | 恒 now（P3-1） |
| 快照 | `--db` 任意路径/大小 | blob 内容寻址，≤64 MiB（P3-4） |
| file 型 | `--submission/--attachments` 目录 | 无入口 → ERROR（fail-closed，文档已声明） |
| command 型 | 无 allowlist → ERROR | serve 注入 allowlist（默认 node），继承 serve cwd/env（P3-3） |
| agent 型 | 需 reviewer 注入 | 无 reviewer → ERROR（gateway 无锚点，边界已声明） |
| 归档 | 默认 on，失败 rc=1 | 默认 on，失败 200 + `archive_error` |

## 7. 复核清单（脚本与证据）

- `tmp/r21-run.sh` + `tmp/r21-probe.cjs` + `tmp/r21-probe2.cjs`：A/B 两段 HTTP 探针与 CLI 对等性；日志 `tmp/r21-*.log`。
- `tmp/r21-parity.sh`：CLI 同输入 prepare 与 HTTP 产物逐字段比对（`tmp/r21-spec-diff.json` 仅 `created` 差异）。
- 门禁：`pnpm test:unit`（442）、`bash examples/demo.sh`（128）、`bash scripts/contract-audit.sh`（100）、`bash scripts/readme-verify.sh`（54）。
- 未覆盖：`pack:check` 全流程（依赖 npm 发布产物，按发布脚本先行）；SSE 进度（0.102 未实现，docs 已声明）；Gitea 私仓（非本仓发布渠道）。

## 8. 建议的下一步

1. 0.102.1 发布前：P2-2 二选一落定 + §7 补一句；P3-5 计数订正；P3-2/P3-4 文档一句话。
2. 0.103 前：P3-3 env/cwd 收紧、P3-1 `as_of` 入口、P3-6 版本守卫（若开放多操作员）。
3. 维持：HTTP 面不加语义裁判（gateway 边界已裁定）；file 型继续走 CLI/封包；作业面默认关。
