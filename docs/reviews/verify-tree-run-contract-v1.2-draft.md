---
name: verify-tree-run-contract-v1.2-draft
description: A1 tree run 契约 v1.2 草案（吸收 fdc/K3 九缺口，待属主单次过手裁 Q1-Q7）
kind: 草案
---

# 递归验证器契约 v1.2 · 草案（待属主裁定）

> 来源：fdc757f6 × 302cb119 两席《tree run 契约裁定处置行动方案》Phase 1（2026-10-23）。
> 状态：**草案**。v1.1 为 relayed-order 实现（无属主落章，见 `verify-tree-run-contract.md` §0.1/0.2）；
> 本草案把九缺口逐项做成**可勾选裁定项**，交属主单次过手裁 Q1–Q7（含本草案新增 Q8–Q14）。
> 裁定前冻结线生效：不实现本草案任何未勾选语义。

## 0. 九缺口处置总览

| # | 缺口 | 本草案处置 | 需属主裁 |
|---|---|---|---|
| G1 | 同主体真绑定 | 新增 `target` 契约 + 全叶 data_source 一致 + V22 失配行 | **Q8** subject 定义 |
| G2 | stale 谓词 | 三候选（round_id 不同/时钟域外/超 N 轮）+ 聚合影响 | **Q9** 选一 |
| G3 | ERROR 单一规则 | 候选 A（ERROR 不否决 PASS，v1.1）vs B（any ERROR→至多 INFRA_BLOCKED，#59） | **Q10** 二选一 |
| G4 | rc 映射 | 逐失败类唯一映射表（rc0/1/2；判定面一律 0） | 默认通过 |
| G5 | 幂等键自相矛盾 | 删「幂等同轮」声明；幂等只保留 prepare；run 去重改 archive 引用 | **Q11** |
| G6 | V17 同轮自引用 | 移到 run 期（prepare 无法知道本轮 id）或重定义为「pinned 必须来自已完成 run」 | **Q12** |
| G7 | V8 跨 workspace 信任根 | 候选 A 仅同 workspace；B 外钥登记表（keyid+fingerprint+来源） | **Q13** |
| G8 | tree spec pin + canonical digest | spec 冻结 engine/corpus/contract；`verdict_digest` 用 **JCS(RFC 8785)** 序列化 | 默认通过（对齐既有 canonical） |
| G9 | 次要九项 | 附件 A：V13/Q4/meta 覆盖/fleet --db 投影等 | 附件勾选 |

## 1. G1 同主体真绑定（Q8）

**问题**：v1.1 的「同主体查重」只对 canonical tree 幂等，没有定义「主体」；不同 target（库/快照/租户）可用同一 tree 得到不可比的判定。
**草案文本**：

- tree spec 增可选 `target`：`{kind: "sqlite"|"workspace"|"tenant", id: string, sha256?: string}`；
  `run --target <id>` 可覆盖但必须与每叶 `data_source` 投影**一致**（kind+id+sha256）。
- 每个叶 report 的 `data_source` 必须落进 tree spec 的 `target` 命名空间；全叶不一致 → 该组 `INFRA_BLOCKED`，
  V22 行点名失配叶。
- `subject` 定义（**裁定项**）：候选 a) `target`（库/租户）；b) `target + tree_spec_sha256`；
  c) `target + 叶 spec 集合`。推荐 **a**，因为树结构变化仍属同一主体，判定可比性由 target 保证。
- 幂等：同 subject + 同 canonical tree → 可复用 prepare 产物；subject 变化 → 必须新 prepare。

## 2. G2 stale 谓词（Q9）

**候选**：

| 候选 | 定义 | 优点 | 缺点 |
|---|---|---|---|
| A | `stale = pinned.round_id 与本轮 round_id 不同` | 机械、零时钟 | 跨 workspace 的旧 run 无 round 可比 |
| B | `stale = |now - pinned.created| > clock_domain_window`（窗口默认 24h） | 直观 | 时钟域/机器差，违反「时钟不进判定」 |
| C | `stale = 本树已跑过 N 轮且 pinned 不在最近 N 轮`（N 默认 5） | 与轮次语义一致 | 需要轮次存储/查询 |

**推荐 C**（round 计数属于既有 events/归档链，不引入墙钟）；`stale` 只在**审计面**标注，不改变节点 verdict；
聚合影响：stale 叶按 pinned 判定参与聚合，但根报告带 `stale_nodes: [...]`，且 `verdict_digest` **包含** stale 标记
（否则 stale 变化不影响 digest，可比性失真）。

## 3. G3 ERROR 单一规则（Q10）

- **候选 A（v1.1 现行）**：ERROR 不入聚合；NEUTRALIZED→FAIL→PASS→全 ERROR=INFRA_BLOCKED；有 FAIL 则 FAIL，
  ERROR 不否决 PASS。
- **候选 B（#59）**：任一 ERROR → 根至多 `INFRA_BLOCKED`（不可能是 PASS/FAIL）。

**推荐 B**（更保守，符合「基础设施故障不得被判定覆盖」；代价是部分 PASS 会被 infra 阻塞）。
若选 B，V15 矩阵重写：`any ERROR → INFRA_BLOCKED`（除非 NEUTRALIZED 优先），JSON enum 增 `ERROR` 节点值；
rc 仍 0（判定面）。**这是本次唯一会改变已实现行为的裁定**，需属主明确勾选。

## 4. G4 rc 逐失败类映射（默认通过）

| 类 | rc | 例 |
|---|---|---|
| 执行完成（含 FAIL/NEUTRALIZED/INFRA_BLOCKED） | 0 | 正常跑完 |
| 基础设施自身故障（快照不可读/进程错） | 1 | `--db` 不存在 |
| 用法/冻结错误 | 2 | 缺参、环、未知算子、空组、超深度、未知 pinned 目标、pinned 验签失败（prepare 期） |
| run 期归档验签失败 | 0（判定面 NEUTRALIZED） | 篡改 pinned 归档 |

与 v1.1 §3.3 一致；本草案只补「run 期 pinned 未登记 → rc2」与「pinned 归档 zip_sha256 不匹配 → prepare rc2」。

## 5. G5 幂等键（Q11）

**矛盾**：v1.1 说「幂等键 = 轮次 id + spec digest」，但轮次 id 是运行期生成，不可能幂等。
**推荐**：删除 run 幂等声明；**仅 prepare 幂等**（同 canonical tree → 同 `tree_spec_id`，V20）。
run 去重只做「同 tree_spec + 同 pinned/输入 digest → 可复用归档引用」，不承诺同 `tree_run_id`；
`round_id` 仍由 CLI 生成（Q3），不参与幂等。

## 6. G6 V17 同轮自引用（Q12）

prepare 期无法知道本轮 id，故「pinned 指向本轮产物」不可能在 prepare 判。
**候选**：A）移到 run 期：pinned 的 archive `created/round_id` 必须早于本轮 `started_at`，否则 rc2；
B）重定义为「pinned 必须来自已完成的 run（registry 存在 + 验签通过）」，v1.1 已有该语义。
**推荐 B**（与现有实现一致，且不引入时钟比较）；在 v1.2 删除 V17 的「prepare 期」表述。

## 7. G7 V8 跨 workspace 信任根（Q13）

- **候选 A**：pinned 只接受**本 workspace** registry 中的归档（U8 当前实现的自然边界）。
- **候选 B**：外钥登记表 `keys.json`（keyid + fingerprint + 来源），跨 workspace 归档需 keyid 在白名单；
  未登记 → rc2/NEUTRALIZED。
**推荐 A（v1.2 冻结）**，B 作为 v1.3 扩展；理由：跨 workspace 引入密钥分发/吊销，超出当前单工作区威胁模型。

## 8. G8 tree spec pin + canonical digest（默认通过）

- tree spec 冻结 `engine_version`、`corpus_version`、`contract_version`（与叶 spec 同纪律）；
  run 时与引擎实况不一致 → 拒跑（rc2）。
- `verdict_digest` 用 **JCS（RFC 8785）** 对判定投影做 canonical 序列化后再 sha256（与
  `packages/verify/core/src/canonical.ts` 同一实现），禁止 `JSON.stringify` 默认键序；字段集合固定：
  `tree_spec_sha256`、`root`、`nodes[{id,verdict,aggregate?,pinned?,stale?}]`、`pinned`。
- `audit`/archive 字节/时钟/主机**不进** digest（与 v1.1 R-1 一致）。

## 9. G9 次要项（附件 A，勾选）

| 项 | 内容 | 建议 |
|---|---|---|
| V13 取代 | tree spec 修改走取代记录（old/new digest + 理由），旧 run 仍可验 | 接 |
| Q4 ratchet | tree-run 耗时成为 ratchet 第四轴（4 层 × 64 叶） | 接（显式 `--write` 认账） |
| meta 覆盖 | tree spec 材料仍走 meta gate（submit 已覆盖；prepare/run 不重复 gate） | 文档明确 |
| fleet --db 投影 | `--db node=path` 支持 glob/批量映射（舰队五仓） | 缓（先单叶绑定） |
| JSON enum | 节点 verdict 增 `ERROR`（若选 G3-B） | 随 Q10 |
| V13 取代测试 | 取代链正负例 | 接 |
| 深度上限 | 16（Q7）不变 | 接 |
| 空组 | rc2（Q6）不变 | 接 |
| 事件 | prepare/run/node/archive 只增；`verify.tree.node` 每层 | 接 |

## 10. 待属主勾选清单（单次过手）

| # | 问题 | 推荐 |
|---|---|---|
| Q8 | subject 定义 | **a) target** |
| Q9 | stale 谓词 | **C) 最近 N 轮** |
| Q10 | ERROR 规则 | **B) any ERROR→至多 INFRA_BLOCKED**（唯一改行为的裁定） |
| Q11 | 幂等键 | 删 run 幂等，只保留 prepare |
| Q12 | V17 | B) pinned 必须来自已完成 run |
| Q13 | V8 信任根 | A) 仅本 workspace |
| G8 | JCS digest | 通过 |
| G9 | 附件 A | 逐项勾选 |

裁定落章后：v1.2 冻结 → Phase 2 按对照表绿行探针会签 → 补齐/返工（G1/G2/G3 两点误吸收）→ 0.115.0 收口。

## 11. 实现现状披露（Phase 1.3）

| 版本 | commit | 已实现（relayed-order） | 与 v1.2 草案的偏差 |
|---|---|---|---|
| 0.114.17 | `6f51d78` | tree prepare：leaf spec 存在/组非空/算子封闭集/环/悬空/深度 16/pinned 形状 | pinned 只校验形状，未验签（0.114.18 修） |
| 0.114.18 | `843038c` | pinned 冻结走 registry+`verify archive verify`（zip_sha256 全链）；聚合解析器拒绝畸形；V20 幂等 | 同主体无 target 定义（G1）；stale 未实现（G2） |
| 0.114.19 | `8313276` | tree run/report/trace；叶真实 run+archive；四态矩阵；`--db node=path`；verdict_digest 判定投影 | digest 用 `JSON.stringify` 排序近似，未 JCS（G8）；ERROR 规则为候选 A（G3-Q10）；幂等声明仍含 run（G5-Q11） |
| 0.114.20 | `9a422ed`/`5def585` | 组层 report+archive（skipMaterials）；V6 NEUTRALIZED；tree-fixture | 组 report 用合成 spec，跨 workspace 信任根未定（G7-Q13） |
| 0.114.21 | `5136c3a` | R6 meta（与本契约无关，engine 档扩展不冲突） | — |
| 0.114.22 | `23fbe87` | K3 选择观测（与本契约无关） | — |

**已知误吸收（先落码锁定、待裁定返工）**：

1. **同主体**：0.114.18–0.114.20 的「同主体」只实现为 canonical tree 幂等，没有 target/data_source 绑定（G1/Q8）；
2. **stale**：V4 的 stale 在 tree run 中**恒 false**，未实现判据（G2/Q9）；
3. **ERROR 规则**：实现按 v1.1 候选 A（ERROR 不否决 PASS），若 Q10 选 B 需改聚合与 JSON enum（G3/Q10）；
4. **幂等**：prepare 幂等已实现；run 的「轮次 id + spec digest」幂等声明未实现且自相矛盾（G5/Q11）；
5. **V17**：prepare 期不能判断同轮，当前只在 pinned 验签层兜底（G6/Q12）；
6. **V8**：跨 workspace 归档目前按本 workspace registry 解析，未定义外来钥信任根（G7/Q13）；
7. **JCS**：`verdict_digest` 当前是排序键的 `JSON.stringify`，未走 `canonical.ts` 的 JCS（G8）。

冻结线（§0.2）期间：以上 1/2/3/5/6/7 不再新增实现；仅允许 P1/P2 修复、测试、文档订正。
