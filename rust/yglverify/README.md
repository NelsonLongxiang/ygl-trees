# yglverify（M13-1b 起点）

M13 的**交付形态**：单静态二进制，spec 进、报告出。TS 侧（`packages/verify/core`）是参考实现与
构造面；这里的 Rust 实现是**执行面**，以冻结语料与 canonical 向量为唯一 parity 真值。

## 现状（0.98.0 进行中）

| 能力 | 状态 |
|---|---|
| canonical JSON（JCS 子集）+ sha256 | ✅ 与 `corpus/canonical/vectors.json` 12/12 逐字节一致 |
| 契约类型（spec/report/checker） | ✅ `src/contract.rs`（`parse_spec` 版本守卫） |
| compare 八模式 | ✅ `src/compare.rs`（货币最小单位整数、容差/窗口/集合/区间/正则） |
| sqlite 只读 runner | ✅ `src/sqlite.rs`（read-only + query_only + 单语句 + schema 指纹） |
| 七型检查器 + 折叠 + witness | ✅ sql / sql-pair / count / exists / file / command；agent 属 review 层 → ERROR（fact-only 二进制） |
| 语料 parity（33 例） | ✅ 30 例报告投影逐项一致 + 3 例构造期拒绝（`tests/corpus_parity.rs`） |
| `run --spec --db --json` / `self-check` / `--version` | ✅ 三命令；`self-check` 校验内嵌 canonical 向量（12/12） |
| 封包形态（内嵌 spec + footer 指纹，拒绝 `--spec`） | ✅ `seal --spec --out`（YGLVF1 footer；spec/build 双哈希篡改检测；`self-check` 打 `sealed-spec` 行） |

## 跑测试

```bash
cd rust/yglverify
cargo test          # canonical 向量 + 谓词渲染 + 33 例语料投影 + CLI 契约（22 例）
cargo build --release
./target/release/yglverify --version
./target/release/yglverify run --spec <spec.json> --db <snapshot.sqlite> --json
./target/release/yglverify seal --spec <spec.json> --out yglverify-sealed   # 交付形态：spec 内嵌
./yglverify-sealed run --db <snapshot.sqlite> --json                         # 封包不接 --spec
./target/release/yglverify self-check
```

## 纪律

- **不另写测试数据**：向量与语料只读 `packages/verify/core/corpus/**`，两份实现吃同一份冻结输入。
- **不静默降级**：不支持的 checker / 模式必须报错，不能当 PASS。
- 二进制必须能离线跑：`--db` 指向 sqlite 快照副本，不连生产库。
