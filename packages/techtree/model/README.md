---
description: "Tech tree node model: nodes, edges, conditions, closure index, topological order, and CLI handlers"
kind: "package-reference"
---

# @ygl/techtree-model

Tech tree node model: nodes, edges, conditions, closure index, topological order, and CLI handlers

## Use this package

Import from `@ygl/techtree-model` when you need tech tree node model: nodes, edges, conditions, closure index, topological order, and cli handlers.

## Node list workspace selection

`node list --tree <tree>` accepts global `--home <directory>` and `--db <SQLite-file>` before or after the command. Workspace selection happens before tree lookup; unknown node-list options still return rc2 with one JSON error under `--json`.

## Further Exploration

- [docs/plan.md](../../docs/plan.md) — architecture decisions and version history
- [docs/conventions.md](../../docs/conventions.md) — data model conventions
