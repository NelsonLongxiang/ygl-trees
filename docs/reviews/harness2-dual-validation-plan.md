# harness2 双线验证方案（两席共识稿）

> 评审席：302cb119（本席）与 fdc757f6（交叉核验席）。日期：2026-10-20。
> 状态：**待用户三项决策后执行**。本文是方案与证据清单，不是已执行记录；与逐轮评审报告冲突时，以
> `REVIEW-spec-validator-m13-r18..r20.md` 原文为准。

## 0. 结论摘要

- **总判断（需求侧）**：所谓「harness2 将成为验证器不可或缺的一部分」应改写为「**程序化验证器将成为
  harness2 类系统的一部分**」——不可或缺性在需求侧，且方向是「外强于内」。
- **近期动作**：不接 harness2。先做两件便宜事：内线 **P1a 方差探针**（证明构造器有无 headroom），
  外线 **evaluator 协议草案 + 扩展点侦察**（证明对方边界可不可插）。
- **红线（先写死，防将来引入第二个裁判）**：单一裁判权 = 引擎 + 评审流水线；harness2 只出候选/prompt，
  不拿分；不 vendor、运行面不联网、不进 `pnpm test`。
- **待用户定**：① M13-2 HTTP prepare/run 放行（凭证已配好）；② 本文入库确认；③ P1a 启动排期。

## 1. 研究对象事实（仓库 + 论文）

| 事实 | 出处 |
|---|---|
| harness2 = 「harness 的递归优化器」：8 类可编辑组件（system prompt/guardrails/memory/tool guidance/subagents/skills/scripts/plugins），任务级递归（Propose–Probe–Compose，`--k`、parallel/sequential）+ harness 级持久改进；executor 为 OpenCode（默认）或 Codex；**不是验证器** | repo README |
| 基准固定三种：JobBench / LAB / WorkBuddy，`harness2-setup <bench>` 逐基准安装；**无自定义 benchmark/verifier 扩展点**；wheel 只装 `harness2` 包，任务切分脚本 `scripts/split_tasks.py` 需源码树 | `docs/BENCHMARKS.md`、`docs/SETUP.md` |
| **WorkBuddy 适配器 reads the verifier's `score.json`；improver never receives verifier output**——对方 benchmark 边界已假定一个程序化 verifier | `docs/BENCHMARKS.md` |
| LAB 把 criteria 从材料中移除；judge 在 selection 之后才读输出；判分为 Partial / All-pass；**changing the judge model changes the measurement** | `docs/BENCHMARKS.md` |
| JobBench：rubrics stay outside the improver's evidence；数据公开在 Hugging Face（executor 联网可能取回），需按 `web access` 章节屏蔽主机 | `docs/BENCHMARKS.md` |
| 执行器网络访问无限制；Codex 以 sandbox disabled 运行；模型凭证 = Vertex ADC（`GOOGLE_CLOUD_PROJECT` 等）；judge 可换 OpenAI 兼容端点（`HARNESS2_JUDGE_BASE_URL/API_KEY`） | `docs/SETUP.md` |
| 论文：开放世界 RSI 的瓶颈是「没有 ground-truth verifier」；PPC 用对比探测替代真值反馈；评分为 judge；报告增益（WorkBuddy +11.5 pts、JobBench +4.5、LAB +11.8pp）为自报 | arXiv:2610.14224（README 引用，本席已核原文） |

## 2. 两席共识口径

1. **不可或缺性在需求侧**：验证器不需要 harness2；harness2 类系统需要一个验证器——「外」才是不可替代
   的方向。内线（用 harness2 递归优化 prepare 构造链）是可选优化，不是验证器的必要组成。
2. **外强于内，四条理由**：① 结构上对方已在 benchmark 边界用程序 verifier（WorkBuddy `score.json`），
   而内线没有自定义 benchmark 扩展点、solver 绑 Vertex+OpenCode/Codex、执行器网络无限制；② 判定上
   我们确定性+可审计+版本化（contract/corpus），judge 换模型就换测量；③ 依赖不对称（需求侧）；
   ④ 内线合并两个优化环，破坏面大且与「零人工确认」的审计纪律冲突。
3. **P1–P5 表态**：P1 同意但拆 P1a/P1b；P2 升红线（单一裁判权）；P3 同意（CLI/fork 边界，不 vendor）；
   P4 部分同意（双向不对称，对方的 benchmark 只比较构造器质量，不验证验证器正确性）；P5 同意且是最强
   「外」形态，但近期形态只能是「协议草案 + 上游 PR/issue 或 fork」——可复用资产是 evaluator 协议而
   不是框架绑定。
4. **PPC 张力两半拆解**：PPC 的对比探测是为「无真值」设计的；我们有 expected reports 时，任务级对比探测
   基本多余——直接对候选打分即可，且报告带 witness / per-VU reason，信号比对比探测更密。但
   (a) improvement-harness 的「跨任务持续改进」与真值无关，仍可复用；(b) **构造器级真值我们其实没有**：
   `expected-report` 是 spec→report 的标签，材料→spec 的标签要自己造。廉价造法 = **隐藏快照**（已知
   真值的数据）当确定性奖励，不必写 gold spec；另一条零成本路径 = 真实业务反馈回流（M13-3 毕业通道）。
   P1a 只测方差不测对错，因此不依赖标签。

## 3. 内线方案（harness2 → prepare 优化）

**假设 H-in**：构造质量（判据覆盖、checker 形态、锚点保真、红队通过率）对 harness 编辑敏感，且提升
可复现地超过噪声。

### P1a 方差探针（1 天）
- 材料：3–5 份代表性材料（业务快照 + 场景说明；含一份带附件）。
- 方法：同一材料 × 3 次 `verify prepare`（同模型、同参数、记录温度）；不接 harness2，只测我们自己
  构造链的自然方差。
- 指标：子句覆盖率、checker 形态正确率（对 expected-report 的可判性）、盲审拒绝率、锚点保真
  （verbatim 命中）、同 spec 重跑判定一致性、每次 token/时长。
- 判真（交叉核验席补数值门槛，2026-10-20）：满足以下任一条即判「存在 headroom，进入 P1b」——
  ① 子句覆盖率在同材料 ×3 次中极差 ≥15 个百分点（跨材料至少一份出现）；
  ② VU 数量或 checker 型分布同材料 ×3 次不完全一致（任一份材料出现即算）；
  ③ 盲审拒绝率或锚点保真率同材料 ×3 次极差 ≥10 个百分点。
- 判假：三条全部不满足（指标饱和、方差≈0）→ 内线暂无可测收益，降为「监控项」（材料形态或模型升级时
  重跑探针）。
- 红旗（不是方差，是缺陷）：**同 spec 重跑判定不一致 ≥1 例 → 引擎确定性破约**，立即停探针转缺陷流程
  （引擎重跑一致性必须恒为 100%，它不进 headroom 判定）。

### P1b VCB（构造基准，~3–5 天）
- 形态：材料 → prepare → spec → 引擎在**隐藏快照**上运行 → 与「已知真值的预期判定」比对。
- 标签：隐藏快照由数据构造保证真值（如金额关系、缺附件、错批次），无需人工写 gold spec；
  真实业务反馈回流（M13-3）作为第二条标签来源。
- 评分：确定性判定（overall/summary/per-VU verdict + witness），不引 LLM judge；这样构造优化与验收
  共用一把尺，也守住单一裁判权红线。
- 用途：任何 harness 改动先用同一把尺量；也只有这时，「让 harness2 参与构造优化」才有可比较的基线。

### 便宜证伪清单（内线）
| # | 探针 | 成本 | 判假信号 |
|---|---|---|---|
| F1 | 同材料 ×3 prepare 方差 | ~1 天（需凭证） | 指标饱和、方差≈0 |
| F2 | 单点 prompt A/B（同批材料，两版） | 0.5 天 | 确定性评分差 < 噪声 |
| F3 | 成本计（token/时长/每提升一分） | 随 F1/F2 | 收益 < 成本 |

## 4. 外线方案（引擎 → harness2 类系统）

**假设 H-out**：harness2 类系统的判定缺口（judge 不可复现、rubric 可泄露）会让程序化验证器成为必需品。

### 协议草案（0.5 天，零凭证）
把 `verify run --json` 的报告压成 evaluator 协议（确定性、可哈希、可审计）：

```json
{
  "protocol": "ygl-verify-evaluator/1",
  "task_id": "...",
  "deliverable_sha256": "...",
  "verdict": "PASS|FAIL|NEEDS-MATERIAL|ERROR",
  "score": { "pass": 0, "fail": 0, "needs_material": 0, "error": 0 },
  "witness": { "rows_scanned": 0, "rows_matched": 0 },
  "versions": { "contract": "1.1", "corpus": "1.1", "engine": "..." },
  "hashes": { "report_sha256": "...", "binary_sha256": "..." }
}
```

### 扩展点侦察（0.5 天）
- 结论（已核）：当前不可插拔——setup 只有 jb/lab/wb；wheel 只装 harness2 包；无 verifier/benchmark
  插件点。可行路径只有「上游 PR/issue 增扩展点」或 fork。
- 证据：`docs/BENCHMARKS.md`、`docs/SETUP.md`；WorkBuddy `score.json` 是先例。

### 消费证明（1 天，可选）
- 最小证明：20 行适配（报告 JSON → 协议 JSON）+ 一个离线消费脚本；若环境允许，用 `harness2-demo`
  （无凭证）验证「对方能读我们的判定」。
- 上游路径：以 GitHub issue/PR 提案扩展点（成本高，但比 fork 可持续）。

### 便宜证伪清单（外线）
| # | 探针 | 成本 | 判假信号 |
|---|---|---|---|
| F1 | 扩展点侦察（docs/code） | 0.5 天 | 无任何任务/评分插件点 |
| F2 | WorkBuddy `score.json` 先例核验 | 0（已核） | 仅个例、非架构 |
| F3 | 协议映射 + 离线消费 | 1 天 | 对方无法消费（无 hook） |
| F4 | 上游/PR 可行性 | 0.5 天 | 上游明确不收（则止于协议草案） |

## 5. 与现有工作的关系

- **不改** `packages/verify/core`（engine/prepare/contract）、封包/签名、corpus 的任何契约。
- 内线 P1a 只调用现有 `verify prepare`；P1b 只新增基准语料与评分脚本，不碰引擎。
- 外线协议基于现有 `verify run --json` 报告形状（contract 1.1），复用 archive/signature 的哈希与
  版本字段，不新增信任面。
- 与 M13-2（HTTP prepare/run）的隔离设计一致：runner 归 serve 进程、请求体永不带 argv/凭证——本方案
  的探针与协议都不改变这个边界。
- 与 M13-3 毕业通道的关系：真实业务反馈回流是「材料→spec 标签」的零成本来源，P1b 可用。

## 6. 排期与决策

| 事项 | 凭证 | 时长 | 决策 |
|---|---|---|---|
| 外线协议草案 + 扩展点侦察 | 无 | 1 天 | 可立即做 |
| 内线 P1a 方差探针 | 需网关 | 1 天 | 待用户/排期 |
| P1b VCB | 需网关 | 3–5 天 | P1a 判真后 |
| 外线消费证明/上游提案 | 无/低 | 1–2 天 | 协议草案后 |

**用户三决策**：① M13-2 放行；② 本文入库；③ P1a 启动排期。

## 7. 证据与原文

- harness2 repo：`google-research/harness2`（README、`docs/BENCHMARKS.md`、`docs/SETUP.md`、`docs/EXPERIMENTS.md`）。
- 本席评审备忘：`tmp/harness2-fit-review.md`（三步使用设想与风险）。
- 交叉核验席：`tmp/review-harness2.md`（P1–P5 与反向开口）。
- 我方事实源：`REVIEW-spec-validator-m13-r18.md`–`r20.md`、`packages/verify/core/src/prepare.ts`、
  `packages/verify/core/corpus/`（33 例 + expected-report）。
