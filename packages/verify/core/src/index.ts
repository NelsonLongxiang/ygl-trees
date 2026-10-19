/**
 * @module @ygl/verify-core
 * Spec-driven deterministic verifier: contract types, CompareSpec evaluator,
 * seven checkers, `$vu:` pipeline refs, scope witness, verdict folding,
 * SQLite runner and the prepare pipeline (P0–P5, zero human confirmation).
 */
export * from "./contract";
export * from "./canonical";
export * from "./compare";
export * from "./engine";
export * from "./sqlite-runner";
export * from "./prepare";
