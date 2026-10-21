# verify 契约 1.3 设计草案：报告的语义边界与取证面（semantic_scope / provenance / 扫描清单）

> 状态：**草案，未实现**。对应 #27 方案（`docs/reviews/taste-extraction-plan.md`）§5 工作流 **T4**，
> 等待裁定 **D3**（契约 1.3 批的内容）与 **T1** 合入（相邻面：archive 的扫描清单形状）。
> 目标评审：K3 评审席、fdc757f6（契约持闸）、开发席（引擎维护者）。
> 现行契约为 1.2（`CONTRACT_VERSION` / `CORPUS_VERSION` = 1.2）。
> 写法沿用 [verify-contract-v1.2.md](verify-contract-v1.2.md)：先问题、再形态、再版本与语料、最后明确不做什么。

## 1. 要解决的真实问题

三件事都是「报告说了什么」与「报告实际证明了什么」之间的缺口，三件都要动 **报告形状**，所以按
纪律必须同批升 `contract_version`（1.1 先例：`verifier.signature` 加字段即升版）：

1. **父 PASS 的语义边界不可见（#27 Q3）**。两级递归验证器里，父级用 `file` VU 验子归档「在场」，
   报告里却没有任何字段说明这个 PASS 只是结构性的；业务侧会把它读成「子结论为真」。五席共识：边界
   必须机器可见、缺省按最保守读、渲染面首屏透出。
2. **`file` VU 的 PASS 回指不到被检字节（#28）**。0.113.2 用工作区侧车 + 归档一等 item 补了 P5 的可追溯
   性，但报告 `evidence` 仍只有计数 `{files, matched, ignored, problems}`；复核报告本身（不解归档）仍
   看不出扫了哪些文件。
3. **快照来源不入报告（PR #16 P1.1）**。`data_source` 只有 `{kind, sha256, source, captured_at}`；
   快照从哪个仓库、哪个提交、哪条路径来，是否已跟踪、是否干净，报告里没有。

## 2. 形态一：`semantic_scope`（报告级 + VU 级，闭集，缺省最保守）

```jsonc
// VerifyUnit（spec，可选）：构造期声明本判据断言到哪一层
{ "id": "V1", "role": "assert", "semantic_scope": "structural", … }

// VuResult（report）：run 期从 spec 复制；spec 未声明 → "structural"
{ "id": "V1", "verdict": "PASS", "semantic_scope": "structural", … }

// VerifyReport（report 顶层）：全部 assert VU 的最弱值（structural < factual < semantic）
{ "overall": "PASS", "semantic_scope": "structural", … }
```

- **闭集**：`structural | factual | semantic`（fdc 提案）。
  - `structural`：断言的是结构在场（文件存在 / 行存在 / 归档可验），不断言其内容为真；
  - `factual`：断言的是快照里可重放的事实（sql / sql-pair / count / exists 对数据的判定）；
  - `semantic`：断言经过人工认定或 review 层的语义结论（agent 型 review；1.3 **不开**运行时判分，D1）。
- **缺省 fail-closed**：spec 未声明 → `structural`；报告顶层取全部 assert VU 的**最弱**值。读者永远不会
  因为「忘了标」而读到更强的承诺。
- **构造期守卫（prepare P2）**：声明 `factual` 的 VU 其 checker 必须是 `sql | sql-pair | count | exists`；
  声明 `semantic` 必须是 `agent`；`file` 与 `command` 只能是 `structural`。声明与检查器不符 →
  `spec_error: "scope_mismatch"`（新码，进封闭码表）。
- **递归父级（R-T5）**：声称覆盖子结论的父 VU，若要标 `factual`，必须是对子报告投影列
  （`overall` / `payload_sha256` / `archive_ok` / 对象一致）的 `sql`/`count` 断言，而不是 `file`；
  `file` 型父级永远只能 `structural`——这与方案 §3 R-T5 四条判据一致。
- **渲染面（T6）**：CLI `verify run` / `verify report`、WebUI 报告头与 VU 表、通知模板首屏显示
  `semantic_scope`；读不到字段的旧报告（≤1.2）一律按 `structural` 显示。

## 3. 形态二：`file` VU 的 evidence 增 `scanned[]`

```jsonc
"evidence": {
  "files": 2, "matched": 2, "ignored": 1, "problems": [],
  "scanned": [ { "path": "a.txt", "sha256": "…", "size": 5 }, { "path": "b.txt", "sha256": "…", "size": 4 } ],
  "scanned_total": 2
}
```

- 与 0.113.2 归档项 `submission-scan.json`（T1 后为白名单投影）**同源同形**：`matched[]` 的
  `{path, sha256, size}`，路径相对 `--submission` 根、POSIX。
- **有界**：`scanned[]` 采样 ≤ 20 条（`ORDER BY path` 字节序），`scanned_total` **无条件出现**
  （1.2 `compared_total` 的同款纪律：消费者能区分「恰好 N」与「N/M 采样」）；全集仍在归档项里。
- `witness` 四字段不变。

## 4. 形态三：`data_source.provenance`

```jsonc
"data_source": {
  "kind": "sqlite-snapshot", "sha256": "sha256:…", "source": "snap.sqlite", "captured_at": "…",
  "provenance": { "repo_commit": "3bbfb79…", "path": "work/snap/round-1.sqlite", "tracked": true, "clean": true }
}
```

- 由 `verify run --source-repo <dir> --source-path <rel>` 声明（PR #16 P1.1 原文）；不声明则无此键。
- 声明了但路径未跟踪 / 工作树脏 / 路径不符 → **ERROR**（不静默），错误码 `spec_error: "provenance_mismatch"`。
- `archive verify` 把 `provenance` 纳入 payload 链（它在报告内，payload_sha256 自然覆盖）。

## 5. 视 D3 决定是否同批的两项

| 项 | 来由 | 形态 | 本席建议 |
|---|---|---|---|
| 聚合 `distinct` | 方案 §2.3 ④：「≥N 个不同仲裁人」用 `count` 表达不了 | `PredicateAgg` 增 `distinct: true`（渲染 `count(DISTINCT col)`；只对 `count` 合法） | 有试点数据（T3）再定 |
| VU `channel` | 方案 §2.3 ③：`VerifyUnit` 无 channel 字段，meta v2 词表校验需契约 | `VerifyUnit.channel?: string`，`verify/meta.json` v2 `channels{}` 词表 + R2 校验（T7b） | 视 D2 选 (b)/(c) |

## 6. 兼容与版本

- `CONTRACT_VERSION` 1.2 → **1.3**；`CORPUS_VERSION` 同步 1.3（语料重冻，§7）。
- **1.1 / 1.2 的 spec 在 1.3 引擎下行为不变**：三个形态都是可选键；旧 spec 不出现即走旧路径，但报告仍会
  带 `semantic_scope`（缺省 `structural`）——这是**报告**加字段，不是 spec 变更，与 1.1 加 `verifier.signature`
  同类。
- **版本闸**：声明 1.1/1.2 却携带 1.3 形态（VU `semantic_scope` / `channel`、`distinct`）→ `version_shape`
  入口拒跑（`uses13Shapes`，与 `uses12Shapes` 同款）。
- **报告 `contract_version` 取引擎版本**还是 spec 声明？1.2 的决定是「取 spec 声明」（1.1 spec 的报告仍写
  1.1，既有 33 例零改动）。1.3 若对 1.2 spec 的报告也加 `semantic_scope`，报告形状就与其 `contract_version`
  不符——两个选项：(a) 报告 `contract_version` 改取引擎版本（1.3），spec 版本另记 `spec_contract_version`；
  (b) 只对声明 1.3 的 spec 产出 1.3 报告字段。**本席建议 (b)**：保持 1.2 的「报告版本随 spec」纪律与
  既有 44 例逐字节不变；旧 spec 的边界缺省由渲染面兜底（T6 的「无字段按 structural 显示」）。**待裁定**。
- 形状守卫：`corpus/shapes/*.shape.txt` 重铸（`YGL_UPDATE_SHAPES=1`），样例 spec 升 1.3。
- Rust 镜像同 commit：`contract.rs`（三个可选字段 + `is_known_contract` 收 1.1/1.2/1.3）、`engine.rs`
  （scope 折叠、`scanned[]` 采样、provenance 透传、`version_shape`）；`corpus_parity.rs` 与
  `rust-parity.spec.ts` 整份报告逐字节 parity 全绿。

## 7. 语料（corpus 1.3，只增不改）

| 例 | 形态 | 期望 |
|---|---|---|
| `scope-default-structural` | 1.3 spec，VU 未声明 scope，`file` 检查器 | PASS；VU 与报告 `semantic_scope = structural` |
| `scope-factual-sql` | `sql` VU 声明 `factual` | PASS；报告顶层 `factual` |
| `scope-weakest-fold` | 一个 `factual` sql + 一个 `structural` file | 报告顶层 `structural`（最弱） |
| `red-scope-mismatch` | `file` VU 声明 `factual` | 构造期拒绝 `spec_error: scope_mismatch` |
| `file-scanned-sample` | 21 个命中文件 | `scanned.length = 20`，`scanned_total = 21` |
| `red-version-shape-13` | 声明 1.2 却带 `semantic_scope` | 入口拒跑 `version_shape` |
| `provenance-ok` / `red-provenance-dirty` | 声明来源且干净 / 脏 | PASS / ERROR `provenance_mismatch` |

既有 44 例逐字节不变；digest 血统写 `packages/verify/core/CHANGELOG.md`。

## 8. 明确不在 1.3 范围

- 运行时 agent 判分（D1：不开；远期 1.4+ 三条件——rubric 冻结逐字锚、runner 请求-响应入 archive 可重放、契约升版）。
- `group_by / having`（1.2 已拆到 1.3 候选池，但本批只收「报告形状」三项；`distinct` 视 D3）。
- 复审期 `review_by`（T5：先在试点里走约定，有数据再决定是否进契约）。
- 品味包的 manifest 顶层新键（归 `ARCHIVE_FORMAT_VERSION` 升版，不在契约内）。

## 9. 待裁定清单（给 D3）

1. `semantic_scope` 三值闭集与「最弱折叠」是否成立；`file`/`command` 只许 `structural` 是否过严。
2. §6 的报告版本口径选 (a) 还是 (b)。
3. `scanned[]` 采样上限 20 是否合适；是否只对 `--submission` 运行出现。
4. `distinct` 与 VU `channel` 是否同批。
