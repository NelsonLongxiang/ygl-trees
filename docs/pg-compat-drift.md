---
name: pg-compat-drift
description: PG 单写后端行为漂移登记册（B0 四护栏之②：发现→登记→统一口径，禁静默改）
kind: 参考
---

# PG 兼容行为漂移登记册

> 依据：`docs/reviews/pg-write-backend-plan.md` §B0 四条护栏之②——「行为漂移登记制：
> 发现 → 登记（本文件）→ 统一口径；禁静默改（digest 血统同族纪律）」。
> 任何 SQLite 与 PG 在同一输入下行为不同的地方，**必须在此登记**，不得在代码里静默分叉。

## 登记格式

| # | 发现时间 | 面 | SQLite 行为 | PG 行为（预期/实测） | 处置口径 | 状态 |
|---|---|---|---|---|---|---|

## 已登记项

| # | 发现时间 | 面 | SQLite 行为 | PG 行为 | 处置口径 | 状态 |
|---|---|---|---|---|---|---|
| 1 | 2026-10-25 | `AsyncOpsReads.runs()` 排序 | `ORDER BY started DESC`（runs 表列为 started/finished/rc，**无 created**） | 同 SQL（方言中立） | 统一按 `started` 排序；不得假设 `created` 存在 | 已修（#77） |
| 2 | 2026-10-25 | `relations` 源列 | 列名为 `src_type/src_id`（**无 `src`**） | 同 schema | facade 一律用 `src_id` | 已修（#77） |
| 3 | 2026-10-25 | `jobs` 名称列 | 列名为 `title/command`（**无 `name`**） | 同 schema | facade 一律用 `title` | 已修（#77） |
| 4 | 2026-10-25 | `patrol_findings` 时间列 | `first_seen/last_seen`（**无 `ts`**） | 同 schema | facade 一律用 `last_seen` | 已修（#77） |
| 5 | 2026-10-25 | `node_conditions` 归属列 | `node_id`（**无 tree_id/node_key**） | 同 schema | facade JOIN `nodes` 取 tree/key | 已修（#77） |
| 6 | 2026-10-25 | `date(ts)` 日粒度 | SQLite `date()` 函数 | PG **无** `date()`（有 `date_trunc`/`::date`） | facade 改用 `substr(ts,1,10)`（双端支持；ISO-8601 前缀即日期） | 已修（#77②） |
| 7 | 2026-10-25 | `datetime('now', '-N days')` | SQLite 相对时间函数 | PG 无此写法（`now() - interval`） | cutoff 在 JS 计算后作参数传入（`WHERE ts >= ?`） | 已修（#77②） |
| 8 | 2026-10-25 | `rowid` 排序 | SQLite 隐式 rowid | PG 无 rowid（需显式序列列） | `events` 用 `ts DESC`（有索引，等价排序） | 已修（#77②） |
| 9 | 2026-10-25 | 同步委托面 | 委托层直接调同步 `Store`/`TreeStore`（SQLite 同步 API） | PG 驱动全异步——同步调用无法到达 | `AsyncDb.dialect` 标记；非 sqlite 方言调用同步委托 **fail-closed 抛错**（`assertSyncDelegationAllowed`） | 已修（#77③） |

## 纪律

1. **新发现先登记再改码**——登记行含 SQLite/PG 双侧行为与处置口径；
2. **禁止静默改**——同一层行为分叉没有登记行，视为评审阻断项；
3. **口径统一后**——两边实现按登记口径走；若确需保留差异，写明理由与影响面；
4. 本文件随 B1–B6 各批更新；B6 门禁矩阵要求「行为漂移清单为空，或每条已登记」。
