---
description: "Knowledge base (kb) and skill registry CLI handlers"
kind: "package-reference"
---

# @ygl/knowledge-skills

Knowledge base (kb) and skill registry CLI handlers

## Use this package

Import from `@ygl/knowledge-skills` when you need knowledge base (kb) and skill registry cli handlers.

## PG CLI boundary (B8 batch 1)

`kb add` writes through the PG TypeORM transaction service and verifies landing through the PG read facade. `kb list` and `kb show` are the minimal readback surface. `kb link` validates both notes and writes the relation plus event atomically; existing relations are retained. `kb import` preserves sorted file preflight and content-level deduplication, then imports all notes/search inputs/events in one transaction. `kb rescope <id> --scope <key>` validates the grant, locks that row, updates scope and writes an old/new audit payload in the same PG transaction. Scope filters on `kb list` are SQL predicates, not client-side filtering. Other knowledge mutations remain explicitly unavailable in PG mode. Errors do not echo driver SQL, URL credentials or transaction parameters. SQLite remains the default and is not dual-written.

## Grant scope

`kb add`, `kb import` and `kb ingest` accept `--scope`; import frontmatter `scope:` takes precedence. Omission stores the empty unattributed value, never a selected-project default. The exact forms are `dept:<id>`, `bench:<id>`, `*` and `restricted`; ids match `[A-Za-z0-9._-]{1,64}`. Invalid or bare values are rc2. Duplicate notes retain their original scope. Only `kb rescope <id> --scope <key>` changes a note grant; unknown ids are rc1, and the event records `old_scope/new_scope`. Lists and search accept an exact filter, with `--scope ""` selecting unattributed rows; omitted filters preserve the previous list shape.

## Promotion admission

`kb promote <noteId>` selects only by the unique note id, never by title. It accepts a note only when cue/lesson/evidence frontmatter is complete and nonempty, or an evidence/claim row really exists at the other end of a relation to the note. Both relation directions count; orphan and unrelated endpoints do not. Refusal returns rc1 with one named JSON error and no skill write. Repair by adding actual material or a real support relation, never placeholder text. Add/import stay permissive; imported admission frontmatter is preserved.

Promotion runs admission, skill/FTS upsert, support snapshots and the `kb.promote` audit event in one transaction. `--force` explicitly bypasses admission and records `forced:true`. `skill show` adds `support_refs:[{type,id}]` using promotion-time typed evidence/claim ids. Free-text evidence is retained in the body rather than invented as an id. Changing note relations does not rewrite the snapshot; a new promotion replaces it. Same-name `skill add`/`import` preserves that promotion-time snapshot; only a new promotion replaces it. Promotion also copies the note grant; ordinary skill upserts preserve that grant when scope is omitted, and re-promotion refreshes it after a note rescope. Skill deletion removes it in the same transaction. The original skill origin and content remain available; no schema migration or PG capability expansion.

## Further Exploration

- [docs/plan.md](../../docs/plan.md) — architecture decisions and version history
- [docs/conventions.md](../../docs/conventions.md) — data model conventions
