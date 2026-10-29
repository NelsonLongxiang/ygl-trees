---
description: "Report production: outline, sections, report assembly, and project management CLI handlers"
kind: "package-reference"
---

# @ygl/research-produce

Report production: outline, sections, report assembly, and project management CLI handlers

## Use this package

Import from `@ygl/research-produce` when you need report production: outline, sections, report assembly, and project management cli handlers.

## PG CLI boundary (B8 batch 1)

`project new` writes the project and session selection transactionally to PG. `project list` and `project show` read from PG; no synchronous SQLite store is touched in that branch. Project use/archive/restore/delete in PG mode are outside this batch and remain refused at boot. `YGL_PROJECT` and explicit project flags override only the caller's session selection for reads.

## Further Exploration

- [docs/plan.md](../../docs/plan.md) — architecture decisions and version history
- [docs/conventions.md](../../docs/conventions.md) — data model conventions
