# benchmarks — ygl-trees 性能基准套件

零依赖（`node:perf_hooks` + `node:child_process`）。度量这个 CLI 里真实付费的面。

## 运行

```bash
pnpm bench              # = pnpm build && node benchmarks/bench.js
node benchmarks/bench.js --quick   # 小规模快速冒烟
```

工作区一次性落在 `tmp/bench-workspace/`（每次重建，gitignored）；结果同时写
`tmp/bench-results.json`（含 node 版本 / 平台 / git 短哈希 / quick 标记，供跨提交对比）。

## 基准面

| 套件 | 度量什么 | 形态 |
|---|---|---|
| `startup` | 进程 + Cordis Context + wasm DB open + Store 构造 | 子进程完整 CLI（`db stats`），n=10，p50/p95 |
| `claim-write` | 事务化写路径（幂等探查 + 插入 + events） | in-process，200 事务，每 op 均摊 |
| `claim-dedupe` | 重复命中路径（hash 查找，无插入） | in-process，200 次重放 |
| `kb-import-batch` | 批量导入单事务（500 行：基表 + FTS 影子 + hash 幂等） | in-process，rows/s |
| `kb-search` | FTS5 bm25 + title 加权 + reuse 计数回写 | in-process，8 个 CJK 查询轮转 100 次，p50/p95 |
| `node-index` | 闭包重建 + Kahn 拓扑索引 | 300 节点/596 边播种，median-of-3 |
| `node-search` | FTS5 节点检索 + key/name 加权 | in-process，100 次，p50/p95 |

## 方法论

- **子进程 vs in-process**：startup 度量的是用户每条命令真实付出的完整代价，必须含进程创建；其余套件 in-process 隔离被测代码。
- **统计**：per-op 套件报 p50/p95；一次性操作（node-index）报 median-of-3（操作幂等可重跑）。
- **方差注意**：Windows 上 Defender 对新建文件的实时扫描会显著抬首轮数字（node-index 一次跑 0.5s~2.5s 都见过）；对比请看同机多次运行的 p50/中位数，不要比单次极值。
- **语料**：kb 语料刻意混合共享 token（命中多行）与专属 token（命中少数行），逼出 bm25 排序的真实工作量；`--quick` 全部规模缩到 ~1/5。

## 战绩

- 0.23.0 首跑即抓到 `kbSearch` reuse 回写写放大：top-20 逐行 UPDATE（20 次隐式事务 = 20 次 VFS fsync）→ 单语句 `IN (...)` 批更新。500 行语料 p50 326ms→172ms、p95 2039ms→484ms。

## 基线（2026-10-16，node v24.12.0，win32，0.23.0）

```
startup           p50 63.6ms   p95 75.8ms
claim-write       43.3ms/op    (200 txns)
claim-dedupe      398µs/op     (200 dup-hits)
kb-import-batch   491 rows/s   (500 rows/1tx)
kb-search         p50 172.6ms  p95 483.7ms  (corpus=500)
node-index        ~0.5-2.5s median-of-3 (300n/596e, Defender 方差大)
node-search       p50 2.5ms    p95 6.1ms    (tree=300)
```
