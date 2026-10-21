# 0.84.0 工作区评审报告

> **评审模型：deepseek-v4.1-flash-1017**
> 日期：2026-10-17 ｜ 评审对象：HEAD `c779763`（0.83.1）+ 未提交工作区（0.84.0「判定落账」）
> 评审方式：diff 逐段审阅 ＋ 四段门禁实测 ＋ 失败形态复现归因 ＋ 文档真值对照

---

## 〇、结论

**判定：可以合入，但建议先修 4 个 P1。** 功能方向正确（`claim link` 的 fire-and-forget 是实证 bug，修法也对），改动面 10 文件 +172/−47，P1 修复量合计约 1.5 小时，风险低。

门禁实测（**隔离复跑**）：

| 检查项 | 结果 |
|---|---|
| 单测 `vitest` | **181/181**，33 个文件 |
| 构建 `tsc + tsdown` | 通过 |
| demo `examples/demo.sh` | **118 条断言全过**，RC=0 |
| 契约 `contract:audit` | **86/86**，AUDIT_RC=0 |
| 文档 `readme:verify` | 全绿 |

> 说明：评审期间本机同一 DSH 宿主上**另一会话**也在同一仓库跑 `pnpm test`，两次 demo 失败经定位为共享 `/tmp/ygl-demo` 互删所致（见 §5.3），非代码缺陷。上表结论已用隔离 home 复跑校正。

---

## 一、评审范围

工作区未提交变更（`package.json` 0.83.1 → 0.84.0）：

| 文件 | 变更内容 | 判定 |
|---|---|---|
| `packages/research/pipeline/src/cmds.ts` | `claim link` 等待评估并落 `claim.eval` 事件；新增 `claim calibration` 子命令 | ⚠ P1-1、P2-1、P2-2 |
| `apps/cli/src/bin.ts` | help/manifest 增 `claim evaluate`·`claim calibration`；JSON 纯度修复 | ⚠ P1-4 |
| `examples/demo.sh` | 5l 新增 4 条校准断言 | ✅ 断言正确；⚠ P1-3（并发） |
| `packages/research/pipeline/tests/claimeval.spec.ts` | 新增 4 例（离线/事件/校准/`--all`） | ⚠ P1-2（依赖 dist） |
| `packages/core/database/tests/lifecycle.spec.ts` | `try/finally` 修锁悬挂级联 | ✅ 正确 |
| `package.json` | 版本号；`test:unit` 加 vitest 超时参数 | ⚠ P1-2（顺序） |
| `scripts/readme-verify.sh` | 增 3 条 claim 校准校验 | ✅ 正确 |
| `skills/ygl-trees-research/SKILL.md` | 补 `evaluate`/`calibration` 命令面 | ✅ 正确 |
| `README.md` | 计数与说明 | ✅ 实测吻合（181/118/86） |
| `CHANGELOG.md` | 0.84.0 条目 | ✅ 与实测相符 |

不覆盖：PG `sync/migrate` 面、WebUI React 端、`vendor/` 框架、`pack:check`/`bun` 探针（按需另评）。

---

## 二、功能审阅

### 2.1 修复对在哪里（结论与证据）

1. **fire-and-forget 截断是真 bug**：0.83 的 `claim link` 异步评估会被 CLI 短进程退出截断，CHANGELOG 记录的实证是「工作区 112 次 link 零 `claim.eval` 事件」。0.84 改为 `await` 后事件落账，校准才有事件源——修因，不是修症状。
2. **JSON 纯度修复**：评估先结算、JSON 回执后输出，`model_label`/`model_confidence` 并入同一对象，避免 `--json` 下 stdout 出现两段。符合契约②（stdout 单对象）。
3. **评估失败不阻断 link**：`try/catch` 包裹，eval 异常仅丢弃模型档位——正确兜底。
4. **事件载荷闭环**：`{model_confidence, label, mode, human_status}`；calibration 用 `human_status` 映射人工档位（supported=4 / contested=2 / refuted=1 / unverified=null），模型 A→4 B→3 C→2 D→1，gap = 人工−模型，语义自洽。
5. **离线安全保持**：`claimeval.spec.ts` 4 例锁定「无凭证/离线 → pending、不落事件」。
6. **`lifecycle.spec.ts` 的 `try/finally`**：修在途锁测试互相污染导致的悬挂级联（真实踩过的 Windows hang）。

### 2.2 缺陷清单

#### P1-1（数据错误）校准 JSON 的 `evaluated` 口径错误

- **位置**：`packages/research/pipeline/src/cmds.ts:796`
- **问题**：`evaluated: latest.size` 统计**全工作区**的 `claim.eval` 事件数；而 `rows` / `comparable` / `share_pct` 都按当前项目过滤。带 `-p` 查某项目时 JSON 自相矛盾（`evaluated` 可能大于 `comparable` 甚至 rows 总数）。
- **影响**：人类输出用 `comparable` 算百分比、看不出；但 JSON 是 Agent API 契约面，Agent 会读到错误样本量。
- **证据**：`evaluated` 取 `latest`（全表 latest-wins 后的 map size），`rows` 在过滤后的循环内生成。
- **修法**：`evaluated: rows.length`（或先按项目过滤 `latest` 再计数），一行。
- **验收**：新增 spec/断言：`-p` 指定项目时 `evaluated === rows.length`。

#### P1-2（测试基建）全新检出 / CI 上 `pnpm test` 会挂

- **位置**：`package.json:15-16`（`test:unit && build && demo && audit`）+ `packages/research/pipeline/tests/claimeval.spec.ts:16-20`（`spawnSync(node, [dist/bundle/bin.cjs])`，无存在性守卫）+ `.gitignore:2`（`dist/` 被忽略）。
- **问题**：单测阶段先于 `build` 运行，而新 spec 依赖 `dist/bundle/bin.cjs`。本机因 dist 已存在所以绿；**干净克隆/CI 会在单测阶段直接失败**。
- **修法**（二选一）：`test` 顺序改 `build && test:unit && …`；或 spec 在 `BIN` 不存在时明确 `skip` 并打印「先 pnpm build」。
- **验收**：`rm -rf dist && pnpm test` 全绿（或 spec 明确 skip 且不失败）。

#### P1-3（测试基建）demo 与 audit 使用固定共享 home，并发运行互删

- **位置**：`examples/demo.sh:8-9`（`YGL_HOME=/tmp/ygl-demo` + 启动 `rm -rf`）；`scripts/contract-audit.sh:19-20`（`tmp/contract-audit` + 启动 `rm -rf`）。
- **问题**：两次运行并发时互相删除数据库，表现为误导性失败：`no database at <tmp>/ygl-demo/ygl-trees.db`、`claim not found`。本次评审真实发生（与另一会话并发，双方向各挂一次）；隔离 home 下插桩版 demo **118 条断言全绿**（`tmp/demo-debug.log`，RC=0），可确认脚本逻辑本身确定性 OK，故障来自共享 home。
- **修法**：`mktemp -d` + `trap 'rm -rf "$YGL_HOME"' EXIT`，保留 `YGL_HOME` 覆盖口子；audit 同理。
- **验收**：两个 demo 并发运行互不影响；或至少错误信息不再误导。

#### P1-4（契约②）db 缺失时 `--json` 输出不纯

- **位置**：`apps/cli/src/bin.ts:356-370`（`needInit && !existsSync(file)` 分支）
- **问题**：`bad()` 与 `out()` 均未受 `ctx.json` 约束，`--json` 时 stdout 变成「错误对象 + 人类 3 行」，机器不可解析；rc=2 但类别与 JSON 面都破了契约。
- **证据**（实测复现，空 home 下 `kb add --json`）：

```text
{"error":"no database at <tmp>\\ygl-demo\\ygl-trees.db"}
  run: ygl-trees db init
  workspace: <tmp>\ygl-demo  (from YGL_HOME)
→ JSON.parse: Unexpected non-whitespace character after JSON at position 100 (line 4 column 3)
```

  这正是 demo 5h 崩溃的形态（`tmp/demo-review.log`）。
- **修法**：`ctx.json` 时只输出单个 `{"error":…}` 对象、提示信息走 `console.error`，保持 rc=2；契约审计「JSON 通道」组补一条 db 缺失用例。
- **验收**：`--json` 下 stdout 单对象可 parse；契约 86→87 项全绿。

#### P2-1 `claim link` 同步等待评估，最坏约 240s

- **位置**：`packages/techtree/eval/src/eval.ts:136`（`AbortSignal.timeout(60_000)`）+ `:123-151`（`attempt>=3` 才放弃 → 最多 4 次）。
- **问题**：网关「挂而不死」时一次 link 可阻塞 4 分钟；无 `--no-eval` 逃生。离线/无凭证会快速 pending，问题只在半可用网络出现。
- **建议**：link 场景传更短超时（如 15s、总预算 ≤60s），或加 `--no-eval` / 环境变量开关。

#### P2-2 `--by-source` 批量 link 不触发评估，与单条 link 行为不一致

- **位置**：`cmds.ts:528-552`（by-source 分支只 `writes.claimLink`）vs `cmds.ts:564-600`（单条 link 带 `evaluateClaimConfidence`）。
- **问题**：同一语义两条路径，一条有模型档位一条没有；Agent 用 `--by-source` 批量挂证据时拿不到评估。
- **建议**：抽「link 后置步骤」公共函数，或帮助文本写明差异。

#### P3（记录，不阻塞）

- `claim.eval` 事件在 `claimLink` 事务**提交后**单独 INSERT（best-effort）：语义可接受，但应注释说明「非原子」的取舍；重复 link（duplicate）也会追加事件，校准取 latest 所以无害，只是事件量 ≠ 唯一链接数。
- `human_confidence` 原样存 `claim.confidence`（A/B/C 或 0.92/85% 未归一化），校准消费时需自行解释。
- calibration 每 claim 一次 `store.db.get`（N+1，量小无碍）；`ORDER BY ts` 同秒时 latest-wins 依赖行序。
- 覆盖缺口：spec 只测离线路径，`calibration --all`、`-p` 过滤、人类输出均无断言。

---

## 三、测试与门禁（证据）

| 检查项 | 命令 | 结果 | 证据 |
|---|---|---|---|
| 单测 | `pnpm test:unit`（vitest run） | 181/181，33 files | 会话内实测；并发会话 `tmp/test-full2.log` 同值 |
| 构建 | `pnpm build` | 通过 | tsc + tsdown |
| demo | `bash examples/demo.sh` | **118 ✓，RC=0** | `tmp/demo-debug.log`（隔离 home 插桩版） |
| 契约 | `bash scripts/contract-audit.sh` | **86/86，AUDIT_RC=0** | `tmp/audit-review.log` |
| 文档 | `bash scripts/readme-verify.sh` | 全绿 | 会话内实测 |

### 3.3 失败复现与归因

| 日志 | 现象 | 归因 |
|---|---|---|
| `tmp/demo-review.log` | 5h `kb add --json` → JSON.parse 崩（`Unexpected non-whitespace character after JSON at position 100`） | P1-4 事件：db 缺失路径 JSON 不纯；进程自身 rc=2 + 非 JSON 文本，管道 `node -e` 直接崩 |
| `tmp/test-full.log` | 另一会话在 section 4 失败 `ELIFECYCLE` | 与本次评审 demo 并发，共享 `/tmp/ygl-demo` 互删（P1-3） |
| `tmp/test-full2.log` | 并发会话全门禁 **82/86**：4 项 flag 校验 `rc=1` + `cannot open database D:\workspace\ygl-trees\`（home 指到仓库根） | **未完全归因**。隔离复跑不复现，疑似该 shell 的 `YGL_HOME` 泄漏/争用；建议收口时独占重跑确认 |

---

## 四、文档真值

| 文档 | 声称 | 实测 | 判定 |
|---|---|---|---|
| `README.md:304` | unit 181 例 | 181/181 | ✅ |
| `README.md:304` | demo 118 条断言 | 运行时 118 条 ✓（静态 `echo " ✓"` 89 行，其余由循环/helper 输出——计数口径按运行时） | ✅ |
| `README.md:304` | contract:audit 86 项 | 86/86 | ✅ |
| `AGENTS.md:50` | audit「73 项」 | 86 | ❌ 陈旧 |
| `AGENTS.md:56` | demo「61 条断言」 | 118 | ❌ 陈旧 |
| `llms.txt:1` | v0.76.1 | 实际 0.84.0，缺 `claim evaluate/calibration`；且列入 `package.json files` → **发布面陈旧**（`ygl-trees llms` 现可生成 214 行新版） | ❌ 需刷新 |
| `AGENTS.md` | 证据链指向 `docs/plan.md` | plan.md 最后执行记录 0.9.0，事实证据链在 CHANGELOG 逐版本 | ⚠ 指路失真 |

建议：llms.txt 用 `ygl-trees llms` 刷新后纳入 `readme:verify`；AGENTS.md 两个计数随版本收口更新（或改为「见 README/脚本实测」避免再漂移）。

---

## 五、修复清单与验收

| # | 优先级 | 修复项 | 位置 | 工作量 | 验收 |
|---|---|---|---|---|---|
| 1 | P1 | `evaluated` 按项目口径计数 | `cmds.ts:796` | 10min | `-p` 下 `evaluated === rows.length`，补断言 |
| 2 | P1 | 单测依赖构建顺序（或 spec 守卫） | `package.json:15-16`、`claimeval.spec.ts:16` | 10min | `rm -rf dist && pnpm test` 绿 |
| 3 | P1 | db 缺失路径 JSON 纯度 | `bin.ts:356-370` | 30min | `--json` stdout 单对象；契约加一项 |
| 4 | P1 | demo/audit 用 `mktemp` 隔离 | `demo.sh:8-9`、`contract-audit.sh:19-20` | 30min | 并发双跑互不影响 |
| 5 | P2 | link 评估短超时 + `--no-eval`；`--by-source` 一致性 | `eval.ts:136`、`cmds.ts:528-600` | 按需 | 半可用网络下 link 不被拖 4 分钟 |
| 6 | 文档 | AGENTS 计数、llms.txt 刷新（+ 门禁） | `AGENTS.md:50,56`、`llms.txt` | 20min | `pnpm readme:verify` 覆盖 llms |

收口节奏（按 lifecycle）：修 1–4 → **独占**跑 `pnpm test` → `ygl-trees agent brief` / `doctor` → `db export` 备份。

---

## 六、评审边界与声明

- 本报告基于**当前工作区**；评审期间另有会话在同一仓库作业，工作区可能继续变动，合入前请以最新树复跑门禁。
- 未覆盖 PG `sync/migrate`、WebUI 前端、`vendor/` 框架一致性、`pack:check`/`bun` 探针。
- 复现用的日志与脚本在 `tmp/`（gitignored）：`tmp/demo-review.log`、`tmp/demo-debug.log`、`tmp/demo-debug.sh`、`tmp/audit-review.log`、`tmp/readme-verify-review.log`。
