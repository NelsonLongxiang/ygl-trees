---
name: mutation-pins
description: G5 关键测试变异校验——钉测清单、已记录变异与预期红（roadmap #96 条目 4）
kind: 参考
---

# 变异钉清单（G5）

> 纪律：钉住关键行为的测试，要能证明**删掉/改坏被钉的那一行时测试变红**。
> 每钉登记：被钉物 · 所在测试 · 已记录变异 · 预期红 · 复现命令。

## 钉 1：#92 事后补登拒绝（结构式核验）

- **被钉物**：`scripts/meta-tooling.mjs` silent-rehash 的提交时刻账本核验（`chainedOn(ledgerAt(atCommit), ...)`）
- **所在测试**：`packages/ops/tools/tests/meta-audit.spec.ts` →「#92: 事后补登的 reregistration 不被接受」
- **已记录变异**：把 K 时刻账本改为工作区账本（`ledgerAt(atCommit)` → `rr`）→ 补登夹具 rc0 → 该测试红
- **复现**：改后 `npx vitest run packages/ops/tools/tests/meta-audit.spec.ts` → #92 用例 fail

## 钉 2：#93 矩阵 PG 腿 pg-stats 步（真连 PG）

- **被钉物**：`scripts/dual-backend-matrix.mjs` PG 腿的 `["pg-stats", ...]` 行（含 `YGL_DB_URL: pgUrl` env）
- **所在测试**：`packages/ops/tools/tests/b7-cli-pg-boot.spec.ts` →「矩阵 PG 腿步骤清单钉」（env 断言绑定 pg-stats 行本身）
- **已记录变异**：删掉 pg-stats 行（评审席变异测试实证，comment 6432118514）→ 钉测红
- **复现**：删除该行 → `npx vitest run packages/ops/tools/tests/b7-cli-pg-boot.spec.ts` → 清单钉 fail

## 钉 3：#91 lastFlagOf 末位胜

- **被钉物**：`packages/core/database/src/types.ts` `lastFlagOf`（MULTI_FLAGS 数组取末位）
- **所在测试**：`packages/research/pipeline/tests/batch-jsonl.spec.ts` →「#91: repeated --db keeps last-wins」（#96 复核更正：原写 ops/tools 路径有误）
- **已记录变异**：取首位代替末位（`v[v.length-1]` → `v[0]`）→ db stats 对不可达首库报错 → 钉测红
- **复现**：改后钉测 fail（rc≠0）
