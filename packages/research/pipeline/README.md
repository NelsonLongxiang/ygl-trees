---
description: "Research pipeline: query/source/evidence/claim entities, reads (Store), transactional writes, and Cordis ResearchService"
kind: "package-reference"
---

# @ygl/research-pipeline

Research pipeline: query/source/evidence/claim entities, reads (Store), transactional writes, and Cordis ResearchService

## Use this package

Import from `@ygl/research-pipeline` when you need research pipeline: query/source/evidence/claim entities, reads (store), transactional writes, and cordis researchservice.

## PG transactional writes (B8 batch 1)

`kbAdd` and `projectCreate` use the same `runTx` boundary on PG. `INSERT ... ON CONFLICT ... RETURNING` arbitrates concurrent duplicates; any lookup uses the transaction manager, not another client. Knowledge search input (`ngram`), the generated `ngram_tsv`, base rows and audit events commit or roll back together. Project selection uses only `current_project@<session>` (never the global pointer). Ordinary duplicates keep rc0; forced knowledge copies reuse contentHash(..., true) salts (the migrated PG column is NOT NULL). SQLite SQL and receipt shapes are retained.

## PG research writes (B8 batch 2)

`sourceAdd`, `evidenceAdd`, `claimAdd` and their batch variants share the existing transaction service and input validation. A batch is one transaction: bad input is rejected before business writes; runtime failure rolls back the entire batch. Source/evidence `ngram` and generated `ngram_tsv` commit with base rows and events. Claims has no fulltext surface in either backend; no extra search columns or migration are introduced. `source add --query` validates and attaches in the same PG transaction; query add/attach/list are available in batch 3; query done stays unavailable. Scoped list/show remain read-only.

## PG research loop (B8 batch 3)

Query upserts/attachments, claim mutations and protected removals use the same transaction manager as binding checks and events. Claim recomputation is shared: prediction preservation, arbitration lock, updated/recalculated and the duplicate-unresolve edge retain SQLite behavior. PG native event ties use monotonic seq; ambiguous historical NULL seq refuses and rolls back. Evidence fences precede claim row locks; removal locks affected claim ids in sorted order and removes only its exact reference cone. No eval call or automatic live arbitration is added. Command-required missing columns receive safe identifier-only diagnostics, never automatic schema changes.

Query attach uses one JSON receipt in both backends: `{query, source}`, with `duplicate: true` on repetition and rc0. Human success/duplicate lines remain unchanged without --json. The golden regression explicitly records the two repaired SQLite outputs against the legacy bytes; every other command stays byte-identical.

## Prediction audit metrics

`measureCriterion` measures complete `key≥N` clauses, where `N` is a nonnegative safe integer. The reserved keys `树` and `kb` count all workspace trees and knowledge notes; other explicit keys bind to `--state` by exact key, then shallowest suffix. Whitespace around `≥` is optional. Multiple clauses may use whitespace-delimited ` 或 ` (any) or ` 且 ` (all), but not both operators in one criterion. Every clause must be recognized and measurable.

Subject-qualified prose such as `adoption 树 ≥4/6 叶节点解锁`, fractions, decimal thresholds, extra requirements or unknown clauses return `null` and project as `manual`; no workspace count is substituted for their intended subject. The registry probe likewise requires the complete `npm 再发≥N个版本` criterion. Audit leaves stored claim text/status/updated unchanged and never arbitrates or unlocks. Existing resolved predictions remain resolved in the projection.

## Further Exploration

- [docs/plan.md](../../docs/plan.md) — architecture decisions and version history
- [docs/conventions.md](../../docs/conventions.md) — data model conventions
