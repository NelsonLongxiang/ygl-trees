/**
 * 语料运行器入口（re-export）：实现随包发布版在 `src/corpus-runner.ts`，
 * 供 `verify self-check` 从发布产物跑语料；本文件保留给测试与 CI 的既有 import 路径。
 */
export {
  type CaseRun,
  type CorpusCase,
  type ExpectedProjection,
  diff,
  runThrowCase,
} from "../src/corpus-runner";

import { fileURLToPath } from "node:url";

import {
  loadCases as loadCasesAt,
  runCase as runCaseAt,
  runCorpus as runCorpusAt,
} from "../src/corpus-runner";

/** 本仓库内语料目录（仅开发/CI 侧解析；发布产物里由 --corpus 或 YGL_VERIFY_CORPUS 给）。 */
export const CASES_DIR = fileURLToPath(new URL("./cases", import.meta.url));

/** 开发/CI 便利封装：省略参数时用仓库内 corpus/cases。 */
export function loadCases(root: string = CASES_DIR) {
  return loadCasesAt(root);
}
export function runCorpus(root: string = CASES_DIR) {
  return runCorpusAt(root);
}
export function runCase(c: Parameters<typeof runCaseAt>[0]) {
  return runCaseAt(c);
}
