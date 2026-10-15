/**
 * @module @ygl/techtree-eval
 */
/** @ygl/techtree-eval — decision model evaluation client (boolean / choice / score). */
export {
  evalToken, evalBoolean, evalBooleanMany, evalChoice, evalScore,
  mapOutcome, mapChoiceOutcome, mapScoreOutcome, resolveEndpoint,
  parseEvalSpec, packEvalChoiceSpec, packEvalScoreSpec, DEFAULT_ENDPOINT,
} from "./eval";
export type { EvalOutcome, EvalBooleanResult, EvalChoiceResult, EvalScoreResult, EvalSpec } from "./eval";
