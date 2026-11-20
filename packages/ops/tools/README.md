---
description: "Operational tools: config registry, PG sync/migrate, db/job/agent/config CLI handlers"
kind: "package-reference"
---

# @ygl/ops-tools

Operational tools: config registry, PG sync/migrate, db/job/agent/config CLI handlers

## Use this package

Import from `@ygl/ops-tools` when you need operational tools: config registry, pg sync/migrate, db/job/agent/config cli handlers.

## Configuration ownership

The registry and pure readers live in core/database; this package retains `configSet/configReset`, audit events, secret masking and export filtering. Existing reader exports from `src/config.ts` and the package entry remain transition-compatible re-exports of the same functions and registry, not a second source of defaults. Domain packages depend on core/database rather than importing ops for configuration.

## Agent brief selection

`agent brief -p <project>` and `--project <project>` use the same resolved selection for admission and payload construction. Explicit selection overrides environment/session pointers without changing them; missing projects return rc1. The multi-project strict gate remains rc2. `buildBrief(env)` keeps its ungated default for dashboard callers.

## MCP routing and request environment

MCP write maps kb add to `--title` plus exactly one body/file source, rel attach to `rel add node:<ref> <typed-target> --rel <type>`, and node-cond to explicit op/value and the existing condition flags. Node can/ready/node-unlock forward a named `context`; can/ready accept the CLI state string. No new lock/path/unlock-enforcement behavior is added.

HTTP MCP snapshots its startup environment and derives a separate child environment per request. `X-YGL-Session` overrides only that request; absent headers use the startup session. The handler never assigns process.env. Legitimate PG credentials remain in the controlled child environment, not argv, JSON or diagnostics; request isolation and argv safety are separate checks.

## Library project filtering

`library list --kind claim --project <name>` filters by the exact project name before totals and paging; an unknown name returns the unchanged `ygl-library/1` empty page with rc0. Omitting the flag lists all projects, independent of session selection. Bare, empty and whitespace-only values return rc2. `note`, promoted `skill` and `check` have no authoritative project ownership, so a project filter returns rc2 naming the kind; scope grants and relations are not inferred as ownership. Cursors remain bound to kind, since, scope and project. MCP `read {domain:"library", action:"list", kind:"claim", project:"<name>"}` forwards the same value without turning flag-like names into options.

## Scope-filtered knowledge

MCP `read kb list/search`, `read skill list` and `read library list` (claim/note/skill) forward an exact `scope`. Omitted leaves the list unfiltered; empty selects unattributed rows. `write claim-add/claim-rescope` and `write kb add/ingest/rescope` share CLI syntax and exit categories. Claim rows always carry scope, including empty; note/skill projections keep their existing omission of empty scope. Cursors bind the selected kind, scope, since and project filters. SQL exports and replay preserve claims.scope; fresh PG migration, explicit v15→v16 upgrade and refresh of existing claim mirrors retain the column and default.

## Verifier HTTP lists

`verify-list` queries the derived `verify/.list-index.sqlite` summary index by spec and stable cursor. Report/archive pages return `items/total/next_cursor`, default200/max500. The server prepares/reconciles legacy files before readiness, not on an HTTP list request. Official report/sidecar writes update summaries; filename watchers maintain external changes without periodic whole-directory stat scans. Source JSON remains authoritative; no business schema/export/migration changes. Preparation refreshes every source record when the cache format is missing or outdated, even if file stamps are unchanged; the format key is published only after reconciliation finishes. Use `firstReportPage/firstArchivePage` for at most200rows; use page APIs for cursors. Changing/incomplete source records remain pending; stable invalid JSON or mismatched records are recorded in the derived `excluded` table with kind/id/stamp/reason and omitted without failing usable lists. Valid rewrites remove the exclusion. Missing/corrupt SQLite index or watcher IO faults remain explicit failures, never an implicit list-time full scan. Close waits for watchers and preparation to finish.

## Tree group archive projection

Tree group reports use ordinary four-value VUs: tree-only `STALE`, `INFRA_BLOCKED` and `NEUTRALIZED` project to `ERROR`. Their summary and overall share the archive verifier’s existing `foldSummary`/`foldOverall` implementation. The tree envelope retains its original five-value verdict, leaf `report_verdict` is unchanged, and business FAIL keeps its precedence. Old report/archive bytes are never rewritten; inconsistent historical archives still fail verification.

## Verifier CLI list counts

`verify list` counts every report for each spec while reading the latest report without removing it from the in-memory list. `last_run` and `last_overall` keep the existing finished-time ordering and stable file-order tie behavior; no-report rows return zero runs and empty latest fields. Listing does not rewrite spec/report bytes. The CLI count fix does not change the HTTP paging/index contract.

## Imported report artifact identifiers

`verify report import` treats supplied `run_id` and `spec_id` as artifact identifiers, not paths: present values use 1–128 ASCII letters, digits, `_` or `-`. A supplied nonempty `verifier.binary_sha256` must be 64 hexadecimal digits with an optional `sha256:` prefix. Invalid values return rc1 with `{imported:false, problems}` before registration lookup, embedded-spec restoration or report writes. Missing/null run IDs keep the existing content-derived filename fallback. Normal payload/build/version/signature checks remain required. This input boundary does not make legacy report import append-only or provide lease authorization; an S2 hand-back needs its own accepted-run identity and transaction.

## WebUI shutdown and verifier output ownership

- `webui serve` 按每条连接的未完成响应跟踪停机，不依赖 Node 18 各版本不一致的 parser-idle 分类或 `closeIdleConnections` API。停止接纳后，无未完成响应的连接经 `destroySoon()` 排空写缓冲后关闭；活跃 HTTP 响应（含流水线）完成后才结束其连接，SSE 先结束流，再排空实际业务工作。半关闭或中途断连的客户端不改变已接纳工作的依赖排空次序。
- `refuseMeta` 的 JSON 拒绝面走 `emitJson`，与受管 invocation 的单对象结果边界一致。

## Verifier engine provenance

CLI and HTTP prepare/run, and newly executed tree leaves, pass the running application `env.version` to the verifier, matching tree G8. A frozen spec records its preparing engine while each new report records its executing engine; running a legacy spec does not rewrite its original version or earlier reports. Archives retain and verify the report version. The standalone verify-core library and deterministic corpus keep their own0.1.0 default; an embedding application should inject its version. This change does not migrate frozen specs, add provenance flags, change as_of or enforce reviewer independence.

`verify prepare` (CLI `--as-of`, HTTP `as_of`) requires an explicit as_of unless it is a draft (#171). Without one the CLI returns rc 2 and HTTP returns 400, before any I/O. as_of is the moment the snapshot describes, not the freeze time, so the same material prepared later or on another machine freezes the same spec.

## Prepare author trace

CLI prepare accepts `--candidates-author <id>` and `--reviews-author <id>`; a flag without its value is rc2 before workspace I/O. Without flags, authors use `YGL_SESSION`, then `DSH_SESSION_ID`, then `cli`. HTTP prepare accepts `candidates_author` and `reviews_author` (source `body`); omitted values use the serve session identity, or `http` when unavailable (source `http`). Both paths include authors in their JSON response, prepare record and frozen trace. Equal author ids add a non-blocking `P3a` diagnostic; self-reported ids are provenance, not authenticated proof of reviewer independence.

## Measurement producer provenance

`verify run` and `verify tree run` accept `--provenance <file.json>`; HTTP run accepts the same object as `provenance`. Supply `probe_sha256`, `platform`, `runtime`, `package_manager` (including version), and a non-secret role/session `identity`. No host credentials or environment variables are collected. Fields are caller assertions, not authenticated evidence.

Reports and archives retain the normalized `data_source.producer` and a `data_source.provenance` comparison. The first integrity-valid measured report for the same frozen spec version is the stable baseline; subsequent changes, including omission after a measured baseline, remain `changed` until the original producer is restored or a new spec version is prepared. Tree leaves project changed provenance to `STALE`, which propagates to ancestors; intrinsic VU verdicts are retained. Existing histories without any producer keep their legacy shape. No historical report bytes are rewritten.

## Further Exploration

- [docs/plan.md](../../../docs/plan.md) — architecture decisions and version history
- [docs/conventions.md](../../../docs/conventions.md) — data model conventions
