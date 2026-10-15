/**
 * @module @ygl/research-pipeline
 */
/** @ygl/research-pipeline — query→source→evidence→claim reads, writes, entities. */
export * from "./entities";
export { Store, deriveL1 } from "./reads";
export * as writes from "./writes";
export { ResearchService, ResearchPlugin } from "./service";
