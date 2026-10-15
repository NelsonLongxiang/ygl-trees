/** Core foundation — shared across all domain modules.
 *  No domain logic here; only DB, ORM, text utilities, and output helpers. */
export { DB, SCHEMA_SQL, SCHEMA_VERSION, dbPath, EDGE_RELS, EDGE_MODES, COND_KINDS } from "./db";
export { getOrm } from "./orm";
export { ngram, nowIso, shortId, sha1, contentHash, clip, slug, parseFrontmatter, splitTags } from "./text";
export { ok, bad, out, head, table, show, dump, paint, writeResult, ack, C, Ctx } from "./fmt";
export { Event, CORE_ENTITIES } from "./entities";
