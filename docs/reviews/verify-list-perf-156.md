---
name: verify-list-perf-156
description: Windows 验证器列表计时失败的分层诊断、同配置对照与测试分段修复证据
kind: 参考
---

# #156：列表性能门的诊断与分段

读取与测量时间：2026-11-01 17:03–17:23 +08。基线 `f57f3cab7ab8f526b56db7357a47393f15bc8d71`；候选 `e1547720b11737e347ee5a5540d0c7596a4d55fe`。本报告为开发席诊断，不是独立评审或发版通过结论。

## 结论与边界

- 已确认：该 HTTP 读路径没有版本差异，也没有由 `Date.now()` 驱动的 TTL、过期重建或 watcher 重挂；所谓“5s 间隔”只 mock 时钟，不真的等待五秒。
- 已观察：相同版本、相同配置下，`specRows` 的异步文件读取时间会大幅波动。一个候选请求 295.12ms，其中 index/SQLite 9.63ms、event-loop idle 191.20ms、GC 0ms；瓶颈位于异步文件读取/宿主调度边界，不是一次可见的索引重建。
- 未确认：导致官方候选 G1 连续失败的具体外部干扰源。尚不能归因于杀毒、索引器、libuv 池、特定新增测试泄漏或产品回退。局部对照没有复现官方失败签名，不能替代 G1。
- 因此本次交付为工单规定的测试确定性修复及可复核诊断，不声称修复已定位的产品 bug。Windows 三连 G1、macOS 复核及第7条根因证据是否充分，仍由相应席在 PR/新候选上核验。

## 官方证据（发版席来源）

两版均用 `bash scripts/offline-gate.sh HEAD`、`env -i`、`test:unit = vitest run --maxWorkers=2`。172 为累计测试文件/进程数量，**不是并发 worker 数**。

| 版本 | 官方 G1 | specs 毫秒 |
|---|---|---|
| v0.118.0 | A1/A2/A3 rc0 | 76.28 / 17.71 / 9.38 |
| e154772 | 三次 rc1 | 294.59 / 200.18 / 206.71 |

A3 晚于候选三次，不是同一时间窗口的同步配对。另读候选第三轮原始日志：warm 42.53ms 通过，最后的 5s 用例失败；这不是所有 warm 请求都超过 200ms。原始记录见 [issue #156](https://github.com/NelsonLongxiang/ygl-trees/issues/156)、[官方口径更正](https://github.com/NelsonLongxiang/ygl-trees/issues/156#issuecomment-6555630887)。

## 可执行路径核对

`handleVerifyApi(GET /api/verify/specs)` → `specRows(env)` → `readListIndex(env.home, ...)` → 一次 spec 目录枚举 → 20 个目录顺序循环，各目录 `Promise.all` 两次 JSON 读取。

两版 Git blob 完全相同：

| 路径 | blob |
|---|---|
| `packages/ops/tools/src/verify-list.ts` | `3b6f311dcd8162c2ce779dcea73f3fc3a31932e6` |
| `packages/ops/tools/src/verify-list-index.ts` | `59eb52cd06926eb96b8e346e4367398a59004c13` |
| `packages/ops/tools/src/verify-web.ts` | `78fb7c2b76f9ef973e0035edbcfc7c8dec64f026` |
| `pnpm-lock.yaml` | `923ebeadc9ab7fbdc562c1ac5df9c2367e9afe1d` |

`Date.now()` 仅出现在 index 写钩子的 stamp/dirty 标记；本用例读路径不调用它。每个 specs trace 都是 1 次 `readdir` + 40 次 `readFile`，没有 `stat`、`prepareListIndex` 或报告 JSON 重扫。

从 webui 静态遍历本仓字面量相对 import/export/require/import() 得到两版各43模块，没有新增可达模块；变动模块仅 verify-cmds（CLI run/list 逻辑）与 archive（导出既有函数）。这排除了该静态图的“新增模块数量”解释，不等于完整动态导入/堆 profile。#146 的 `.pop()` → `.at(-1)` 位于 CLI，不在 HTTP 调用链。

## 同配置请求 trace（诊断，不是 G1）

Git archive 导出两版至仓内 `tmp/issue156-exp/{base,candidate}`，复用同一依赖集，独立 Vitest root，`maxWorkers=2`，原始单样本断言不变；trace 对两版等量增加 fs promise 计时、index 包装及 GC/event-loop 观测。测量顺序为下表从上到下，pairs 在两个 control 组之间。开始阶段仍有另一轮 baseline 的 README 计数 Vitest 进程，已在前后进程快照中保留；不是“空闲机器”结论。

| 控制组 | warm 被判定请求 ms | 5s 三轮 specs ms |
|---|---:|---|
| baseline first | 94.90 | 160.55 / 53.67 / 111.87 |
| candidate first | 9.37 | 9.89 / 10.37 / 11.16 |
| baseline last | 159.17 | 114.87 / 45.62 / 18.82 |
| candidate last | 30.22 | 16.25 / 150.77 / 168.55 |

较慢 baseline 5s 请求 160.55ms：index6.78ms、GC0ms、event-loop idle106.85ms。较慢 candidate 5s 请求 168.55ms：index8.85ms、GC0ms、idle100.37ms。两版均有快慢样本，未显示稳定版本分界。

candidate last 在“不重解析报告”的功能用例中读 specs 达295.12ms：index9.63ms、readFile累计352.95ms、单次max22.15ms、idle191.20ms、GC0ms。readFile累计值含每目录两读重叠，不能直接相加为墙钟。GC回调异步交付，0ms指本观测窗未收到GC事件，不是严格证明没有GC。

### 九组配对

每组为原 perf spec + 下列文件、`maxWorkers=2`；其中大部分文件在 perf setup 完成前已结束，所以这也是“曾并发执行后是否留下干扰”的实验，不保证计时期间仍并发。timeline 保存实际重叠。

| 配对文件 | warm ms | 5s specs ms | 结果 |
|---|---:|---|---|
| cli-contract-148 | 28.23 | 21.09 / 21.90 / 33.45 | rc0 |
| config-secrets-150 | 9.33 | 9.28 / 11.79 / 11.66 | rc0 |
| offline-gate | 27.02 | 88.49 / 130.18 / 72.90 | rc0 |
| verify-group-archive（archive导出） | 115.17 | 88.23 / 52.46 / 47.66 | perf绿，6条CLI setup超时；不计绿 |
| verify-list-count | 8.65 | 9.71 / 11.59 / 12.98 | rc0 |
| predict-metrics | 10.38 | 10.47 / 8.51 / 9.86 | rc0 |
| predict-metrics-cli | 10.85 | 9.95 / 9.20 / 9.31 | rc0 |
| b8-sqlite-gate | 10.02 | 9.80 / 10.25 / 10.18 | rc0 |
| verify-web | 10.77 | 10.09 / 9.35 / 10.66 | rc0 |

归档组异常与无自身 `.git` 的导出形态有关：meta 扫描在无.git时递归磁盘，再过滤依赖/tmp；该导出存在 node_modules junction。用正常本地 clone 重跑同一 pair 为16/16、rc0，perf预算通过。此异常不冒充产品回归或成功pair。

进程快照包含 PID/PPID、创建时间、句柄数、读写字节；各组 after 快照未见其 test worker/CLI 子进程继续存在。perf case 的活动handle类别开始结束均为 Pipe + 三个Socket；仍不能证明所有OS句柄均无泄漏。未获得杀毒/磁盘内核trace，未量化整个系统TMP文件体量，不对(v)作确定归因。

### 真实历史 clone 的全量调度 trace

在本地正常 clone e154772 中使用同一trace/原断言、全文件 `--maxWorkers=2`。warm 62.49ms、5s三轮18.77/49.24/25.27ms；两计时case的并行文件为 `verify-fleet-fixtures.spec.ts`。该次未复现失败。计时case及后续时间线采集完后主动中止余下无关测试，**没有全量rc0结论**。

## 修复范围

- 默认配置排除这一个perf文件；新的perf配置 `fileParallelism:false,maxWorkers:1`。主段仍可并行。
- `pnpm test:unit` 顺序执行主段与perf段，G1通过原有`pnpm test`自动覆盖，不需要修改offline-gate。
- 所有计时路径每次取5样本中位数；warm/三轮时钟前移阈值仍200ms，冷HTTP非阻塞阈值仍500ms，无skip/todo。输出原始5值与median，持续慢的多数样本仍失败。
- README计数为主段1430 + 独立perf10；默认readme计数工具仍测主段。
- 顺带修复工单记录的job-tick-lock清理：注册child close promise、finally kill后await close、Windows删除有限重试；scratch改为仓内tmp。未改产品代码。

## 原始证据与复现

开发机诊断目录 `D:/workspace/ygl-trees/tmp/issue156-exp/`：`prepare.cjs`/`run.cjs`（两版对照+9pair）、`profile.ts`（request/fs/GC/index trace）、`reporter.cjs`（文件时间线）、`*.snapshot.json`、`*.log`、`results.ndjson`。`full-candidate/` 为正常Git clone。永久仓内结论保存在本文件；原始日志是本机临时证据，不保证随clone分发。

```bash
node node_modules/vitest/vitest.mjs run --config diagnostic.config.mjs --maxWorkers=2 packages/ops/tools/tests/verify-list-performance.spec.ts <pair-file>
# 在对应export root执行；diagnostic配置必须包含perf文件。
# 默认主配置排除perf，指定文件名并不能绕过exclude。
pnpm test
node scripts/meta-tooling.mjs --check
node scripts/meta-tooling.mjs --audit --against-git
```

验收状态以PR的最新命令回执为准；不把中断诊断、跳过项或待跑项写成通过。
