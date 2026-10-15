/** Research domain — query→source→evidence→claim→produce pipeline.
 *  Entities, reads, writes, and CLI command handlers. */
export * from "./entities";
export { Store } from "./reads";
export * as writes from "./writes";
export { deriveL1 } from "./reads";
