/** Tech tree domain — nodes, edges, conditions, eval gates, closure/topo indexes. */
export { TreeStore } from "./reads";
export * as treeWrites from "./writes";
export { evalToken, evalBoolean, evalBooleanMany, mapOutcome, resolveEndpoint, DEFAULT_ENDPOINT } from "./eval";
export type { EvalOutcome, EvalBooleanResult } from "./eval";
