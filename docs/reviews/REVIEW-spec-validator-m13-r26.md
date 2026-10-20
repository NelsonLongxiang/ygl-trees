# M13 复核 r26：0.103.0 毕业通道（5d0eb49）——r25 收口实证 + 作业命令注入

评审对象：commit `5d0eb49`（0.103.0，master 已推；tag/npm/Gitee 尚未发布）。工作树另有与本版无关的 techtree WIP（`bin.ts` / `techtree/model/src/cmds.ts` / `node-qual.spec.ts` / `ratchet-baseline.json`），全量 unit 会因此多 3 例失败（见 §4）。
方法：源码逐行读 + 端到端探针（`tmp/r26-probe.mjs`、crafted-report 导入链路）+ 定向测试实跑。
结论：**CHANGES**。r25 的 3×P2、4×P3、两问实现**全部实证通过**；但发现 **P1 安全缺陷**：`job_command` 直接内插报告控制的 `data_source.source`，而 `job tick` 用 shell 执行 → 恶意报告可注入任意命令（端到端实证）。P1 修完 + 补测即可 PASS。

## 1. r25 收口实证（全过）

| 项 | 实测 |
|---|---|
| P2-1 跨度闸门 | 单份 PASS + `--min-runs 1 --min-span-days 30` → rc=1 `span threshold 30 day(s) needs at least 2 reports at spec_version 2 (found 1)`，`graduations/` 空 |
| P2-2 blob 来源 | `job_command` 用占位符 `<snapshot.sqlite>`、`usable:false`、human 有 note；`--schedule` → rc=1 点名来源并提示 `--db`；`--db <snap>` → rc=0、命令串用覆盖值、作业登记 every=60、`record.data_source` 仍是 blob（冻结源不变） |
| P2-3 文档 | §9 已改为「0.103.0 只做资格闸门」，与实现一致 |
| P3-1 先落盘 | `--schedule` 缺 `--every` → rc=2，`graduations/` 空 |
| P3-2 回冻结值 | 先按 30 冻结、再传 `--min-span-days 31` → `duplicate:true`、payload/record 的 `thresholds` 均为 30；先 `--every 60` 再 `--every 120` → 作业仍 60、payload `job_every_minutes=60` |
| P3-3 被取代文案 | 记录 v2 后 spec 升 v3 并补 3 份 v3 PASS → rc=1 `graduation frozen for an older spec_version: … was v2 (3 run(s)), the current spec is v3; re-run … then delete … deliberately` |
| P3-4 窗口右移 | §9 已写明「跨度取最近 N 份首末、新报告让窗口右移」 |
| Q1 history | `{reports_same_version:4, non_pass:1, last_non_pass:{run_id:"run_old_fail",finished:"2026-07-01…",overall:"FAIL"}}`，资格仍 eligible；human 行打印 |
| Q2 阈值不进 identity | 同证据换阈值 → duplicate；阈值只作政策 |

定向测试：`graduate.spec.ts` + `verify-cli.spec.ts` **44/44**（graduate 15 + verify-cli 29）。

## 2. P1（安全，发布前必修）：报告来源串进入 job_command → shell 注入

**攻击链（端到端实证）**：

1. 构造报告：把某份真实报告的 `data_source.source` 改成
   `C:\snap.sqlite" & echo PWNED > …\PWNED2.txt & rem "`，重算 `payload_sha256`（算法公开，自己算即可）；
2. `verify report import tmp/r26/evil2.json` → **`imported:true`**——import 只校验 payload 自洽（`verify-cmds.ts:819-823`），**不校验来源形态**；
3. `verify graduate spec_… --schedule --every 60` → rc=0，`job_command` 原文内插该串、`job_command_usable:true`；
4. `job tick` 用 `execSync(job.command, …)`（shell）执行（`job-cmds.ts:141`）→ 注入的 `echo PWNED > …` 被执行（`PWNED2.txt` 已生成）。

即使运营者不用 `--schedule`，human 输出里的 `next: job add … -- <cmd>` 也会把注入串摆出来供复制执行。

**代码点**：`packages/ops/tools/src/graduate.ts` 的 `jobCommand()`——只判 `!candidate.startsWith("blob:")`，用双引号包裹但未转义/白名单；`--db` override 走同一路径，操作员输入同样未消毒。

**修复建议（含测试）**：
- `jobCommand()` 对 candidate 做白名单（如 `^[A-Za-z0-9._/\\:\- ]+$`），拒绝 `"`、空白控制符、`& | ; < > ^ % ( ) { } [ ] ! $ ` ' ~ *` 与换行；不安全 → `usable:false`、拒绝 `--schedule`，展示串用占位符或转义形态。
- 同一白名单处理 `--db` override（虽然来自操作员，也要防引号/换行拼坏命令）。
- 防御纵深：`report import` 可对 `data_source.source` 做形态校验/警示（它不是可执行路径就不该被当成 `--db` 候选）。
- 更彻底方向（可留 M13-4）：job 存 argv 数组、`job tick` 用 `spawn` 不经 shell。
- 测试：source 含 `" & echo pwned & ` → graduate 拒绝/无 record、job_command 不含原串；override 含引号同理。

## 3. 两问答复

### Q1 `usable` 该不该查本地存在性？

**不查，保留「形态可用」语义**，理由：报告可能产生在被验机器，而 job 在工作区机器执行——本地不存在 ≠ 不可执行；r25 的死命令是**形态**问题（`blob:` 不是路径），不是存在性问题。但补三项：

1. **先做安全白名单**（§2，优先级最高）；
2. payload/human 增加 `db_exists` 诊断；`existsSync(db)` 为真时命令串写 `resolve(db)` 绝对路径（同机更稳），为假时打一行 warning（"not found on this machine; the job will fail until the path exists"）；
3. 可选 `--require-db-exists`（默认关）给 CI 做硬检查；不建议默认开，否则跨机报告流程全被挡。

### Q2 `--db` 覆盖会不会成为「绕过来源校验、把作业指到任意库」的口子？

**代码层面不是。** 已逐条核对：

- `dbOverride` 只喂 `jobCommand()`；资格判定 `checkEligibility()` 只读 spec+reports；`writeGraduation()` 用 `el.data_source`；`patrolEligibility()` 也用 `el.data_source`（override 不参与）——所以 **不能伪造资格、不能改冻结记录、不能绕 patrol 闸门**。
- 能力面不新增：`job add` 本来就允许任意命令；`graduate --schedule --db X` 没有比 `job add -- "verify run … --db X"` 更多的权限。

剩余两个真实风险：
1. **注入**（§2 的 P1，override 同路径，需同修）；
2. **语义漂移**：作业检查的库不是当初被验的库，FAIL 噪声会指向错误目标。建议 override != 报告 source 时打 human 警告，并在文档写明「override 只换常驻目标，冻结记录仍记被验源」；不要把 override 写进冻结记录（保持不可变）。

## 4. P4 / 记账

- `docs/plan.md:361` 仍写 `graduate.ts，211 行`（实际 **231**）；同段「`graduate 10→15、CLI 27→29`」与事实不符（`verify-cli` 是 **24→29**，graduate 文件 15 例）；CHANGELOG 的「graduate.spec 10—…」也与 15 例不符。
- `llms.txt` 的 graduate usage 缺 `[--db <source>]`（CLI help 已有）。
- 工作树有与本版无关的 techtree WIP（`bin.ts`/`cmds.ts`/`node-qual.spec.ts`/`ratchet-baseline.json`）；默认全量 unit 因此 **3 例 FAIL**（`node-qual.spec` 期待未提交行为、dist 也未重建）。**在本 commit 的跟踪范围内 483 passed**，定向 44/44。
- 发布态：`master=5d0eb49` 已推；本地无 `v0.103.0` tag、npm latest 仍 `0.102.4`、Gitee 无 0.103.0 release（发版席 handoff 已发）——发版后需补 tag/npm/Gitee 与最终 diff 核对。
- `pnpm contract:audit` 本次 240s 超时（WIP 环境），未取到 100/100；dev 报 100。

## 5. 结论

**CHANGES**：P1 注入必修（一个函数 + 两处调用 + 测试，工作量小）；Q1/Q2 见 §3；P4 记账顺手修。修完后在 **clean tree**（不含 techtree WIP）跑一次全量门禁 + 发布态核对，即可 PASS。

证据：`tmp/r26-probe.mjs`（r25 收口矩阵 + 注入原文）、`tmp/r26/import2`（crafted report → import → graduate → PWNED2 全链）、`tmp/r26-unit.log`、`tmp/r26/inject2.json`。
