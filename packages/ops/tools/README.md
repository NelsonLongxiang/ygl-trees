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

## Further Exploration

- [docs/plan.md](../../docs/plan.md) — architecture decisions and version history
- [docs/conventions.md](../../docs/conventions.md) — data model conventions
