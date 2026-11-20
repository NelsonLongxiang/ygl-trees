---
description: "DB connection, schema, migration, ORM, entities, types, container, and Cordis DatabaseService"
kind: "package-reference"
---

# @ygl/core-database

DB connection, schema, migration, ORM, entities, types, container, and Cordis DatabaseService

## Use this package

Import from `@ygl/core-database` when you need db connection, schema, migration, orm, entities, types, container, and cordis databaseservice.

## Explicit ORM ownership

Applications choose lightweight entity manifests and supply literal lazy constructor loaders to `createScopedOrm`. `createEntitySelection` copies declarations; `sealEntityCatalog` requires every selected member, rejects conflicts and verifies selected table/relationship metadata before connecting. It never discovers entities from files or unrelated global decorators. SQLite and PG receive the same explicitly chosen catalog; `synchronize` remains false.

`ScopedOrm.getOrm(file)` / `getPgOrm(url)` single-flight assembly and initialization for one immutable target. Each owner has its own connection and terminal awaitable `close()`, including close-during-assembly and failed-initialization cleanup. Reopening uses a new owner. The named adapters `getOrm(file, owner)`, `getPgOrm(url, owner)` and `closeOrm(owner)` require an explicit instance; calls without it fail before a database opens. Domain handlers receive borrowed `env.orm`, not application close authority.

`InvocationOwner` stops admission, settles accepted work and closes consumers before connections and native DB resources. `DB.closeStrict()` confirms handle release before releasing only its instance-owned lock; failed or unknown cleanup retains failure and does not permit dependent release. `DatabaseService.stop()` returns the owning invocation close promise and must be awaited.

## Configuration readers

`config.ts` owns the single `CONFIG_REGISTRY`, `ConfigSpec`, `specOf`, `isSecretKey` and `configGet/configGetNumber/configGetBool` exports. Readers accept the DB type without a runtime DB import, resolve overrides against the registry defaults and perform no writes. Mutation, audit events, secret display and export filtering stay in ops/tools. Domain packages import these readers directly from this lower layer.

## PG business workspaces (B8 batch 1)

`pg-workspace.ts` validates a credential-free target hash, checks `meta.backend_binding`, and atomically publishes the local `pg-binding.json` pointer after connecting to an explicitly migrated schema. PG business commands require `YGL_SESSION` or `DSH_SESSION_ID`; a bound home without its PG target refuses SQLite fallback. The explicitly composed PG ORM stays `synchronize: false`. `requirePgColumns` checks identifier metadata required by the actual command, emits safe table.column diagnostics and never changes the schema. No ticker locking or exactly-once external effects are claimed.

## Knowledge grant schema

Schema v15 stores `scope TEXT NOT NULL DEFAULT ''` on `kb_notes` and `skills`. SQLite v14 and version-zero dump replays upgrade in place without inferring grants. PG uses the v15 `PG_UPGRADES` step; export/mirror paths retain the added column and no ORM synchronization is enabled.

Schema v16 extends the same grant contract to `claims`. SQLite v15 and version-zero replays retain existing rows and audit history with `scope = ''`. The v16 PG step is explicit and idempotent; no business command auto-upgrades PG. The shared additive-column helper preserves ordered legacy version gates and defaults; `SCHEMA_VERSION` remains the engine and doctor source of truth.

## Further Exploration

- [docs/plan.md](../../../docs/plan.md) — architecture decisions and version history
- [docs/conventions.md](../../../docs/conventions.md) — data model conventions

## Lock admission

Ordinary `DB(...,{lock:true})` acquisition and explicit project-copy recovery share an exclusive `.ygllock.recovery` admission directory. It serializes stale-owner inspection through new-owner publication, not the lifetime of ordinary DB use. Recovery keeps the gate through stale-lock rename and checkpoint. Its owner token must match before removal; an unknown orphaned gate fails closed for inspection. Live-holder waiting keeps the existing `YGL_LOCK_RETRY_MS` budget; no business table, transaction retry or backend binding is changed.
