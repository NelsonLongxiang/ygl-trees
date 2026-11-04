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

With `YGL_DB_URL` set to a migrated PG target, `tree new/list/show/use` and `node add/list/show/link/unlink/rm/move/index/validate` run on PG and print the same JSON as SQLite; W1-T3 adds `node cond add/rm/list`, `unlock/lock`, `can/ready/path` (incl. `ready --all`) and `parents/children/ancestors/descendants`. `--eval` and `cond --due` stay refused with rc2, and so do `search/export/import`.
- Writes keep one statement text for both dialects: `runTx` translates `?` to `$n` on a PG manager (`pgPlaceholders`).
- `tree new` and `node add` use `INSERT … ON CONFLICT DO NOTHING` on PG, so concurrent writes of one name give one row.
- PG has no `nodes_fts`; the search input goes to `nodes.ngram`, and rows drop `ngram`/`ngram_tsv` (`withoutSearchCols`) before they leave the store.
- Gate judgement on PG (`canUnlock`/`ready`/`pathTo`/`ancestors`/`descendants`) does not have a second implementation. `materializeTree` copies the selected tree into an in-memory SQLite workspace, and the synchronous `TreeStore` runs there. `materialize.spec` checks node by node that the copy answers exactly like the source.
- Structural writes (link/unlink/rm/move/index/validate) take a per-tree `pg_advisory_xact_lock` on PG (`lockTree`; two trees are locked in id order), because the closure rebuild deletes and re-inserts the whole tree. `validateTree` is the PG twin of `TreeStore.validate`: the same checks, order and messages.
- `AsyncTreeStore` PG branches cast counts to `::int` and order keys with `COLLATE "C"` (SQLite binary order). Tree selection is session-only (`current_tree@<session>`).

## State timestamps

`node show` and `node list` expose `unlocked_at` only when the selected context is currently `unlocked`; missing or locked state yields `null`. The value comes from the current state row, not a historical last-unlock audit. Locking does not invent a new unlock time or rewrite another context. Historical transitions remain in events; no schema or stored timestamp migration is performed. SQLite and PG use the same projection.

## Further Exploration

- [docs/plan.md](../../docs/plan.md) — architecture decisions and version history
- [docs/conventions.md](../../docs/conventions.md) — data model conventions
