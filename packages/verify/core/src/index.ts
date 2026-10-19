/**
 * @module @ygl/verify-core
 * Spec-driven deterministic verifier: contract types, CompareSpec evaluator,
 * seven checkers, `$vu:` pipeline refs, scope witness and verdict folding.
 */
/**
 * @ygl/verify —— M13 spec-validator 参考实现（TS）：契约 + 比较 + 引擎 + SQLite runner。
 */
export * from "./contract";
export * from "./compare";
export * from "./engine";
export * from "./sqlite-runner";
