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

Query attach is an explicit output exception: the existing SQLite successful --json path emits human text, unchanged here; PG returns a single object. Cross-backend success-output parity is not claimed for that face.

## Further Exploration

- [docs/plan.md](../../docs/plan.md) — architecture decisions and version history
- [docs/conventions.md](../../docs/conventions.md) — data model conventions
