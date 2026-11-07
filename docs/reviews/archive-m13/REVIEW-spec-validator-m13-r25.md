# M13 复核 r25：0.103.0（M13-3 毕业通道，工作树 WIP）

评审对象：`packages/ops/tools/src/graduate.ts`（181 行）+ `verify-cmds.ts:645-741` + `tests/graduate.spec.ts`（10 例）+ CLI 3 例 + 文档；`dist/bundle/bin.cjs` 已构建 **0.103.0**（10:52），HEAD 仍 `83b2ed1`（`v0.102.4`），发布尚未落。
评审方式：源码逐行读 + 逐例 CLI 探针（`tmp/r25-probe.mjs` / `tmp/r25-probe2.mjs`，隔离 YGL_HOME）+ 全量门禁实跑。
结论：**CHANGES**。三段拆（资格/记录/调度）成立、两问设计判断基本正确，但有 **P2×3**（`--min-runs 1` 的跨度闸门真空、HTTP 源的 `job_command` 是死命令、§9 的 `patrol add` 文档与实现不符）+ **P3×4**；修完可发。

## 0. 两问回答（先给结论）

### Q1「最近 N 份」取样会不会把「中间一次 FAIL、最近 N 份全 PASS」判成够格？

**会（有意），我判这个语义是对的，但缺两条补强。** 理由：

- `FAIL` 是**有效结论**，不是"稳定性污点"。同一 `spec_version` 早先 FAIL 通常意味着当时的数据真违规（检查器正常工作），违规修完后最近 N 份 PASS 正是"可常驻"的证据；若把历史 FAIL 当否决，会惩罚"真的抓到过问题"的规范，反而鼓励大家去删报告。
- 真正要防的是**振荡**（FAIL/PASS 交替、靠运气撞进窗口）。当前窗口语义只保证"最近 N 份全 PASS"，不保证"没振荡过"。

实测（`tmp/r25-probe.mjs` A）：v2 下 `run_old_fail`(2026-07-01 FAIL) + 3 份 PASS（09-01/09-20/10-11，span 40d）→ rc=0、`run_ids=[run_c,run_b,run_a]`、记录 `thresholds={min_runs:3,min_span_days:30}`。行为与文档一致。

补强建议（不阻塞）：
1. 记录与 `--json` 增加**历史摘要**（同 `spec_version` 总报告数、非 PASS 条数、最近一条非 PASS 的 `finished`/`run_id`），让审计者看到"窗口外还有 FAIL"，而不是误以为"从未失败"。
2. 可选的严格模式 `--require-clean-history`（同版本历史出现任何非 PASS 即拒绝），给"宁严勿松"的运营者一个显式开关；默认不改变现语义。

另有一条**必修**（与窗口相关）：`--min-runs 1` 会让跨度闸门**静默失效**，见 P2-1。

### Q2 `duplicate` 判据不含阈值，阈值不同但 run 集合相同会回 duplicate——要不要把 thresholds 纳入？

**不纳入 identity 是对的，但响应必须回冻结值。** 毕业记录冻结的是**证据集**（`spec_id+spec_version+run_ids`）；阈值是"这次决策用的政策"，不产生新证据，重跑同证据只是重述政策，duplicate 合理。**但实测有审计矛盾**：

- `tmp/r25-probe.mjs` A2：先按默认（`min_span_days:30`）冻结；再跑 `--min-span-days 31` → rc=0、`duplicate:true`，**`payload.thresholds` 回的是请求值 31，而记录文件里是 30**（`verify-cmds.ts:701` 用请求变量而非 `written.record.thresholds`）。审计者会以为冻结记录里是 31。
- 同类问题在调度上：E2 用 `--every 120` 重跑 → `payload.job_every_minutes=120`，但已存在的作业仍是 60（E3），且没有任何更新路径。

建议：duplicate 时 `thresholds` 回 `record.thresholds`（另加 `requested_thresholds` 或 warning 行）；`job_every_minutes` 回**实际作业行**的 `every`（或显式更新作业 / 拒绝重排）。若你更想"阈值也要进 identity"，那就等于"换阈值=换毕业记录"，需要允许覆盖或分文件，与"冻结"承诺冲突，不如现在这套 + 响应修正。

## 1. P2（发布前必修）

### P2-1 `--min-runs 1` 时跨度闸门真空

`graduate.ts:107-112`：`span` 只在 `picked.length >= 2` 时计算，而跨度拒绝条件也要求 `picked.length >= 2`。因此 `--min-runs 1 --min-span-days 30`（默认跨度 30）**单份 PASS 即可毕业**，记录照样写 `min_span_days:30`、`span_days:0`。

实测（probe B / probe2 I）：单份 PASS（2026-10-01）→ rc=0、`graduated:true`、`span=0`、`thresholds={"min_runs":1,"min_span_days":30}`。

修法：`min_span_days > 0 && picked.length < 2` → 拒绝并点名（"span needs at least 2 runs; got 1"）；或在 CLI 直接 `--min-runs>=2` 当 `--min-span-days>0`（rc=2）。单份毕业本身可以保留（跨度=0 时），但不能带着 30 天阈值冻结。

### P2-2 HTTP 源报告的 `job_command` 是死命令，`--schedule` 会登记一个永远失败的作业

HTTP `POST /api/verify/run` 的报告 `data_source.source = "blob:<sha12>"`（0.102.0 设计，不暴露路径）。毕业时 `jobCommand()` 直接拿它拼 `--db`：

- 实测 C1：`job_command = ygl-trees verify run spec_grad --db "blob:02c771f01c31" --no-archive`
- C2：照此执行 → rc=1 `cannot snapshot --db: ENOENT ... 'blob:02c771f01c31'`
- C3：`--schedule --every 60` 仍 rc=0 并登记作业（`job_id=37318221c5`）——**作业每分钟失败一次**。

修法：`jobCommand` 只接受"可作 `--db` 的源"（`existsSync(source)` 或非 `blob:`）；HTTP 源 → 打印占位符（`<path-to-snapshot.sqlite>`）并**拒绝 `--schedule`**（除非显式给 `--db <path>` 覆盖，如加 `graduate ... --schedule --every N --db <path>`）。另外 `patrolEligibility` 对 blob 源已经会拒（好），但报错文案是"报告来自 blob:..."，可读性可再改。

### P2-3 §9 文档承诺 `--patrol` 会 `patrol add`，实现只做资格闸门

`docs/spec-validator.md:372` 写「`--patrol` 分支把渲染后的 `findSql` 交 `patrol add`」；实现（`graduate.ts:169-181` + `verify-cmds.ts:676-682`）只调用 `patrolEligibility` 校验库是否同源，**不登记任何 patrol check**。实测 F1 可毕业、F2 `patrol list` 为空。

要么实现 patrol 登记，要么把 §9 那句改成「0.103.0 仅做资格闸门；patrol check 登记在 M13-4/后续」。按当前发布节奏，**改文档**更诚实（别让运营者以为 `--patrol` 之后会多出一条巡检）。

## 2. P3（可随版修，但建议本版收）

1. **`--schedule` 缺 `--every` 时先落盘再报用法错**：`writeGraduation`（`verify-cmds.ts:685`）在 `every` 校验（:722-725）之前执行；实测 D1 rc=2 但 `graduations/spec_grad.json` 已冻结。修法：every 校验提到 `writeGraduation` 之前。
2. **duplicate 响应的 `thresholds` / `job_every_minutes` 不是冻结值/实际值**（见 Q2 实测 A2/E2）。修法：回 `written.record.thresholds`；job 字段回作业行。
3. **版本升级后无法再毕业**：`spec_version` 变了 → `sameCore=false` → `refusing to overwrite ... if the frozen record was wrong`（实测 H2）。记录冻结没错，只是**被取代**；报错文案与应用层行为建议拆开——至少文案点名「frozen v2 vs current v3；delete deliberately to re-graduate after a version bump」，或加 `--supersede`（M13-4 前先别做）。
4. **窗口跨度会因新 run 收缩**：G2 中新增一份更近的 PASS 后，最近 3 份变成 09-20→10-18（28d <30）→ 从"够格"变"不够格"。这是窗口语义的必然结果，但运营者容易误会；建议文档写一句「跨度按最近 N 份的首末算；新增 run 会把窗口整体右移」。

## 3. P4 / 观察

- `daysBetween` 只按 `finished` 排序（`graduate.ts:94`），同一毫秒并列时选取不确定 → 加 `run_id` 次级键。
- `docs/plan.md:361` 写 `graduate.ts，211 行`，实际 **181 行**（文件数漂移）。
- 损坏报告静默跳过（`graduate.ts:84-88`）：与看板 N2 WONTFIX 同口径，但资格判定应至少把"跳过了 N 份损坏报告"打一行 stderr/诊断。
- `job_command` 用裸 `ygl-trees`（依赖 PATH）——与现有 job 习惯一致，记为约定即可。

## 4. 实测证据

| 探针 | 结果 |
|---|---|
| A1 旧 FAIL 在窗口外 | rc=0，eligible，run_ids 新→旧，span 40 |
| A2 同证据换跨度阈值 | duplicate=true，payload.thresholds=31，record.thresholds=30（P3-2） |
| B / I min-runs=1 + span 30 | rc=0，span=0（P2-1） |
| C1/C2/C3 blob 源 | job_command 带 `--db "blob:..."`；执行 rc=1 ENOENT；schedule 仍登记 job（P2-2） |
| D1 schedule 缺 every | rc=2 但记录已落盘（P3-1） |
| E1/E2/E3 schedule 重排 | 首次 job every=60；重跑 every=120 未生效、payload 却回 120（P3-2） |
| F1/F2 patrol | 同源库 → eligible；`patrol list` 空（P2-3） |
| G2 新 PASS 到达 | 窗口右移 → span 28 <30 不够格（P3-4） |
| H2 版本升级 | rc=1 拒绝覆盖 + "if the frozen record was wrong"（P3-3） |

## 5. 门禁（WIP 树，`dist` 0.103.0）

- unit **475/476**：唯一失败 `webui.test.ts > P1-1 fetch failed`（ECONNRESET，已知环境 flake 族；**隔离单跑 17/17 通过**），与 r12/r18 记录同族。
- contract **100/100**、demo **128 ✓ rc=0**、readme **54/54**。
- 定向 `graduate.spec + verify-cli.spec`：**37/37**（graduate 10 + verify-cli 27）。
- 发布态：npm 0.103.0 仍 **404**、`v0.103.0` tag 未推、Gitee release 未建（HEAD=`83b2ed1`/`v0.102.4`）——本报告针对工作树；提交/发布后需照 r21 惯例补一次 tag/npm/Gitee 与最终 diff 核对。

## 6. 结论

资格/记录/调度三段拆是对的，两问判断我确认；但 **P2×3 修完再发**（P2-1 是资格真空、P2-2 会持续制造失败作业、P2-3 是文档承诺未兑现）。P3-1/P3-2 各是几行改动，建议一并收；P3-3/P3-4 可留到 M13-4。

证据脚本：`tmp/r25-probe.mjs`、`tmp/r25-probe2.mjs`；日志：`tmp/r25-unit.log` / `r25-contract.log` / `r25-demo.log` / `r25-readme.log`。
