---
description: "Knowledge base (kb) and skill registry CLI handlers"
kind: "package-reference"
---

# @ygl/knowledge-skills

Knowledge base (kb) and skill registry CLI handlers

## Use this package

Import from `@ygl/knowledge-skills` when you need knowledge base (kb) and skill registry cli handlers.

## PG CLI boundary (B8 batch 1)

`kb add` writes through the PG TypeORM transaction service and verifies landing through the PG read facade. `kb list` and `kb show` are the minimal readback surface. `kb link` validates both notes and writes the relation plus event atomically; existing relations are retained. `kb import` preserves sorted file preflight and content-level deduplication, then imports all notes/search inputs/events in one transaction. Other knowledge mutations remain explicitly unavailable in PG mode. Errors do not echo driver SQL, URL credentials or transaction parameters. SQLite remains the default and is not dual-written.

## Further Exploration

- [docs/plan.md](../../docs/plan.md) — architecture decisions and version history
- [docs/conventions.md](../../docs/conventions.md) — data model conventions
