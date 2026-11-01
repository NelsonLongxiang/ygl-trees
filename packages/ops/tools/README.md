---
description: "Operational tools: config registry, PG sync/migrate, db/job/agent/config CLI handlers"
kind: "package-reference"
---

# @ygl/ops-tools

Operational tools: config registry, PG sync/migrate, db/job/agent/config CLI handlers

## Use this package

Import from `@ygl/ops-tools` when you need operational tools: config registry, pg sync/migrate, db/job/agent/config cli handlers.

## MCP routing and request environment

MCP write maps kb add to `--title` plus exactly one body/file source, rel attach to `rel add node:<ref> <typed-target> --rel <type>`, and node-cond to explicit op/value and the existing condition flags. Node can/ready/node-unlock forward a named `context`; can/ready accept the CLI state string. No new lock/path/unlock-enforcement behavior is added.

HTTP MCP snapshots its startup environment and derives a separate child environment per request. `X-YGL-Session` overrides only that request; absent headers use the startup session. The handler never assigns process.env. Legitimate PG credentials remain in the controlled child environment, not argv, JSON or diagnostics; request isolation and argv safety are separate checks.

## Verifier HTTP lists

`verify-list` queries the derived `verify/.list-index.sqlite` summary index by spec and stable cursor. Report/archive pages return `items/total/next_cursor`, default200/max500. The server prepares/reconciles legacy files before readiness, not on an HTTP list request. Official report/sidecar writes update summaries; filename watchers maintain external changes without periodic whole-directory stat scans. Source JSON remains authoritative; no business schema/export/migration changes. Use `firstReportPage/firstArchivePage` for at most200rows; use page APIs for cursors. Changing/incomplete source records remain pending; stable invalid JSON or mismatched records are recorded in the derived `excluded` table with kind/id/stamp/reason and omitted without failing usable lists. Valid rewrites remove the exclusion. Missing/corrupt SQLite index or watcher IO faults remain explicit failures, never an implicit list-time full scan. Close waits for watchers and preparation to finish.

## Verifier CLI list counts

`verify list` counts every report for each spec while reading the latest report without removing it from the in-memory list. `last_run` and `last_overall` keep the existing finished-time ordering and stable file-order tie behavior; no-report rows return zero runs and empty latest fields. Listing does not rewrite spec/report bytes. The CLI count fix does not change the HTTP paging/index contract.

## Further Exploration

- [docs/plan.md](../../docs/plan.md) — architecture decisions and version history
- [docs/conventions.md](../../docs/conventions.md) — data model conventions
