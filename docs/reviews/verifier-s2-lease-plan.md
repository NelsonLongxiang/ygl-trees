# S2 租约设计单：claim / renew / release 与 `verify run --instance` 回交

> **状态：方案（design only），承接 #205 的 S2。本文不含实现，不新建表、不改 CLI。**
> 依据：`docs/reviews/verifier-scale-plan.md` §3（登记表）、§7（S2 验收判据）、§8 D1（S2 起切 PG）；
> 前置 S0（#206）与 S1（#207）已交付并在 0.121.0 复验。

## 1. 要解决什么

S0/S1 之后，实例与运行记录已在登记表里，但**同一实例可以被两个节点同时执行**：没有租约就没有互斥，
重复执行会产生两条互相矛盾的 run 记录，而「只追加不修改」的登记表无法自证哪条有效。S2 要给出：

1. 一个实例同一时刻只有一个执行者（互斥）；
2. 执行者失联时，另一个节点能接管（活性），且不丢历史（只追加）；
3. 跑完把报告交回登记表，**且只有当前租约持有者的回交才被接受**（防两个执行者先后回交）。

## 2. 数据模型

新增 `verifier_leases` 一张表，只有四个语义列（列名沿用 §3 的既定口径，不另造）：

| 列 | 语义 |
|---|---|
| `instance_id` | 被租实例，**主键（或唯一约束）**——互斥就是靠它 |
| `node` | 持有者节点标识（与 `YGL_SESSION`/`DSH_SESSION_ID` 同源口径） |
| `expires_at` | 到期时刻（UTC），到点即视为可被接管 |
| `claimed_at` | 本次领取时刻，用于诊断与「被接管」举证 |

**加表必须走九触点**（conventions §一）。本文不复制触点清单，避免与约定漂移；这里只声明该表在各触点上
必须满足的语义：SQLite 与 PG 两侧 DDL 同步落地、schema 版本随之升级、`db export/import` 能往返、
`verify meta` 能读到新版本、MCP/JSON 面只读可查。**不提前建 `verifier_packs`（S4 才建）。**

> 说明：`taken_over_from` 一类审计列**不在 S2 加**——租约是易失状态，历史由 run 记录承担；
> 接管证据用 `claimed_at` 与 run 记录的先后即可还原，避免为审计再加列。

## 3. 事务化租约服务

三条命令，全部是**单事务内的比较后写**，不是「先查再写」：

- `verify lease claim <instance> --ttl <s>`：仅当该实例**无租约或租约已过期**时写入成功；
  已有未过期租约 → **rc2**，输出当前持有者与到期时刻（不泄露包内容）。
- `verify lease renew <instance>`：仅当持有者是本节点且未过期时延长 `expires_at`；否则 rc2。
- `verify lease release <instance>`：仅当持有者是本节点时删除；已被接管 → rc2（不是静默成功）。

实现形态（两种后端同语义）：
```sql
-- SQLite / PG 同构：把判定压进一条语句，靠唯一键兜并发
INSERT INTO verifier_leases (instance_id, node, expires_at, claimed_at)
VALUES (?, ?, ?, ?)
ON CONFLICT (instance_id) DO UPDATE
  SET node = excluded.node, expires_at = excluded.expires_at, claimed_at = excluded.claimed_at
  WHERE verifier_leases.expires_at <= ?   -- 已过期才允许接管
RETURNING node;
```
返回 0 行即「没抢到」→ 命令层转 rc2。**不做 SELECT-then-INSERT**：那会在两节点并发时都读到
「无租约」而双写，正是本条要消除的缺陷。

**登记表不可用时 fail-closed**（§3 末条）：节点只能继续跑**已领取**的租约，不能新建实例、不能
claim 新租约、不能回交；宁可停也不分叉。

## 4. `verify run --instance` 的回交契约

跑完自动回交，沿用 `verify report import` 的同一套校验，**只追加不修改**。接受前逐项校验：

| # | 拒绝条件 | 结果 |
|---|---|---|
| R1 | 租约不存在 / 已过期 / 持有者不是本节点 | rc2，不写 run |
| R2 | 租约已被他人接管（`node` 已变） | rc2，**原执行者的回交被拒**，提示已被接管 |
| R3 | `payload_sha256` 与本地不符 | rc2，不写 run |
| R4 | 实例状态为 `retired` | rc2，不写 run |
| R5 | 归档缺失或校验失败 | rc2，不写 run |

**R2 是本设计的关键**：被接管的执行者即使跑完也不得写入——否则一次接管会留下两条「都声称是当前结果」
的记录。拒绝时把本次产物留在本地临时目录并打印路径，交人工判断，**不自动删除、不自动重试**。

成功路径：写 `verifier_runs`（`run_id`、`executor=node`、`payload_sha256`、`archive_sha256`、`judged_at`），
更新实例的 `last_run_id/last_verdict/last_judged_at`，然后释放租约；**释放失败不回滚 run**（run 是事实，
租约到期自然失效）。

## 5. 保留（retention）条款——必须在实现前明说

- 每实例保留：最近 K 次运行、**每次结论翻转的那一次**、**每个发布对应的那一次**；其余运行**只留 sha 指针**。
- 字节因内容寻址天然去重，删除只发生在「没有 keep-set 引用」时。
- **哈希只能证身份，不能还原内容**：一旦某次运行的字节按保留策略删除，事后只能用 sha 证明「当时是这份」，
  不能取回报告正文或归档。调用方若需要原件，必须在删除前把该 `run_id` 放进 keep-set。
- **keep-set 在删除前选定**：保留策略执行**前**先解析 keep-set（最近 K／翻转／发布），解析结果落库再删；
  不接受「先删后补」。默认 K 建议 20，随 S2 实测调整，但「删除前选定」不可省。

## 6. 验收判据（可执行）

1. 两个节点并发 `claim` 同一实例 → **恰好一个 rc0、一个 rc2**（重复 50 次不出现双成功）。
2. 租约过期后另一节点 `claim` → rc0，且能跑完回交。
3. 被接管后，**原执行者的回交被拒（R2）**，登记表 run 数不增加。
4. 回交报告的 `payload_sha256` 与本地一致；不一致时 rc2 且不写 run。
5. `db export/import` 对含租约的工作区往返后，互斥语义不变（导出可只导结构，租约视为易失）。
6. `pnpm test` 全绿；九触点各有对应测试。

## 7. 不做什么

- 不做跨实例的全局串行化（只保证单实例互斥）。
- 不做租约续期的心跳守护进程；`renew` 由执行者在跑动中显式调用。
- 不在 S2 引入 pack 表、不做 S3/S4 的解析执行。
- 不改「只追加不修改」的 run 记录语义。

## 8. 回滚

租约是易失状态：删除 `verifier_leases` 行或整表不影响既存实例与 run。CLI 三条命令可先以
「登记表无该表 → rc2 并提示需迁移」的方式软上线，待 schema 迁移随版本发布后再放开。

