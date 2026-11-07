# M13 复核 r29：0.105.0（`14396eb`）—— 批九增补单 + r28 收口（发布物复核）

评审：302cb119（r29，评审线）｜对象：tag `v0.105.0` = commit `14396eb`｜复核日期：2026-10-21
说明：本报告是**事后独立复核**。复核时仓库已推进到 0.109.1，开发线已用 0.105.1/0.105.2/0.108.2 修掉了本报告发现的大部分问题；本文档的职责是把「当时的问题、证据、修在哪个后续 commit」钉进证据链，而不是重开处置。

## 0. 结论

- **发布物：BLOCK（P1）**。`ygl-trees@0.105.0` 的 npm tarball 含 4 条 `workspace:~` 依赖残留，空目录 `npm install` 直接 `EUNSUPPORTEDPROTOCOL`——已发布、不可安装。该缺陷由 **0.105.1（`de4a2bf`）** 修复并记账（pack-repro 改以 pnpm 产物为源 + 硬闸拒绝 `workspace:` 残留 + pack:check 5b 加 npm 真装探针；Gitea 0.105.0 unpublish、npmjs latest 回拨 0.104.0）。
- **代码：CHANGES**。2×P2（evidence_fts 影子未删、node move 重试非幂等）→ **0.105.2（`a48e7db`）** 修复；3×P3 + 2×P4（`--db` 空白 origin 误标、cascaded 类型、Q2 断言同义反复、plan 漏记同 subject 提交）→ **0.108.2（`37fd9dc`）** 修复或记账。r28 的 `$` denylist 与 `job_target` 主体实现**复核通过**。
- 仍开放（建议继续收）：① `job_target.updated_at` 在目标未变时仍随每次 `--schedule` 刷新；② 非预测断言的 `claim unlink` 会机械重算并可能覆盖 `claim resolve` 的人工仲裁。

## 1. 发布物核验（独立证据）

| 证据 | 结果 |
|---|---|
| tag `v0.105.0` | 本地与远端均指向 `14396eb` |
| npm `ygl-trees@0.105.0` | 存在；sha256 tarball = `91a44a7c38e356079a7c44c6a21af0f4ee8bd454f6f6b305f347c68f87a284c3`、1,345,792 B——与开发线声称的确定性 sha **逐字节一致** |
| Gitee release | `v0.105.0`，id 1222724，`target_commitish=14396eb` |
| **npm 可安装性** | **失败**：空目录 `npm install <tarball>` → `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"`（tarball `package.json` 内 `@deepseek-ai/cordis`、`-plugin-timer`、`cosmokit`、`schemastery` 四条 `workspace:~`） |
| 0.105.1 对照 | tarball sha `5d41df9d…`、1,356,449 B，`workspace:` 计数 0，空目录 `npm install` rc=0 → 修复成立 |

根因（与 0.105.1 的 plan 记录一致）：`pack:repro` 手工组装 tarball 时直接读仓库根 `package.json`，绕过了 pnpm 的 `workspace:` 重写；`pack:check` 5b 只验「两次同 sha + 条目与 npm pack 清单一致」，没验**可安装性**，所以门禁全绿而发布物是死的。

## 2. r28 收口复核（通过）

- **`$` 进 denylist**：`graduate.ts:269` `SHELL_METACHARS = /[&|<>^%!"`$()\u0000-\u001f\u007f]/`，`{`/`}` 不再误列（文档 §9 的「拒 `{}`」句已删，改成「双引号内是字面量，不拒」）——与 r28 P3 一致。
- **`job_target`（`graduate.ts:198,218`）**：探针（隔离 home + 0.105.0 bundle）——
  - 首次 `--schedule` → `job_target {db, origin:"report", usable:true, job_id, every_minutes:60, updated_at}`；
  - 改 `--db B` 重排 → `duplicate:true`、`job_id` 不变、**identity 字段哈希不变**（`spec_id/spec_version/run_ids/thresholds/history/span_days/data_source/created`）；
  - 不带 `--schedule` 重毕业 → 记录逐字节不变；
  - **P3-1（0.108.2 修）**：`--db "   "`（纯空白）→ `origin:"override"` 但 `db` 是报告源，payload `db_override:"   "`——冻结记录与实际排期不一致。
- **P3-2（仍开放）**：目标未变时重复 `--schedule`，`updated_at` 仍刷新（实测同一 `--db B` 两次 → updated_at 03:44:13 vs 03:33:27）。语义上「最后一次 attach 时间」可接受，但若定位为「排期意图变更时间」应改为仅变更时刷新，至少写进 §9。
- **P3-3（0.105.2 修测试）**：0.105.0 的 CLI 级 Q2 断言是**同义反复**（`expect(afterMove.created).toBe(... ? afterMove.created : afterMove.created)`，两边永远相同，永不失败）；0.105.2 改为 before-image 对比 `created/data_source/run_ids`。代码层 identity 边界本身是守住的（见上），但发布时的测试没有真正守住它。
- **P4-1**：0.104.0 CHANGELOG 的「基线不动」已改「方法变了必须按新方法重烘基线」，✓。
- **P4-2**：回执称同 subject 提交（`1eb0225`/`6e04578`）已「在 plan 记一句」——14396eb 的 plan 中未找到该句（可能记在后续提交）。

## 3. 批九增补单复核

### 3.1 `research claim unlink` / `evidence rm`（`writes.ts:307/331/367`）

- 探针：`evidence rm` 有链接 → rc=1，点名 2 个 claim 与 `unlink/--force` 指引；`--force` → 解绑 2 条、`statuses {普通 claim:"unverified", 预测 claim:"supported"}`、事件 payload `linked evidence (cascaded: 2 link(s))`。
- 预测断言：`claim link` 时 `auto_promote:false`；`claim resolve --as supported` 后 `unlink` → `recalculated:false`、状态保持 `supported`，事件 `prediction: status kept`。**Q3 答：与 predict 纪律一致**——证据增删不是仲裁，结算只走 `claim resolve`。
- **P2-1（0.105.2 修，`a48e7db`）**：`evidenceRemove` 只 `DELETE FROM evidence`（`writes.ts:391`），**未删 `evidence_fts` 影子行**——违反 AGENTS「FTS 双写：基表+影子表同事务」。实测删除后 `select count(*) from evidence_fts where id='<eid>'` 仍为 1（ghost 行，`nodes_fts` 的删除路径有先例）。修法即 0.105.2 的「同事务删影子行」。
- **P3-4（设计，仍开放）**：非预测断言的重算会覆盖人工仲裁——实测 `claim resolve --as supported` 后解掉唯一证据，状态变 `unverified`。建议在 `claims` 上区分「自动提升」与「人工仲裁」，或文档写明 unlink 会撤销仲裁（预测线已保护）。
- **P4-3（0.108.2 修）**：`source rm` 的 `cascaded` 是 boolean，`evidence rm` 无该字段；0.108.2 统一为 number。0.105.0 回执「事件 payload 带 `cascaded: N link(s)`」属实（事件字符串），但 JSON 面不一致。

### 3.2 `node move <key> --to <tree>`（`techtree/model/src/writes.ts:277`）

- 探针：树内有边 → rc=1 点名 `has 1 edge(s) inside tree 't-a'`；无边的节点 → 成功迁移（`state_rows:1, closure_rows:1`），`nodes.tree_id`、`node_state.tree_id`、`node_closure.tree_id`（自环行 depth=0）均迁到目标树；目标同名 → rc=1 点名；同树 → rc=0 `moved:false`、`! node already in tree`。
- **P2-2（0.105.2 修）**：成功搬走后**重试同一命令** → rc=1 `node not found: c`（写命令幂等契约要求 rc=0/duplicate）。0.105.2 在源树查空时回查目标树，返回 `moved:false, duplicate:true, rc=0` + `node.move.noop`；0.108.2 再补 `from/to` 血统校验，防「节点本来就在目标树却被当成重试」的假幂等。
- **Q2 答：表覆盖无遗漏。** 带 `tree_id` 的表共 5 张：`nodes`、`node_edges`、`node_closure`、`node_state`、`node_index`。迁移覆盖 `nodes` / `node_state`（按 node_id 的全 context）/ `node_closure`（`ancestor=? OR descendant=?`）；`node_edges` 因「有边即拒」的前置条件无需迁；`node_index` 两树 `markDirty`（重建延后到 `node index`，输出已提示）。`nodes_fts` 无 `tree` 列；`node_conditions`、`relations` 按 node id 关联、无需改。复核时按 **node id**（不是 key）查询已确认 state/closure 随迁。
- 观察（非缺陷）：迁移后索引重建要显式跑 `node index`；若读命令依赖 `node_index`，建议文档补一句。

### 3.3 可发现性与并行会话纪律

- `node rm`：help 合并行 `node list | show <key> | … | rm <key>` 与 llms.txt 独立行均可见 ✓（我最初按字面 `node rm <key>` 在 help 里 grep 未命中，是展示形式差异，不是缺失）。
- `docs/scenarios.md`（0.105.0 版）已写「`-t/--tree` 单次覆盖或各自 `project use`/`tree use`，别依赖共享指针」✓（0.106.0 起再加 `YGL_SESSION` 注入）。

## 4. 门禁（开发线声称；本轮无法在 14396eb 干净复跑）

- 开发线报：unit 522（76 文件）/ Rust 31 / demo 128 / contract 100 / readme 54 / ratchet held（认账后 bundle 648067）/ pack:check PASS（5b：连打两次同 sha + 与 npm pack 条目清单一致）。
- 复核时仓库已推进到 0.109.1，无法在 14396eb 复跑 `pnpm test`；发布物侧已独立核验（sha/npm install/Gitee/tag）。
- 另附环境观察（与本版评审无关）：本会话中全新 `db init` 在 bundle 路径**偶发挂起**（WASM 写入/异步技能导入，0.109.1 也复现，tsc 树与 bundle 均出现过），本报告探针改用 schema-v12 预置 DB 完成。建议开发线单独排查——干净安装是用户第一公里。

## 5. 证据索引

- 发布物：`tmp/r29/ygl-trees-0.105.0.tgz`（sha `91a44a7c…`）、解包 `tmp/r29/pkg/package/`（package.json 4×`workspace:`）；对照 `tmp/r29/ygl-trees-0.105.1.tgz`。
- 探针：`tmp/r29/probe.cjs` + 手工命令（隔离 home：`tmp/r29/home/{a,b,c}`、`tmp/r29/{b2,c2}`）；应用安装实测：`tmp/r29/inst`。
- 代码引用（14396eb）：`packages/ops/tools/src/graduate.ts:198,218,269`；`packages/ops/tools/src/verify-cmds.ts:691,736`；`packages/research/pipeline/src/writes.ts:307,331,367,391`；`packages/techtree/model/src/writes.ts:277,313,315-316`。
- 后续修复：`de4a2bf`（0.105.1 打包）、`a48e7db`（0.105.2 fts/node-retry/Q2 断言）、`37fd9dc`（0.108.2 空白 `--db` / cascaded / node-move 血统）。
