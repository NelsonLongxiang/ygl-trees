/**
 * @module @ygl/core-database
 * DB, schema, migration, ORM, entities, types, container, and Cordis DatabaseService.
 */
export { DB, SCHEMA_SQL, SCHEMA_VERSION, dbPath, EDGE_RELS, EDGE_MODES, COND_KINDS } from "./db";
export { AsyncDb, SqliteAsyncDb, getAsyncDb } from "./asyncdb";
export { getOrm, getPgOrm, closeOrm, createScopedOrm } from "./orm";
export type { ScopedOrm, OrmAccess, OrmTarget } from "./orm";
export { createEntitySelection, sealEntityCatalog, assertEntityCatalogUnchanged, registerEntityOwner } from "./entity-catalog";
export type { EntityManifest, EntityRegistration, EntitySelection, EntityCatalog } from "./entity-catalog";
export { CORE_ENTITY_MANIFEST } from "./entity-manifest";
export { InvocationOwner, InvocationCleanupError } from "./invocation";
export type { InvocationAccess, InvocationResource } from "./invocation";
export { pgTargetHash, checkPgWorkspace, bindPgWorkspace } from "./pg-workspace";
export { Event, CORE_ENTITIES } from "./entities";
export { Args, Ctx, Env, parse, str, num, bool } from "./types";
export { Container } from "./container";
export type { ServiceName } from "./container";
export { DatabaseService, apply } from "./plugin";
export type { DatabaseConfig } from "./plugin";
export { CONFIG_REGISTRY, specOf, isSecretKey, configGet, configGetNumber, configGetBool } from "./config";
export type { ConfigSpec } from "./config";
