import { defineConfig } from "vitest/config";

/** Wall-clock budgets run after the parallel suite so sibling tests do not consume their budget. */
export default defineConfig({
  test: {
    include: ["packages/ops/tools/tests/verify-list-performance.spec.ts"],
    exclude: ["node_modules", "dist", "tmp"],
    env: {
      YGL_TEST: "1",
    },
    setupFiles: ["tests/support/fetch-retry.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 60000,
    testTimeout: 60000,
  },
});
