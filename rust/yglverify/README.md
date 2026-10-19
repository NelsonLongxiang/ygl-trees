# yglverify（M13-1b 起点）

M13 的**交付形态**：单静态二进制，spec 进、报告出。TS 侧（`packages/verify/core`）是参考实现与
构造面；这里的 Rust 实现是**执行面**，以冻结语料与 canonical 向量为唯一 parity 真值。

## 现状（0.98.0 进行中）

| 能力 | 状态 |
|---|---|
| canonical JSON（JCS 子集）+ sha256 | ✅ 与 `corpus/canonical/vectors.json` 12/12 逐字节一致 |
| 契约类型（spec/report/checker） | ⬜ |
| compare 八模式 | ⬜ |
| sqlite 只读 runner | ⬜ |
| 七型检查器 + 折叠 + witness | ⬜ |
| 语料 parity（33 例） | ⬜ |
| `run --spec --db --json` / `self-check` / `--version` | 部分（`--version`） |

## 跑测试

```bash
cd rust/yglverify
cargo test          # canonical 单测 + 跨实现向量 parity（直接读 TS 侧冻结的 vectors.json）
cargo build --release
./target/release/yglverify --version
```

## 纪律

- **不另写测试数据**：向量与语料只读 `packages/verify/core/corpus/**`，两份实现吃同一份冻结输入。
- **不静默降级**：不支持的 checker / 模式必须报错，不能当 PASS。
- 二进制必须能离线跑：`--db` 指向 sqlite 快照副本，不连生产库。
