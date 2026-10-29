---
description: "DB connection, schema, migration, ORM, entities, types, container, and Cordis DatabaseService"
kind: "package-reference"
---

# @ygl/core-database

DB connection, schema, migration, ORM, entities, types, container, and Cordis DatabaseService

## Use this package

Import from `@ygl/core-database` when you need db connection, schema, migration, orm, entities, types, container, and cordis databaseservice.

## PG business workspaces (B8 batch 1)

`pg-workspace.ts` validates a credential-free target hash, checks `meta.backend_binding`, and atomically publishes the local `pg-binding.json` pointer after connecting to an explicitly migrated schema. PG business commands require `YGL_SESSION` or `DSH_SESSION_ID`; a bound home without its PG target refuses SQLite fallback. `getPgOrm()` stays `synchronize: false`. No ticker locking or exactly-once external effects are claimed.

## Further Exploration

- [docs/plan.md](../../docs/plan.md) — architecture decisions and version history
- [docs/conventions.md](../../docs/conventions.md) — data model conventions
