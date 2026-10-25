---
name: ygl-cost-collection
description: ygl-trees 侧 cost 采集点提案（cost-governance 晨链快照的 ygl 段）——events 表 ygl_*/CLI 调用计数、不含 token
kind: 参考
---

# ygl-trees 侧 cost 采集点（cost-governance 快照 · ygl 段）

> 分工：**本段** = ygl-trees 工作区的调用/成本可观测面（events 表）；
> **宿主段** = token/网关侧（另由监督席/宿主席出）。两段拼合 = 晨链 cost 快照步。

## 1. 现成数据面（无需新埋点，B0 零改动）

`events` 表已记录每次 CLI 命令运行（`cmd.run`），payload 是自描述 JSON：

```json
{"run":"mvnkfi0fdae5","group":"db","action":"init","rc":0,"duration_ms":41,"session":"ygl-session-dev"}
```

| 字段 | 成本语义 |
|---|---|
| `group` + `action` | 调用面（哪类操作：research/tree/verify/db…） |
| `rc` | 成功/失败（失败调用也是成本——重试面） |
| `duration_ms` | 时长成本（引擎侧，不含模型） |
| `session` | 调用归属（哪条 agent 会话） |
| `ts` / `actor` | 时间窗 / 发起者 |

**MCP 调用可区分**：`ygl-trees mcp` 派生的 CLI 子进程带 `YGL_SERVE=1` + `YGL_MCP_CHILD=1`，
其 `cmd.run` 事件与直连 CLI 可区分（如需显式标记，B0 可在 payload 增加 `surface:"mcp"|"cli"`）。

## 2. 快照采集设计（一条 SQL，晨链跑）

```sql
-- 日成本快照（按 session × group × rc 聚合）
SELECT
  substr(ts,1,10)                                   AS day,
  json_extract(payload,'$.session')                 AS session,
  entity                                            AS "group",
  json_extract(payload,'$.rc')                      AS rc,
  COUNT(*)                                          AS calls,
  SUM(json_extract(payload,'$.duration_ms'))        AS engine_ms
FROM events
WHERE kind='cmd.run' AND ts >= :window_start
GROUP BY day, session, entity, rc
ORDER BY day DESC, calls DESC;
```

- `:window_start` = 晨链当日 0 点（或滚动 24h）
- SQLite 用 `json_extract`；PG 用 `payload::jsonb->>'session'` —— **方言差异登记进 `docs/pg-compat-drift.md`**
- 该 SQL 只读 `events` 表（不碰业务表），可安全在晨链每周/每日跑

## 3. 快照产物形状（供宿主段合并）

```json
{
  "backend": "ygl-trees",
  "window": {"start": "2026-10-25T00:00:00Z", "end": "2026-10-25T23:59:59Z"},
  "calls": {"total": 1234, "by_group": {...}, "by_session": {...}, "failed": 12},
  "engine_ms": {"total": 45678, "p50": 41, "p95": 2200},
  "notes": "不含 token（LLM 侧由宿主段采集）"
}
```

## 4. 边界（明确不做什么）

- **不含 token**：ygl-trees 不接触 LLM 调用；token 计数在网关/D SH 宿主侧
- **不新埋点**（B0）：现有 `cmd.run` 已够；`surface` 标记是可选的增量
- **不做全局聚合**：各 workspace 的 `$YGL_HOME` 各自独立——晨链只读**本机工作区**（多 workspace 需逐个跑）
- **历史数据**：`cmd.run` 从 0.7x 起有——窗口内无事件 = 0 调用（不是缺失）

## 5. 落地步骤（宿主段拼合后）

1. 晨链加第 0 步：`db sql "<快照 SQL>" --json > tmp/cost-ygl-$(date +%F).json`
2. 宿主段产出 `cost-host-*.json`
3. 拼合器（宿主侧）合并两份 → 晨链简报一行「call 成本 / token 成本」
