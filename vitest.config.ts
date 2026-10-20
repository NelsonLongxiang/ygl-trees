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
    // 测试侧只重试「一个字节都没收到」的连接级失败（见 tests/support/fetch-retry.ts）：
    // 干净检出上满负载跑 72 文件会偶发 ECONNRESET，那是传输抖动而非判据失败。
    setupFiles: ["tests/support/fetch-retry.ts"],
    hookTimeout: 60000,
    // bundle 级用例要 spawn 发布产物（dist/bundle/bin.cjs），冷检出上单次 spawn 3–5s，
    // 一条用例串 4–5 次就顶到 20s 上限（实测干净 worktree 上 patrol recurrence 20.8s 超时，
    // 主树同一用例 ~6s）。上限放到 60s：它只决定「失败要等多久」，不改变通过判据。
    testTimeout: 60000,
  },
});
