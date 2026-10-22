# 子句覆盖规则（冻结附录）

> 2026-10-23 文档预算治理：由 `docs/verify-contract.md` §1.6 移出，内容未改动（规范效力不变，按引用执行）；契约正文保留摘要与链接。

**子句覆盖（#34；0.114.1 引入，修正版按规则界定子句——对齐审查席 #34 设计提案 a–d）**——判据不得静默消失（丢一条规则冻结出 ready 的 spec，会 PASS 本应 FAIL 的数据），但子句的范围由**规则**决定，不由豁免清单决定：

- **子句 = 匹配子句模式的行**；模式的第 1 个捕获组是子句 id。默认模式是舰队约定 `^([A-Z]+[0-9]+) `（大写字母 + 数字 + 一个空格：`S1 …`、`P12 …`、`AB3 …`）。材料可在冻结时声明自己的模式：`verify submit --clause-pattern <regex>` 把它写进 `material.json` 的 `clause_pattern`，**与材料一起冻结**（声明的模式参与 `material_id` 哈希——同一文本换模式即另一份材料，不会静默改靶；未声明时 id 与旧版一致）。prepare（CLI 与 WebUI 作业端点）只认材料里冻结的模式，不接受临时旗标；`lint-candidates` 面对的是裸文本文件，用 `--clause-pattern` 声明。模式缺捕获组或非法 → rc=2。标题（`#`/`##`）、空行、表格/结构行、散文（`验收对象：…`）、纪律列表**按规则不在范围内**。同一 id 声明两次 → 覆盖问题（点名两处行号）。
- **没有一行匹配不是静默通过（SKIP ≠ OK）**：
  - 材料**声明了**模式却一行不中 → 覆盖问题（`no clause lines matched pattern … misconfiguration`），lint `ok:false`，prepare `error`。
  - 用**默认**模式一行不中（未编号的旧材料）→ 具名跳过：lint 输出 `coverage_skipped:true`、`coverage.enforced:false`，并在 `issues[]` 里放一条 `{stage:"COVERAGE", level:"warning", reason:"no clause lines matched pattern …"}`——只读 `issues` 的门禁也看得见跳过；`ok` 只计拒绝（`level` 缺省），因此仍是 prepare 的投影（prepare 对这类材料照常 ready）。门禁要「必须有覆盖」时判 `ok && !coverage_skipped`。prepare 的 ready 记录带 `diagnostics[stage=P1c]` = `no clause lines matched pattern … — clause coverage not enforced (a skip, not a pass)`，`--json` 带 `coverage`。
  - prepare 记录（`prepare.json` 与 `attempts/*.json`，CLI 与 WebUI 作业端点同口径）带结构化 `clause_scope: {pattern, declared, enforced, clauses}`——冻结时按哪个模式、是否声明、是否真的执行了覆盖。不造子句（0.114.1/0.114.2 的「每行都是子句」回归），也不把跳过折成 OK。要开启覆盖：把判据编号成 `<id> <text>`，或 submit 时声明模式。
- **定位语法**（`[文件名]#<片段>`，取最后一个 `#` 之后）：`#<片段>` **先**按子句 id 解析（所以 `#S1`、`#L2` 是子句 id，不是行号）；`#line=<n>` 是物理行（1 起）的独立写法。材料有子句时，其他任何 `#片段` 都是 P1 拒绝（点名「declares N clause(s): S1, S2, …」——诊断数子句就只说子句，说行就只说行，不混用）；无子句时 id 片段无从解析，只受 material_index 约束。不带 `#` 的 locator（`bills!B7`、`p3`）只受 material_index 约束。quote 必须落在 locator 所指的子句 / 行内。
- **覆盖**：每条子句必须被一个**通过 P1** 的候选认领——其 `anchor.locator` 解析到该子句（或其所在行），或其 `source_clause` 包含整行子句原文；只引片段又无可解析 locator 的候选不认领任何子句（`S1` 不能顺带覆盖 `S10`）。prepare 在 P1–P3 之后、P4 之前校验，未覆盖 → `verdict:error`、`diagnostics[stage=P1c]` 按 id 点名；lint 同源，`coverage:{pattern,enforced,clauses,covered,exempted,uncovered:[{id,locator,line,text}],problems}`、`issues[].stage="COVERAGE"`。
- **豁免**（`--coverage-exempt <file>`：JSON 数组或 `{exempt:[…]}`）：每条是对象，恰好用 `id`、`locator`（`#S3`）或 `text`（整行原文）之一指明子句，并带**必填** `reason`；裸字符串条目 rc=2（没有隐式 reason）。**不认行号**（`#line=<n>` 豁免被拒——材料一改行号就静默改靶）。指向不存在的子句、缺 reason、或豁免一条已被覆盖的子句 → 覆盖问题。
- **评审配对**：prepare 把评审文件里的 `source_clause` 交给构造面（`PrepareOptions.reviewedClauses`）；没有任何候选携带的评审是**孤儿评审**（判据在评审后被删或改名）→ `verdict:error`、`diagnostics[stage=P3]`。无评审的候选本来就在 P3 以「self-review incomplete」被拒。`lint-candidates --reviews` 同源（`stage:"REVIEW"`）。
- **发布门禁**：`contract-audit` contract 15 对 `packages/verify/core/tests/fixtures/fleet/` 下冻结的 24 份真实舰队材料（审查席 7 份、webui 6 份含 view、fleet 2 份、design 9 份；均带标题/散文/纪律节）跑 `lint-candidates --text --reviews` 与 `submit → prepare --draft`，任何非 ok / 非 ready 即阻断。
- **契约面**：spec 与报告形状不变（`contract_version` 1.2、`corpus_version` 1.2）；变化在构造面——`material.json` 增可选 `clause_pattern`、lint 输出增 `coverage_skipped` 与 `coverage.enforced/pattern`、prepare `--json` 增 `coverage`（均为加法）；豁免文件与 `#L<n>` 行号写法（0.114.1 引入）语义收紧。charter 不涉及。
