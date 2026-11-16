/**
 * @module @ygl/core-text
 */
/** @ygl/core-text — pure text utilities and output helpers. Zero dependencies. */
export { ngram, nowIso, shortId, sha1, contentHash, clip, slug, parseFrontmatter, splitTags } from "./text";
export { ok, bad, out, head, table, show, dump, paint, writeResult, ack, emitJson, C } from "./fmt";
export { validateScope } from "./scope";
export { InvocationResult, RESULT_MAX_BYTES } from "./result";
// Ctx lives in core/database/src/types.ts
