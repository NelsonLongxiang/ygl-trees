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

## MCP trees and transition

The preferred tool is `trees {domain, action, params}`. `trees {action:"help"}` returns the domain directory; domain help lists actions/access, and `params:{action:"<verb>"}` requests parameter detail. `tools/list` exposes the versioned `ygl-trees/1` route contract in `_meta["ygl-trees/dispatch"]`. Hosts must enforce roles before dispatch: unknown routes deny; mixed trees is not globally read-only. Counters, evaluation events and node index refreshes count as writes. Doctor uses separate check/fix actions; params.fix cannot override check. See [MCP contract](../../../docs/mcp-trees.md).

The old read/write/verify/doctor tools retain their schemas, results and request environment behavior for one transition release. They carry replacement metadata, and remain subject to the host role policy; they are not an authorization fallback.

## MCP routing and request environment

MCP write maps kb add to `--title` plus exactly one body/file source, rel attach to `rel add node:<ref> <typed-target> --rel <type>`, and node-cond to explicit op/value and the existing condition flags. Node can/ready/node-unlock forward a named `context`; can/ready accept the CLI state string. No new lock/path/unlock-enforcement behavior is added.

HTTP MCP snapshots its startup environment and derives a separate child environment per request. `X-YGL-Session` overrides only that request; absent headers use the startup session. The handler never assigns process.env. Legitimate PG credentials remain in the controlled child environment, not argv, JSON or diagnostics; request isolation and argv safety are separate checks.

## Offline stdio test support

Import `startStdio({ bundle, home })` from `tests/support/mcp-stdio.ts`. Supply the absolute release bundle entry and a fresh, test-owned absolute home. The child uses that directory for its workspace, OS home, and temporary files. The environment keeps the model offline and leaves network source fetching disabled. Use `offlineMcpEnv(home)` to seed the fixture with the same settings.

Use `client.request(method, params, timeoutMs)` for a raw JSON-RPC reply or pass a JSON array to `runStdioCases(client, cases)`. Each case has `name`, `tool`, and `arguments`, with optional `timeoutMs` and `expect: { isError, rc, fields }`. Field keys such as `project.name` or `items.0.id` address the decoded MCP text payload. Each result carries assertion errors and the raw receipt when the request was sent. The client retains request/reply lines, so use synthetic inputs. Await `client.close()` in a finally block before deleting the home so the shared observer can drain CLI children.

## Project copy

`runProjectSync(ctx, args, createOwner)` is a CLI-only explicit SQLite-copy operation, dispatched before normal workspace boot. The injected factory supplies an application-owned ORM; planning, dry-run, verify and all-duplicate replay use detached readonly images only. Both homes must exist, be checkpointed/quiescent and match the current table_xinfo columns (including generated/hidden state), primary/unique-key and FK definitions. No init, implicit upgrade, PG fallback, selection change or network call occurs.

The copied subset is the named active project plus sources, evidence, claims (including scope/channel), supports/refutes links, all relations whose two endpoints are this project's claims (any rel and original direction) and each claim's current status/latest resolve-or-unresolve payload. The existing `supersession` step/count key includes these recorded internal relations, including `supersedes`; no vocabulary or direction is normalized. `superseded-by` retains its endpoint, single-replacement and cycle checks. IDs and base-row timestamps are preserved. Target audit events are new replay records; other historical events, query/query-source rows, tasks, reports, knowledge and tree assets are not copied. Identity/content conflicts and extra rows inside the target project fail before business writes; unrelated projects remain untouched. Prefer an empty matching-schema target. This is additive copy, not merge or live replication.

`ygl-project-sync/1` returns `steps[{kind,source_id,target_id,action}],written,skipped,skipped_count,verify{ok,source,target}`. Each relation touching a project claim but ending outside this claim set is excluded from replay and listed in stable ID order as `{id,rel,src,dst,reason}` in `skipped`; the count/hash proof covers every copied internal relation. A skipped relation is not treated as copied or hashed target data. The count/hash proof reads each complete project graph, using ordered IDs, material fields, scope, stance, replacement endpoints and the effective resolution payload. Audit IDs/timestamps and base creation/retrieval/update timestamps are not part of equivalence. It never counts the same target row twice. A missing/different graph makes verify rc1; dry-run reports the prospective steps with zero writes. A second completed replay is all duplicate, rc0, with file bytes/mtime unchanged.

Each nonduplicate step commits its base row, FTS shadow and audit in one research write-service transaction. Native target data_version changes are checked after writer reservation; source identity/hash is rechecked before writing and final verification. Runtime failure reports `partial{written,completed,rerunnable:true}` for the committed prefix; rerun against the unchanged source after resolving the reported cause. No completed step is rolled back by a later failure.

A process exit may leave its sync lock and uncheckpointed WAL. `--resume` is mutually exclusive with dry-run/verify and only takes over a confirmed dead owner matching the source-file hash, source path, target home and project. It validates the target, checkpoints under an atomic admission guard shared with ordinary DB lock acquisition and replans; a normal writer cannot steal the abandoned lock during validation/rename. Live/unknown/unrelated locks are refused. Recovery itself is mutating. Admission gates record an owner token, pid and task. Only a confirmed-dead generation is atomically retired; a token-addressed, nonempty `.stale-<owner-hash>` directory is retained to fence delayed reclaimers and preserve interrupted recovery evidence. Do not delete those tombstones while workspace processes run. An ordinary open reclaims a dead gate; `db unlock` and `doctor --fix` can also retire it, while doctor without fix reports it. Live/unknown gates remain refused even by `db unlock --force`. A malformed owner or damaged rollback journal requires inspection, not automatic deletion. Cleanup uncertainty returns rc1, retains owned resources/locks and reports `rerunnable:false,recovery_required:true`; do not force-clear a live holder. Defaults, dry-run and verify never recover or remove locks.

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
