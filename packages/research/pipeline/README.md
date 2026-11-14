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

## Scope keys

Schema v15 adds empty-default `scope` to notes and skills in SQLite and the explicit PG upgrade track. Add/import/ingest validate an exact market key; duplicates never change it. `kbRescope` selects by id and updates the grant plus an old/new event transactionally. Scope filters are applied before FTS ranking or list ordering; empty selects only unattributed rows, while omitted filters retain the prior list shape. Promotion copies scope, but ordinary skill upserts that omit it retain the existing grant.

## PG research writes (B8 batch 2)

`sourceAdd`, `evidenceAdd`, `claimAdd` and their batch variants share the existing transaction service and input validation. A batch is one transaction: bad input is rejected before business writes; runtime failure rolls back the entire batch. Source/evidence `ngram` and generated `ngram_tsv` commit with base rows and events. Claims has no fulltext surface in either backend; no extra search columns or migration are introduced. `source add --query` validates and attaches in the same PG transaction; query add/attach/list are available in batch 3; query done stays unavailable. Scoped list/show remain read-only.

## PG research loop (B8 batch 3)

Query upserts/attachments, claim mutations and protected removals use the same transaction manager as binding checks and events. Claim recomputation is shared: prediction preservation, arbitration lock, updated/recalculated and the duplicate-unresolve edge retain SQLite behavior. PG native event ties use monotonic seq; ambiguous historical NULL seq refuses and rolls back. Evidence fences precede claim row locks; removal locks affected claim ids in sorted order and removes only its exact reference cone. No eval call or automatic live arbitration is added. Command-required missing columns receive safe identifier-only diagnostics, never automatic schema changes.

Query attach uses one JSON receipt in both backends: `{query, source}`, with `duplicate: true` on repetition and rc0. Human success/duplicate lines remain unchanged without --json. The golden regression explicitly records the two repaired SQLite outputs against the legacy bytes; every other command stays byte-identical except the explicitly asserted additive evidence verification receipt described below.

## Stored quote verification

New evidence quotes are checked against stored nonempty source content with whitespace collapse/trim and exact, case-sensitive substring matching; no NFKC, fuzzy matching or fetch. Mismatch returns a source-named rc1 error and the transaction writes nothing. Successful matching receipts add `quote_verified:true`; empty original content is allowed but false. Explicit `--unverified` permits deliberate paraphrase/translation, returns false and records the bypass in the new `evidence.add` payload. `--force` never bypasses checking. SQLite and PG share this rule, including whole-batch rollback with physical JSONL line numbers.

Existing evidence is not retroactively checked: duplicate receipts preserve prior creation-event verification when known (legacy unknown=false), and do not rewrite evidence or append a second creation event. Quote verification is an add receipt, not a newly persisted column. New creation-event TEXT payloads contain versioned JSON objects (payload_version:1, evidence_id, source_id, quote excerpt, quote_verified, unverified); legacy plain quote strings remain untouched and are unknown=false. Generic event feeds and SQL export pass the text through; consumers must discriminate a JSON object from legacy strings before inspecting fields. The mismatch error is QuoteMismatchError in both backends, not PgCapabilityError. The SQLite golden fixture uses actual literal quote content and permits exactly the additive `quote_verified` field; all other output bytes remain compared to the pinned baseline.

## Prediction audit metrics

`measureCriterion` measures complete `key≥N` clauses, where `N` is a nonnegative safe integer. The reserved keys `树` and `kb` count all workspace trees and knowledge notes; other explicit keys bind to `--state` by exact key, then shallowest suffix. Whitespace around `≥` is optional. Multiple clauses may use whitespace-delimited ` 或 ` (any) or ` 且 ` (all), but not both operators in one criterion. Every clause must be recognized and measurable.

Subject-qualified prose such as `adoption 树 ≥4/6 叶节点解锁`, fractions, decimal thresholds, extra requirements or unknown clauses return `null` and project as `manual`; no workspace count is substituted for their intended subject. The registry probe likewise requires the complete `npm 再发≥N个版本` criterion. Audit leaves stored claim text/status/updated unchanged and never arbitrates or unlocks. Existing resolved predictions remain resolved in the projection.

## Prediction scores

`research predict list` adds `p`, `brier_calc` and `brier_mismatch`; the existing `brier` remains note-derived. Numeric confidence follows the existing decimal/percentage convention, while evidence grades A/B/C have no probability. Binary outcomes use `(p - outcome)^2`; ND/open rows never receive a computed score. A note/calculation discrepancy strictly greater than 0.005 is marked `≠` in the human list.

`research predict score [--all] [--channel <c>] --json` returns channel rows with `settled`, `nd`, `open`, `no_p`, `hit_rate`, and `brier_mean`. Default scope is the selected project; `--all` spans the workspace as list already does. `settled` counts every 1/0 outcome, but means use only the subset with numeric P. `no_p` counts missing probability regardless of status and can overlap ND/open/settled counts. Both means are null for an empty eligible subset. Computed scores, not handwritten notes, feed aggregates; claim/evidence records are never rewritten. Prediction commands preserve audit matching and claim calibration; the scoring projection is read-only.

## Further Exploration

- [docs/plan.md](../../docs/plan.md) — architecture decisions and version history
- [docs/conventions.md](../../docs/conventions.md) — data model conventions
