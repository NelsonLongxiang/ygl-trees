---
name: review-a1-q10-r36
description: A1 r35 六项修复第二轮复核（r36）——Q9/五值/V15 已修；G8 运行期校验缺失、矩阵绑定仍是旧测试；0.115.0 继续暂缓
kind: 评审
---

# A1 r35 修复 · 第二轮复核（r36）

> 复核对象：`5fa6a1a`（六项修复）+ `f3d9b88`（矩阵重生成），HEAD `f3d9b88`。
> 方法：代码路径 + 重建 bundle 后空 scratch 探针 + 测试/矩阵 manifest 核对。
> 结论：**大部分已修，但 G8 运行期校验缺失、矩阵 Q8/Q9/G8 绑定仍是旧测试** → 暂缓 0.115.0，补完即签。

## 0. 已确认修复（不再重开）

- **Q9 活叶**：tree 冻结 `spec_version:2` vs spec v1 → run `STALE`（旧 `ts_797b8d65accb` 探针由 FAIL 变 STALE）。
- **五值**：空库 ERROR 叶 → `nodes[].verdict` 在五值内（`INFRA_BLOCKED`），`report_verdict:ERROR` 保留；`toTreeVerdict` 已落。
- **V15/Q10**：cap-on-PASS 改码（`aggregateTreeVerdict:295-326`）；`FAIL+ERROR=FAIL`、`FAIL+INFRA=FAIL`、quorum 基础 PASS 才 cap；测试 17+4 行。
- **Q8 部分**：tree spec 冻结 `target{kind,id,sha256?}` + `subject{repo,commit}`，进 JCS canonical（同结构不同 target → 不同 tree_spec_id）；pinned 分支有 target 比对代码。
- **Q9 部分**：pinned 分支有 target/spec_version 比对 + 缺字段 fail-closed（代码 inspection）。
- **G8 部分**：engine/corpus/contract 三字段进 spec + canonical。
- Q11 两跑 id 不同、digest 相等；verify-tree 33 + verify-q10 8 测试通过（开发报告）。

## 1. 阻塞项（补完即签）

### 1.1 G8 运行期校验缺失（契约要求 rc2）
- 契约 v1.2 §0/G8：「tree spec 冻结 engine/corpus/contract；run 时与引擎实况不一致 → 拒跑（rc2）」。
- 实测：tree spec 声明 `engine_version:"0.999.0"`（实际 0.114.31）→ `tree prepare` rc0、`tree run` 正常执行（FAIL），**没有 rc2**。
- 代码：`validateTreeSpec` 只存字段，不比对实况；`treeRun` 也不检查 `spec.engine_version/corpus_version/contract_version`。
- 要求：`tree run`（或 prepare）比对实况，不一致 rc2 并点名字段；补测试；或明确改契约把 G8 降为「只冻结不校验」（需两席+属主改裁定，不建议）。

### 1.2 矩阵 Q8/Q9/G8 绑定仍是旧测试（绿行不可追溯）
- `tree-contract-matrix.json` 现状：
  - Q8 `test_title: "V22: leaf target mismatch"`（未覆盖 target 冻结/subject/pinned）；
  - Q9 `test_title: "V22: leaf target mismatch"`（未覆盖 spec_version 漂移/pinned/缺字段）；
  - G8 `test_title: "G8: jcsCanonical"`（只覆盖 JCS，不覆盖 pin）。
- 即 `green 20` 里这三行的依据仍是旧测试，即使新测试存在（Q8 target frozen / Q9 leaf drift / G8 fields），manifest 没绑定、断言也没覆盖全。
- 要求（二选一，倾向补测试）：① 改 manifest 绑定到新测试并**补足** pinned/subject/G8-mismatch 用例；② 把 Q8/Q9/G8 标 **partial** 并在 evidence 写「测试覆盖子集：…」，重生成矩阵。不能维持「green + 旧测试标题」。

### 1.3 测试覆盖缺口（与 1.2 配套）
- Q8：pinned 叶 target 失配用例；subject=repo+commit 进 canonical 的用例（或文档声明 subject 只声明不校验）。
- Q9：pinned 归档 spec_version 漂移、pinned report 缺 target/spec_version 的 fail-closed 用例。
- G8：engine/corpus/contract 与实况不一致 → rc2 用例。
- 现有 `verify-q10` 已覆盖 Q8 target 冻结、Q9 活叶漂移、五值、V15；补上述 4 组即可。

## 2. 非阻塞
- `aggregateTreeVerdict` 上方注释仍写旧「Q10-B 优先于 quorum」语义，建议同步为 cap-on-PASS。
- 矩阵 V15 行 assertion 仍写「四态聚合矩阵」，应改「五值 5×5」。
- Q12 代码已落、测试 planned 保持正确；Q4/V21 planned 不变。

## 3. 签注条件
补完 1.1（G8 run-time rc2）+ 1.2/1.3（矩阵绑定或 partial + 测试缺口），矩阵在最终 HEAD 重生成，302 席即签；fdc 席同批复核后 0.115.0 放行。
