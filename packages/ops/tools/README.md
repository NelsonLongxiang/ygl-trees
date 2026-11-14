---
description: "Operational tools: config registry, PG sync/migrate, db/job/agent/config CLI handlers"
kind: "package-reference"
---

# @ygl/ops-tools

Operational tools: config registry, PG sync/migrate, db/job/agent/config CLI handlers

## Use this package

Import from `@ygl/ops-tools` when you need operational tools: config registry, pg sync/migrate, db/job/agent/config cli handlers.

## Agent brief selection

`agent brief -p <project>` and `--project <project>` use the same resolved selection for admission and payload construction. Explicit selection overrides environment/session pointers without changing them; missing projects return rc1. The multi-project strict gate remains rc2. `buildBrief(env)` keeps its ungated default for dashboard callers.

## MCP routing and request environment

MCP write maps kb add to `--title` plus exactly one body/file source, rel attach to `rel add node:<ref> <typed-target> --rel <type>`, and node-cond to explicit op/value and the existing condition flags. Node can/ready/node-unlock forward a named `context`; can/ready accept the CLI state string. No new lock/path/unlock-enforcement behavior is added.

HTTP MCP snapshots its startup environment and derives a separate child environment per request. `X-YGL-Session` overrides only that request; absent headers use the startup session. The handler never assigns process.env. Legitimate PG credentials remain in the controlled child environment, not argv, JSON or diagnostics; request isolation and argv safety are separate checks.

## Scope-filtered knowledge

MCP `read kb list/search`, `read skill list` and `read library list` (note/skill) forward an exact `scope`. Omitted leaves the list unfiltered; empty remains an explicit unattributed filter. `write kb add/ingest/rescope` use the same syntax validation and exit categories as the CLI. Library responses omit empty scope rather than presenting it as public, and cursors are bound to the selected kind, scope and since filter.

## Verifier HTTP lists

`verify-list` queries the derived `verify/.list-index.sqlite` summary index by spec and stable cursor. Report/archive pages return `items/total/next_cursor`, default200/max500. The server prepares/reconciles legacy files before readiness, not on an HTTP list request. Official report/sidecar writes update summaries; filename watchers maintain external changes without periodic whole-directory stat scans. Source JSON remains authoritative; no business schema/export/migration changes. Preparation refreshes every source record when the cache format is missing or outdated, even if file stamps are unchanged; the format key is published only after reconciliation finishes. Use `firstReportPage/firstArchivePage` for at most200rows; use page APIs for cursors. Changing/incomplete source records remain pending; stable invalid JSON or mismatched records are recorded in the derived `excluded` table with kind/id/stamp/reason and omitted without failing usable lists. Valid rewrites remove the exclusion. Missing/corrupt SQLite index or watcher IO faults remain explicit failures, never an implicit list-time full scan. Close waits for watchers and preparation to finish.

## Tree group archive projection

Tree group reports use ordinary four-value VUs: tree-only `STALE`, `INFRA_BLOCKED` and `NEUTRALIZED` project to `ERROR`. Their summary and overall share the archive verifier’s existing `foldSummary`/`foldOverall` implementation. The tree envelope retains its original five-value verdict, leaf `report_verdict` is unchanged, and business FAIL keeps its precedence. Old report/archive bytes are never rewritten; inconsistent historical archives still fail verification.

## Verifier CLI list counts

`verify list` counts every report for each spec while reading the latest report without removing it from the in-memory list. `last_run` and `last_overall` keep the existing finished-time ordering and stable file-order tie behavior; no-report rows return zero runs and empty latest fields. Listing does not rewrite spec/report bytes. The CLI count fix does not change the HTTP paging/index contract.

## Verifier engine provenance

CLI and HTTP prepare/run, and newly executed tree leaves, pass the running application `env.version` to the verifier, matching tree G8. A frozen spec records its preparing engine while each new report records its executing engine; running a legacy spec does not rewrite its original version or earlier reports. Archives retain and verify the report version. The standalone verify-core library and deterministic corpus keep their own0.1.0 default; an embedding application should inject its version. This change does not migrate frozen specs, add provenance flags, change as_of or enforce reviewer independence.

`verify prepare` (CLI `--as-of`, HTTP `as_of`) requires an explicit as_of unless it is a draft (#171). Without one the CLI returns rc 2 and HTTP returns 400, before any I/O. as_of is the moment the snapshot describes, not the freeze time, so the same material prepared later or on another machine freezes the same spec.

## Prepare author trace

CLI prepare accepts `--candidates-author <id>` and `--reviews-author <id>`; a flag without its value is rc2 before workspace I/O. Without flags, authors use `YGL_SESSION`, then `DSH_SESSION_ID`, then `cli`. HTTP prepare accepts `candidates_author` and `reviews_author` (source `body`); omitted values use the serve session identity, or `http` when unavailable (source `http`). Both paths include authors in their JSON response, prepare record and frozen trace. Equal author ids add a non-blocking `P3a` diagnostic; self-reported ids are provenance, not authenticated proof of reviewer independence.

## Measurement producer provenance

`verify run` and `verify tree run` accept `--provenance <file.json>`; HTTP run accepts the same object as `provenance`. Supply `probe_sha256`, `platform`, `runtime`, `package_manager` (including version), and a non-secret role/session `identity`. No host credentials or environment variables are collected. Fields are caller assertions, not authenticated evidence.

Reports and archives retain the normalized `data_source.producer` and a `data_source.provenance` comparison. The first integrity-valid measured report for the same frozen spec version is the stable baseline; subsequent changes, including omission after a measured baseline, remain `changed` until the original producer is restored or a new spec version is prepared. Tree leaves project changed provenance to `STALE`, which propagates to ancestors; intrinsic VU verdicts are retained. Existing histories without any producer keep their legacy shape. No historical report bytes are rewritten.

## Further Exploration

- [docs/plan.md](../../docs/plan.md) — architecture decisions and version history
- [docs/conventions.md](../../docs/conventions.md) — data model conventions
