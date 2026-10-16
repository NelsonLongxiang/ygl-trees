---
name: ygl-trees benchmarks
description: 仓库级性能基准——按用户路径组织（startup/research-write/knowledge-search/techtree-index），DSH benchmarks 典范。pnpm bench 一键跑全部。
kind: 库
---

# benchmarks/ — 性能基准

按**用户路径**组织（一个目录一条路径），不镜像包树。DSH benchmarks 典范。

## 结构

```
benchmarks/
  AGENTS.md              基准纪律（合成输入/进程级采样/预算不可环境覆盖）
  package.json           @ygl/benchmarks（workspace 包）
  bench.js               薄 runner（按路径调度子模块，清理，写 artifact）
  support/
    helpers.js           共享：stats/suite/时长格式化/artifact 写出/freshWorkspace
  startup/
    startup.bench.js     CLI 完整进程 spawn（p50/p95 × n=10）
  research-write/
    research-write.bench.js  事务化 claim 写入 + 幂等命中
  knowledge-search/
    knowledge-search.bench.js  kb 批量导入 + FTS5 bm25 CJK 检索
  techtree-index/
    techtree-index.bench.js  闭包重建 + Kahn 拓扑 + 节点检索
```

## 用法

```bash
pnpm bench             # 先 build 再跑全部，结果落 tmp/bench-results.json
node benchmarks/bench.js --quick   # 小规模（预留参数位，当前跑全量）
```

## 基线（fork 4.0.5-α，2026-10-17）

```
startup           p50 523ms   p95 568ms
claim-write       25.8ms/op   (200 txns)
claim-dedupe      372µs/op    (200 dup-hits)
kb-import-batch   890 rows/s  (500 rows/1tx)
kb-search         p50 30.5ms  p95 174ms  (corpus=500)
node-index        591ms median-of-3 (300n/596e)
node-search       p50 2.7ms   p95 5.7ms
```

## 已知限制

- `--quick` 尚未接线到各子模块（预留参数位，当前跑全量）
- 无内存峰值端点——加内存维度时在 helpers 加 `recordPeakMemory`
