import { defineConfig } from "vitest/config";

/**
 * vitest 5 不再读 package.json 的 "vitest" 键——本文件是唯一被读的配置位（0.92.1 教训：
 * tmp/ 下外来 *.test.cjs 一度被默认 glob 收进门禁，57 文件假失败）。
 * include 只收 packages/apps 的测试树；tmp/ 是脚本暂存区，永远不进门禁。
 */
export default defineConfig({
  test: {
    include: [
      "packages/*/*/tests/**/*.{test,spec}.ts",
      "apps/*/tests/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: [
      "node_modules",
      "dist",
      "tmp",
    ],
    env: {
      YGL_TEST: "1",
    },
    hookTimeout: 30000,
    testTimeout: 20000,
  },
});
