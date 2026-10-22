# Changelog

## 未发布

GitHub #34 修正（0.114.1 / 0.114.2 的回归：舰队全部材料 lint `ok:false`、prepare 拒冻）：**子句按规则界定 +
不冲突的定位语法 + 舰队材料消费方夹具**，对齐审查席在 #34 的设计提案 a–d。原修复的意图保留——丢一条判据、
错一个锚点仍然被点名，prepare 不静默冻结；孤儿评审也被点名。

- **a. 子句 = 匹配子句模式的行**（`packages/verify/core/src/prepare.ts`）：默认舰队约定 `^([A-Z]+[0-9]+) `
  （捕获组 = 子句 id）；标题 / `##` 小节 / 空行 / 散文（`验收对象：…`）按规则不在范围内，不再靠豁免。
  材料可在冻结时声明自己的模式：`verify submit --clause-pattern <regex>` 写进 `material.json`
  `clause_pattern`（参与 `material_id` 哈希；未声明时 id 不变），prepare（CLI / WebUI 作业端点）只认冻结的模式；
  `lint-candidates --clause-pattern` 面向裸文本。缺捕获组或非法 → rc=2。同 id 重复声明 → 覆盖问题。
  **SKIP ≠ OK**：声明了模式却一行不中 → 覆盖问题（lint `ok:false` / prepare `error`）；默认模式一行不中 →
  具名跳过（lint `coverage_skipped:true`、`coverage.enforced:false`，`issues[]` 增一条 `level:"warning"` 的 COVERAGE
  条目——`ok` 只计拒绝，保持 prepare 投影；prepare ready 记录
  `[P1c] no clause lines matched pattern … — clause coverage not enforced (a skip, not a pass)`，`--json` 带 `coverage`），
  不再逐行造出子句。prepare 记录（`prepare.json` / `attempts/*.json`）增结构化 `clause_scope: {pattern, declared, enforced, clauses}`。
- **c. 定位语法**：`[文件]#<片段>` 先按子句 id 解析（`#S1`、`#L2` 是 id，不再被当成第 1/2 行）；物理行写
  `#line=<n>`。材料有子句时，无法解析的片段是 P1 拒绝，诊断只按子句计数（`declares 3 clause(s): S1, L2, S3`），
  行诊断只按行计数（`material has 12 line(s)` / `line 2, which is blank`）。旧的 `#L<n>`/`#S<n>` 行号写法删除，
  `clauseLineOf` 导出随之移除（0.114.1 引入，无消费方）。
- **覆盖认领收紧**：候选的 locator 解析到该子句（或其行），或 `source_clause` 含整行子句，才算认领；只引片段
  又无可解析 locator 的候选不认领（`S1` 不再顺带覆盖 `S10`）。`coverage` 输出增 `pattern` / `enforced`，
  `uncovered[]` 增 `id` / `line`。
- **b. 豁免只认子句 id 或原文 + 必填 reason**：`{id | locator | text, reason}` 恰好一个指明字段；裸字符串条目 rc=2
  （不再隐式补 reason）；`#line=<n>` 豁免被拒（编辑会静默改靶）；豁免已被覆盖的子句 → 问题。
- **评审配对**：prepare 把评审文件的 `source_clause` 交给构造面，**孤儿评审**（无候选携带）→ `error` +
  `[P3] orphan review`（CLI 与 WebUI 作业端点）；`lint-candidates --reviews <file>` 同源检查（孤儿评审 / 无评审候选 →
  `stage:"REVIEW"`）。
- **d. 消费方夹具进发布门禁**：`packages/verify/core/tests/fixtures/fleet/` 冻结 4 个舰队验证器仓（review 7 /
  webui 6 含 view / fleet 2 / design 9）共 24 份真实 spec 的 `material.md` + 已提交 `candidates.json` / `reviews.json`
  （来源 commit 见 `manifest.json`；全部带标题/散文/纪律节）。contract 15 对全部 24 份跑 `lint --text --reviews` 与
  `submit → prepare --draft`（快照 schema 由候选谓词合成，P4 空库红队照跑），任何非 ok / 非 ready 即发布阻断。
  单测：`fleet-fixtures.spec`（库面：全部 lint ok + prepare ready；S/L 开头 id 的三份材料上做丢子句 / 坏锚点 /
  孤儿评审负例；在 0.114.2 的 `prepare.ts` 上 57/58 红）+ `verify-fleet-fixtures.spec`（发布产物：全部 ok/ready +
  CLI 负例 + submit 冻结模式 + 裸字符串豁免 rc=2）。
- 契约面：spec 与报告形状不变（`contract_version` 1.2、`corpus_version` 1.2）；构造面加法字段（`material.json`
  `clause_pattern`、lint `coverage_skipped`、prepare `--json` `coverage`）；`docs/verify-contract.md` §1.6 改写。
  charter 不涉及。Rust 侧不镜像 prepare / lint，无改动。
- 门禁：contract 15 改写（id 子句 + 按 id 豁免 + 行号豁免拒绝 + 跳过可见 + 舰队夹具 lint/prepare 24/24），
  141 → **144**；`scripts/contract-audit.sh` 合并 0.114.3 后按 #37 机制显式重登记一次（`verify/meta.json`
  `reregistrations[]` 追加 591755c2 → 新 sha 一条，reason 写明合并前本分支三次旧机制重登记 7b367f41 / c241e42c / e6bf02b0）。
- 棘轮：bundle 基线 739,621 → **757,018 B**（本 PR 自行抬升，**需维护者显式认账**；master 的上限是 754,413）。同源对比：
  0.114.2 自身 748,195 B，本修正 head 757,602 B（+9,407：子句清单 / 定位解析 / 评审配对 / 豁免校验与其可操作诊断文案；
  已把新增顶层 JSDoc 改为 `//` 注释省下约 2.3 KB——tsdown 保留顶层 JSDoc、剥离行注释）。只认 bundle 一项，web dist 与冷启动保持原 win32 基线不动。
## 0.114.3

验证席派单 #36/#37（双 P3，其中 #36 为红门）。

- **#36 墙钟硬编码（红门）**：`predict-cli.spec` 的 due fixture 用 `created=2026-10-10 / deadline=2026-10-17`
  字面量，过了 2026-10-21 后每个清洁检出的 unit 门恒红。改为**相对 today 滚动**（created = 今天−11d、
  deadline = 今天−4d、`days_left` 恒 −4），不再有日历日期会过期。
- **#37 重登记审计出域**：`meta.reregister` 原先只写操作员本地 DB，clone/评审者看不到理由，且 raw SQL
  绕过写服务纪律。改为把审计记录追加进 `verify/meta.json` 的 **`reregistrations[]`**
  （{path, old_sha256, new_sha256, reason, at}，append-only，**随仓库走**）；`meta-tooling --reregister`
  用一次原子写同时更新登记与审计（无本地 DB 依赖）。R2 校验该数组形状（path/old/new/reason/at）；
  contract 12c 追加**链一致性**断言：每条记录的 path 已登记、reason 非空、at 可解析，且每条路径的最后一条
  `new_sha256` 必须等于当前活 sha。本仓三笔历史重登记已迁入（contract-audit.sh ×2、meta-tooling.mjs ×1）。
- 门禁：unit 706 → **707**；contract 141（12c 加强，条数不变）。

## 0.114.2

r32 讨论催办（GLM Q3）：**tooling 登记漂移修复显式化 + 可审计**，并修掉本仓 `verify meta .` 的 R3 漂移。

- **漂移修复**：`scripts/meta-tooling.mjs` 重写为三模式——`--check`（只比对）、
  `--reregister <path> --reason "<why>"`（显式重登记）、`--add <path> --role`；**删除隐式 auto-rehash**
  （无参数 = usage rc2）。重登记**先写 `meta.reregister` 事件**（events：path/old_sha256/new_sha256/reason/actor，
  append-only、level=warn）再改 `verify/meta.json`——事件写失败则拒绝改索引（fail-closed）。
- **本仓漂移**：`scripts/contract-audit.sh`（0.114.1 contract 15 改动）与 `scripts/meta-tooling.mjs`（本版改动）
  两条登记已按上述流程重登记；`verify meta .` 恢复 PASS（R1/R2/R3/R5a）。
- **机械门**：contract-audit 增 12c——`meta-tooling --check` 必须 rc=0（与 `verify meta` R3 同源）；
  contract 140 → **141**。
- 测试：`meta-tooling.spec`（drift 红 → 无 reason 拒 → 显式重登记写事件+索引 → check 绿 → 无 drift 拒重登记 →
  bare run usage rc2）；unit 704 → **706**。
- charter §4.4 R3 补记⑤：登记漂移只能显式修复，禁 auto-rehash。

## 0.114.1

GitHub #34（验证席 P2 · 构造面覆盖缺口）：判据不得静默消失——prepare / lint 增加**冻结子句覆盖**检查。

- **子句模型**：材料每个非空行=一条冻结子句（`#L<n>`，`#S<n>` 同义别名；可带文件名前缀）。
  `anchor.locator` 为子句式时**必须命中存在的子句且该子句含 quote**（#S9 类悬空锚点拒）。
- **覆盖检查**：每条子句必须被**至少一个通过 P1 的候选**的 `source_clause` 覆盖；prepare 在 P1–P3 之后、
  P4 之前校验，未覆盖 → `verdict:error` + `diagnostics[stage=P1c]` 点名（**不冻 ready**，防「丢一条规则
  的 spec PASS 本应 FAIL 的数据」）；`verify lint-candidates --text` 同源检查，输出增
  `coverage:{clauses,covered,exempted,uncovered}`、`issues[].stage="COVERAGE"`。
- **具名豁免**：`--coverage-exempt <file>`（JSON 数组或 `{exempt:[{locator,reason}]}`），缺 reason /
  locator 不存在 / 格式非法 → 拒（不可审计的豁免不生效）。
- 契约面：报告形状不变（构造面检查，`contract_version` 1.2）；`docs/verify-contract.md` 补记 P1 与 §1.7 前口径。
- 门禁：contract-audit +2（contract 15 覆盖/豁免）→ **140**；unit 700 → **704**。

## 0.114.0

- **charter v1.2（docs-only，0.113.2 之后）**：#29 修正谱系——R5 权威拆分（R5a 静态合规 / R5b 审计方
  内嵌能力表、默认不执行）、§4.7 增 `capability_version` 列与 `unshipped` 无界、verbatim 提取规则入表注；
  依据 fdc757f6 对 #29 的裁定。无代码面变更。
- **#27 方案 T1（#28 残留）：归档内 `submission-scan.json` 改为白名单投影**。0.113.2 只去掉了侧车顶层的
  `dir`，逐 scan 的 `dir`（本机绝对路径）仍进了包。现在归档项只含
  `{run_id, spec_id?, scans[]: {vu_id, files, ignored, matched[]: {path, sha256, size}}}`；`matched[].path`
  非相对（绝对 / `..`）→ 拒绝归档并点名。同一份扫描在任何机器上产出同一 zip 字节；归档内 grep 不到
  `/Users/`、`/private/`、`/tmp/`；字节篡改仍 fail-closed。契约 §7.2 补记 0.113.1/0.113.2 新增的三类条目与
  本形状。报告形状未动（契约 1.3 批另议，见 `docs/verify-contract-v1.3.md` 草案）。
- **#27 方案 T7a（charter v1.1 §4.4 / v1.2 R5a）：`verify meta` 读 `meta_index_version: 2` 登记制**。
  - v2 索引新增 `orchestration[]`（`{path, sha256, role ∈ collect|invoke|aggregate-input, replaced_by, sunset}`）
    与 `tooling[]`（`{path, sha256, role ∈ build|test|release|gate}`）；**R2** 校验登记形状（键集、角色闭集、
    64 位小写 hex、路径仓内相对且不重复）。
  - **R3 豁免改登记制（v2）**：扫描面 = git 看到的文件（已跟踪 + 未忽略的未跟踪；`dist/` 等 gitignored 构建产物不在面上；
    非 git 目录则全树），只豁免 `tmp/` 与依赖根（`node_modules/`、`vendor/`）；**目录名白名单在 v2 下退场**（评审 P2：
    0.112.0 的按名放行让未登记的 `scripts/run.mjs` 驱动 `verify run` 而 R3 PASS，#22 绕过仍在）。其余可执行件（v2 起含 `.py`）
    只在登记于 `orchestration[]`（有效性归 R5a）或 `tooling[]`（sha256 必须一致）时放行；列有 spec 的仓库里 `tooling[]`
    文件不得调用 `verify run|prepare|submit|archive`——机械匹配同时覆盖 shell 形式与舰队惯用的 argv 数组形式
    `ygl(["verify", "run", …])`（评审 P3）。v1 索引仍按 0.112.0 规则（目录白名单 + `freeze.mjs` 硬编码）只读兼容。
  - **本仓登记**：`verify/meta.json` 升 v2，25 个已跟踪脚本（`scripts/`、`benchmarks/`、`examples/`、`freeze.mjs`）登记为
    `tooling[]`；新增 `scripts/meta-tooling.mjs`（`--check` / 刷新 sha / `--add`）维护登记，contract-audit 12 的
    `verify meta .` 让登记漂移变红。`.ts` 不在 charter 的扩展名闭集里（Node ≥22 可直接运行 .ts；本仓 254 个 .ts 源文件）——
    留给 charter 裁定，引擎按闭集扫描。
  - **ratchet 认账**：bundle 722,820 → 739,621 B（+16.8 KB，超 2% 容差；meta v2 登记制 + R5a + git 扫描面 + 归档投影），
    只重设 `bundle_bytes` 基线；冷启动与 web 基线不动（基线由属主的 win32 机器测得，本机不得覆盖）。
  - **新增 R5a**（仅 v2 报告）：`orchestration[]` 每条 `path` 在 `verify/orchestration/` 下、sha256 一致、
    `replaced_by` ∈ §4.7 命令 token 闭集（`verify collect` / `verify snapshot build` / `verify tree run` /
    `verify self-check` / `verify package` / `verify notify` / `verify import-report`）、`sunset` 为完整
    `MAJOR.MINOR.PATCH`；**不做时钟比较**（R5b 审计面显式开启，本版未提供 `--capabilities`，#29 口径）。
  - **版本映射**：`META_INDEX_VERSIONS = [1, 2]`，`META_VERSION` 1.0 → **1.1**；v1 索引按 v1 规则只读兼容、
    不读登记（报告仍是 R1–R3 三条）；`meta_index_version ∉ {1,2}` 按名拒绝，闸的 `meta_index_unknown` 语义
    随之收窄为「未知」。报告增 `meta_index_version` 字段（无索引为 null）。
  - 测试：verify-meta +4（v2 空登记 / tooling 登记与 sha 漂移与形状 / tooling 驱动验证 / R5a 四缺陷 + v1 不读登记）、
    meta-gate +1（v2 登记过闸）；顺手修 #25c walk-up 用例在 macOS 上的 realpath 比较（`/var` ↔ `/private/var`，
    #26 口径）；archive/submission-scan 单测扩成「任何层级无 `dir`、无本机路径、两次构建同字节、非相对路径拒绝」。
- **#27 方案 T6：渲染面透出语义边界（缺省按 structural）**。契约 ≤1.2 的报告没有 `semantic_scope` 字段，
  此前任何渲染面都看不出「这份 PASS 在哪一层成立」——父验证器对子归档的 PASS 容易被读成「子结论为真」（#27 Q3，K3 双钉）。
  - **WebUI 报告看板**：运行记录每行、报告头各带一个「边界」标签（structural「仅结构」/ factual「事实」/ semantic「语义」）；
    无字段 → 显示「仅结构·缺省」并在报告头给**一行**说明「父 PASS 不代表子结论为真」；VU 表只在报告真带 `semantic_scope`
    （契约 1.3 起）时才加「边界」列，缺省不逐行重复。说明走 Tooltip + 可聚焦 span + 标签内视觉隐藏文本
    （键盘 / 触屏 / 读屏可达；不给无 role 的 span 挂 `aria-label`——ARIA 1.2 禁止命名 generic 元素）；
    缺省提示只说「按最保守读」、不描述检查器实际做了什么。`ReportDetail` / `ScopeTag` / `scopeLabel` / `scopeHint` 可测导出——
    种子库没有报告，运行时视图验证器画不到新 UI，其证据是夹具静态渲染单测（监督席评审 ①②③）。
  - **服务端列表投影**（`verify-web.ts listReports`）：`semantic_scope` 原样透传，无字段为 `null`——服务端不替报告发明值，
    兜底在 UI。
  - **CLI**：`verify run` / `verify report <run>` 的人类输出首屏增一行 `semantic_scope <值>`；无字段时写
    `structural (缺省：报告无 semantic_scope 字段，按最保守读——父 PASS 不代表子结论为真)`。**JSON 面原样**（报告不可变、形状冻结；
    字段本体属契约 1.3 批 T4）。
  - **闭集之外不失败开放**（评审 P3）：`semantic_scope` 不在 `structural | factual | semantic` 内的值（拼错、大小写、未来新值），
    WebUI 标签显示「仅结构·未知值」、报告头给一行说明，CLI 行写 `structural (未知值 "<原值>" 不在闭集内，按最保守读…)`；
    任何面都不原样透出未知值。
  - 测试：`verify-report-scope.spec`（CLI 两面 + JSON 不变 + 投影 null）、`verify.spec.tsx` +2（缺省/闭集映射）。

- **#29 T8 补裁落地（charter §4.4 R3 范围 + `META_VERSION` 1.1→1.2）**：R3 扫描面=git 可见文件；
  **gitignored 路径不属 R3 面**（其内验证驱动脚本由 P2 证据规则管辖，路径无关；`tmp/` 唯一探索白名单；
  全局 gitignore 接受为不可机械检面）；可执行扩展名闭集 v2 起含 `.py` 与 **`.ts/.mts/.cts`**；产品源码根经
  **`source_roots[]`** 显式声明（具名子目录，禁 `.`/`..`/绝对/反斜杠/尾斜杠，非法→R2 形状拒绝；
  **未声明即全扫**；根级闭集文件不被 source_roots 覆盖，按登记处置）。本仓声明 `["packages","apps","tests"]`
  并登记 `vitest.config.ts`（tooling role=test）。审计面对「source_roots 过宽」的 warning 记 §4.7 待办（不实现）。
  测试：verify-meta +3（source_roots 豁免/非法值/严格全扫）。

## 0.113.2

GitHub #28（验证席 P2 · charter P5）：`verify run --submission` 的 file 检查器扫描面留痕。

- **扫描 trace**：file VU 执行时（PASS/FAIL/NEEDS-MATERIAL 均记）经引擎内部 `onFileScan` 回调产出
  `{vu_id, dir, files, ignored, matched:[{path,sha256,size}]}`；CLI 写工作区侧车
  `verify/submission-scans/<run_id>.json`，`verify run --json` 增 `submission_scan` 摘要（path/files/dir）。
- **archive 一等 item**：构建归档时把 trace 以 `submission-scan.json`（去绝对路径）入包，matched 文件字节
  按内容寻址入 `submission/<sha256>`（role=`submission-file`，`original_name` 保留原相对路径）；
  `manifest.items` 绑 sha、**manifest 顶层形状不变**；归档时重算哈希，字节已变即 fail-closed
  （`submission file changed since the scan`）。
- **契约面**：report `evidence` 形状与 `data_source` **未改**——路径清单/逐文件哈希入 report 属报告形状
  变更（契约 1.3），与 #16 P1 raw-material provenance、#27 Q3 `semantic_scope` 同批升版；本版先用
  sidecar + archive 把 P5 的可追溯性补齐（PASS 可回指被检字节、字节可复原）。
- 测试：`submission-scan.spec`（CLI 端到端：trace 侧车 + report evidence 键集冻结 + archive items）、
  archive 单测（入链 + 字节篡改 fail-closed）；unit 680 → **682**。

## 0.113.1

GitHub #25 / #26（验证席 P2/P3）：bypass 进证据链、meta 根 walk-up、跨平台 realpath；charter 补齐闸的覆盖面。

- **#25a `--no-meta` 逃逸进证据链**：submit/prepare 在 material/spec 目录落 `meta-bypass.json`
  （canonical JCS，`{command,cwd,repo,bypassed_at,payload_sha256}`）；archive 把它作为**一等 item**
  （role=`meta-bypass`，manifest.items 绑定字节 sha），**不改 manifest 顶层形状**（冻结形状守卫不变）；
  `verifyArchiveBytes` 全链可验。events 的 `meta.bypass` 携带同一份 provenance。
- **#25b 闸的覆盖面（fdc 裁定）**：meta 是准入闸，骑在 `submit`/`prepare`；`run`/`archive` 不二次 gate，
  以 provenance 追溯承接 P5。charter §4.2 明写，防「漏实现」误读。
- **#25c meta 根解析 walk-up**：`verify meta <repo>/subdir` 与自动检测从给定路径向上找验证器标记/git 根；
  自动检测阶梯**限定在 git 仓内**（普通业务目录静默），且 marker 不再把工作区 `verify/` 数据目录误判为验证器仓库
  （改为 AGENTS.md / `verify/meta.json` / `verify/specs`）。
- **#26 realpath 归一**：cwd/repo 双侧 `fs.realpathSync`，macOS `/var`→`/private/var` 软链不再产生审计差异。
- 测试：meta-gate（含 bypass sidecar、subdir 回显、realpath 断言）、verify-meta（子目录 walk-up）、
  archive（provenance item 可验 + manifest 形状不变）；unit 677 → **680**。

## 0.113.0

charter §4.2 翻转点：**meta 准入闸默认硬拒收**（阶梯检测）+ **版本键控机械门**。

- **检测阶梯**（fdc757f6 裁定 A 加固版）：
  1. `--meta-repo <path>` 显式 → 硬拒；
  2. cwd 在 git 仓且带验证器标记（AGENTS.md / verify/ / verify/meta.json 任一）→ **默认硬拒**；
  3. cwd 在 git 仓但无标记 → **warn+点名 R1 提示后跳过**（缺 AGENTS.md 的验证器仓库得到 R1 压力，
     门不静默消失）；
  4. cwd 非 git 仓（业务随机目录）→ 静默跳过（产品面无感）。
- **`--no-meta` 逃逸**：允许应急注册，但必须**持久化审计**——每次 bypass 同步写入
  `events(kind="meta.bypass", payload={command,cwd,repo})`；写入失败则拒绝 bypass。JSON 回执带
  `meta_bypassed:true`。
- `--require-meta` 保留为幂等显式开关（不再改变默认），help 用 deprecation-style 标注；CHANGELOG/help
  双声明翻转。
- **机械门（本版随版本落地）**：contract-audit 新增 contract 14——`version >= 0.113.0` 时断言
  `META_DEFAULT_POLICY = "hard-for-verifier-repos"`、阶梯检测（gitRootOf）与 bypass 落账同时存在；
  版本键控在人读声明之外提供机器拦截。
- 门禁：unit 675 → **677**（ladder 3/4 + bypass events 三例）；contract 135 → **136**。

## 0.112.0

charter §4.3 落地：**`verify probe --matrix`** —— 评审席两代临时探针（sealprobe/sigprobe）升为 CLI 命令，
复核证据必须来自命令（P2 自我约束的正式化）。

- **16 向并集**（开发席八 + 评审席篡改八）：
  `envelope` / `signature` / `digest` / `timestamp` / `escalation` / `injection` / `cross-machine` / `replay`
  + `tamper-spec` / `tamper-engine` / `tamper-footer` / `noncanon` / `sig-byte` / `unknown-key` /
  `retired-key` / `resign-fv`。
- **确定性/离线**：fixture 用 RFC8032 确定性测试种子（`sha256(probe-label)`）自签，禁网、禁生产钥；
  `timestamp` 探针以「同输入两次封包字节逐字节相同」验证无时间/随机泄漏。
- 输出 `{probe_version, target, seeds, probes:[{probe,verdict,detail,evidence_sha256}], verdict, checked_at}`；
  `--matrix` 全量、`--only <name>` 单探针、`--target <sealed-file>` 以真实封包为基；失败不中断、
  rc 镜像 verdict（0 PASS / 1 FAIL / 2 用法）。`retired-key` / `resign-fv` 保留（fdc 0.99 复核实证语义）。
- charter §4.3 状态更新为已落地；contract-audit 新增 contract 13（16 向全 PASS + 未知探针 rc=2）→ **135**。
- **#22 meta soundness（评审席 P 级）**：R2 无索引域从「PASS skipped」改为 **NEEDS-MATERIAL**（zero-scan
  不是通过；闸映射 `meta_unverified`），R3 改为**全树扫描**（工具目录白名单，`lib/probe.mjs` 这类散件会被拒），
  charter §4.4 口径同步；`verify meta`/meta 闸测试补零扫描与全树散件两例。
- 门禁：unit 667 → **675**（probe 5 + #22 三测）；**ratchet 认账**：bundle 703,423 → 722,820
  （+19,397 B，probe 矩阵 + meta 全树扫描），显式 `node scripts/ratchet.mjs --write` 重设基线。

## 0.111.1

GitHub #21（prepare 确定性拒重放）+ charter §4.2 v2 准入闸落地（案 A：meta 拒收走 `meta_error`）。

- **#21 prepare 确定性拒跨轮去重**：P1/P2 是确定性拒绝（同候选跨轮必得同一结论），轮循环只为 P3
  盲审重试而存在——现按内容键 `(stage, source_clause, reason)` 跨轮去重并保留首次顺序；一整轮没有任何
  候选进入 P3 时直接收敛（1 候选 × 3 轮不再产生 3 条 rejected）。**lint 拒绝集与 prepare `rejected`
  从「集合相等」升级为「列表相等」**（同源同序，测试锁死）。
- **meta 准入闸（charter §4.2，案 A）**：`verify submit`/`verify prepare` 增加 `--meta-repo <dir>`
  （默认 cwd）与 `--require-meta`。默认 **warn**（失败仅警示 + `meta_warning` 字段/`diagnostics[].stage=META`）；
  `--require-meta` 时拒收：`verdict=ERROR`、rc=1、单 JSON 对象带 `meta_error` 三码——
  `meta_failed`（R1/R2/R3 失败）、`meta_unverified`（无 AGENTS.md/未跑）、`meta_index_unknown`
  （`meta_index_version` 未知）。`evidence.spec_error` 五码**冻结不动**（跨层：接受面尚无 report 对象）。
- 0.113.0 将翻转为硬拒收默认并落地版本键控机械门（charter §4.2），help 已用 deprecation-style 标注。
- 门禁：unit 660 → **667**（#21 两测 + meta 闸五测）；contract 133 不变。

## 0.111.0

**验证器生态根规范（charter）入档 + `verify meta` v1**（属主令 2026-10-21 13:18：「验证器的开发与
运维以及使用的规范，一切必须以 ygl-trees CLI 为主，禁止临时编码执行」）。契约/语料零变更。

- **`docs/validator-charter.md` 入档**：五根原则 P1-P5（单一执行面 / 禁止临时编码执行且对评审席自身生效 /
  元验证先于一切 / 判据语言封闭七型 / 审计链完整）+ §1 开发、§2 运维、§3 使用、§4 执行机制（v1/v2 闸/
  探针 CLI 化/元规则 R1-R4）、§5 文件关系。生效依据＝属主令本身。
- **`verify meta [<repo>]` v1**（charter §4.1）：验证器仓库准入规则 R1 AGENTS.md 根存在、R2
  `verify/meta.json`（`meta_index_version: 1` 单一来源）↔ `verify/specs/*.json` 双向一致（含 sha256；未知版本按名拒绝）、R3 无散落可执行验证件（仓库根无
  游离脚本、`docs/**` 无 `*.mjs/*.js/*.sh`、`tmp/` 必须 gitignored）；`--json` 单对象，
  **rc 镜像 verdict**（0 PASS / 1 FAIL / 2 用法）。**0.105.x 未落 meta（落的是 self-check 递归门）**，
  v1 为 greenfield，charter §4.6 已如实对账。
- **过渡排期**：0.111.x 在 submit/prepare 接受面默认 warn + `--require-meta` 拒收；**0.113.0 翻硬拒收**
  并同时落地版本键控机械门（contract-audit/pack:check 断言），help 用 deprecation-style 前瞻标注。
- **探针 CLI 化（0.112.0）**：`verify probe --matrix` 16 向并集（开发席八向 + 评审席篡改八向含
  retired-key/resign-fv），RFC8032 确定性种子、离线、`--target sealed|workspace`。
- 门禁：unit 656 → **660**；contract-audit 130 → **133**（contract 12：meta PASS/FAIL/缺仓用法）；
  **ratchet 认账**：bundle 685,095 → 703,423（+18,328 B，meta 模块/命令/契约 12 与 charter 文档），
  显式 `node scripts/ratchet.mjs --write` 重设基线；cold/web 保持。

## 0.110.3

0.110.x 队列批（F1/F2/F4 + `db init` 批量 + r29 Q1/Q3）+ 期间外部复审的 #19/#20 安全/发布修复。
契约版本与语料零变更；schema **无**列变更（Q3 仅加幂等索引）。

- **F2 `research claim show` / `research evidence show`**：单条全字段 + 双侧关联（claim↔evidence、
  evidence↔claims、source 摘要），`--json` 单对象；非本项目的 id 点明归属并给 `-p` 出路（读命令，不写）。
- **F4 跨项目 link 提示**：`research claim link` 与 `rel add` 在两端存储 project 不同时输出一行提示，
  JSON 增 `cross_project` 事实字段（实体 project 字段是唯一判据；任一端无项目→不提示；link 不阻断）。
- **F1 写回执放大目标**：写命令 JSON 增 `project` / `project_source`（闭集 `flag|env|session|global|only|none`）；
  多项目工作区里未显式 `-p` 的写会在 **stderr** 打 cwd 提示（JSON stdout 仍单对象）。
- **`db init` 冷启动批量导入**：单事务 + 每技能 savepoint 容错；`skill.import` 一条汇总事件替代 N 条；
  部分失败显形（`failed[]` + rc=1）；二次 init 幂等。实测冷启动 **85-86s → ~0.8s**（观察值，不设硬门）。
- **r29 Q1**：`job_target` **change-only** 刷新（同目标重复 `--schedule` 不动 `updated_at`、不重写冻结记录），
  输出增 `job_target_retargeted`。
- **r29 Q3**：claim 仲裁锁——最新 `claim.resolve` 事件锁住状态，后续 link/unlink 不再静默改写
  （`auto_promote:false` 如实回执）；`claim.unresolve` 释放锁；**无 schema v13**，纯事件读 +
  幂等索引 `idx_events_kind_entity(kind, entity_id, ts)`（测试断言查询计划走索引、不全表扫）。
- **#19（P2 安全）**：谓词 `op` 闭集双层校验（prepare P2 typed 拒 + `renderCondition` 入口拒），
  杜绝 `op:"= 1 OR 1=(SELECT …)"` 类 SQL 片段注入；红测试覆盖。
- **#20（P3 发布闸）**：`package.json` 双 `prepublishOnly` 键合并为单链
  `prepublish-guard && pnpm test && pnpm pack:check`；新增重复键 lint 测试防回归。
- 门禁：unit 636 → **656**；contract 130 不变。

## 0.110.2

GitHub #17 / #18.1 / #18.2（zhujun，0.110.0 发布后三单）。契约/语料零变更；迁移面：无。

- **发布序 guard（#17）**：`scripts/prepublish-guard.mjs` 校验发布 tag 必须命中 HEAD
  （`git tag --points-at HEAD` 含 `v<version>`）且可选校验远端（`--remote <name>`，
  `--no-network` 跳过）；`package.json` 的 `prepublishOnly` 同源调用。
  关键事实：`npm publish <tgz>` **不执行**生命周期钩子，exact-bytes 发布流必须显式跑 guard——
  两层闸（SOP 脚本 + 目录发布 backstop）已写进 `docs/release.md`。
- **lint `schema_skipped`（#18.1）**：`verify lint-candidates` 输出增 `schema_skipped`（与 `p1_skipped`
  并列），无 `--db` 时人类面点明「P2 schema skipped」。**口径订正**：0.110.0 的
  「lint 拒绝集 == prepare `rejected_detail` 集」只在提供 `--db` 时成立；无 `--db` 时只比形状。
**file 构造面订正 + 附件 staging（#18.2 / cf31945f 回归）**：`verify-contract.md` 更正
  「P2 直接拒 file」的错误表述（`doc-governance.md` 同项随该文件在途治理批并入，本版未动它）——
  P2 放行 file（glob/ignore 非通吃）。prepare 现在把 material 附件
  从 blob store **stage 到临时目录**供 P4 红队跑 file 检查器：**带附件提交（`verify submit --attach`）的
  file 候选可正常冻版**（修复 v0.107 后 cf31945f 报告的 22 条 file 判据全量 P4 拒绝）；无附件时才给
  可操作 P4 诊断（提示 `--attach`），不再泄漏引擎裸文案。工作区侧文件检查仍可走 `verify run --submission`。
- 门禁：unit 629 → **635**（guard 四测 + lint 两测）；contract 130 不变。

## 0.110.1

GitHub issue #14（zhujun，P3×2）+ 0.110.0 发布事故的防复发门（契约/语料零变更；迁移面：无）。

- **claimLink 状态重算统一（#14 ①）**：删掉 `claimLink` 内联的状态推导副本，与
  `claimUnlink`/`claimResolve`/`claimUnresolve` 共用 `recomputeClaimStatus`——两路径不再漂移
  （内联版此前不写 `updated` 戳）；prediction 的「链接不自动升格」守卫与各自事件文案保持不变。
- **`agent brief --json` 增 `db` 字段（#14 ②）**：报告本次 brief 解析到的工作区库路径
  （`--db` 显式时即该路径）；此前 `--db` 在 payload 里不可见。
- **`scripts/pack-repro.mjs` clean-tree guard**：打包前检查 `git status --porcelain`（含 untracked、
  排除 gitignored），脏工作树直接拒绝（`--allow-dirty` 仅供本地实验、`--check-dirty` 输出同源判定）；
  根因=0.110.0 handoff 在主树（含另一会话未提交 docs + 旧 CRLF 检出）出包，官方字节失效。
- **测试夹具泛化**：`predict-list.spec` 的 settler 夹具 `dsh/ae07421e` → `dsh/demo0000`（C+ 扫描残留）。
- 门禁：unit 623 → **629**（#14 两测 + guard 三测）；contract 130 不变。

## 0.110.0

**可发现性主题版**（用户令 m04180；批十四四件 + F6）。契约形状零变更（contract/corpus 1.2，digest
`683766f1…`），全部为命令/输出加法；迁移面：无。

- **`verify example [--checker <type>] [--null-ops]`**：从**冻结语料**派生的七型示例（`sql` /
  `sql-pair` / `count` / `exists` / `file` / `command` / `agent`），生成器 `scripts/gen-examples.mjs`
  用**显式 checker→case 常量映射**（不看 readdir 顺序），生成物 `examples.generated.ts` 由 golden
  `--check` 测试锁；输出自 declare `_derived_from: corpus 1.2 (173 files, digest 683766f1…)`。
  `--null-ops` 附 NULL 谓词语法说明（`is null`/`is not null`，`count(col)` 跳 NULL、空表 0，
  而 max/min/sum 产 NULL），明标为 syntax note 而非语料案例。
- **`verify lint-candidates <file> [--text <material>] [--db <snap>]`**：prepare 闸门的只读投影——
  与 prepare 共用同一 p1/p2 校验器（共享夹具测试证明 lint 拒绝集 == prepare `rejected_detail` 集）；
  不写 spec、不耗 `spec_version`、不发事件；无 `--text` 时 `p1_skipped:true` 显式声明。
  顺带修 p2 不校验未知 `checker.type` 的旧缺口（现由闭集点名拒绝）。
- **prepare `rejected_detail`**：`--draft` 与正常路径 JSON 增结构化
  `[{source_clause,stage,reason}]`；旧 `rejected:<count>` 保留一版（下版移除时按破坏性变更显式记账）。
- **七型选型表（`--help` + llms 双面同源）**：`CHECKER_SELECTION` 单常量渲染两面，含
  「count=存在断言 vs sql=违例扫描」的 PASS 反向坑、sql-pair 需 join key、file/command/agent 边界；
  测试锁七型与三条坑字面。
- **F6 predict 结算日历**：
  - `research predict list [--all] [--due]`：JSON 增 `due` / `days_left`（`floor((deadline-as_of)/86400s)`，
    两端 UTC 午夜）；`--due` 只留到期（deadline ≤ 今天）。
  - `research predict audit [--offline] [--state <file|url>] [--all] [--due]`：每行增
    `bucket: due|near|future`（near = 1..30 天，边界字面锁定）与 `days_left`；`--due` 只留 due 桶，
    空集 rc=0；人类输出表头带三段计数。
  - 两条命令的**未知旗标 → rc=2 单 `{"error":...}`**（此前静默忽略，`--due` 会被读成"无到期"）。
- **隐私清理（发版席 P0，前向清除）**：删除仓库根 `HANDOFF.md`（含真实内网拓扑的个人交接文档）；
  `packages/techtree/eval/src/eval.ts` 与 `docs/plan-archive-2026-10-20.md` 的个人盘符路径改为
  「本地参考文档」（该路径此前随 tarball 分发）；`examples/demo.sh` 注释里的真实 A2A 任务 id 泛化。
  **历史改写（旧提交中的内网 IP、`Jun<jun@Mac.local>` 身份 redact）属属主裁定项，未裁定前不动 git 历史。**
- 门禁：`contract-audit` 新增 contract 11 段 8 项（example/lint/predict）→ **130/130**。

测试：unit **608 → 623**（predict-cli +4、verify-lint +4、verify-example +4、help-checker +3）；
contract-audit 122 → 130。

**ratchet 认账**：bundle 667,562 → 683,862（+16,300 B，约 +2.4%：corpus 派生七型示例、选型表与三条
新命令的代码/数据），显式 `node scripts/ratchet.mjs --write` 接受并重设基线；web dist 1,434,106 按
当前构建重烘（PR#5 合并后的真实值）；cold start 481 → 441（收紧）。

## 0.109.1

**作者复审四连收口**（verification seat 派单：#7 余项 / #10 / #11 + PR#13）。契约零变更（1.2，digest 不变）。

- **#7 余项 · plain-shell 兜底双名（P1）**：`workerSessionId` 的父会话原用 actor 兜底 `"cli"`，而
  `project use` 无语境时写 `current_project@default`——worker 爬 `current_project@cli` 无人写，
  多项目工作区里**裸 shell 的 job tick 仍 ambiguous**（此前只测了有会话路径）。修法：父会话改取选择桶
  `sessionId()`（缺省 `"default"`）——选择与审计身份是两个命名空间。回归 `job-plain-shell.spec`：
  无 `YGL_SESSION`/`DSH_SESSION_ID` 环境跑 `job tick`，断言子作业解析出 `alpha` 且无 ambiguous。
- **#10 契约体检补四命令（P2）**：`node move` / `claim unlink` / `evidence rm` / `source rm` 此前
  contract-audit **零覆盖**。新增 contract 10 段（22 项）：重跑语义（move 重试幂等 + duplicate:true、
  unlink 重跑 named `link not found`、rm 重跑 named gone）、用法 rc=2、坏引用点名、`--json` 单对象错误
  （含 `--force` 级联成功形状）。**100 → 122 通过**。
- **#11 文档字段名（P3）**：`docs/plan.md` node.move 事件 payload 由 `from_tree/to_tree/state_rows`
  订正为实况 `from/to/key/state_rows/closure_rows`。
- **PR#13（zhujun）**：`tokens.spec` 漂移守卫读取即归一化 CRLF（解析收进 `parse()`，加 CRLF 回归用例），
  `apps/web/README` 可选工具措辞「要求」→「建议保持」。集成评审 + 干净 worktree 门禁
  （604 passed/2 skipped + web build + `pack:check`）后合并为 `7ab0ce7`。

测试：unit **605 → 608**（tokens CRLF +1、job-at 桶断言 +1、plain-shell +1）；contract-audit 122/122。

## 0.109.0

**前端两项特性合流**（GitHub PR#4 / PR#5，均已评审合并；此前两版只带代码未记 release note，本版统一记录）。
后端/契约零变更（contract/corpus 1.2，digest `683766f1…` 不变）。

- **PR#4 · 深/浅色主题 + hash-router 壳**（merge `dd8cd3e`）：`DESIGN.md` 成为调色板唯一事实源
  （`colors` / `colors-light` 双主题 + chart 系列色，OKLCH 明度带与对比度门禁），`tokens.css` / `tokens.ts`
  两面由测试锁同步；`index.html` 首屏前应用保存的主题（无闪烁），`react-router` 引入 hash 路由壳，
  页面拆分为 `pages.tsx` 等模块；antd 主题映射与 `KnowledgeGraph` 服务端色板同源校验。
- **PR#5 · 研究管线重建 + 概览驾驶舱**（GitHub rebase-merge `e5f49fe`，合回发布线 `313004a`）：
  `Pipeline.tsx` 重建（读写视图、阶段化交互）、新增 `ActivityTimeline` 概览（按 `research/tree/eval/other`
  四类事件的 30 天窗口，含 UTC 日标注与表格视图）、`timeline.ts`/`clipboard.ts`/`flow.ts` 工具层、
  复制结果真实反馈、未选择项目时的空态；全部消费既有 `api/*` 契约（无后端改动）。
- **合并纪律**：PR#4 在干净 worktree 过 574/574 + `pack:check` 后合；PR#5 在作者未响应 rebase 时按预验
  （rebase 无冲突、自有 diff 仅 14 文件、603/603 + `pack:check` 绿）走 GitHub rebase-merge，随后合回
  Gitee 发布线并双远端对齐（`313004a`）。合并后主树实测 **605/605**、ratchet held。

测试：unit **605**（83 文件，较 0.108.3 的 576 增长来自两项前端 PR 的测试）；其余门禁同 0.108.3。

## 0.108.3

**GitHub issue #10 / #11**（P3，工具链韧性 + 文档名实）。无契约形状变更，无运行时行为变更。

- **#10 `pack-repro` 找不到 pnpm（Homebrew/全局安装）**：`scripts/pack-repro.mjs` 原先只猜两个
  node-relative 路径；`/opt/homebrew`、npm 全局（`%APPDATA%\npm`、`/usr/local/lib`）与各 PATH 项的
  `node_modules/pnpm/bin/pnpm.cjs` 全部落空 → `cannot locate pnpm` rc=1。现按已知全局布局 + PATH 项探测；
  仍然**用本进程 node 跑 pnpm 的 JS 入口**（不 spawn `.cmd` shim，避免 Windows shell 引号面）。
  错误信息列出候选数与安装建议。
- **#11 文档名实不符（doc-only）**：`docs/plan.md` 的 `node_states` → 真表名 `node_state`；
  `docs/plan.md` / `docs/spec-validator.md` 把 `materials_sha256` 列为「毕业记录逐字节不变字段」——
  毕业记录（`GraduationRecord`）没有该字段（它是 spec 字段），改为真实字段清单
  `spec_id/spec_version/run_ids/thresholds/history/span_days/data_source/created` 并注明归属。
- `.gitignore` 增 `{}`（仓库根偶发空文件名，测试脚本副作用）。

测试：unit **576**（不变：本版无行为变更；`pack-repro` 的探测用两次同哈希手工验证）。

## 0.108.2

**GitHub issue #8 / #9 的 P2 三处**（外部报告，验证席数据级复现）。无契约形状变更。

- **#8 `node move` 假幂等**：源树查行落空后的重试分支只判断「目标树有同名 key」，没有来源证明——
  `node move y7 --to b -t a`（y7 本就生在 b）会 rc=0 报 `duplicate:true` + 谎报 `from_tree` +
  落一条幻影 `node.move.noop`。修法：重试分支查 `events` 里该节点的 `node.move`/`node.move.noop`
  血统（`from`/`to` 同时匹配）才认重试；无血统 → rc=1 点名两棵树并指路 `node rm`。
  真重试仍幂等（`node-move.spec` 两条用例对拉）。
- **#9① `--db` 全空白**：`String("   ")` 为真 → 冻结记录写 `origin:"override"`，而实际命令回落到报告来源——
  记录与执行不一致。修法：flag trim 后空串视为未传（`db_override:null`、`origin:"report"`）。
  回归测试在 `verify-cli.spec`。
- **#9② `cascaded` 两形**：`evidence rm` 返回 number（丢掉的链接数），`source rm` 返回 boolean——
  同一 JSON 字段两种类型。统一为 **number**（两面的「级联删掉多少」），`source rm` 值 = 证据行数；
  `unlink.spec` 断言类型冻结。

测试：unit **549 → 576**（含 PR#4 合并带入的前端测试；本版 +2：`node-move.spec` 幻影重试、`verify-cli.spec` 空白 --db）；其余门禁同 0.108.1。

## 0.108.1

**GitHub issue #6 的 P2×2**（外部报告，验证席源码级坐实）。无契约形状变更。

- **stuck-run reaper 恢复生效（#6 ①）**：`jobReapStuck` 的 cutoff 用「空格分隔的本地时间」，而
  `runs.started` 自 0.87.1 起由 `nowIso()` 写成 UTC ISO-8601（`T…Z`）——同日字符串比较
  (`' ' 0x20 < 'T' 0x54`) 恒假、跨日再叠加时区偏移，README「30 分钟收割」从 0.87.1 起静默失效。
  修法：cutoff 改 `toISOString()`，与 `started` 同源同格式；**不比较格式化时间**是根因教训。
  回归：同日/跨日/新鲜三例在 `job-reap.spec.ts`。
- **job worker 会话链继承（#7，P1，0.106.0 回归）**：`workerSessionId` 让 job 子进程以
  `<parent>/<job-id>` 作为 `YGL_SESSION`，但选择解析只读**精确**会话键 → 多项目工作区里裸命令 job
  全部 "ambiguous project"。修法：`resolveProjectRaw` / `resolveTreeRaw` 的会话层沿会话链向上回退
  （精确键 → 父 → 祖父 …，`/` 分隔段），子树自己设过的键优先。`selection.spec` 增项目/树两例。
- **`job tick` / `job run` 不再长持写锁（#6 ②）**：两者 `execSync` 每个到期作业（最长 600s）期间
  独占进程级写锁，其他 CLI（含读命令）排队至分钟级。修法：与 `webui serve` 同推理——boot 时
  `YGL_SERVE=1` 旁路进程锁；互斥仍由 fs `tick.lock`（tick 之间）+ SQLite WAL（写串行）保证；
  子作业本就以 `YGL_SERVE=1` 启动。回归：慢作业运行期间 `db stats` 仍即时返回
  （`job-tick-lock.spec.ts`）。

测试：unit **541 → 547**（`job-reap.spec` +3、`job-tick-lock.spec` +1、`selection.spec` +2）；其余门禁同 0.108.0。

## 0.108.0

**语料冻结锚点强化（blob 双检）**。无契约/语料语义变更：`contract_version` / `corpus_version` 仍 1.2，
digest 仍 `683766f1…`（两种锚法等价，见 `packages/verify/core/CHANGELOG.md`）。

- **身份锚（blob 内容哈希）**：`corpus/freeze.mjs` 不再按磁盘字节冻结，而是
  `git hash-object -w --path=<repo 相对>`（让 git 按 `.gitattributes` 过滤）→ `git cat-file blob`
  → sha256。同一提交在任何 `core.autocrlf` 配置下都得到同一清单；未提交的新语料文件同样可算
  （先写对象再取内容）。这是 0.103 事故复盘裁定里「manifest 记 blob 内容哈希」那一半。
- **运行时锚**：`corpus-freeze.spec` 新增断言「工作树字节 sha256 == manifest 哈希」——属性/配置回归把语料
  写成 CRLF 时，两道哈希分叉并大声失败（0.103 事故的失败形态从「CI 才红」提前到本地门禁）。
- **属性文件进保护集**：manifest 新增 `attributes_sha256`，`.gitattributes` 被改动立刻可见。
- **全仓文本统一 LF**：`.gitattributes` 从 `* text=auto` 改为 `* text=auto eol=lf`。`text=auto` 在
  `core.eol=native`（Windows 默认）下检出为 CRLF——前端 PR 的 `tokens.spec` 按行解析 `DESIGN.md`
  时在 fresh clone 上必红（本机主树恰好是 LF 历史检出，掩盖了它）。这是 0.103「在哪台机器检出决定
  测试结果」同类问题的最后一个仓库级入口；语料与 `*.pdf -text` 规则保留。
- 兼容：安装态没有 git，`freeze.mjs` 回退磁盘哈希（仅开发/CI 侧冻结；发布产物只读 manifest）。

测试：unit **541**（corpus-freeze +2：盘上字节审计、属性文件保护）；其余门禁同 0.107.0。

## 0.107.0

**契约 1.2：右值可引用列**（`contract_version` / `corpus_version` 1.1 → 1.2）。1.1 spec 行为不变，
声明 1.1 却携带 1.2 形态 → 入口 `version_shape` 拒跑；`report.contract_version` 取 spec 声明值。

- **同表列对列 `{col}`**：`PredicateCondition.value` 接受 `{"col":"<column>"}`。只许引用 `predicate.from`
  同一张表（跨表引用要 join key，属 `sql-pair`，构造期 `spec_error: cross_table_col` 指路）；
  `is null`/`is not null` 不接受 `{col}`（`null_rhs_for_null_op`）。按 SQL（含列亲和性）语义比较，不做隐式 cast。
- **`count.against` 单值标量**：`{from, col, agg}`，`agg` **必填**（`max|min|sum|count`；缺省 → `missing_agg`）。
  不设默认的理由：默认 max 会在策略表意外多行时静默取值，而「多行才拒绝」是**数据依赖**判据——
  spec 有效性只许依赖 schema。空表/全 NULL → 右值 NULL → `ERROR`；`count` 是 agg 家族里唯一不产 NULL 的
  （空表 → 0），语料把这对不对称冻在同一例。
- **观测面**：形态一 `evidence.compared_rows`（≤5 采样 `{left,right}`，渲染带 `ORDER BY rowid` 保证
  TS/Rust 采样路径字节一致）+ `compared_total`（**无条件出现**，可区分「3 行」与「3/N 采样」）；
  形态二 `evidence.compared: {left,right}`。`ScopeWitness` 四字段不变。
- **构造期错误码**：新设 `evidence.spec_error` 封闭码表
  （`cross_table_col` / `missing_column` / `missing_agg` / `null_rhs_for_null_op` / `version_shape`）；
  四值 verdict 骨架冻结——加第五值会破坏报告消费者、WebUI、Rust parity 与 evaluator 协议。
- **Rust mirror 同版**：`contract.rs`（`AgainstSpec` + CountChecker 变体 + 1.1 兼容判定）、
  `predicate.rs`（`{col}` 渲染/跨表拒绝/`contains_col_ref`/首个引用对定位）、`engine.rs`
  （against 渲染/NULL 右值/`compared`/版本闸/报告版本取 spec）。`rust-parity.spec.ts` 与
  `corpus_parity.rs` 对 **44 例整份报告逐字节** parity 全绿。
- **语料 33 → 44 例**：`count-against-pass/fail`、`col-ref-pass/fail`、`against-null`（count=0 vs max=NULL 双对比）、
  `type-mixed`（INTEGER 亲和性把 TEXT 侧转数字，冻结 type-mixed 语义）、`agg-variants`
  （`agg:count` = `count(col)` 跳 NULL）、`count-against-missing-agg`；红队 `red-cross-table-col`、
  `red-null-rhs-for-null-op`、`red-version-shape`。既有 33 例逐字节不变。
  语料 LF 重冻：digest `ee1a0a1d6dddcfcd…`（129 文件）→ **`683766f1077bb2c0…`（173 文件）**，
  血统记录见 `packages/verify/core/CHANGELOG.md`（blob 双检纪律沿用 0.103 事故后的规则）。
- 测试：unit **539**（含 1.2 地面工程 7 例）、Rust **31**、demo 128、contract 100/100、readme 54/54；
  `pack:check` 与 `pack:repro` 见 handoff。

## 0.106.0

**选择归属与 worker 隔离**（K3 情报：8 个 verifier 节点落错树的两个残余洞）。无契约形状变更。

- **worker 级 session 身份**：`job tick` 派生作业时注入 `YGL_SESSION=<parent-sid>/<job-id>`
  （嵌套 worker 续 `/<run-id>`）与 `YGL_JOB_ID`。此前同一 DSH 会话派 N 个并行 worker 共享一个
  session id，session 级选择（`current_project@<sid>`）互相覆盖；裸 cron/脚本进程则全落在
  `"default"` 桶。现在每次作业运行都有自己的选择命名空间，父链仍可回溯。
- **写事件选择归因**：`resolveProject`/`resolveTree` 把解析来源（`flag|env|session|global|only|none`）
  记入进程上下文；事务写路径的 `events.actor` 改为真实 session id（无则 `cli`），树域对象 payload
  额外带 `via`——审计上第一次能回答「这次写是显式 `-t`、环境变量、会话选择还是全局遗留指针授权的」。
  研究域 payload 保持冻结的字符串形态不改（只归因 actor），避免已有审计消费者与测试断言的形状漂移。
- **`doctor` 两条新警告（warn，不 fail）**：`session_identity`——未设 `YGL_SESSION`/
  `DSH_SESSION_ID` 且工作区有多个项目时，点名所有进程共享 `"default"` 选择桶的风险；
  `tree_selection_hygiene`——多树工作区只设置了全局 `current_tree` 指针时，提示并行会话会互相
  改写的实际路径（`tree use` 或 `-t/--tree` 钉住）。
- 测试：unit **528 → 531**（`job-at.spec` +1 `workerSessionId` 链、`unlink.spec` +1 归因
  〔actor=session + 树域 payload `via`〕、`doctor.test` +1 `session_identity`）。

## 0.105.3

**issue #2 剩余项 + K3 评审五条 NIT**（GitHub `NelsonLongxiang/ygl-trees#2`）。无契约形状变更。

- **冻结记录原子写（#3）**：`writeJson()` 改为同目录临时文件 + `rename`。`--schedule` 会就地重写
  `graduations/*.json`，旧实现 `writeFileSync` 被 kill 时留下截断 JSON——既是无法审计的记录，也让
  之后每条命令解析失败。现在要么是旧内容、要么是新内容，不存在半写状态（`rename(2)` 在 POSIX 与
  Windows 同卷均原子）。
- **`source rm` 不再静默级联（#7）**：`evidence.source_id` 是 `ON DELETE CASCADE`，旧实现一条
  `DELETE` 就静默删掉整串证据、丢光 claim 链接、留下过期 status 与两张表的 FTS 影子。现在：
  有证据时拒绝并列出证据 id（提示 `research evidence rm <id> [--force]` 或 `source rm --force`）；
  `--force` 在一个事务里逐条解链 → 重算受影响 claim → 删 `evidence_fts` 影子 → 删证据 →
  删来源 → 删 `sources_fts` 影子，落 `source.rm` 事件（`cascaded: N evidence, M claim(s)`）。
  同时补上项目域前置检查（此前 `source rm` 只按 id 查，未校验 project_id）。
- **`ratchet` seeded 状态可见（#8）**：基线缺失（新检出/新指标）时旧实现测完就丢，既不落库也不提示，
  下一轮重复同样空转；现在打印「N 项无基线，`--write` 建基线」。
- **`job_target_error` 进人类输出（#9）**：排期字段写失败此前只在 `--json` 里出现，人类路径仍只说
  scheduled；现在补黄字说明「记录仍是上一次排期意图，作业已登记」。
- **K3 NIT① relations 孤儿治理**：`relations` 无 FK 级联，删节点/证据/断言会留下指向空行的关系。
  新增 `orphanRelations()` 与 `rel prune [--dry-run]`（显式清理，落 `rel.prune` 事件），`doctor`
  增 `relation_orphans` 检查（warn，不 fail）。删除路径**不**顺带清关系——静默连坐会让「这次删除
  到底删了什么」不可审计。
- **K3 NIT② `evidence rm` 报错指引**：`evidence not found` 补 `-p` 指引，与 `claim unlink` 对齐。
- **K3 NIT③ `forced` 语义**：`forced` 改为如实反映入参（是否传 `--force`），新增 `cascaded`
  报实际级联链接数——旧值靠 `unlinked.length` 推断，契约面不可自证。
- **K3 NIT④ `nodeMove` 闭包收窄**：只迁 `depth=0` 自环行（透传行由 `node index` 重建），
  docstring 与 SQL 对齐；**NIT⑤** 边检查补 `tree_id`（把「边不跨树」从隐式不变量变成显式条件）。
- 测试：unit **523 → 528**（`unlink.spec` +3：forced/cascaded 语义、source rm 拒绝与级联、
  FTS 影子断言；`rels.test` +1 孤儿关系检测与 prune；`doctor.test` +1 `relation_orphans`；
  `node-move.spec` 增闭包收窄断言）。

## 0.105.2

**外部复核 issue #2 的 P1 修复批**（GitHub `NelsonLongxiang/ygl-trees#2`）。无契约形状变更。

- **`node move` 重试幂等（#1，契约违约）**：首移成功后节点已在目标树，同一命令重试时源树查行必然为空
  → 旧实现抛 `node not found` rc=1。现在查行落空时若目标树已有同名节点，返回
  `{moved:false, duplicate:true}`（rc=0）并落 `node.move.noop` 事件——重试不产生第二个「已移动」声明，
  也不把幂等操作报成错误。新增 `writes.ts` 的 `duplicate` 字段与 CLI 既有 `moved:false` 分支对接。
- **`evidence rm` 的 FTS 影子同事务删除（#6，写路径铁律 1 违约）**：旧实现删 `claim_evidence` 与
  `evidence` 基表，却没删 `evidence_fts` 影子行——删除后仍可被全文检索命中，且搜索结果是「没有基表行的
  证据」。现在同一事务内 `DELETE FROM evidence_fts WHERE id=?`。
- **补强测试（#2）**：`verify-cli.spec.ts` 里 r28 Q2 的 `created` 不变量断言写成同义反复
  （两个分支都是 `afterMove.created`，永远为真）；改为在 `--db` 重排**之前**读取冻结记录做
  before-image，逐项断言 `created` / `data_source` / `run_ids` 与重排后逐字节一致。
- 回归：`node-move.spec` 7 例（+1 重试幂等）、`unlink.spec` 7 例（+FTS 影子断言）。

## 0.105.1

**打包修复（P0）：`pack:repro` 产物不再携带 `workspace:` 残留**。源码零改动，仅发布链路修复。

- **事故**：0.105.0 的发布 tarball 由 `scripts/pack-repro.mjs` 手工组装，而该脚本直接读取仓库原始
  `package.json` 并打包——`workspace:~` 依赖没有被解析成真实版本，`@deepseek-ai/cordis` /
  `cosmokit` / `schemastery` / `cordis-plugin-timer` 四个包以 `workspace:~` 原样进入 npm 清单，
  任何全新 `npm install ygl-trees@0.105.0` 都以 `EUNSUPPORTEDPROTOCOL` 失败。`pnpm pack` /
  `pnpm publish` 会自动重写这类依赖，手写组装器则不会——发布字节必须是被解析过的字节。
- **修法**：脚本改为**以 pnpm 的产物为内容源**，再确定性重打包（这正是外部复核建议的方案 b）：
  `pnpm pack` 负责依赖重写与 `files`/`.npmignore` 选择，脚本只把它的条目按路径排序、
  `mtime=0`/`uid=gid=0`/`uname=gname` 空/`mode=0644`/ustar/gzip level 9 重写成可复现字节。
  重打包前有一道硬闸：`package.json` 里仍有 `workspace:` → 直接抛错拒绝封包。
- **跨主机字节一致（外部复核 #5）**：gzip 头的 OS 字节（offset 9）由宿主 zlib 的 `OS_CODE` 决定，
  同一内容在 Windows/Linux 上会产出不同 sha256；现在固定写 `0xFF`（unknown），
  `docs/release.md` 的「跨主机同字节」声明才成立。
- **装得上才算发布（外部复核 #4）**：`pack:check` 5b 段新增真·npm 隔离安装探针——
  在空目录 `npm i <pack:repro tarball>`，断言退出码 0 且装出来的 `bin` 能跑 `--version`。
  此前 5b 只验「两次哈希相同 + 条目清单一致」，验的是字节稳定性，不是可安装性；
  这正是 0.105.0 事故漏过门禁的原因。
- **发布纪律（发版席 SOP 已补）**：发布前解包 tarball，确认 `dependencies` 无 `workspace:` 残留、
  `bin` 路径正确；不再以「tarball sha1 双端一致」替代内容级检查。

## 0.105.0

**批九增补单 + r28 收口**：无契约形状变更（`contract_version` / `corpus_version` 仍 1.1）。

- **误挂证据不再是死角（批九增补 P2-1）**：`research claim unlink <claimId> <evidenceId>` 与
  `research evidence rm <id> [--force]` 补上——此前误挂证据只能 `db sql` 裸删，而
  `claim_evidence` 是 `ON DELETE CASCADE`，裸删会静默丢链接、断言状态滞留 `supported`。
  - `claim unlink`：事务内点名 `claim not found` / `evidence not found` / `link not found`
    （后者给出 `claim show` 的查看建议），删链接后**重算状态**（supports/refutes 计数 →
    `contested|supported|refuted|unverified`），落 `claim.unlink` 事件。**预测断言
    （`[预测·` 前缀）不因证据增删降级**：状态由仲裁（`claim resolve`）决定，事件里写
    `prediction: status kept`。
  - `evidence rm`：仍有断言链接时拒绝并列出 claim id 与解绑命令；`--force` 逐条解绑 →
    逐条重算 → 删证据 → 落 `evidence.rm` 事件（含 `(cascaded: N link(s))`）。不做成
    `source rm` 那种「只删不级联」——证据的链接影响面比来源大。
- **`node move <key> --to <tree>`（批九增补 P2-2）**：整节点跨树迁移。拒绝条件：节点在
  当前树内仍有边（先 `node link` 改边，不替你猜哪些边该跟走）；目标树已有同名 key；源树
  里找不到节点。成功时迁移 `node_states` 行、**两棵树都标脏**（`node index` 一次重建两侧闭包）、
  落 `node.move` 事件（`from_tree`/`to_tree`/`state_rows`）。树内重挂（改 parent）不在本版——
  那是 `unlink` + `link` 的组合，语义不同，不塞进同一个命令。
- **`node rm` 可发现性（批九增补 P2-3）**：处理器早已存在，顶层 help 与 llms 计数里缺行；
  补 `node rm <key>` 与「删除会连带边/条件/状态」的说明。
- **并行会话纪律入文档**：`-t` 单次覆盖与会话级 selection（`project use`/`tree use` 落
  session selection）都已可用，缺的是「多会话共用工作区时各自 `use` 或全程 `-t/--project`」
  这句话；写进 `docs/scenarios.md` 与 techtree 技能，不新增机制。
- **`$` 进 shell 元字符 denylist（r28 P3）**：POSIX sh 在双引号内仍展开 `$VAR`，
  `--db /data/${HOME}/x.sqlite` 会被静默换成另一个库；`$` 与 `&` `|` `<` `>` `^` `%` `!` `"`
  反引号 `(` `)` 同列。`{` `}` 在双引号内是字面量，不拒（源码与文档同步订正）。
- **`job_target` 写入毕业记录（r28 Q2）**：`--schedule` 成功后记录里多一个
  `job_target {db, origin:"report"|"override", usable, job_id, every_minutes, updated_at}`，
  **只动这一个字段**——`run_ids`/`thresholds`/`created`/`data_source`/`materials_sha256`
  逐字节不变（重毕业的 `duplicate` 路径同样只更新它；不带 `--schedule` 的重复毕业保留旧值）。
  语义是「最后一次排期意图」，执行真相仍在 `jobs` 表，漂移靠 `job.retarget` 事件与
  `updated_at` 审计。该字段不进 identity/重复判定/资格/patrol，旧记录缺失需容忍。
- **可复现打包（`pnpm pack:repro`）**：`npm pack` 的 tarball 带打包机 mtime/属主/gzip 头，
  同一 commit 每次指纹都变，只能记账不能校验。新脚本 `scripts/pack-repro.mjs` 固定
  文件顺序（路径字节序）、`mtime=0`、`uid/gid=0`、`uname/gname` 空、`mode=0644`、ustar 无
  pax、gzip level 9 无文件名/时间戳；文件清单仍取 `npm pack --dry-run --json`（沿用 npm 的
  `files`/`.npmignore` 规则）。实测连打两次同 sha256。`pack:check` 继续负责「能装能跑」。
- **闸门不再弄脏工作树（发版席发布坑②）**：`ratchet` 原来在指标变好时**自动写回基线**，
  于是 `pnpm test`（以及任何跑它的发布钩子）会在发布过程中修改被跟踪文件，`pnpm publish`
  随即以 `ERR_PNPM_GIT_UNCLEAN` 拒绝。度量工具不得改变被测对象：现在只在显式 `--write`
  时落盘，变好只打印「N 项比基线更紧，可 `--write` 锁定」（`docs/measurement-ratchet.md` 同步）。
- **`pack:check` 5b 自检两处（否则确定性断言恒挂）**：`scripts/pack-repro.mjs` 不再盲信
  `npm_execpath`（`pnpm run` 下它指向 pnpm CLI，不支持 `pack --dry-run --json`，只在
  `npm-cli.js` 时才用，否则回落到 node 同级的 npm）；`scripts/pack-check.sh` 第二个哈希
  误用 `process.argv[2]`（`node -e` 只有一个参数位 → `readFileSync(undefined)` 抛
  `ERR_INVALID_ARG_TYPE`，而 `|| fail` 只记不退，表面症状是「两次哈希不同」）。
- 测试：unit **522**（76 文件，+25：`unlink.spec` 7、`claim-unlink.spec` 4、`node-move.spec` 6、
  `node-move` CLI 4、`graduate.spec` 18→22）；`pnpm test` / `readme:verify` / `pack:check` 门禁数据见
  `docs/plan.md` 0.105.0 记录。

## 0.104.0

**批九可发现性 + r26 P1 安全收口**：无契约形状变更（`contract_version` / `corpus_version` 仍 1.1）。

- **跨树边提示（批九 P1①）**：`node link` 的两端查找失败原来只说 `parent not found: na`，用户看不出「这个 key 在别的树里」。`enrichNodeNotFound` 的正则从 `^node not found:` 扩到 `^(node|parent|child) not found:`，并复用 `trees.nodeInOtherTrees()` 点名——`key exists in other tree(s): 't-a' — edges cannot cross trees; add 'na' to 't-b' (or -t t-a to work over there)`。边不跨树是数据模型边界，提示必须给出「加节点」与「换树工作」两条出路。
- **未知组指引（批九 P1②）**：`ygl-trees claim list` 这类「把动作当组」的输入原来只说 `unknown group: claim`。现在对 `claim/source/evidence/query/predict` 五个动作补一行 `try: ygl-trees research claim …  (claim is an action of the research group)`；llms 尾注的 `- claim evaluate`、`- evidence assess` 一并订正为 `research …`。首启引导里的技能数 9 → 12（与 README / `skills/` 目录一致）。
- **`db sql` 列名速查（批九 P2）**：裸 `db sql` 原来静默 rc=0（形似「空结果」）——现在 rc=2 并给出真值形状：`edges.parent_id/child_id` 是 `nodes.id` 整数引用，要 join 后 alias `nodes.key`（附可直接跑的示例 SQL）。help 同步三行。
- **`node cond --force`（批九 P2）**：同键异内容原来只能 `node cond rm` 再 add（两次写、中间态缺条件）。`--force` 就地把 value/op 等改写为同一行（id 不变），落 `node.cond` 事件带 `"updated":true` 以便审计区分「新增」与「就地改写」；无 `--force` 的拒绝文案补「或 `--force` 就地改写」。
- **语料行尾规范化（发版席 0.103.0 复核 BLOCK 修复）**：`freeze.mjs` 按**磁盘字节**算 sha256，而 `core.autocrlf=true` 的检出会把 `corpus/cases/**` 写成 CRLF、脚本直写的 `canonical/vectors.json` 却是 LF——manifest 成了混合清单：Windows 主树自洽，CI/Linux/新 clone 上 `corpus-digest` 快照必红，且 tarball 内容随打包机漂移（产物正确性取决于哪台机器打包）。修法：仓库根新增 `.gitattributes`（`packages/verify/core/corpus/** text eol=lf`、`*.pdf -text`），在统一 LF 基上重冻 `manifest.json`（129 文件，digest `4cac21b4…` → `ee1a0a1d6dddcfcd8fcf58f70f5955ca4edab3d9fca5deb131c8c3eccc7212fc`）。语料语义零变化（仓库 blob 本来就是 LF），`corpus_version` 仍 1.1；`docs/verify-contract.md` §4.6 与 `packages/verify/core/CHANGELOG.md` 记明该 digest 取代关系。
- **r26 收口（评审 302cb119，1 个 P1 安全缺陷 + P4 文档项）**：报告是数据不是命令——`verify report import` 只校验 payload 自洽，伪造报告把 `" & echo PWNED & rem "` 塞进 `data_source.source` 后，`--schedule` 会把它内插进 `job_command`，`job tick` 经 shell 执行。修法：`jobCommand()` 对报告 source 与 `--db` 覆盖统一做字符校验（r27 起为 denylist：拒 shell 元字符与控制字符、拒超长、拒尾随分隔符/空白；中文/`#`/`+`/空格/两种分隔符均放行），不安全 → `job_command_usable:false`、命令串打占位符、`--schedule` rc=1，且 `job_command_rejected` **只描述形状**（长度 + 首个越界字符的 offset / 尾随类原因），不回显任何原字符；`spec_id` 同白名单（不合格打 `<spec-id>`）。`verify report import` 对可疑 source 出声（`source_warning`，不拒绝——跨机绝对路径合法）。`--db` 覆盖语义钉死：只换常驻作业目标，不改资格判定/冻结记录/patrol。彻底修法（argv 存储、不经 shell）留 M13-4。
- **schema 探针问快照库要真实列（0.104.0，发版席上报 P2）**：`probeOf(ddl)` 解析的是 `sqlite_master.sql` 里的建表语句，`ALTER TABLE … ADD COLUMN` 加的列不在那条文本里——`kb_notes.tags/created` 这类「代码里在用、DDL 文本里没有」的列被 P2 结构性拒绝（`count column "tags" is not in kb_notes (columns: …)`）。修法：新增 `probeOfDb(dbPath)`（`PRAGMA table_info` 取真实表/列，带标识符转义），CLI `prepare` 与 HTTP `prepareViaHttp` 都改用它；DDL 文本只剩红队建空库与指纹用途。回归：CLI 新增「ALTER TABLE 加的列不被结构性打回」端到端用例（ready + 无 `is not in notes`）。
- **冷启动度量抗噪（0.104.0，门禁自伤修复）**：`ratchet` 的 `cold_start_ms` 原本「预热 1 次 + 5 次取中位数」，本机实测同一 commit 摆动 464–634ms——pre-push 钩子排在全量门禁末尾时，5 个样本一起被回收负载拖慢，中位数被顶穿 30% 容差，于是**同一个绿 commit 推不出去**（闸门测的是机器忙闲，不是产品快慢，正是该脚本开头想避免的错）。修法：预热 2 次 + 7 次取**最小值**（启动耗时存在可达下界，噪声是单侧的，真回归会把最小值一起抬上去），并在超容差时延迟 1.5s 复测一次取更优值（真回归两次都慢，噪声只命中一次）。方法变了必须按新方法**重烘基线**（同版 ratchet 记账条：三项各带 `method`），`docs/measurement-ratchet.md` 与脚本头注同步说明。
- **测试侧连接级重试（0.104.0，门禁可复现性）**：干净检出满负载跑套件会偶发 `TypeError: fetch failed / read ECONNRESET`（实测 `webui.test.ts` P1-1 与 `verify-jobs` 语料归档两例，隔离跑必绿）——服务端还没读到请求就被复位，属传输抖动。统一在 `tests/support/fetch-retry.ts`（vitest `setupFiles`）给全局 `fetch` 加「一个字节都没收到」的传输级重试：≤3 次、退避 300/600ms，body 必须可重放（流式 body 直接抛），**收到任何 HTTP 状态码都不重试**（那是被测系统的回答）。真实缺陷会三次都失败，不会被这条遮住。
- **r27 / K3 收口（评审 302cb119 r27 PASS + K3 评审席 REJECT）**：
  - **`--db` 重排真的生效（r27 P2①）**：`--schedule` 第二次跑时 `jobAdd` 按 title 幂等回旧行，jobs 表里仍是旧路径而输出展示新命令——「retarget 静默 no-op」。新增 `writes.jobRetarget()`：同名作业存在且命令/周期变化时 `UPDATE jobs` + 落 `job.retarget` 事件，响应带 `job_retargeted:true`；不存在才新建。
  - **引号装不下的路径不许排期（r27 P2②）**：`--db "C:\…\Temp\"` 的尾随分隔符会转义闭合引号（实测 `node: bad option`）；尾随空白会被 shell 裁剪。`jobCommand` 现把这类路径判为不可用并给出原因。
  - **白名单过窄（r27 P2③）**：原 ascii 白名单拒绝中文/`#`/`+` 目录，真实用户无法排期。改为元字符 denylist（见上条），合法路径字符全部放行。
  - **掩码只描述形状（r27 P3①）**：`job_command_rejected` 原来保留 40 个可打印字符并落进冻结记录，测试还把样本内容写成契约——现在只回「N chars；第一个元字符在 offset K」或尾随原因，测试断言掩码不含样本串。
  - **超时修复在门禁入口无效（K3 P1 / r27 P3②）**：`package.json` 的 `test:unit` 带 `--test-timeout=20000`，CLI 旗标覆盖 vitest config 的 60000——`patrol` recurrence 实测 20.8s 被误杀。现删除 CLI 旗标，config 为超时唯一事实源（`--maxWorkers=2` 保留）。
  - **测试重试桶收窄（K3 ③）**：`fetch-retry` 原按 `fetch failed` 文本匹配，DNS/TLS 失败也会重试两次。改为只认 `err.cause.code` 的 `ECONNRESET/ECONNREFUSED/EPIPE/ECONNABORTED/UND_ERR_SOCKET`。
  - **ratchet 记账（r27 P3④ / K3 ②）**：删除死代码 `median()`；三项度量各带 `method`（`stat-size-of-dist-bundle` / `sum-file-sizes-recursive` / `warm2-min7-retry-once`），基线按新方法重烘——旧冷启动基线烘于 median-of-5、余量仅 14ms，方法变了必须重取。
  - 文档：`spec-validator.md` §9 补「掩码只描述形状」「缺失文件是运行期错误」「count 与 sql-pair 的词汇双轨（批十一②）」三节，并订正 r26 段的字符集口径。
- 测试 unit **497**（+14：`node-qual` +3 跨树边提示、`guidance.spec.ts` 新增 3 例 unknown-group 指引、`cond-idem` +1 `--force` 就地改写、`graduate.spec.ts` +3 注入拒绝/普通路径放行/引号装不下的路径拒绝、`verify-web` +1 `source_warning` 读面投影、CLI +2 注入 source 拒绝与 `--schedule` 就地 retarget、CLI +1 ALTER TABLE 列探针）/ Rust 31 / demo 128 / contract 100 / readme 54。`spec-validator.md` §9 新增「报告是数据，不是命令（r26 P1）」「`--db` 覆盖的语义边界（r26 Q2）」「掩码只描述形状（r27 P3①）」「缺失文件是运行期错误（r27 Q1）」「count 与 sql-pair 的词汇双轨（批十一②）」五段。
- 附：r26 评审报告入库 `docs/reviews/REVIEW-spec-validator-m13-r26.md`（索引登记）。

## 0.103.0

**M13-3 毕业通道**：把「一次性验证」升级为「常驻检查」——`verify graduate`（`packages/ops/tools/src/graduate.ts`）。无契约形状变更（`contract_version` / `corpus_version` 仍 1.1）。

- **三段拆**：①**资格**＝同一 `spec_version`、最近 `--min-runs`（默认 3）份报告全部 `overall=PASS`、首末跨度 ≥ `--min-span-days`（默认 30 天）。**跨 spec_version 不算连续**——判据本身变了，"历史最好成绩"不成立。拒绝时逐条点名（缺几条、哪条不是 PASS、跨度差多少天），rc=1 且**不落盘**。
- **毕业记录冻结**：`$YGL_HOME/verify/graduations/<spec_id>.json` 写 `{spec_id, spec_version, run_ids, thresholds, span_days, data_source, created}`。同核心内容重跑回 `duplicate:true`（保留首次 `created`）；不同形状**拒绝覆盖**并给出 `delete <path> deliberately` 的显式指引——冻结记录不可被重跑改写（与 prepare「成功记录不被失败补跑冲掉」同一纪律）。
- **常驻执行**：默认只打印命令串（JSON 的 `job_command`），`--schedule --every <min>` 才真的登记作业（`job add`）；命令串固定带 `--no-archive`（趋势看 `reports/`，不看归档数量）。`<source>` 取毕业报告 `data_source.source`。
- **patrol 化边界**：`--patrol` 只在「被验库 == 工作区库」时放行，否则点名拒绝——`patrol run` 在工作区库上跑 SQL 而 VU 判的是被验快照，生成半对的检查比没有检查更危险。0.103.0 **只做资格闸门**，不自动生成 patrol check。
- **r25 收口（评审 302cb119，3 个 P2 必修 + P3 记账）**：①跨度闸门不再真空——`--min-span-days > 0` 时必须 ≥2 份报告，`--min-runs 1` + 单份 PASS 不再以 span=0 混过；②报告来源是 `blob:<sha12>`（HTTP 作业面内容寻址）时**不能当 `--db`**——`job_command` 打占位符、`--schedule` 拒绝登记，除非 `--db <file>` 显式覆盖，否则作业每分钟 ENOENT 失败；③文档把「`--patrol` 交 patrol add」订正为「0.103.0 只做资格闸门」。另收：`history` 摘要（同版本总数/非 PASS 数/最近一条非 PASS）、跨度窗口右移写进文档、响应一律回冻结阈值、`--schedule` 的用法校验提前到落盘之前（旧实现 rc=2 却已冻结记录）、被取代与记录错误分开提示。
- rc 语义与 verify 组一致：0=已毕业/duplicate，1=资格不够或运行错误，2=用法错误（缺 spec-id、`--min-runs` 非正整数、`--schedule` 缺 `--every`）。
- 测试 unit **483**（+20：`graduate.spec.ts` 15——资格/缺报告/FAIL/跨度/跨版本隔离/缺 spec/冻结幂等/拒绝覆盖/命令串/patrol 边界/history/冻结阈值/被取代文案/blob 不可执行与 `--db` 覆盖；CLI 5——缺参数 rc=2、未知 spec rc=1、资格不够→够格→duplicate 全链、`--schedule` 缺 `--every` rc=2 且不冻结、blob 来源拒绝登记而 `--db` 覆盖后放行，各自用独立 `YGL_HOME` 不污染共享夹具）/ Rust 31 / demo 128 / contract 100 / readme 54。
- 文档：`docs/spec-validator.md` §9 毕业通道补「已实现（0.103.0）」语义；`docs/verify-contract.md` §4.7 收 r24 三条口径——①`attempts[].file`=目录内文件名 / HTTP `record`=spec 目录相对 / CLI `record`=verify 根相对，**三个基准不同**；②小数秒 >3 位静默截断到毫秒；③有意保留的宽容边界（纯日期按 UTC、偏移 ±23:59）与「拒小写 t/z、闰秒、基本格式」显式写明。

## 0.102.4

**r23 收口**（评审 302cb119：0.102.3 PASS，留 1 P2 + P3×5）——无契约形状变更，全部是把「口径」收紧到可对质。

- **as_of 严格 ISO（P3⑤ / 三问①）**：`normalizeAsOf` 从「Date 能解析就收」改为显式语法校验——**接受**纯日期（UTC 00:00）与带显式时区的 datetime（`Z`/`+08:00`/`+0800`，±hh 与引擎 `ISO_DATETIME_TZ` 同口径）、1–9 位小数秒；**拒绝**无时区 datetime（同一串在本机 +08 与 CI UTC 会落成两个锚点）、空格分隔、非 ISO、非法日历（`2026-02-30` 曾被 Date 静默滚成 03-02 并以错误锚冻结——现在直接拒）。这是 0.102.3「可解析即归一」的漏洞：评审实测 CLI 曾以错误锚覆盖上一份 ready 记录。
- **as_of 校验提前（P3①）**：HTTP `prepare` 的 as_of 校验移到 `findMaterial`/`snapshotPath`/`schemaOf` 之前——「缺材料 + 非法 as_of」现在报 400（旗标错误）而非 404（资源错误），与 CLI 的「先校验后 I/O」同纪律。
- **attempts 原子占位（三问③）**：`prepareRecordPath` 的 `existsSync` 续号换成 `writeFileSync(..., {flag:"wx"})` + EEXIST 续号——原方案有 TOCTOU 窗口（评审：8 路并发没撞是毫秒错开的运气）。
- **P2：文档 reviews 示例形状**：`docs/verify-contract.md` 的 `--reviews` 示例原写旧嵌套 `[[{vu_id…}]]`，而 `fileReviewer` 按 `source_clause` 匹配对象数组——照文档抄永远 `needs-material`。示例改为 `[{source_clause, findings}]`（并注明 vu_id 由 prepare 生成），补 CLI 正向回归：文档形状 → ready rc=0 且三文件落盘；旧嵌套形状 → 非 ready（P2 的反例）。
- **措辞订正（P3②③）**：撤掉「`prepare.json` 不可变」的说法——真实口径是「成功以最后一次成功为准，失败的补跑不得冲掉上一轮成功记录」；文档写明 attempts 投影的 `file` 是 attempts 目录内 basename，而 CLI `record` 是相对 verify 根的 `specs/<id>/…`，两者基准不同。另注明 as_of 比引擎 `ISO_DATETIME_TZ` 更严（拒空格分隔）是有意的：数据值宽容，入参严格。
- 测试 unit **463**（+9：as-of 严格用例 6、CLI ready 形状正向 1、HTTP 严格 as_of 2（含「校验先于 I/O」））/ Rust 31 / demo 128 / contract 100 / readme 54。`contract_version` / `corpus_version` 仍 1.1。
- 附：r23 评审报告入库 `docs/reviews/REVIEW-spec-validator-m13-r23.md`（索引登记）。

## 0.102.3

**r22 P3 收口**（评审 302cb119：0.102.2 PASS，留 as_of 校验 / attempts 可审计 / 命名碰撞 / CLI record 四条）——无契约形状变更。

- **as_of 双侧同校验（评审要求②）**：新增 `normalizeAsOf`（`verify-cmds.ts`），HTTP `POST /api/verify/prepare` 的 `as_of` 与 CLI `--as-of` 共用——可解析 → `toISOString()`（`+08:00` 偏移归一 UTC，同一个瞬间只有一种存盘形态）；不可解析/非字符串 → HTTP 400、CLI rc=2，且**不落盘、不消耗 spec_version**。理由（R13）：不可解析的时间锚会让报告不可对质。CLI 的校验先于 material/db I/O，旗标错误不会被报成运行错误。
- **attempts 可审计（评审建议①）**：`GET /api/verify/spec?id=` 的载荷新增 `attempts: [{file, created, verdict}]` 投影（按文件名排序）。构造追溯视图可直接回答「为什么没 ready」，正文仍只在盘上。
- **命名碰撞（P3①）**：`prepareRecordPath` 同毫秒两次尝试不再撞名——首个 `attempts/<ts>.json`，续列 `-2`/`-3`，只追加不覆盖。
- **CLI `--json` 的 record（P3②）**：`verify prepare --json` 回 `record`（相对 verify 根的 `specs/<id>/prepare.json` 或 `attempts/<ts>.json`），脚本不必自己拼时间戳；`--draft` 回 `record: null` 保持形状稳定。
- 文档：`docs/verify-contract.md` §4.7 与 `docs/spec-validator.md` §7 同步（as_of 校验、attempts 投影、record 字段、命名规则）；`skills/ygl-trees-verify` 补 as_of 纪律。
- 测试 unit **454**（+9：`as-of.spec.ts` 6 例 normalizeAsOf/路径碰撞；HTTP 不可解析 400 且不落盘、`+08` 归一；CLI rc=2；specDetail attempts 投影）/ Rust 31 / demo 128 / contract 100 / readme 54。`contract_version` / `corpus_version` 仍 1.1。
- 附：r22 评审报告原文入库 `docs/reviews/REVIEW-spec-validator-m13-r22.md`（索引已登记）。

## 0.102.2

**评审 r21 三问收口（P2-2 / P3-2 / as_of 入口）** —— 0.102.0 作业面复核后的下一批口径统一，无契约形状变更。

- **构造记录只追加（P2-2）**：`ready` 才写不可变的 `prepare.json`；未 ready 的尝试写同 spec 目录下 `attempts/<ts>.json`。此前 CLI 无论 ready 与否都覆盖 `prepare.json`（一次失败补跑会冲掉上一轮已冻结的成功记录），HTTP 面什么都不写（失败无痕）——两个面各错一半，现在一个口径：成功记录不改、失败尝试留档。CLI 人类输出多一行 `attempt recorded: <path>`，HTTP body 多 `record` 字段（`prepare.json` 或 `attempts/<ts>.json`）。
- **`as_of` 有 HTTP 入口（P3）**：`POST /api/verify/prepare` 收可选 `as_of`（ISO 时刻）——P5 冻版时点由构造方钉（与 CLI `--as-of` 同语义），缺省按请求时刻，服务端不猜。
- **门的形态写清（P3-2）**：作业面只由 `--enable-verify-jobs` 把门、不随绑定地址收紧（地址不是信任边界，内网自托管是正当用法；上传门按回环默认是因为它没有专属 flag 且直接写盘）。command 型 VU 继承 serve 的 cwd/env、`stdout` 入 witness 是「执行外部命令」检查器的固有边界，白名单只收窄 `argv[0]`。
- **计数复核**：`CHANGELOG` 0.102.0 写 441、0.102.1 写 442 是按批次递增的真实值，不矛盾（r21 P3-5 的疑问据代码与 git 记录回复）。`specDir` 不分版本仍记 backlog。
- 测试 unit **445**（+3：HTTP 未 ready 只追加 attempts / `as_of` 落 spec / CLI 未 ready 不覆盖冻结记录）/ Rust 31 / demo 128 / contract 100 / readme 54。`contract_version` / `corpus_version` 仍 1.1。

## 0.102.1

**热修（发布后 P2）**：`YGL_VERIFY_ALLOW_CMD` 的空串语义是 **fail-open** 的——`String(process.env.YGL_VERIFY_ALLOW_CMD || "node")` 让「设空串 = 全禁 command」的操作员意图静默变成「放行 node」。改为 `??`：未设置才回落 `node`，空串是**显式空表**（所有 `argv[0]` 判 VU `ERROR`，fail-closed）。补回归一例（空串下跑 `command` 型 VU → `ERROR` 且 reason 含 `allowlist`）。

- 记 backlog（评审观察，非本批新增）：`specDir` 按 `spec_id` 不按版本分目录（`verify-cmds.ts`），CLI 与 HTTP 同语义都收强制 `spec_version`——同 id 低版本号会覆写 `spec.json`，`run` 永远读最新写入。两面同源、在"操作员可信"模型下可接受，将来可考虑版本冲突拒绝或分版本目录。
- 无契约变更；`contract_version` / `corpus_version` 仍 1.1。测试 unit **442**（+1）/ Rust 31 / demo 128 / contract 100 / readme 54。

## 0.102.0

**升级注意**：无契约变更——`contract_version 1.1` / `corpus_version 1.1` 不变，已发规范、封包与归档包继续可验。新增的是**默认关闭**的 HTTP 执行面，CLI 命令面零破坏。

- **M13-2 第三批：作业式验证面**（`packages/ops/tools/src/verify-jobs.ts`）。`POST /api/verify/prepare` 收 `{material_id, candidates, reviews, snapshot_sha256, draft?}`，跑 P0–P5 冻版（只有 `verdict=ready` 且非 `draft` 才落 `prepare.json`/`spec.json`/`trace.json`，形状与 CLI 完全一致）；`POST /api/verify/run` 收 `{spec_id, snapshot_sha256, no_archive?}`，在快照副本上出报告并默认归档。两者与 CLI 共用 `verify-cmds` 的同一组原语（`schemaOf` / `snapshotCopy` / `specDir` / `findMaterial` / `archiveRun` 等改为导出），不另写第二实现——重复实现才是漂移的源头。
- **默认关闭（`webui serve --enable-verify-jobs`）**：一个嵌入方不该因为调了 `serve` 就默默获得「能执行任意 spec」的能力；未开时两端点回 403 并点名开关。执行面要求 `application/json`（415）、只收 POST（405）、请求体上限同材料草稿（413）。
- **三条不变量**：①**请求体永不携带可执行面**——没有 argv/allowlist/路径，夹带 `submission_dir`（或 `submission`）直接 400，因为目录树没有安全的 HTTP 来源，file 型检查器仍走 CLI/封包；command 型白名单由 serve 启动时注入（`YGL_VERIFY_ALLOW_CMD`，默认只放 `node`），不在白名单的 `argv[0]` 判 VU `ERROR` 而不是执行。②**快照只能按内容寻址**——先 `PUT /api/verify/blob?name=snapshot.sqlite` 再传 `snapshot_sha256`（64 位小写 hex，非法 400、缺 blob 404 并点名上传端点），服务端到 blob 仓取字节。③**run 只碰副本**——blob 字节先复制成临时快照再跑（与 CLI 同一条 `snapshotCopy` 路径），报告 `data_source` 记 `{kind:"sqlite-snapshot", source:"blob:<sha12>", sha256, captured_at}` 后重算 `payload_sha256`。
- **HTTP 状态只表达过程**：400 用法 / 404 找不到 / 415 / 413 / 422（快照不可读或引擎硬拒，文案 `run rejected: …`）；判定结论在 body——prepare 的 `verdict`（`ready` / `needs-material` / `error`）、run 的 `overall`（PASS 与 FAIL 都是 200）。归档失败记 `archive_error`，不把已生成的报告变成 500。
- **构造面仍在 agent**：`candidates`（提取/翻译产物）与 `reviews`（盲审三问）由 agent 提交，服务端只做 P0–P5 机械判定与冻版，绝不发明候选；缺数组回 400。**gateway 边界如实记录**：`~/.vercel.ai-gateway.env` 的 key 可调 typesafe-ai/jev，但它只回布尔概率、不产出带锚点引文，喂不进 `ReviewRunner`（review 契约要求逐条 `anchor.quote` + `locator`）——所以 HTTP 面在 agent 型 VU 上仍会 NEEDS-MATERIAL/ERROR，这是能力边界而非配置缺失。
- 测试：unit **441**（+16：`verify-jobs.spec.ts` 覆盖门/方法/JSON/体上限、prepare 落三件套与 `spec_<sha12>` 幂等、`--draft` 不落盘、缺 blob 404、非法 sha 400、缺材料 404、缺 candidates 400、run 出报告+归档、`no_archive`、语料例归档失败记 `archive_error`、`submission_dir` 400、缺 spec 404、command 白名单外判 ERROR）/ Rust 31 / demo 128 / contract 100 / readme 54。

## 0.101.1

**热修（发布后 P3）**：`createBlobSink().finish()` 的 `renameSync` 缺并发护栏——两个并发 PUT 同内容时，胜者落位后败者在 Windows 上抛 `EEXIST/EPERM` → 500，而语义上应幂等 200。修法与 `putBlob` 同款：`try/catch` → 清临时文件 → `dest` 已存在即返 ref；补「同内容并发收尾」回归（8 例）。

- **r19 非阻塞项（302cb119）**：N1 端点计数订正（0.100.0 = 6 读 + 1 写；0.101.0 = 7 读 + 2 写）；N2 坏报告静默丢弃 **显式 WONTFIX**（单条损坏不应拖垮整块看板，`verify report <run>` 会点名解析错误，后续可在 UI 加脚注）；N3 `.gitignore` 补 `*.tgz`；N4 评审证据链移入 `docs/reviews/` 并加索引；N5 补 blob PUT 的 HTTP 413 直接用例。

**回执勘误**：0.101.0 回执写附件 mime 上限「>128 字符弃」，代码实际是 **200**（`blob-store.ts` 的 `clientMimeOf`）——代码无需动，口径以代码为准；勘误同步进 plan 记录。

无契约变更；`contract_version` / `corpus_version` 仍 1.1。

## 0.101.0

**升级注意**：`contract_version` / `corpus_version` 均不变（1.1），已发规范与归档包继续可验。新增 HTTP 写端点与 blob 仓，CLI 命令面零破坏。

- **M13-2 第二批：附件内容寻址仓**（`packages/ops/tools/src/blob-store.ts`）。附件原始字节落 `$YGL_HOME/verify/blobs/<sha 前 2 位>/<sha256>`，材料记录只记 `{path,sha256,mime,size,stored,blob:true}` 引用；`verify submit --attach` 与 WebUI 上传共用同一写入函数，同一份文件重复提交只占一份磁盘。归档 `--with materials` 从仓按 sha 取字节（缺 blob 点名拒产半包），旧工作区未标 `blob` 的条目继续读材料目录副本。
- **HTTP 写入面**：`PUT /api/verify/blob?name=&mime=` 收原始字节（服务端按实收字节算 sha256，不信 `Content-Length`；客户端声明的 mime 只记录，实际 mime 按扩展名定）；超 64 MiB 回 413 JSON（不再只断连）；`.incoming/*.part` 孤儿在启动与上传前按 mtime 清 6 小时以上残留；`POST /api/verify/material` 接 `attachments:[{sha256,name}]`，引用未入仓 blob → 400，非 JSON → 415。
- **服务面补齐（r18 P2）**：`GET /api/verify/archives`（侧车展开）与 `GET /api/verify/reports?spec=`（按规范过滤）；订正 0.100.0 记录里「7 个只读端点」的误写——当版实为 **6 读 + 1 写**（specs/spec/reports/report/materials/material；本条原写「5 读」漏计 materials 与 material 两个端点，0.101.1 的 N1 订正已含此括注）。
- **安全修复（r18 P1）**：`/api/verify/{spec,report,material}` 的 id 此前直接拼路径，`?run=../../leak` 可读到 verify 根外文件。改为 id 白名单 `^[A-Za-z0-9_-]{1,128}$` + 解析后包含性断言，越界与不存在一律 404（不区分，避免探测）；补五条穿越探针（含 `%2e%2e%2f`）回归。
- **上传门（r18 P3）**：`createDashboardServer` 默认 **拒绝** 上传；serve 仅在回环绑定显式开，`YGL_VERIFY_ALLOW_UPLOAD=1/0` 可强制开关；门的是端点本身（403 JSON），不是只藏 UI 按钮。
- **WebUI**：材料提交视图接附件上传（`Upload` 原始字节 PUT → 只提单引用），追溯/看板视图区分「加载失败」与「空态」——失败不再显示成「还没有规范」。
- **文档订正**：契约新增 §4.7 服务面（端点/id 白名单/附件两步/413/415/上传门/孤儿清理）与 §7.5 附件字节来源；`spec-validator.md` §7 端点表按实现更新并把「R16 选择门」口径改正——验证器工件是 home 级，与项目选择正交；`plan.md` 0.100.0 计数误写订正。
- 测试：unit 423（+13：blob 仓 7 / 服务面 +4 / CLI 附件归档 E2E 1 / 三视图文案 1）/ Rust 31 / demo 128 / contract 100 / readme 54。

## 0.100.0

**升级注意**：无契约变更（`contract_version 1.1` / `corpus_version 1.1` 不变，语料 digest 不动）。新增 WebUI 服务面端点与三视图，CLI 命令面零破坏。

- **WebUI 验证器三视图（M13-2 第一批）**：`apps/web/src/Verify.tsx` + 服务端 `packages/ops/tools/src/verify-web.ts`（挂 `/api/verify/*`）。
  - **材料提交**：标题 + 一段话（模糊输入是常态）。附件上传尚未接（multipart 排第二批）——WebUI 对 `attachments` 字段**显式 400** 并指向 `verify submit --attach`，不静默丢弃（静默丢弃会让「提交成功」掩盖材料缺失，而材料缺失正是 NEEDS-MATERIAL 的根因）。
  - **构造追溯**（只读审计面）：规范清单 → 材料原文 + 构造结论（verdict/轮次/被拒）+ 「判据 ↔ 检查器」表（类型/比较模式/判据原文/锚点）。**没有 ✓/✗ 按钮**——判定链上没有人工确认。
  - **报告看板**：运行记录按 `finished` 倒序；详情把 FAIL/NEEDS-MATERIAL 例外项**置顶为处置清单**（severity + 行数），四态统计退居摘要；附引擎模式/签名身份/快照 sha/归档数。
  - 服务面实现 7 个只读端点 + 1 个写入端点（材料草稿，同正文幂等）；`prepare`/`run` 端点仍欠——构造面需要判定网关，接入前 HTTP 层不假装能跑。
- **r17 复核 P3 四项（302cb119）**：①`archive --with binary` 的内容身份分支补 CLI 用例（同 key 另一封包替换工作区副本 → `refusing to archive`）；②`prepare.spec` 增 `corpus_version === CORPUS_VERSION` 回归断言（此前硬编码 "1.0" 的缺陷无守卫）；③`docs/verify-signing.md` §2 补 unsigned legacy 语义——**完整性可验、身份未证**，且剥掉签名字段会改变 `binary_sha256`（降级不保留身份），发布物应要求 signed 登记；④§5/§6 措辞订正——`archive verify` 做的是**哈希链与签名登记项一致性**，它没有密钥表输入、不重验签名，真伪性走 `verify signature`。
- 测试：unit **410**（+12：verify-web ×8 / Verify 渲染 ×3 / archive 身份 ×1）/ Rust 31 / demo 128 / contract 100 / readme 54。

## 0.99.1

**升级注意**：无契约变化（`contract_version 1.1`、`corpus_version 1.1` 不变）。本版是 0.99.0 签名批的收尾补丁：修一处版本透传缺陷，补首签实证与运维文档两条口径澄清。

- **修 `verify prepare` 的 `corpus_version` 漏传**：此前硬编码 `"1.0"` 写进 `spec.verifier`（与语料 `1.1` 不一致，报告/归档版本链会错位）。`packages/verify/core/src/contract.ts` 新增 `CORPUS_VERSION` 常量，`prepareSpec` 默认值与 `verify prepare` CLI 都改用它。
- **`seal --key` 容错**：种子文件允许尾随换行（64 hex 或 32 字节裸种子，末尾多一个换行都可）；此前报 `must be 32 raw bytes or 64 hex chars (got 65 bytes)`。补 Rust 用例 `seal_accepts_seed_file_with_trailing_newline`（Rust 测试 31）。
- **首签实证（2026-10-20）**：生产 key #1（`key_id = 80a978fa…e3632`，私钥在本机 `$YGL_HOME/verify/keys/production.seed`，不进仓库）签发 Cordis 漂移守卫封包（spec `spec_efb9a6a40450` v3）：`verify signature` rc=0 → `register` → 封包直跑 `run_first_signed`（overall PASS 5/5，报告带 `verifier.signature/signing_scheme/public_key_fingerprint`）→ `report import` `imported:true` → `archive --with binary`（`arc_8b717422ca3a`，6 项）→ `archive verify {ok:true}`。密钥表与首签记录落 `docs/verify-signing.md` §3。
- **r16 复核修复（302cb119）**：①**legacy 封包可读回**——规范形断言（raw == JCS）只对 `format_version` 存在的 footer 生效；真实 0.98.0 形态（serde 字段序 + 非规范 spec + 无 `format_version`/`engine_sha256`）按 unsigned 读回，magic/布局/三条哈希仍逐项校验（补用例 `遗留 0.98.0 形态…`，此前"legacy 按 unsigned 读取"的承诺不成立）；②**二进制内容身份**——`report import` 与 `archive --with binary` 在文件名之外再核 `sha256(工作区字节) === report.verifier.binary_sha256`，把 `binaries/<sha>.bin` 换成同 key 签名的另一封包会被点名 `binary identity mismatch`；③**密钥表自检**——载入时校验 `key_id === sha256(public_key)`，贴错行即报 `key table inconsistency`。
- **文档两条口径**：`docs/verify-signing.md` 新增 §4.1——①footer 字段名是 `sig_alg`/`key_id`/`sig`（不是 `alg`），报告侧对应 `signing_scheme`/`public_key_fingerprint`/`signature`；②**`run` 只验完整性不验签名**（离线可跑，真伪性走 `verify signature`/`register`/`import` 链）。
- 测试：unit **398**（+3：legacy 读回 / 二进制身份 / 密钥表自检）/ Rust **31**（+1）/ demo 128 / contract 100 / readme 54。

## 0.99.0（2026-10-20）封包签名（ed25519）+ 契约 1.1

- **封包签名（footer v1）**：`yglverify seal --key <seed>` 在 footer 里写 `format_version` / `engine_sha256` / `sig_alg:"ed25519"` / `key_id` / `sig`；签名输入 = `JCS(去掉 sig 的 footer)`，`sig_alg`/`key_id` 在签名输入内、`sig` 不在。同一 spec、同一引擎字节、同一种子 → TS `signFooter` 与 Rust `seal` 的签名**逐字节相同**（`packages/verify/core/tests/seal-parity.spec.ts`，RFC 8032 §7.1 公开测试种子）。
- **验签认表不认报文**：`key_id = sha256(32 字节公钥)`；`verify signature <sealed> [--keys <file>] [--expect-key <hex|file>]` 只认 `--keys`/`YGL_VERIFY_KEYS`/`$YGL_HOME/verify/keys/signing-keys.json` 里的未退役密钥——公钥不得只从报告/封包自带材料自证，签名构建没有可信表就不通过。轮换**只增不换**（旧 key 标 `retired_at` 保留）。
- **登记与导入接上签名**：`verify register` 对签名构建先验签再落 `registrations/`（登记里记 `signature:{signed,verified,scheme,key_id}`）；`verify report import` 对已登记的签名构建**重新**从工作区二进制验一遍，并核对报告 `verifier.public_key_fingerprint === footer.key_id`；验不过 → `imported:false`（实测篡改工作区二进制副本后 import 当场点名 `binary signature does not verify`）。
- **报告自描述（contract 1.1）**：`verifier` 增 `signature` / `signing_scheme` / `public_key_fingerprint` 三个可选字段；`contract_version` 与 `corpus_version` 同时升 1.1（33 份语料 spec 仅版本字段变化，digest `4cac21b4f5bc…`，差异表见 `packages/verify/core/CHANGELOG.md`）。
- **篡改矩阵**：spec 字节、engine 字节、footer 非规范（raw ≠ JCS(parse)）、签名字节、未知/退役 key、未知 `format_version`、legacy 无签名字段——七向各自点名拒绝；TS 侧逐向单测覆盖，Rust 侧 `sealed.rs` 覆盖 spec/engine/规范形/format_version/签名五向（Rust 无验签路径）；旧 0.98.0 封包按 unsigned 读取（不假称已验证）。
- **未签名构建显式告警**：`seal` 不带 `--key` 仍可打包（供测试/内部），但 stderr 打 `warning: sealing without --key produces an unsigned build`。
- 文档：新增 [docs/verify-signing.md](docs/verify-signing.md)（信任边界、密钥表、验签顺序、事故处置、非目标）；契约 §5 实现形态与 §6 状态补 v1.4 行。
- 测试：unit **395**（+9：signature ×5、seal-parity ×1、sealed-signature 篡改矩阵 ×3）、Rust **28**、demo 128、contract 100。
`）。

## 0.98.0（2026-10-20）构造面无损试跑 + file 排除集 + r14 三项收口

- **`verify prepare --draft`**：跑完 P0–P5 只给结论，**不写** `spec.json`/`prepare.json`/`trace.json`、不消耗 `spec_version`。构造面调参不再污染版本号（此前每次试跑都推进 spec 版本，回滚只能删目录）。
- **file 检查的 `ignore` 排除集**（TS + Rust 对称）：被排除文件不进扫描面（`witness` 与 `evidence.ignored` 只算可见文件），`require`/`sha256` 仍按字面路径校验；全部被排除 → NEEDS-MATERIAL 而不是 PASS；P2 拒绝绝对路径、`..` 段与通吃 glob。契约 §1.7。
- **r14 R1（归档链）**：`data_source.sha256` 统一 `sha256:<hex>`（TS 曾写裸 hex、Rust 写前缀 → 跨实现 `archive --with snapshot` 必失败）；archive/retain 归一化剥前缀。新增 `archive --snapshot <db>`：Rust 直跑等没有 retained 快照的报告，显式交同一份字节，入包前按报告 sha 校验，不符即点名拒绝。
- **r14 R2（门禁可信度）**：parity 门断言 `rustPayload === rustCore`，并补 `data_source` 形态断言（此前该字段被剥除，正好是盲区）；`YGL_REQUIRE_RUST=1` 时缺 release 产物直接红，不再静默 skip。
- **r14 R3（封包判别）**：`looks_sealed` 改结构性候选——magic 字节坏、footer JSON 语法坏也算「封包被改」，一律 rc=1；不再降级成开放模式（rc=2）。
- **verify 组未知旗标 rc=2**：每个动作有旗标白名单，`--attachment` 这类误拼不再被静默吞掉（曾导致 `files: []` 却 rc=0）。
- **`--db` 语义纠正（r15 P1-1，重要）**：`verify <cmd> --db <file>` 的 `--db` 是**业务库快照**，verify 组不再把它当工作区库打开——此前 `verify run/prepare --db <业务库>` 会就地跑 ygl schema 迁移（实测给业务库灌入 57 张表、`user_version` 0→12），且 `data_source.sha256` 取的是改写之后的字节，证据与报告当场对不上。工作区库固定为 `$YGL_HOME/ygl-trees.db`；回归断言「verify 后业务库 sha 不变、表集不变」。
- 文档：契约新增 §1.7（ignore）、§1.8（CLI 文件形态：candidates/reviews/db 示例 + `--draft` + 未知旗标纪律），§7.5 补 `--snapshot`；`docs/spec-validator.md` §5 澄清「执行面闭集 ≠ 构造面发射集」（prepare 只发 sql/sql-pair/count/exists 四型）。
- 测试：unit **386**（+4：file-ignore ×3、verify-cli 未知旗标 ×1、archive 跨实现快照 ×1；r15 回归 +4：业务库不被迁移、`--no-archive`、`--draft` 不落盘）、Rust **28**（+1 封包损坏判别）、demo 128、contract 100。

## 0.97.2（2026-10-20）同字节重发（npm 版本元数据传播延迟消歧）

**内容与 0.97.1 完全一致，仅版本号不同。** 0.97.1 发布后 npmjs 的版本元数据约 16 分钟后才可解析
（tarball shasum `63e12145…`，registry time 17:57Z），期间外部复核探针 404；补发又撞上 npm 11 的
staged-publish 冲突（`Cannot publish over previously staged version`）。为消除「到底发出去没有」的歧义，
以 0.97.2 重发同内容，0.97.1 已 `npm deprecate` 指向本版。

运维结论：**`npm publish` 打印 `+ pkg@version` 不等于 registry 已可解析**——版本元数据也传播，
验收要直查 `https://registry.npmjs.org/<pkg>/<version>`，别只看 `npm view`。

## 0.97.1（2026-10-20）归档诚实性修复（评审 r12 G1–G5）

- **G1 归档确定性**：`manifest.created` 缺省从 `report.finished` 派生，不再取 `now()`——同一 run 反复归档字节一致，`zip_sha256` 可复算；契约 §7.3 写明。此前同一 run 两次归档会得到不同 zip（`created` 每次都变），与「同输入同字节」自相矛盾。
- **G4 归档入口 fail-closed**：报告缺 `payload_sha256` 直接拒绝归档，不产出「一验就红」的包。
- **G5 engine_version 进校验链**：`verify archive verify` 比对 `manifest.engine_version` 与 `report.verifier.engine_version`，不再只写不比。
- **G3 空 archives 目录 → SKIP**：`verify self-check` 的 archives 项在目录为空时报 skip，不再报 ok（没有可验对象 ≠ 验过）。
- **G2 `--help` 补齐**：verify 组帮助加上 `archive` / `archive verify` / `self-check` 三行。
- 测试：unit 374（新增 archive ×3：确定性/无 payload 拒绝/engine_version 点名；selfcheck ×1：空目录 skip）。
- 评审席侧残留（非阻塞，已记录）：`R7` 快照清理只做 TTL、`R9` registrations 暂无写入方（M13-1b 封包侧补）。

## 0.97.0（2026-10-20）归档包 + 递归自校验：产物可带走、校验器可被校验

- **归档是默认动作（`verify archive`，契约 §7）**：`verify run` 结束即归档，`--no-archive` 才关。文件名有语法（`yglverify-<domain>-<slug>-v<n>-<utc>-r<run8>.yglverify.zip`，domain/slug 都可退化），包内目录唯一（`manifest/report/spec/prepare?/trace?/materials/<id>/files/<sha12>-<name>`，深度 ≤4、全 ASCII 化、原名进 `items[].original_name`）。**报告不可变**：归档身份写侧车 `$YGL_HOME/verify/archives/<run_id>.json`，不改 `report.json`（否则 payload_sha256 自毁）。
- **确定性 zip（`zip-store.ts`）**：store-only、条目按路径字节序、mtime 固定 1980-01-01、外部属性 0644、无目录条目/extra/comment —— 同输入同字节，`zip_sha256` 跨平台可复算；`archive_sha256 = sha256(canonical(manifest 去掉自身两个字段))`，`archive_id = arc_<前12>`。附独立 zip reader（零依赖，CRC 不符即拒）。
- **`verify archive verify <file>` 重算全链**：路径规范 → 每条 item sha256/size → `archive_sha256` 重算 → 未声明条目点名 → `report.payload_sha256` 重算 → summary/overall **按 VU 结果重算**比对 → contract/corpus/spec_version/run_id 一致 → `materials_sha256` 与 spec 一致。任一环失败 rc=1 点名文件；**判定结论不在归档校验里表达**。
- **`verify self-check`（递归验证单入口，契约 §7.6）**：environment → canonical 向量 → 语料冻结摘要 → 形状快照 → 语料实跑（33 例含红队）→ 归档重算，六项逐条报 ok/fail/skip。**SKIP 不等于 OK**：发布产物不含 `corpus/`，缺语料时显式 skip 并提示 `--corpus` / `YGL_VERIFY_CORPUS`，绝不静默显示通过。`--no-cases` 关实跑、`--limit N` 只跑前 N 例。
- **语料运行器随包发布**：实现从 `corpus/run.ts` 移到 `src/corpus-runner.ts`（`corpus/run.ts` 保留为 re-export + 默认参数适配），`verify self-check` 才能用发布产物跑语料；惰性 `node:sqlite` 绑定保持不变（未触达 verify 的命令仍零 stderr）。
- **形状快照口径修正**：值为 `undefined` 的键不再进形状（它本就在 JSON 里不存在，如 open 模式的 `verifier.binary_sha256`），快照重铸；`self-check` 的 shapes 项校验每行 `path:type` 形态。
- **真实试炼场：Cordis 应用评审自动化（`scripts/cordis-scan.mjs` + `scripts/cordis-drift.mjs`）**：m00310 的一次性 Cordis 评审固化成 verify spec（五条不变量：跨域直连白名单外为 0 / 事件面 ≥20 / 0.86 删除的服务不复活 / 服务必须声明 ctx 合并 / 事件表裸写 ≤13），每轮 = 一次 verify run。采集器把 `packages/**`、`apps/**` 扫成只读 sqlite 快照（四表 + `meta.source_digest`），`--root` 可指向任意树用于验收注入。实测：HEAD `overall PASS` 5/5；把 src 拷到临时树并注入一条 `knowledge/skills → techtree/model` 跨域 import → 同一冻结 spec `overall FAIL`，只有 V1 失败，witness `rows_scanned=151 / rows_matched=1`、`evidence{count:1,op:"==",expected:0}`；`archive verify` ok、`report import` imported。方法论与纪律见 `scripts/verify/cordis-drift/README.md`。
- **修 `ratchet --write` 空转（真实缺陷）**：回归分支 `continue` 早退导致认账值从未写进基线——文档承诺的「显式 `--write` 重设基线」实际无效。改为作者席 `--write` 时 adopt 新值并记 `accepted`（rc=0），否则仍 rc=1。本版因此把 bundle 基线从 507800 重设为 552030（verify 命令面 + 归档 + 自校验的真实增量）。
- 测试：unit 370 / demo 128 / contract 100 / readme 53。新增 `archive.spec.ts` ×13（命名/路径/确定性 zip/篡改/缺件/侧车）、`selfcheck.spec.ts` ×6（全绿/改语料/改向量/无语料 skip/归档注入/摘要同算法）、`verify-cli.spec.ts` +4（archive 未知 run、缺文件、非 zip、self-check）。

## 0.96.0（2026-10-20）M13-1 spec validator：verify 命令面 + 契约/语料钉 1.0 + 度量棘轮

- **verify 命令面（M13-1 落地，主推④ 的机器判定入口）**：`submit`（冻结材料：正文 + 附件 sha256/size/mime）→ `prepare`（候选 → P0–P5 流水线：逐字锚点 → 机械形态校验 → 盲审三问 → 红队 → 冻版）→ `run`（**只碰 sqlite 快照副本**，报告记 `data_source{kind,sha256,source,captured_at}`）→ `list`/`report`/`trace`/`export`/`report import`（校验 payload_sha256 + 构建登记 + 三版本一致）。rc 只表达过程：发现 FAIL 的报告仍 rc=0，判定看 `overall`；`prepare` 只有 `ready` 才 rc=0。
- **契约钉 1.0**：`CONTRACT_VERSION = "1.0"`（引擎入口版本守卫，不匹配直接拒绝）；新增 `Predicate.scan` 扫描域（`where` 只进 find、`scan` 进 find+scope，`witness.rows_scanned` = 域内检查行数）；报告增 `spec_id` 与 `data_source`。**语料钉 1.0**：129 文件 digest `388604230680f9606635caf1d55403703347097ef0337a1aba8337fdaaa076f0`，`packages/verify/core/CHANGELOG.md` 记冻结依据与 8 条不兼容变更（版本守卫 / sealed.review=false / 拒 agent 型 / as_of 必填 / window 偏移归一 / canonical 只收纯对象 / scan 域口径 / count-exists 谓词扫描面已知局限）。
- **度量棘轮（`pnpm ratchet`，docs/measurement-ratchet.md）**：`scripts/ratchet.mjs` + `ratchet-baseline.json` 钉三条确定性度量——bundle 字节（容差 2%）、前端 dist 字节（2%）、`--version` 冷启动中位数（30%）；**变好自动收紧基线，变坏超容差 rc=1**，`--write` 才认账重设。刻意不测单测/demo 总时长（并行负载下测的是机器忙闲）。已挂进 `pnpm test` 末段。
- **形状守卫**：`packages/verify/core/tests/shape.spec.ts` 对 `VerifySpec`/`VerifyReport` 的字段路径+类型做快照（快照首行钉 `contract_version`）——契约 1.0「不得静默改内文」有了机械门；升 1.1 必须重铸快照并进评审。
- **修一个真缺陷（JSON 纯净）**：verify 命令面曾顶层 `import node:sqlite`，让**每条命令**的 stderr 都带 ExperimentalWarning（demo 的 2>&1 捕获因此变红）。改为 `sqlite-bindings.ts` 惰性 require，未触达 verify 的命令零噪音。
- **r10/r11 评审修复**：`$` 守卫收窄 `$vu:`（`$50` 不再误伤）；window 时间偏移归一（`+08`→`+08:00`）；agent 型在 prepare P2 直接拒（M13-1 fact-only）；`as_of` 必填；canonical 拒非纯对象；`--help` 补 verify 组；快照临时库 7 天自清理；`report import` 补 engine/corpus 版本校验。
- 测试：unit 347 / demo 128 / contract 100 / readme 53；新 `verify-cli.spec.ts` ×6（rc 三态 + JSON 纯净 + import 形状）、`shape.spec.ts` ×2、predicate R4 ×2。

## 0.95.0（2026-10-19）毕业三件套 demo 落地 + source tags 读面修复

- **毕业三件套 demo 序列（0.94 P3 承诺兑现）**：demo.sh §9g——supported 断言（判据可机读）→ `source add --tags sop`（执行体词汇落账）→ `rel executes`（能力位↔SOP 源接缝边）三断言全绿；docs/graduation-protocol.md 自指验收条款闭合（demo 125→128）。
- **source 读面 tags 修复（demo 抓出的真缺口）**：`source list`/`source search` 投影漏掉 tags——毕业协议写明的消费方式「按 tags=sop 拉源」在 CLI 读面上不可能。修复三处：cmds.ts list 投影 + reads.ts sourceList SQL + sourceSearch cols；tags 一直有落库（FTS 也索引），只是读面看不见。
- 测试：demo 128 / contract 100 / readme 53；unit 258 不变（无新命令面，断言由 demo 承载）。

---

更早版本（0.1.0 – 0.94.0）的变更记录见 [docs/CHANGELOG-archive-2026-10-20.md](docs/CHANGELOG-archive-2026-10-20.md)（归档按拆分日期命名，指针只指向最新归档）。
