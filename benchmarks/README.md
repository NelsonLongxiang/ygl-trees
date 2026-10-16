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
pnpm bench                          # 先 build 再跑全部，结果落 tmp/bench-results.json
node benchmarks/bench.js --quick    # 缩小规模（startup n=4 / 写入 50 / kb 150 行·30 检索 / 树 100 节点）
```

每席除时延外还报告**内存端点**：whole-process RSS 峰值（after）与该席增量（delta），artifact 同步携带。

## 基线（fork 4.0.5-α + bundle 发布产物，2026-10-17）

```
startup           p50 560ms   (受控交替测量，bundle vs 树 607ms → ~8% 提速)
claim-write       ~16-25ms/op (200 txns，跨次波动)
claim-dedupe      ~380-615µs/op (200 dup-hits)
kb-import-batch   ~1400-3000 rows/s (500 rows/1tx)
kb-search         p50 ~23-31ms (corpus=500)
node-index        ~560-630ms median-of-3 (300n/596e)
node-search       p50 ~3-5ms
```

**startup 测量纪律**：进程 spawn 对系统负载敏感——单次 `pnpm bench` 的 p95 可能因并发进程飙到 3s+。
判定 bundle/树差异必须**交替测量同一负载窗口**（各自 8 轮取 p50），不要跨时间窗对比单次运行。

## 已知限制

- startup 无独立进程隔离（同进程 spawn），高负载下方差大（见上测量纪律）
- 内存端点是 whole-process RSS 而非单席独占计量——同进程多席共享堆，delta 只作趋势参考
