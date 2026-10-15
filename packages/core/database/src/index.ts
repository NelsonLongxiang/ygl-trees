/**
 * @module @ygl/core-database
 */
/** @ygl/core-database — DB, schema, ORM, entities, types, container, Cordis service. */
export { DB, SCHEMA_SQL, SCHEMA_VERSION, dbPath, EDGE_RELS, EDGE_MODES, COND_KINDS } from "./db";
export { getOrm } from "./orm";
export { Event, CORE_ENTITIES } from "./entities";
export { Args, Ctx, Env, parse, str, num, bool } from "./types";
export { Container } from "./container";
export type { ServiceName } from "./container";
export { DatabaseService, DatabasePlugin } from "./database-service";
export type { DatabaseConfig } from "./database-service";
