# AGENTS.md — Performance Benchmarks

本目录持有仓库级性能门禁。包局部诊断留在包内（`.perf.ts` 后缀），不进 `pnpm bench`。

- **按用户路径组织**：一个目录一条路径，不镜像包树（当前路径：`startup/` `research-write/` `knowledge-search/` `techtree-index/`）。
- 基准文件用 `*.bench.ts` 后缀；fixture 与 support 模块不带此后缀。
- benchmarks 是私有 workspace 包（`@ygl/benchmarks`）——基准专用依赖在此声明，不污染根。
- **合成固定输入**——从审阅过的常量合成，不用录制的会话、用户材料、环境仓库或网络服务。
- **进程级 wall-clock 与内存采样**在全新子进程中跑，每次用私有 `mkdtemp` 根目录。纯同步折叠每采样建全新对象图，不污染进程全局状态。限制每个子进程，await 退出，失败与成功都清理根目录。
- **报告足够原始与聚合测量**来解释判定——预算用的是中位数/最小值/绝对值/比值中的哪个，写清楚。
- **跑生产入口**。不复制产品算法，不添加仅用于测量的生产导出。
- 时间预算**不能被环境变量覆盖**——审阅过的源码常量是唯一真源。
- 场景专属 support 放在其基准目录旁；移入 `support/` 需至少两个基准目录用到同一行为。
- 运行方式：`pnpm bench`（先 build 再跑，结果落 `tmp/bench-results.json` 含 node 版本/平台/git 哈希）。
