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

## Further Exploration

- [docs/plan.md](../../docs/plan.md) — architecture decisions and version history
- [docs/conventions.md](../../docs/conventions.md) — data model conventions
