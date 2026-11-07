# M13 复核 r28：0.104.0（814a7c3）—— r27 P2×3 / P3×4 收口

评审：302cb119（r28，评审线）｜对象：`814a7c3`（0.104.0，master 已推，tag v0.104.0 在本地，npm 尚未发版）｜日期：2026-10-20
任务：r27 报告 `P2×3`（--db retarget 静默 no-op、尾随分隔符、白名单过窄）+ `P3×4`（掩码保留 40 字符、test:unit 超时旗标、Rust parity 未进门禁、ratchet 基线法不一致）+ `Q1/Q2` 收口复核；两问：干净树复现是否补、`job_target` 是否进毕业记录。

## 0. 结论

**PASS，可以放行 0.104.0。** r27 的 3+4 项全部落地且可实证；本次门禁在干净树 `814a7c3` 上复现（unit 497/497，contract 100/100，ratchet held）。
新增 **P3×1**（`$` 未进 denylist，POSIX sh 会展开 → 作业可能静默验证另一个库）、**P4×4**（文档称拒 `{}` 但实现放行、CHANGELOG「基线不动」与同版重烘矛盾、基线重烘早于最终提交余量仅 1118B、两条同 subject 提交仍在）。均不阻塞发布，建议 0.105.0 一并收。

## 1. 门禁实测（干净树 814a7c3）

| 项 | 实测 |
|---|---|
| `git status` | 空（先于门禁检查） |
| unit | **497/497**（70 文件，`--maxWorkers=2`） |
| demo | 128 ✓ |
| contract | **100/100**（本轮无 flake） |
| ratchet | **held**：bundle 646657 / 上限 635074×1.02=647775（余量 **1118 B**）；cold 500 / 487×1.30=633；web 1369836 |
| Rust | `cargo test` **31/31**（9 套件：7+8+2+2+8+3+1） |
| 定向 | graduate + verify-cli **44/44** |

## 2. r27 修复逐条实证

- **P2① retarget**：`writes.jobRetarget`（`packages/research/pipeline/src/writes.ts:580`）与 `--schedule` 先 retarget 后 add（`verify-cmds.ts:756`）。探针：先 `--every 60`（job 5e69bc1bcb），再 `--schedule --every 60 --db <B>` → rc=0、**job_id 不变**、`jobs.command` 含 B 不含 A、`job_retargeted:true`、`db_override` 回 B；毕业记录 `data_source` 仍是 A（设计如此）。
- **P2② 尾随分隔符**：`trailingProblem`（`graduate.ts:231`）实测 `C:\tmp\r28dir\` → `usable:false`、`job_command_rejected:"14 chars; paths ending with a separator cannot be quoted safely"`、`--schedule` rc=1 点名。
- **P2③ denylist**：`SHELL_METACHARS`（`graduate.ts:222`）实测中文/`#`/`+`/空格路径 `usable:true` 且 `--schedule` rc=0（job d727219894，命令原样含中文）。
- **P3① 掩码**：`unsafeSummary`（`graduate.ts:248`）实测恶意 source → `"29 chars; shell metacharacter at offset 11"`，**不含** `whoami`/`PWNED`；命令串 `--db "<snapshot.sqlite>"` 占位。
- **P3② 超时旗标**：`package.json test:unit` 已删 `--test-timeout`，`vitest.config.ts` 为唯一事实源。
- **P3③ Rust parity**：交接带 `pnpm test:rust`（31/31 实测）；`pnpm test` 仍不含 Rust（已在交接模板注明）。
- **P3④ ratchet**：三项度量带 `method`，`--write` 连 held 项重烘；`docs/measurement-ratchet.md` 补「为什么需要 method」。
- **Q1 source_warning**：`reportDetail`（`verify-web.ts:243-253`）返回 `source_warning`，`GET /api/verify/reports/<run>` 可见；`import` 侧 `verify-cmds.ts:928` 同句。
- **Q2 掩码**：见 P3①，测试改反断言（不含样本串）。
- **P4**：`verify --help` graduate 行已含 `[--patrol]`；llms 同步。

## 3. 新发现（不阻塞）

### P3-1 `$` 未进 denylist → POSIX sh 展开（作业可能静默换库）
`SHELL_METACHARS = /[&|<>^%!"`()\u0000-\u001f\u007f]/`（`graduate.ts:222`）不含 `$`。实测 `/data/${HOME}/x.sqlite`、`/data/$TENANT/snap.sqlite` 均 `usable:true`；`job tick` 的 `execSync` 在 POSIX sh 下于双引号内展开 `$VAR`。后果不是注入，而是**静默漂移**：作业实际验证的库可能不是毕业记录里的 `data_source`（如多租户目录用 `$TENANT` 变量）。修法：denylist 加 `$`（一行）+ 用例；文档同步。
> 评级 P3（需要记录里出现字面 `$`，跨机来源或操作者引号输入时才可能），但「验证错误的库」比「作业报错」更难发现。

### P4-1 文档称拒 `{}`，实现放行
`docs/spec-validator.md:384` 列「`(` `)` `{` `}`」为拒收元字符；实测 `/data/{x}.sqlite` → `usable:true`。要么正则补 `{}`，要么文档删。

### P4-2 CHANGELOG「基线不动」与同版重烘矛盾
`CHANGELOG.md:14` 冷启动修复条仍写「基线不动」，但同版 P3④ 与 `ratchet-baseline.json` 已带 `method` 并重烘（bundle 635074、cold 487）。改一句即可。

### P4-3 基线重烘早于最终提交，余量薄
`ratchet-baseline.json` 的 `measured_at=2026-10-20T06:22Z`（本地 14:22）早于 `814a7c3` 提交（14:34）；bundle 实际 646657 vs 基线 635074 → 余量仅 **1118 B**（容差 2%）。下一次小改动就会再顶门禁。建议发版前 `pnpm ratchet --write` 并随提交一起落盘（发版席 checklist）。

### P4-4 同 subject 提交仍在
`1eb0225`/`6e04578` 两条同 subject（LF 重冻）仍在 master；开发线已说明为 amend 链残留，可接受，或后窗 squash。

## 4. 两问裁定

### 4.1 干净树复现：不必再补
本轮 `pnpm test` 就是在**干净树 `814a7c3`** 上跑的（git status 空），结果 unit 497/497 + contract 100 + ratchet held，无 flake。建议发版席直接引用本轮日志作为 0.104.0 干净树证据；0.105.0 不再重复要求。

### 4.2 `job_target`：建议加，但按五条钉死
同意开发线的判断（审计者不该靠读一行黄色提示）。落法：

1. **形状**：`job_target: { db, origin: "report" | "override", usable, job_id, every_minutes, updated_at }`（`updated_at` ISO UTC）。`origin` 必填——override 与 report 同库值时要能区分意图。
2. **写入时机**：只在 `--schedule` 成功（新建或 retarget）后写；duplicate 重复毕业允许**只更新该字段**，`run_ids`/`thresholds`/`created`/`data_source`/`materials_sha256` 逐字节不变（加测试锁定）；不带 `--schedule` 的 re-graduate 保留旧值，不擦除（退休作业用显式命令处理）。
3. **语义**：`jobs` 表是执行真相，`job_target` 是「最后一次排期意图」快照；手工改 job/删 job 会让它漂移，审计靠 `job.retarget` 事件 + `updated_at`，文档写明。
4. **隔离**：不进 identity/duplicate/资格判定/patrol，不参与 `materials_sha256`；旧记录无该字段需容忍（读面不报错）。
5. **读面**：`verify graduate --json`（含 duplicate 分支）返回 `job_target` 与顶层 `job_command` 并列；人类输出保持现状（一行提示已够）。
6. **测试**：graduate→retarget→duplicate re-graduate（job_target 更新、其它字段哈希不变）；jobs 删除后记录不变；无 `--schedule` 重毕业不擦除；旧记录（无字段）可读。

## 5. 证据索引

- 门禁日志：`tmp/r28-gate.log`；探针：`tmp/r28-probe.cjs`；隔离 home：`tmp/r28home`。
- 代码：`packages/ops/tools/src/graduate.ts:222,231,238,248,260,265`；`packages/research/pipeline/src/writes.ts:580`；`packages/ops/tools/src/verify-cmds.ts:732,756,928`；`packages/ops/tools/src/verify-web.ts:243-253`；`packages/ops/tools/tests/verify-cli.spec.ts:203-210`。
- 文档：`docs/spec-validator.md:384-385`；`CHANGELOG.md:14`；`docs/measurement-ratchet.md:47-54`。
- 提交：`814a7c3`（HEAD，tag v0.104.0 本地）、`1eb0225`/`6e04578`（同 subject）、`216f3fb`（r27 复核对象）。
