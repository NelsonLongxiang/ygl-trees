/**
 * @module @ygl/research-pipeline
 * Research pipeline: query/source/evidence/claim entities, reads, writes, and Cordis ResearchService.
 */
export * from "./entities";
export { Store, deriveL1 } from "./reads";
export { AsyncResearchStore } from "./async-store";
export * as writes from "./writes";
export { ResearchService, apply } from "./plugin";
