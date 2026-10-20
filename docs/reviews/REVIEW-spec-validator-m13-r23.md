# M13 复核 r23：0.102.3（`e5fbd7d` / `v0.102.3`）

评审对象：r22 四条（as_of 双侧校验 / attempts 审计投影 / 命名碰撞 / CLI JSON record）在 0.102.3 的落点。
评审方式：HEAD 源码逐段读 + 隔离 home（`tmp/r23home`、端口 18693）动态探针 + 全量门禁实跑 + 发布物核验。
结论：**PASS**（四条均落地且可实证），留 **1 个 P2**（用户面文档的 `--reviews` 形状与实现矛盾）与 **P3×5**（as_of 边界口径、HTTP 校验次序、record 措辞、并发 TOCTOU、attempts 细节）。均不阻塞 0.102.3 使用，但 P2-1 会让照文档操作的用户永远拿不到 `ready`。

## 0. 实测事实

- 发布物：`e5fbd7d` / tag `v0.102.3`（`git tag --points-at HEAD` 命中）；npm latest 0.102.3（tarball 1,272,205 B，与开发线声称一致）；Gitee release id **1220626**「v0.102.3 r22 P3 收口：as_of 双侧校验 + attempts 审计投影」，assets `v0.102.3.zip`/`v0.102.3.tar.gz`。
- 门禁实跑：unit **454/454（70 文件）**、contract **100/100**、demo rc=0、readme **54/54**；与 CHANGELOG 声称一致。
- 来源：`git status` 仅评审侧未跟踪文件；r22 报告原文与索引行已随本提交入库（`docs/reviews/REVIEW-spec-validator-m13-r22.md`）。

## 1. r22 四条复核（全部通过）

1. **as_of 双侧同校验**：CLI `--as-of "yesterday-ish"` → rc=2、文案点名 as_of（实测 `RC=2`，先于 material/db I/O，attempts 计数 13→13 不变）；HTTP 不可解析 → 400 `{"error":"as_of is not a parseable ISO-8601 timestamp: …"}`，`specs/<id>` 与 `attempts/` 都不落盘；`+08:00` 归一 UTC 后写进 `prepare.json` 的 `as_of.value`（`2026-10-20T02:00:00.000Z`）。`normalizeAsOf`（`verify-cmds.ts`）双侧共用，失败路径 `AsOfError`。
2. **attempts 可审计**：未 ready 两次 → `attempts/` 两文件、`specDetail` 投影 count=2，keys 恰为 `["file","created","verdict"]`（无 diagnostics/materials_sha256 泄漏），按文件名排序；ready 后 `prepare.json` 存在、`spec.json`/`trace.json` 齐全；`record` 字段（`001-…Z.json` / `specs/<id>/prepare.json`）与 CLI `--json` 一致；`--draft` 时 `record: null`（形状恒定）。
3. **同毫秒撞名**：`prepareRecordPath` 首个 `<ts>.json`，冲突 `-2`/`-3` 续号；8 路并发 HTTP prepare → 10 个不同文件（`delta=8, unique=true`），未观察到碰撞（毫秒粒度掩盖了 TOCTOU，见 P3-4）。
4. **CLI JSON record**：ready → `specs/spec_d79fb3eea29d/prepare.json`、rc=0；非 ready → `specs/…/attempts/<ts>.json`、rc=1；draft → `record: null`。三条实测与代码一致。

## 2. 阻塞项（P2，需修文档 + 补测试）

### P2-1 `docs/verify-contract.md` 的 `--reviews` 形状与实现矛盾

- 文档 `docs/verify-contract.md:147-148` 给的是**旧的嵌套数组形状**：
  `{ "reviews": [[{ "vu_id": "V1", "question": "faithful", … }]] }`
- 实现 `fileReviewer`（`packages/ops/tools/src/verify-cmds.ts:79-87`）按 `source_clause` 在 **`[{source_clause, findings}]` 对象数组**里找；嵌套数组永远匹配不到 → 返回 `[]` → prepare fail-closed 报
  `no candidate survived extraction/translation/self-review — ask the business expert for the missing material`（needs-material，rc=1）。
- 实测复现：同一 `candidates` + 同一 db，嵌套形状 → needs-material（rc=1，attempts 落档）；对象形状（`{source_clause, findings}`）→ **ready**（rc=0，record=`specs/<id>/prepare.json`）。HTTP 面同样吃对象形状（`verify-jobs.spec.ts:169`），文档示例对 HTTP 也不成立。
- 为什么现在没人发现：CLI 测试只在**非 ready / draft** 用例里用嵌套形状（`verify-cli.spec.ts:194-202`、`:230-242`），这些用例本来就期望失败；而 `docs/plan.md:348` 的夹具经验反而写对了对象形状。即：**用户面文档错、内部笔记对、测试没覆盖 ready 路径**。
- 修法：①改 §4.7 示例为对象形状（并去掉 findings 里的 `vu_id`——最终 VU id 由引擎分配 `C1…`，见 plan 同一行的经验）；②`verify-cli.spec.ts` 增加一条「照文档形状 → ready」的正向用例；③若想兼容旧形状，可在 `fileReviewer` 里按候选顺序兜底映射，但更建议只留一种。

## 3. 三问回答（开发线点名想看的判据）

### ① `normalizeAsOf` 的边界

现状实现是 `new Date(raw.trim())` + `toISOString()`，因此：

| 输入 | 现状 | 判定 |
|---|---|---|
| `2026-10-20T10:00:00+08:00` | 200，`…02:00:00.000Z` | ✓ 接受 |
| `…T10:00:00Z` / `…T10:00:00.123Z` | 200，原样归一 | ✓ 接受 |
| `2026-10-20`（纯日期） | 200，`00:00:00.000Z` | ✓ **接受**（ISO 日期语义确定，不依赖本机时区） |
| `2026-10-20T10:00:00`（无时区） | 200，`…02:00:00.000Z`（本机 Asia/Shanghai） | ✗ **应拒**：同一字符串在北京与 CI（UTC）落盘成两个锚点，报告失去跨机可比性（R13 的初衷正是这个） |
| `2026-10-20 10:00:00`（空格分隔、无时区） | 200，按本机解析 | ✗ **应拒**（同上，且非严格 ISO） |
| `2026-02-30` | **200，`2026-03-02T00:00:00.000Z`** | ✗ **应拒**：非法日历日期被静默滚到另一天；实测 CLI 以此冻结 spec v10、覆盖了上一份 ready 记录——审计锚被悄悄改写，比直接报错更危险 |
| `2026-13-01` | 400 | ✓ |
| `Jan 1 2026` | 200，按本机解析的 2025-12-31T16:00Z | ✗ 应拒（非 ISO） |
| `2026-10-20T10:00:00+08`（无冒号） | 400 | ⚠ 与引擎 `ISO_DATETIME_TZ`（接受 `±hh`）不一致：建议统一为「接受并归一」或两侧都拒 |

建议：在 `normalizeAsOf` 里做**严格 ISO 解析**——日期部分 `YYYY-MM-DD` 用正则 + 逐段范围/日历回验（或回验 `toISOString().slice(0,10) === 输入日期`）；时间部分必须带 `Z` 或 `±hh:mm`/`±hhmm`/`±hh`；拒绝空格分隔与非 ISO 形态；纯日期保留（UTC 00:00）。这样 ①「可解析」不再隐含「本机时区」或「换一天」。

### ② attempts 投影是否泄露不该出现的字段

没有。实测 keys 恰为 `file`/`created`/`verdict`；`file` 是 basename（`2026-10-20T02-06-24-962Z.json`），不是相对路径，也没有 diagnostics/正文；排序按文件名即可用。两点小建议：`file` 与 CLI `record`（相对 verify 根、带 `specs/<id>/` 前缀）口径不同，文档一句话说明即可；attempts 列表无上限（本地单用户可接受，将来多用户可加截断）。

### ③ `prepareRecordPath` 续号在并发下是否真不撞

逻辑正确但不原子：`existsSync` 检查与 `writeFileSync` 之间存在 TOCTOU 窗口，两个同毫秒请求可能选中同一路径后互相覆盖（`writeJson` 是覆盖写）。本轮 8 路并发没撞（`created` 毫秒不同），但这是**运气而非保证**。建议改成原子占位：`writeFileSync(path, data, { flag: "wx" })`，捕获 `EEXIST` 后换 `-2`/`-3` 重试——三行改动，同时把「只追加不覆盖」变成文件系统级保证。HTTP 作业面引入后并发是真实场景，值得现在改。

## 4. 其余 P3

- **P3-1（次序）**：HTTP `prepareViaHttp` 的 `normalizeAsOf` 在 `findMaterial`/`snapshotPath`/`schemaOf` **之后**（`verify-jobs.ts` 按 `material_id → candidates/reviews → findMaterial → snapshotPath → schemaOf → as_of` 顺序）。所以「缺材料 + 非法 as_of」报 404 而不是 400，与开发线回执里「在查 blob 之前校验」不符；CLI 侧确实先校验。建议把 as_of 归一挪到 candidates/reviews 检查之后、`findMaterial` 之前（用法错误先于 I/O，和 CLI 同一条纪律）。
- **P3-2（措辞）**：`docs/verify-contract.md:293` 与 CHANGELOG「不可变的 `prepare.json`」不准确——ready 重跑会覆盖 `prepare.json`（实测第二次 ready 以 v10 覆盖 v9，attempts 不变）。真正的约束是「失败尝试绝不覆盖已冻结的成功记录」。建议改成「同路径仅被后续成功冻结覆盖」，或若确实要求不可变则把文件名带版本。
- **P3-3（文档）**：`docs/verify-contract.md:293` 的 CLI `record` 示例写 `attempts/<ts>.json`，实际含 `specs/<id>/` 前缀（实测 `specs/spec_d79fb3eea29d/attempts/…`）。
- **P3-4（一致性）**：as_of 与引擎窗口比较的 ISO 偏移口径不一致（`+08` 前面已列）。
- **P3-5（既有，未变）**：`specDir` 不分版本、run 总读最新写入（0.102.1 已记 backlog），本轮无新增风险。

## 5. 建议（按性价比排序）

1. 修 P2-1 文档 + 加一条 CLI「照文档 → ready」正向测试（半小时）。
2. `normalizeAsOf` 严格化：拒无时区 datetime / 空格分隔 / 非 ISO / 非法日历；保留纯日期；±hh 与引擎对齐（一小时内含测试）。
3. HTTP 把 as_of 校验提到 `findMaterial` 之前（三行）。
4. `prepareRecordPath` 改 `flag:"wx"` 原子占位（三行 + 一条并发测试）。
5. 文档措辞：prepare.json 覆盖语义、record 路径前缀、attempts 投影字段说明。

## 6. 证据

- 探针：`tmp/r23-run.sh`、`tmp/r23-probe.cjs`（as_of 矩阵 12 例、attempts/record/draft、8 路并发、次序用例）；`tmp/r23home` 隔离 home。
- 门禁日志：`tmp/r23-unit.log`（70 文件 454 例）、`tmp/r23-contract.log`（100/100）、`tmp/r23-demo.log`、`tmp/r23-readme.log`（54/54）。
- 源码：`packages/ops/tools/src/verify-cmds.ts:79-87`（fileReviewer）、`:174-178`（prepareRecordPath）、`normalizeAsOf` 实现；`packages/ops/tools/src/verify-jobs.ts`（prepareViaHttp 次序）；`docs/verify-contract.md:147-148,293`；`docs/plan.md:348`。
