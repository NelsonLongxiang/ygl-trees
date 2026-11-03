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

## PostgreSQL business mode (#176 W1-T1)

With `YGL_DB_URL` set to a migrated PG target, `tree new/list/show/use` and `node add/list/show` run on PG and print the same JSON as SQLite. Other tree commands are still refused with rc2.
- Writes keep one statement text for both dialects: `runTx` translates `?` to `$n` on a PG manager (`pgPlaceholders`).
- `tree new` and `node add` use `INSERT … ON CONFLICT DO NOTHING` on PG, so concurrent writes of one name give one row.
- PG has no `nodes_fts`; the search input goes to `nodes.ngram`, and rows drop `ngram`/`ngram_tsv` (`withoutSearchCols`) before they leave the store.
- `AsyncTreeStore` PG branches cast counts to `::int` and order keys with `COLLATE "C"` (SQLite binary order). Tree selection is session-only (`current_tree@<session>`).

## Further Exploration

- [docs/plan.md](../../docs/plan.md) — architecture decisions and version history
- [docs/conventions.md](../../docs/conventions.md) — data model conventions
