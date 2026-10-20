# spec-validator 设计（验证规范驱动器）— M13 提案（2026-10-19，用户目标 m11350 / 无人工确认裁定 m11558）

> 一句话：**业务专家只提交材料（一段话+附件），agent 把判据构造成确定性可执行的验证器并驱动执行，验证器输出 `true` 即判定通过——全程无人工逐项确认，最终交付带证据的布尔结论。**

## 1. 为什么是这个（血统）

本会话反复验证的核心命题——「eval 门过≠解锁」（kb f4a2a9299f）、「模型读到五步在跑就判数据已入账」（tta-target 人审推翻）、「决策模型比 agent 直觉审慎一级」（50+ 轮实测）——全指向同一结论：**语义概率可以辅助分类，不能当结论**。本工具把这个结论产品化：

- 判定分两层：**fact 层**（SQL/文件/命令——确定性，逐字重放）与 **review 层**（agent 按冻结 rubric 审阅——布尔+引文，标注来源）。**没有第三层「人裁」**——m11558 用户裁定：没有专家逐项确认，agent 通过验证器输出为真判定通过。
- 正确性不靠人签字，靠三件事（§4.3）：**可审计构造**（判据原文+出处锚点随身）、**独立上下文自审**（第二个 agent 复核构造）、**抗弛构造守卫**（空转/自证检查器机械拒绝）+ **fail-closed**（判不了=不通过）。
- 与 .157 ops-handbook 的血缘：其 SOP 巡检四问判据 + S1/S2/S3 信号 + 零未处置铁律，就是本工具检查器的实战祖先（10-17 起在产运转）。
- 与 patrol 的分工：patrol=**持续**巡检（同一 SQL 反复跑+处置队列）；spec-validator=**按规范**的一次性/里程碑验证（材料驱动+agent 全链驱动+报告交付）。两者共享 SQL 门语法。

## 2. 流程（谁干什么——零人工确认环节）

```
业务专家 ——提交——> 业务材料（一段话 + 附件：基准材料/提交物）
   agent ——构造——> 逐条判据 → 验证单元 VU（判据原文 + 出处锚点随身）
   agent ——自审——> 独立上下文复核（忠实/可判/非空转）→ 通过才可执行
   agent ——执行——> 逐项跑检查器 → 布尔结论 + 证据
        ——交付——> 验证报告：PASS / FAIL / NEEDS-MATERIAL / ERROR
```

人工只在**提交材料**与**事后审阅报告**两处出现——都不在判定链上，任何一步都不等人签字。验证器输出 `true` = 该项通过；`false` = 不通过；判不了 = NEEDS-MATERIAL（不是通过）。

## 3. 材料提交（业务专家面——模糊输入是常态，不是例外）

**专家的真实输入不是结构化表单，是业务材料**：一段话 + 任意附件（图片/表格/PDF/压缩包）。设计原则随之翻正：

> **结构化是预处理的输出，不是专家的输入义务。**

**两类附件（m11490 区分）**：

| 类别 | 作用 | 例 |
|---|---|---|
| **基准材料** | 提供期望值/规则出处——「什么算对」的证据 | 报价基准.xlsx、合同条款.pdf |
| **提交物** | 被验证的交付件本身——业务方交上来的东西 | 本月账单包.zip（文件级）、结算单.pdf、发票截图.png |

提交物是验证的**靶子**；基准材料是**标尺**。二者都可以是图片/PDF/表格/压缩包（压缩包按**文件级**验：清单、命名、数量、校验和）。

提交形态（WebUI / `verify submit` CLI）：

```
标题：FBA 头程运费对账 · 2026-10 批次
一段话（意图/判据，自由文本）：
  「每张运费发票金额要跟订单应付对得上；附的是这批的报价基准和账单包；
   超过一周没对账的要暴露出来」
基准材料：
  报价基准.xlsx   （期望值表——基准价在文件里）
  合同条款.pdf    （规则出处）
提交物：
  账单包.zip     （文件级：解包清单要与发票号清单一致）
```

附件入 content-addressed blob（新表 `attachments`：sha256/size/mime，评审 R3），可追溯、可重放。专家零 SQL、零代码、零字段义务——写不清楚的部分交给 agent 构造，构造不了的不会静默通过（fail-closed，见 §4.3）。

## 3.5 提交物即验证器（m11490 核心洞察）

> 「验证的提交物，本质上也是一个验证器，只是类型不同，他只输出布尔值。」

推论三条：

1. **提交物是可判定的**：任何提交物都能被「某个验证器」判真/假——文件在不在（布尔）、清单齐不齐（布尔）、内容合不合裁（布尔）。
2. **多数场景的验证者是 agent**：业务界的交付物（报告、报表、方案、压缩包）大多没有 SQL 面，靠「对照 rubric 读一遍」判布尔——这是 agent 型的原生场景。
3. **布尔是唯一输出契约**：不管来源是 SQL、文件清单还是 agent 审阅，对上层输出**同一个布尔 + 证据**——来源只影响证据的形态与「真」的承诺强度（§6）。

## 4. 构造（agent 全链驱动——模糊消解器，零人工确认）

`verify prepare <spec>` → 三步：**提取 → 翻译 → 自审**（无待确认清单，m11558 裁定）。

### 4.1 提取（值从哪来——三源）

| 值来源 | 说明 | 例 |
|---|---|---|
| **材料提取值** | agent 读附件挖出的数字/规则（xlsx 解析、PDF 抽取、图片走视觉模型），**每个值带出处锚点**（哪份文件·哪页/哪sheet哪行/哪区域） | 基准价 2.35/kg ← 报价基准.xlsx·Sheet1·R5C3 |
| **材料显式值** | 一段话里明确给出的数/期限 | 「7 天内」→ 容差窗口 7d |
| **运行时查询值** | 验证时才从数据库取（当前态） | Odoo 运费发票金额 |

提取值在 prepare 阶段**一次性冻结进 VU**（静态期望值）——run 阶段模型只做 review 层审阅，fact 层零模型。

### 4.2 翻译（一段话 → 候选 VU）

每条候选 VU：

```json
{
  "id": "V1", "title": "发票金额一致性", "severity": "S1",
  "source_clause": "每张运费发票金额与对应订单应付金额一致（来自提交材料+报价基准.xlsx）",
  "checker": {
    "type": "sql-pair",
    "left":  {"table": "freight_invoices", "key": "order_id", "value": "amount"},
    "right": {"table": "purchase_orders",  "key": "id",       "value": "payable_amount"},
    "compare": { "mode": "tolerance_abs", "value": 0.01, "currency": "CNY", "scale": 2, "cardinality": "1:1" }
  },
  "expected_from": {
    "quote": "每张运费发票金额与对应订单应付金额一致（来自提交材料+报价基准.xlsx）",
    "locator": "定价框架.md:41",
    "note": "两侧均为运行时查询"
  }
}
```

- **判据原文永远伴随 VU**（source_clause）——翻译可审计、可回放，报告逐条呈现「哪条判据被翻译成了什么检查器、依据什么材料」。
- **每个期望值带出处**（expected_from）：材料显式 / 材料提取（source_id + 锚点：文件·页/sheet/行/区域）/ 运行时查询——「基准价 2.35 来自报价基准.xlsx·Sheet1·R5C3」直接进报告。
- 模型在此阶段做三件事：①读附件提取值/规则（表格解析、PDF 抽取、图片走视觉模型）②分类判据→选择 checker 类型 ③把数据描述→表/列引用（需数据 schema 可达）。全部模型调用前压到 prepare，一次性。

### 4.3 自审（审计门——替代人工确认的三重防线）

没有专家逐项确认，正确性由**三重机械防线**保证，全部自动执行：

1. **可审计构造**：VU 必须携带 source_clause（判据原文 verbatim，不得转述）+ expected_from 锚点。报告展示「判据原文 ↔ 检查器 ↔ 证据」全链——事后任何人都能复核（复核是可选动作，不是通过门槛）。
2. **独立上下文自审**：第二个 agent（全新上下文，只拿到「材料 + VU 清单」而无构造理由）逐条回答三个问题——**忠实**（这条 VU 真是那段判据的意思吗）/ **可判**（输入数据可达吗）/ **非空转**（这个检查器真能失败吗）。任一不合格 → 构造 agent 修订（≤3 轮）；仍不合格 → 该 VU 判 `NEEDS-MATERIAL`（不给通过）。
3. **自审的可验收契约（评审 B6）**：三问不够——must-meet 四条：
   - **锚点复读**：reviewer 必须逐字引用冻结材料在锚点处的原文（文本/xlsx 可字符串比对；图片要求裁剪区 + OCR 文本且数值出现在其中）；引不出 → 该 VU 不通过自审；
   - **盲审**：每轮全新上下文，不带上一轮结论/修订史；「≤3 轮」每轮独立；
   - **红队语料**：≥8 例故意松弛/错误规格（恒真谓词、错列、同源期望、把含税读成未税）必须 **100% 被拒**，否则自审层不验收；
   - **异模型族优先**：reviewer 模型族与构造模型不同（至少不同温度），降低共同误读相关性。
4. **抗弛构造守卫**（机械规则，写死在 checker 校验里，违反即拒绝构造）：
   - **空转拒绝**：checker 两侧同源（同表同列自比、条件恒真 `WHERE 1=1`、期望值来自与实测值同一锚点）→ 拒绝；
   - **无条件拒绝**：sql 型无 WHERE 或只在视图上聚合 → 拒绝；
   - **覆盖率检查**：每条 source_clause 至少映射一个 VU，或显式声明该判据不可机器判定（进 NEEDS-MATERIAL 并说明缺什么材料）——判据不许静默消失；
   - **fail-closed**：材料不足以锚定任何检查 → NEEDS-MATERIAL，绝不落 PASS。
   - **per-type 最小强度（评审 C3-ii）**：`sql-pair` 的 tolerance 必须落在合法数值域（**`exact` 不带 ε**；`tolerance_abs|tolerance_rel|window` 的 **ε 必须 >0**（ε=0 即 exact，混用=空转，拒绝）；`range` 必须给上下界）；`count` 的判据不得恒真（`>= 0` 之类拒绝）；`file` 的 glob 不得匹配任意名（`*`/`**` 裸用拒绝）；`agent` 的 rubric 必须含**可证伪检查点**（全称肯定句如「格式规范」=空转，须写「字段 X 缺失即 FAIL」这类可失败项）；`sql` 无 WHERE/仅视图聚合拒绝（已有）。
   - **typed tolerance（§4.1 补全）**：容差形状统一（R7）——`tolerance_abs`（绝对数值 ε）、`tolerance_rel`（相对比例 ε）、`window`（时间窗口 ε + `unit:"d"|"h"|"s"`，如「7 天内」→ `{"mode":"window","value":7,"unit":"d"}`）；`unit` **只属 window**，数值域带 unit 即拒绝。

自审与修订过程全部写进 spec 的 meta（谁在第几轮改了什么），报告可追溯。

## 5. 检查器类型（闭集——按判定来源分两层）

| type | 语义 | 来源层 | 真承诺 |
|---|---|---|---|
| `sql` | 断言查询，违规行=FAIL（patrol 同语法：SELECT 前缀门+分号拒绝） | **fact** | 逐字重放 |
| `sql-pair` | 两表按键值比对（容差 ±ε） | **fact** | 逐字重放 |
| `count` | 计数窗口（telemetry 同语法 `kind[:win] op N`） | **fact** | 逐字重放 |
| `exists` | 记录/证据存在性 | **fact** | 逐字重放 |
| `file` | **文件级检查（m11490）**：存在性/类型/大小/zip 清单/命名规范/校验和 | **fact** | 逐字重放 |
| `command` | CLI 命令 rc=0 / stdout 匹配 | **执行事实**（不进 fact 折叠；witness 可选） | 逐字重放（stdout 摘要） |
| `agent` | **提交物审阅（m11490）**：按冻结 rubric 读提交物 → 布尔 + 逐项引文 | **review** | 可复核（rubric+引文），不承诺逐字 |

**两层「真」的承诺**（§6 展开）：

- **fact 层**：确定性事实——同输入同判，逐字重放；
- **review 层**（`agent`）：模型审阅——输出布尔但**标注来源**，证据=rubric 逐项检查+提交物原文引文，事后可人工复核推翻（复核不是通过门槛）；不冒充事实；
- **NEEDS-MATERIAL 是诚实非真态**（§6）：判不了 → 不给通过，绝不静默落 PASS；**提交物本身不可读**（文件坏了/加密/格式不认）归 NEEDS-MATERIAL（补材料可解），**不是 ERROR**（评审小项边界）。

**闭集纪律**：新增 type = 破坏性变更（走 schema 版本）。判定输出永远不含概率；语义判不了且无 rubric 可依的判据在构造阶段就该落 NEEDS-MATERIAL，不许硬编成 `agent` 或塞进 sql 糊弄。

**执行面闭集 ≠ 构造面发射集**（0.98.0 口径澄清）：七型是**引擎能执行**的闭集；`verify prepare` 目前只**发射** `sql` / `sql-pair` / `count` / `exists` 四型（P2 闸拒 `file`/`command`/`agent`），其余三型只能以手写 spec + 评审例外的形态进入执行面。两者分开读，别把「引擎支持」当成「构造器会产出」。

### 5.1 VU 角色：`assert` 与 `source`（评审 C1——语义地基）

每个 VU 必须声明 `role`，这是**四态契约能说清话的前提**（评审 direct-5fbe6d54 C1）：

| role | 语义 | verdict | 计入总判定？ |
|---|---|---|---|
| **`assert`**（断言，默认） | 检查器违规行 = 业务不合规 → FAIL | PASS / FAIL / NEEDS-MATERIAL / ERROR | **是** |
| **`source`**（数据源/投影） | 只负责把数据取出来给下游用（`$vu:<id>.out`），自身不判定 | **不参与折叠**（PASS-by-construction；取数失败=ERROR 级联） | **否** |

- **总判定 = 所有 `assert` 节点独立合取**：任一 `assert` FAIL → 总 FAIL；`source` 节点不参与总判定，只作为数据管线的一环在 trace 里呈现。
- **逐条计数不折叠**：V1 FAIL、V2 消费 `$V1.rows` 后 PASS 时，报告分别记两条（V1 FAIL / V2 PASS），summary 的 `fail` 计数以 assert 节点为准——不允许「下游过了就当上游没问题」。
- **空转守卫**：`source` 节点**未被任何下游引用** = 空转 → 构造拒绝（写了等于没写）。

这条必须钉在语料与双实现门禁之前（Rust 面按同一语义实现），否则两面对「V1 到底断言什么」各写各的。

**`agent` 型的 run 时行为**：rubric 与提交物快照在 prepare 阶段**已冻结**，run 时模型只按冻结 rubric 对照冻结提交物——输入确定性封死，输出标注 review 层；同一 rubric+同一提交物重跑原则上同判（允许抖动，报告标注并给复核通道）。fact 层在 run 时零模型。

## 5.5 管线组合（函数语义，m11413 裁定）

**每个 VU 是一个纯函数**：输入 → {verdict, evidence, **outputs**}。输出带类型（七域 + rowset 行集型），可被下游 VU 引用——一个验证器的结果是另一个验证器的输入：

```
VU := (环境查询值, 附件提取值, 上游输出 `$vu:<id>.out`) → { verdict, evidence, outputs: {name: type} }

V1 (sql)      : 「拉超期未对账账单」      → outputs: {rows: rowset}
V2 (sql-pair) : 「$V1.rows 逐行 vs 报价基准」 → inputs: $V1.rows → outputs: {violations: rowset}
V3 (count)    : 「$V2.violations == 0」   → 0 行=PASS；>0 → FAIL 并带样例行
```

- **引用语法**（302cb119 r3 收窄）：唯一命名空间 **`$vu:<id>`**，仅支持两处消费位——**`count.from`**（上游行集）与 **`sql-pair` 某一侧的 `from`**；`sql` 的 `WHERE IN` 占位展开**首版不支持**（SQL 文本里出现 `$` 一律按非法字符拒绝）。
- **执行序 = 拓扑序**：复用科技树引擎的 DAG 语义（拓扑排序 + 环检测）——规范内引用成环在 prepare 阶段拒绝（同 `node validate`）。
- **级联语义**：上游 FAIL → 其 outputs 仍然产生（FAIL 的行集正是下游要消费的证据）；上游 ERROR（表不存在/连接断）→ 下游标 ERROR（原因=上游不可用），不装死也不中断独立分支。
- **verdict 传播（评审 C1 补 + R5 表述修正）**：`source` 节点**不参与折叠**（PASS-by-construction，仅记录 trace；取数失败=ERROR 级联，下游引用了它才暴露）；下游 `assert` 的判定**独立成立**，不因上游 FAIL 而自动 FAIL（上游行集正是它的输入）；总判定只做 `assert` ∧，`source` 与 trace 不进 summary 分母。
- **确定性保持**：组合是纯数据流——同输入同输出同判定；报告=管线执行 trace（每级展示收到什么、产出什么、判了什么）。
- **与科技树同构**：spec 内 VU 图是 mini-DAG，树引擎的闭包/拓扑/环检测直接复用；跨 spec 组合（一个 spec 的报告作为另一个 spec 的输入）未来走 artifact 引用，首版不做。

## 5.2 整体判定与 severity（评审 B1——判定聚合）

**overall ∈ {PASS, FAIL, NEEDS-MATERIAL, ERROR}**，折叠规则（写死，报告头与 `--json` 单对象都带 `overall` + `reason`）：

```
overall = FAIL  if 任一 role=assert 的 verdict=FAIL
        = NEEDS-MATERIAL if 无 FAIL 且任一 assert=NEEDS-MATERIAL
        = ERROR if 无 FAIL/NM 且任一 assert=ERROR
        = PASS  otherwise
```

优先级 **FAIL > NEEDS-MATERIAL > ERROR > PASS**——「业务不对」压过「没判成」压过「环境故障」。`source` 节点不参与（§5.1）。混合态必须在报告首屏可见（例：2 FAIL + 1 NEEDS-MATERIAL → overall=FAIL，但 NEEDS-MATERIAL 条目单独列出、附补材料清单）。

**severity 权属**：S1/S2/S3 在构造阶段按判据语气赋值（材料/规范中「必须/不得」→ S1，「应」→ S2，「建议」→ S3），自审只允许上调不允许下调；severity **不改变 overall 数学**，只决定报告呈现顺序、处置队列优先级与是否自动开 task（**NEEDS-MATERIAL 自动开**；首版 FAIL 只进例外清单不自动开——与 §12 决策表 E 一致，R9 统一）。

## 5.3 比较契约 CompareSpec（评审 B5——数值/单位/基数/NULL）

所有比较器只认一个 `CompareSpec`，字段闭集：

```json
{ "mode": "exact|tolerance_abs|tolerance_rel|window|subset|superset|range|regex",
  "value": 0.01,  // exact 不带；tolerance_* 必 >0；range 为下界
  "value_max": 10, // 仅 range
  "unit": "d",     // 仅 window（d|h|s）
  "currency": "CNY", "scale": 2,
  "cardinality": "1:1|1:N|N:1", "null": "error|equal|ignore" }
```

- **货币**：`currency` + `scale` 必填，比较一律换算成**最小单位整数**（分）后比，禁止浮点直比；小数位超出 `scale` → 构造拒绝。
- **sql-pair 基数**：默认 `1:1`；键重复（1:N fan-out）**默认 ERROR 点名**，需要聚合时显式 `cardinality:"1:N"` + `agg:"sum|max|min"`。
- **NULL 语义**：默认 `null:"error"`（NULL vs 0 不相等，也不当作缺失静默放过）；`null:"equal"` 仅在判据原文明确时使用。
- **count / exists 语义**（评审 B5 修正）：**业务数据源查询语义**，不是 ygl 事件账本——`count` = `SELECT count(*) FROM <table> WHERE <pred>` 在 `as_of` 窗口内；`exists` = 查询返回 ≥1 行。ygl 事件账本语义仅在 workspace 模式的 telemetry 检查器里保留（封包模式不可用，构造时点明）。

## 5.4 scope witness（评审 B2——防空洞通过）

每个 fact 检查器**必须**输出：

```json
"witness": { "rows_scanned": 42, "rows_matched": 2,
             "sources": [{"table":"freight_invoices","rows":42}],
             "schema_fingerprint": "sha256:…" }
```

- `rows_scanned = 0` → **NEEDS-MATERIAL**（表空/选错表/谓词全 NULL 都不许落 PASS）；
- 零匹配结论**按型而定**（不再一刀切 NM；逐型见 `docs/verify-contract.md` §2.1 表：找违规 matched=0 → **PASS**；找缺失 matched=0 → **FAIL**；`file` 缺省 PASS、`min`/`require` 缺失 → FAIL；`count` 见下条）；
- prepare 冻结 schema fingerprint（表/列/类型），run 不一致 → **ERROR**（schema 漂移=环境不满足契约）；
- 证据行 canonical 排序（主键升序，NULL 置末）——否则「逐字重放」不成立。

## 6. 交付契约：真 + 产物（m11429 用户裁定）

**交付 = 一定为真的结论 + 可持有的产物。**

### 6.1 真（判定纪律——按来源分层承诺，零人工签收）

- 每项 verdict ∈ {PASS, FAIL, **NEEDS-MATERIAL**, ERROR}，且**每项标注判定来源**（fact / review）：
  - **fact 层**（sql/sql-pair/count/exists/file/command）：PASS/FAIL 是**事实陈述**——带证据（违规行数、样例行、两侧数值、文件清单）且**可重放**（同一数据快照+同一 spec 版本重跑，逐字段一致；时间戳仅入 meta 不入判定）；
  - **review 层**（agent 审阅）：PASS/FAIL 是**布尔审阅结论**——证据=rubric 逐项勾选+提交物原文引文，报告显式标注「审阅层，可事后复核推翻」；不冒充事实；
  - **NEEDS-MATERIAL / ERROR 是诚实的非真态**——判据无法被材料锚定/数据不可达/检查器自身失败，绝不冒充真假（与 FAIL 严格分开：材料问题 ≠ 判据不满足），且 **NEEDS-MATERIAL 不算通过**；
  - 只有可证伪、可复验（fact）或可复核（review）的结论才允许交付——「一定为真」的工程含义：**验证器输出 true 才判通过**。
- 报告不可变：每个 run 一个 artifact（kind=verify-report），永不覆写、永不清洗。

### 6.2 产物（专家拿走的东西）

1. **验证报告**（处置清单优先：FAIL 项=工作清单，含单号/差值/判据原文/基准出处/管线 trace）
2. **证据包**（可追溯锚点全链：判据原文→附件出处→违规行→两侧数值）
3. **规范资产**（可执行的 spec——可重跑、可毕业 patrol、可挂树）
4. **补充材料 task**（NEEDS-MATERIAL 自动落账，零未处置——要的是材料，不是签字）

## 6.5 版本管理（m11429 用户裁定：验证器必须版本化）

| 对象 | 版本语义 | 机制 |
|---|---|---|
| **spec（规范）** | 每次 prepare 自审通过即产生新版本（v1→v2…）；修订=重新 prepare（自审失败项回炉） | artifacts.version 自增；旧版本只读保留 |
| **run（报告）** | 钉住 spec 版本 + 附件 sha256 快照 | 报告头记 {spec_id, spec_version, attachment_sha256[], db 快照标识}——重放=同版本+同输入 |
| **附件（基准文件）** | 不可变 blob：报价基准换版=新 `attachments` 行，**旧报告的锚点永不断链** | content-addressed（sha256 去重、append-only） |
| **毕业（patrol）** | 毕业产物记 spec 版本来源 | graduation 引用 {spec_id, version} |

对比视图的版本对：同数据两版规范（判据修订影响面）/ 同规范两次 run（数据漂移）——报告看板的 diff 就是这两个轴。

## 7. 前端支持（WebUI，用户裁定 m11362；无确认环节 m11558）

业务专家的主界面就是浏览器，不是 CLI。React 客户端（apps/web，现有 webui serve 承载）新增三个视图：

1. **材料提交视图**（专家填写面，m11390 修正）：**标题 + 一段话 + 附件上传**（图片/表格/PDF/压缩包拖拽区）——不是结构化字段表单；结构化是 agent 构造的产物，不是专家的输入义务。附件上传即入 content-addressed blob（归属当前项目，sha256 去重）。草稿自动保存（artifact kind=verify-spec, status=draft）。提交即触发 prepare（含自审），无需二次确认。
2. **构造追溯视图**（审计面，非门槛）：只读展示 prepare 产物——左列判据原文 + **材料出处**（期望值锚点：报价基准.xlsx·Sheet1·R5C3；图片值标注提取区域），右列翻译出的 checker（类型+表+列+容差+期望值来源），附自审三问的逐条结论（忠实/可判/非空转）与构造修订历史。**这里没有 ✓/✗ 按钮**——它是事后复核入口，不是放行闸门。
3. **报告看板**（结果交付面，m11428+m11429 修正）：**处置清单优先**（FAIL 例外项=工作清单置顶，四态统计退居摘要行）——每项可展开证据明细（判据原文/基准出处/违规行/两侧数值/管线 trace）；NEEDS-MATERIAL 一键转「补充材料」task；版本对比视图（同规范两次 run=数据漂移轴；两版规范同数据=判据修订影响轴）。

**服务端端点**（`packages/ops/tools/src/verify-web.ts` 只读与写入面；`verify-jobs.ts` 作业式执行面）。**归属口径（0.101.0 订正）**：验证器工件是 **$YGL_HOME 级**，与 R16 项目选择正交——不套项目选择门，也不按项目过滤；这道门属于业务数据（research/claim/kb），不属于「规范↔运行」的工件面。唯一的访问控制是 id 白名单 + 解析后包含性断言（防路径穿越），越界一律 404（不区分「不存在」与「越界」，避免探测）。

```
GET  /api/verify/specs            # 规范清单（version/units/构造 verdict/run 聚合）           ✅ 0.100.0
GET  /api/verify/spec?id=<spec>   # 构造追溯载荷（spec + prepare + trace，只读）                ✅ 0.100.0
GET  /api/verify/reports          # 报告清单（四态统计/模式/归档数）                            ✅ 0.100.0
GET  /api/verify/report?run=<id>  # 报告详情（报告原文 + 归档侧车；不重算不改写）               ✅ 0.100.0
GET  /api/verify/reports?spec=<id> # 报告清单按规范过滤                                       ✅ 0.101.0
GET  /api/verify/archives         # 归档清单（侧车展开：archive_id/filename/zip_sha256/with）    ✅ 0.101.0
GET  /api/verify/materials        # 材料清单（投影）                                            ✅ 0.100.0
GET  /api/verify/material?id=<m>  # 材料正文（构造追溯左列的事实源）                            ✅ 0.100.0
PUT  /api/verify/blob?name=&mime= # 附件原始字节入内容寻址仓（服务端算 sha256；幂等去重）       ✅ 0.101.0
POST /api/verify/material         # 材料草稿（{title,text,attachments:[{sha256,name}]}）         ✅ 0.101.0
POST /api/verify/prepare          # 构造+自审：收 {material_id,candidates,reviews,snapshot_sha256,draft?,as_of?} ✅ 0.102.4
POST /api/verify/run              # 跑验证：收 {spec_id,snapshot_sha256,no_archive?}                    ✅ 0.102.0
```

**实现口径（0.100.0 → 0.102.0）**：三视图全部读文件工件（`$YGL_HOME/verify/*`），不碰工作区库。附件有两步：先 `PUT /api/verify/blob` 把**原始字节**入仓（服务端按字节算 sha256、全局去重、`blobs/<sha 前 2 位>/<sha>`，超 64 MiB 回 413 JSON，`.incoming/*.part` 启动时与上传前按 mtime 清理 6 小时以上孤儿），再 `POST /api/verify/material` 只带 `{sha256,name}` 引用——**客户端永远不报哈希、不传路径**，引用未入仓的 blob 直接 400。写端点要求 `application/json`（否则 415）；上传门是端点本身：serve 绑非回环地址时默认关（403），`YGL_VERIFY_ALLOW_UPLOAD=1` 显式开、`=0` 强制关。`prepare`/`run` 是**执行面**，0.102.0 起由 `--enable-verify-jobs` 显式打开（默认 403）——一个嵌入方不该因为调了 `serve` 就默默获得「能执行任意 spec」的能力。三条不变量：①**请求体永不携带可执行面**（没有 argv/allowlist/submission_dir/路径；`submission_dir` 出现即 400，目录树没有安全的 HTTP 来源），command 型白名单在 serve 启动时定下（`YGL_VERIFY_ALLOW_CMD`——**未设置**才默认只放 `node`；**空串 = 显式空表**，所有 command 型 VU 判 `ERROR`，fail-closed，0.102.1 订正）；②**快照只能按内容寻址引用**（先 `PUT /api/verify/blob?name=snapshot.sqlite`，再传 `snapshot_sha256`，服务端到 blob 仓取字节，缺 blob 404，不做猜路径）；③**run 只碰副本**：blob 字节先复制到临时快照再跑，报告 `data_source.source` 记 `blob:<sha12>`。
**构造记录与 as_of（0.102.2 订正 / 0.102.3 校验 / 0.102.4 收紧）**：`prepare` 只有**判定为 ready** 才写 `prepare.json`（口径是「成功记录以最后一次成功为准」，不是不可变）；未 ready 的尝试写同一 spec 目录下的 `attempts/<ts>.json`（`flag:"wx"` 原子占位，同毫秒第二次尝试拿 EEXIST 续号 `-2`/`-3`）。此前 CLI 无论 ready 与否都覆盖 `prepare.json`（一次失败补跑会冲掉上一轮已冻结的成功记录），HTTP 面则什么都不写（失败无痕）——两个面各错一半，现统一为「成功记录不改、失败尝试留档」。审计面：`GET /api/verify/spec?id=` 的载荷带 `attempts: [{file,created,verdict}]` 投影，CLI `prepare --json` 回 `record`（相对 verify 根的路径）。`as_of` 双侧同一校验（0.102.3，0.102.4 收紧为严格 ISO）：接受纯日期（UTC 00:00）与带显式时区的 datetime（`Z`/`+08:00`/`+0800`），**拒绝**无时区 datetime、空格分隔、非 ISO、非法日历（`2026-02-30`）；归一 `toISOString()` 存 UTC；不可解析 → HTTP 400（先于任何 I/O）/ CLI rc=2，不落盘、不消耗 `spec_version`——R13 要求锚定冻结值，不可解析的时间锚会让报告不可对质。`run` 面不涉及 as_of 入参。
**门的形态（P3-2 口径）**：作业面只由 `--enable-verify-jobs` 把门，**不随绑定地址收紧**——地址不是信任边界（内网 `192.168.x` 自托管是正当用法），而 flag 表达的是运维明确意图；上传门之所以按回环默认，是因为它没有专属 flag 且直接写盘。command 型 VU 继承 serve 的 cwd/env、`stdout` 入报告 witness：这是「执行外部命令」检查器的固有边界，白名单只收窄 `argv[0]`，给不可信命令授权仍是操作员的责任。
**构造面仍在 agent**：`candidates`（提取/翻译产物）与 `reviews`（盲审三问）由 agent 提交，服务端只做 P0–P5 机械判定与冻版，绝不发明候选——缺这两个数组直接 400。HTTP 状态只表达**过程**（400 用法 / 404 找不到 / 415 非 JSON / 422 快照不可读或引擎硬拒），判定结论在 body：prepare 的 `verdict`（`ready`/`needs-material`/`error`）、run 的 `overall`（PASS/FAIL 都是 200）。

SSE 实时进度走既有 ctx.on("ygl") 公共通道（verify.report / verify.progress 事件），无新通道。前端组件复用 antd 表单/表格/标签生态（Pipeline.tsx 同款模式：类型化载荷 + 渲染验证测试 + token 纪律）。

## 8. 命令族（CLI 面，与 WebUI 同一后端）

```
verify submit                      # 材料提交（标题+一段话+附件入 blob）
verify prepare <spec-id>           # 提取+翻译+自审 → 可执行 VU 集（无人确认环节）
verify run <spec-id> [--db <path|url>]   # 跑全部检查器 → 报告
verify report <run-id>             # 复核历史报告
verify report import <report.json> # 封包跑回的报告入库（校验 binary_sha256/spec_version/payload_sha256）
verify trace <spec-id>             # 构造追溯（判据↔检查器↔自审结论，只读）
verify list                        # 规范清单与状态
```

数据面：ygl 工作区 db（默认）+ 任意 SQLite 文件路径 + PG URL（**复用 0.89 的 getPgOrm 方言地基**——.157 的 Odoo/PG 直连即在此）。

## 8.5 验证器的存在形态（验证器是什么东西——m11628）

**核心裁定：验证器 = 规范数据（spec）+ 通用运行时（引擎）**，不做「一个规范编译成一个程序」。

| 形态 | 是什么 | 谁用 | 版本钉法 |
|---|---|---|---|
| **规范工件** | verify-spec artifact：VU 集合 + 判据原文 + 出处锚点 + rubric，JSON，workspace 内自增版本 | 系统内部真相源 | spec_id + version |
| **单文件导出** | `verify export <spec>` → `.yglverify.json`（VU + 冻结期望值 + 数据源声明 + spec_version）——**构建输入，不直接交付** | 封包的原料、存档、跨环境重放 | 文件内嵌 spec_version + runtime_min |
| **运行时** | ygl-trees 的 `verify` 命令组（发布产物 bundle 内）；同一引擎执行所有规范 | 所有场景 | ygl-trees 版本号 |
| **服务面** | `webui serve` 的 `/api/verify/*` + 三视图 | 业务专家的浏览器 | 同运行时 |
| **agent 面** | CLI `--json` / MCP 工具：submit/prepare/run/report 结构化调用 | 驱动验证的 agent | 同运行时 |
| **封包二进制** | `yglverify build` → 引擎 + 内嵌 spec + 指纹合成单文件；**spec 不可变更**（m11703） | 无 ygl 环境的业务方 / 第三方 | 二进制哈希即验证器版本 |

**为什么是数据+运行时，不是逐规范生成程序**：

1. **确定性可审计**——引擎代码一份、七型闭集，判定逻辑不随规范漂移；报告出错能定位到引擎或规范其中一层；
2. **版本正交**——spec 版本 × 运行时版本，两钉即重放；生成式程序无法这样钉；
3. **零代码生成**——材料→VU 是数据翻译，不经编译器，不存在「生成的代码没人看得懂」；
4. **安全边界**——规范没有任意代码执行权：`command` 型是唯一可执行面（显式声明+白名单），`sql` 型只读前缀门。**规范是数据，所以它做不了坏事**——这本身是「验证器不可被构造得能越权」的结构保证。

**运行契约（agent/CI 友好）**：`verify run --json` 输出单对象 `{run_id, spec_version, summary:{pass,fail,needs_material,error}, report_path}`。**退出码只表达过程**：`rc=0`=验证已执行出报告（无论 PASS/FAIL——FAIL 是有效结论，不是程序错误）；`rc=1`=运行错误；`rc=2`=用法错误。判定在报告里，不在退出码里——agent 驱动时不会把「有问题的业务」误判成「工具坏了」。

**时间确定性（R13）**：`as_of` 必须锚定到冻结值；SQL 中出现 `NOW()/CURRENT_TIMESTAMP/CURRENT_DATE` 一律**构造期拒绝**（无法重放），时间参数以字面量绑定。

**运行环境**：任何装了 ygl-trees 的机器 + 规范声明的数据源可达（SQLite 文件路径 / PG URL / workspace 内附件 source）。连接串运行时传入、不入库。

### 8.5.1 交付形态：封包二进制（m11659 + m11703 用户裁定）

> m11659：「交付的程序 为二进制 cli」；m11703：「包括 spec 本身都是验证器的一部分，也是二进制程序里面，不可变更」。

**交付物 = 单一封包二进制：spec 内嵌其中，不可变更。** 拿到文件的人无法替换、改写或追加规范——能改二进制就改了它的哈希，而哈希写在报告里，审计可对质。

- **封包（build/seal）**：`yglverify build --spec spec.json --out yglverify-<name>` —— 引擎字节 + spec 载荷 + 尾部指纹（`spec_sha256`、`engine_version`、`corpus_version`、`build_sha256`）合成一个文件。封包是字节拼接，不需要 Rust 工具链，秒级完成；同引擎字节 + 同 spec 字节 → 同二进制字节（可复现构建）。
- **运行**：`yglverify-<name> run [--db <sqlite> | --pg <url>] [--out report.json] [--json]` —— **封包模式不接受 `--spec`**（拒绝外部规范输入，这是「不可变更」的执行面保证）。
- **自检**：启动即校验自身指纹（文件被改动 → 拒绝执行，ERROR）；`self-check` 打印 engine/spec/corpus 三版本与两个哈希。
- **报告头**记录 `binary_sha256` + `spec_version` + `engine_version` + `corpus_version`——「这份报告是哪个验证器、在哪个规范版本上跑出来的」永远可查。
- **规范源文件 `.yglverify.json` 降为构建输入**，不直接交付；交付目录里只有一个可执行文件（加业务自己的数据与提交物）。
- **两阶段冻结（评审 B4，唯一正确的冻结边界）**：
  - **阶段一 · 基准材料（提交时冻结）**：报价单/规则文档等「标尺」在 `verify submit` 时登记为 source，prepare 从中提取期望值并**把值 + 锚点 + 原文引文冻结进 spec**——之后基准原件换版不影响既有 spec（旧报告锚点永不断链）。
  - **阶段二 · 提交物（run 时以字节校验）**：账单/截图等「靶子」在 submit 时登记附件（content-addressed），**spec 冻结其 `sha256`**；run 时要求传入同一批字节，先校验哈希才交给检查器/review 层——「同一批字节」是硬条件，哈希不符即 ERROR，换文件不成立。
- **附件存储（评审 B4 实测结论）**：现有 `source` 只按 `sha1(text)` 存 UTF-8 正文（`writes.ts:139,152`，且 `url_hash` 重复早返回），**没有二进制入库路径**——附件必须走 **content-addressed blob**：`{sha256, size, mime, path/object}`，同路径换内容 = 新 blob 行（按 sha256 去重）。落点二选一：`sources` 增列（九触点）或新表 `attachments`（推荐，语义干净）；附件不参与 FTS。
- **运行时输入只剩三类**：数据源（SQLite 文件 / PG URL）、**提交物字节（哈希校验）**、输出路径（`agent` 型另加网关凭证，见下）。基准材料的冻结值已在 spec 里，原件不需要随包。
- **通用模式仍保留**（开发用）：未封包的引擎支持 `--spec`，报告头标 `sealed: false`；交付场景一律用封包二进制。
- **安全边界不变**：`command` 是唯一可执行面（显式白名单，默认关闭）；`sql` 只读前缀门；附件只读；封包载荷是只读数据，不是代码。
- **封包 × `agent` 型（评审 C2）**：`agent` 型 run 时要调判定网关，而第三方机器没有凭证——**`build` 默认拒绝含 `agent` VU 的 spec（封包 = fact-only）**；显式 `--with-review` 才允许，且运行时输入**增加第四类：网关凭证（运行时传入，不入库）**，报告标注 `sealed.review=on`。封包限制在 `self-check` 里明示。
- **威胁模型（评审 C3-i，必须诚实写明）**：指纹在文件内，**能改二进制的人可以改 spec 并重算尾纹**；构建可复现意味着「同引擎 + 新 spec」就是一份合法的新封包。所以「不可变更」的真实承诺是 **tamper-evidence（防意外漂移、防顺手替换），不是 tamper-proofness（不防持有者恶意伪造）**。验真动作 = **带外比对 `binary_sha256`**（发哈希的通道 ≠ 发二进制的通道）：`self-check --expect <sha256>` 给接收方一条机械核对通道；需要更高门槛时用 ed25519 对尾纹签名（公钥带外分发，`--key` 封包）。
- **报告首屏（评审小项升格硬规则）**：报告第一屏固定为「**判据原文（source_clause verbatim）↔ verdict ↔ 证据**」全对照表——自审无法消除的共同误读，在这里暴露给一定会看的人；这是零人工确认下残余风险的唯一可见面。

**外部锚链（评审 B3——自校验是循环论证，必须对质二进制之外的期望值）**：

1. **构建登记**：`yglverify build` 完成时，同步往 workspace 写一条登记 artifact（kind=verify-binary）：`{spec_id, spec_version, engine_version, corpus_version, platform, binary_sha256, build_at, signature?}`——**这份登记就是封包的外部期望值**，与二进制分开发布（登记进 ygl 工作区/服务端，二进制交给业务方）。
2. **import 校验**：`verify report import <report.json>` 必须做三件事才入库——①`binary_sha256` 命中登记；②`spec_version` 与登记一致；③报告 `payload_sha256` 与文件内容一致（防 import 前被手改）。任一不符 → 拒绝入库并点名「unknown verifier / version mismatch / payload tampered」，落进报告审计环。
3. **尾纹计算域（footer 定义，防循环）**：文件布局 = `[engine 字节][spec 字节][footer]`；footer = `magic("YGLVF1") | offset(uint64) | length(uint64) | spec_sha256 | engine_version | corpus_version | build_sha256`，其中 **`build_sha256 = H(engine || spec)`——不含 footer 自身**（含自身即自指循环）。`self-check` 重算这三段并对质，任何一段改动即 ERROR。
4. **签名（可选更高门槛）**：`--key ed25519.pem` 对 `build_sha256` 签名，公钥带外分发；登记条目带 signature，import 时验签。无签名时 tamper-evidence 靠 ①+③ 与带外哈希比对。

**构建 → 交付 → 回收入库**：TS 构造面产出 spec（submit/prepare/自审）→ `yglverify build` 封包（并写登记 artifact）→ 交付单文件 → 业务方在其环境中 `run` 出报告 → `verify report import` 校验哈希+版本+payload 后回收入 workspace，版本链闭合。

## 9. 与树/毕业协议的接缝（复用而非新建）

- 验证规范可挂树节点：`rel add node:<tree>/<key> artifact:<spec-id> --rel decided-by`（规范=节点的验收判据）。
- 报告挂节点：`--rel evidenced-by`（验证结果=节点证据）。
- **毕业通道**（M13-3，设计裁定 2026-10-20）：目标是把「一次性验证」变成「常驻检查」。关键事实（代码侦察）：`patrol run` 把 check 的 SQL 直接跑在**工作区自己的库**上（`patrol-cmds.ts:117` `store.db.all(c.sql)`），而验证规范的 VU 判的是**被验快照**里的表——两张库不同源，把 VU 的 `findSql` 抄成 patrol check 只对「被验对象就是本工作区库」的规范成立。第一版按三段拆：①**资格**：同一 `spec_version`、连续 `--min-runs`（默认 3）份报告 `overall=PASS`、跨度 ≥ `--min-span-days`（默认 30 天），任一不满足则点名拒绝（rc=1，不落盘）；②**毕业记录**：`$YGL_HOME/verify/graduations/<spec_id>.json` 冻结（spec_version、run_id 清单、阈值、created），幂等重跑返回 `duplicate:true`；③**常驻执行**：生成 `job add --every <min> -- ygl-trees verify run <spec_id> --db <source> --no-archive`（`<source>` 取毕业报告的 `data_source.source`，作业运行史落 runs 表、报告继续进 `reports/` 形成趋势）。patrol 化（S1/S2/S3 处置队列）只对被验库 == 工作区库的规范开放；**0.103.0 只做资格闸门**（`--patrol` 校验库同源后放行毕业，不自动生成 patrol check——把 VU 的 `findSql` 抄成 check 需要逐条确认空结果语义，留给后续版本）；库不对源时明确拒绝并点名。CI 集成后置（M13-4），先把「毕业 = 冻结资格 + 绑定调度」做实。

**已实现（0.103.0）**：`verify graduate <spec-id> [--min-runs N] [--min-span-days DAYS] [--db <source>] [--every MIN --schedule] [--patrol]`，代码在 `packages/ops/tools/src/graduate.ts`：
- 资格判定只读不写——`checkEligibility` 读 `specs/<id>/spec.json` 与 `reports/*.json`，**跨 spec_version 不算连续**（判据本身变了，"历史最好成绩"不成立），取样按 `finished` 从新到旧最多 `min_runs` 条；拒绝时逐条点名（缺几条报告、哪条不是 PASS、跨度差多少天），rc=1 且**不落盘**。
- 毕业记录冻结在 `$YGL_HOME/verify/graduations/<spec_id>.json`：同核心内容重跑回 `duplicate:true`（保留首次 `created`）；不同形状**拒绝覆盖**并给出 `delete <path> deliberately` 的显式指引——冻结记录不可被重跑改写。
- 常驻执行默认只打印命令串（`job_command` 字段），`--schedule --every <min>` 才真的登记作业（`job add`）；命令串固定带 `--no-archive`（趋势看报告，不看 zip 数量）。
- `--patrol` 仅在「被验库 == 工作区库」时放行，否则点名拒绝——`patrol run` 跑在工作区库上而 VU 判的是被验快照，生成半对的检查比没有检查更危险。
- rc 语义与 verify 组一致：0=已毕业/duplicate、1=资格不够或运行错误、2=用法错误（缺 spec-id、`--min-runs` 非正整数、`--schedule` 缺 `--every`）。
- **历史摘要（r25 Q1①）**：记录与 `--json` 带 `history: {reports_same_version, non_pass, last_non_pass}`——窗口外失败也计数，审计者不会以为「最近 N 份全 PASS」等于「从未失败」。资格只看最近 N 份（FAIL 是有效结论，历史 FAIL 不否决资格）。
- **窗口右移（r25 P3④）**：跨度取最近 N 份的首末，新报告进入会让窗口右移——同一规范可能「昨天够格、今天不够格」（实测 40d → 28d）。这是取证纪律：毕业看的是当前连续窗口，不是历史最长跨度。
- **跨度闸门非真空（r25 P2-1）**：`--min-span-days > 0` 时必须取到 ≥2 份报告，否则直接点名拒绝——旧实现让 `--min-runs 1` + 单份 PASS 以 span=0 混过闸门。
- **可执行来源（r25 P2-2）**：报告 `data_source.source` 若是 `blob:<sha12>`（HTTP 作业面的内容寻址引用），**不能当 `--db` 用**——`job_command` 打占位符、`--schedule` 拒绝登记，除非显式 `--db <file>` 覆盖。否则作业每分钟 ENOENT 失败而毕业记录已冻结。
- **报告是数据，不是命令（r26 P1）**：`job tick` 走 shell，而 `data_source.source` 可以来自 `verify report import`（该命令只校验 payload 自洽）。伪造报告把 `" & echo PWNED & rem "` 塞进 source 曾能让 `--schedule` 生成可执行的注入命令。现在 `jobCommand()` 对**报告 source 与 `--db` 覆盖一视同仁**做字符校验；r27 P2-3 起改为 **denylist**：只拒 shell 元字符（`&` `|` `<` `>` `^` `%` `!` `"`、反引号、`$`、`(` `)`）与 U+0000–U+001F / U+007F 控制字符、超长（>4096）、以及**尾随分隔符/尾随空白**（`--db "C:\path\\"` 会让闭合引号被转义、`"C:\path "` 会被 shell 裁剪）；中文、`#`、`+`、空格、两种分隔符都是合法路径字符，不再误伤。不安全 → `job_command_usable:false`、`job_command_unsafe:true`、命令串打 `--db "<snapshot.sqlite>"` 占位符、`--schedule` rc=1。`spec_id` 同为命令串成分，按 id 白名单校验，不合格打 `<spec-id>`。`verify report import` 与读面 `GET /api/verify/reports/<run>` 都对可疑 source 出声（`source_warning`，不拒绝——跨机绝对路径合法）。r28 P3 补 `$`：POSIX sh 在双引号内仍展开 `$VAR`，`/data/${HOME}/x.sqlite` 会被静默换成别的库，所以 `$` 同列元字符（`{` `}` 在双引号内是字面量，不拒）。彻底修法（argv 存储 + 不经 shell）留 M13-4。
- **掩码只描述形状（r27 P3①）**：`job_command_rejected` 是**形状摘要**，不是原文截断——只回「N chars；第一个元字符在 offset K」或「路径以分隔符/空白结尾」，不回显任何原字符（旧实现保留 40 个可打印字符并落进冻结记录，测试还把样本内容写成契约）。测试现断言掩码**不含**样本串、只匹配 `/shell metacharacter at offset \d+/`。
- **缺失文件是运行期错误（r27 Q1）**：`--db` 指向不存在的文件时，`graduate` 不拒绝（毕业只判定资格与记录），失败发生在 `job tick` 跑 `verify run` 时（rc=1，error 点名快照路径）——排期成功 ≠ 文件存在，巡检要在 `job list` 的运行史里看。
- **count 与 sql-pair 的词汇双轨（批十一②）**：`count` 族用 `op` + `value`（`rows>=1` 这类阈值），`sql-pair` 族用 `compare: {mode, null}`（两侧结果的比较口径）。两套词汇都已在 contract 1.1 冻结，**不统一**（统一就是破坏性变更）；`prepare` 在形态混用时按族点名拒绝文案，本节对照表即唯一索引。
- **排期意图随记录冻结（r28 Q2）**：`--schedule` 成功后把 `job_target {db, origin:"report"|"override", usable, job_id, every_minutes, updated_at}` 写进毕业记录——**只动这一个字段**，`spec_id`/`spec_version`/`run_ids`/`thresholds`/`history`/`span_days`/`data_source`/`created` 逐字节不变（毕业记录无 `materials_sha256` 字段——它是 spec 字段）（重新毕业的 `duplicate` 路径同样只更新它；不带 `--schedule` 的重复毕业保留旧值不擦除）。语义是「最后一次排期意图」的快照，执行真相在 `jobs` 表，二者漂移靠 `job.retarget` 事件与 `updated_at` 审计。该字段不进 identity/重复判定/资格/patrol，旧记录缺失需容忍；`graduate --json` 输出它，人类输出不变。
- **`--db` 覆盖的语义边界（r26 Q2）**：覆盖只换**常驻作业的目标库**，不改变资格判定、冻结记录与 patrol 判定（三者都用报告里的 `data_source`）；与报告 source 不同时人类输出点名「冻结记录仍记被验源」；`--db` **不进**资格判定与 `data_source`，但要记进 `job_target`（见下条 r28 Q2——排期意图必须可审计，二者不冲突：一个记「验的是谁」，一个记「排到哪」）。
- **响应回冻结值（r25 Q2/P3②）**：`thresholds` 一律回冻结记录里的值（不回本次请求），重复毕业不会让响应与实际记录不一致；`job_every_minutes` 读作业行实际值。
- **被取代 ≠ 记录错了（r25 P3③）**：spec_version 升级后重新毕业被拒时，文案是「older spec_version 被取代，跑新版本后显式删除再毕业」，与「frozen record was wrong」分开。

## 10. 待裁定点（实现前需拍板）

1. **提交载体**（m11362+m11390+m11558 三次裁定后收窄）：**WebUI 材料提交视图为主入口**（标题+一段话+附件上传）+ CLI `verify submit`/Markdown 留 power 用户——模糊输入（图片/表格/PDF/压缩包）是常态，结构化是 agent 构造的输出。
2. **命令名**：`verify`（推荐，避开 produce spec 重名）vs `checklist` vs 顶层 `spec`。
3. **第一版检查器范围**（m11490 扩型 + m11558 删 human）：fact 层 sql / sql-pair / count / exists / file / command + review 层 agent 共**七型**——推荐全上（sql/count/command 引擎已在 patrol/telemetry 现成；file 型是纯 fs 操作；agent 型复用判定网关）——边际成本低。
4. **VU 存储**：新表 verify_specs/verify_units（schema v13）vs 复用 artifacts（kind=verify-spec，VU 存 meta JSON）——推荐 artifacts 起步（九触点成本减半），查询面成型再升表。
5. **多数据源连接**：第一版是否带 PG（.157 直连）——推荐带（地基已在），但连接串安全（不入库，运行时传入）。
6. **前端批序**（m11362 新增）：CLI 后端先行（M13-1 命令族+检查器+报告，可独立验收）→ WebUI 三视图（M13-2 材料提交/构造追溯/报告看板）——推荐此序（前端依赖后端契约稳定）；若要并行则 WebUI 先做材料提交视图（依赖最少）。
7. **附件提取通道**（m11390 新增）：xlsx/csv 表格解析（纯库，如 xlsx 包）；PDF 文本抽取（pdf-parse 类）；图片值提取走**视觉模型**（Vercel AI Gateway 同通道，prepare 一次性）——推荐第一版表格+图片先上、PDF 视样本再定；提取值全部带出处锚点。
8. **管线组合深度**（m11413 新增）：VU 间 `$vu:<id>.out` 引用 + 拓扑执行 + 环检测拒绝 + 级联语义——推荐首版就上（DAG 引擎复用科技树现成件，边际成本≈引用解析器）；跨 spec 组合推后。
9. **agent 型审阅契约**（m11490 新增）：rubric 在 prepare 自审阶段冻结（逐项检查点清单）+ 提交物快照冻结；run 时模型只按冻结 rubric 对照冻结提交物输出布尔+逐项引文；报告标注 review 层并给事后复核通道——推荐此形态（把模型调用关进冻结输入的笼子里）。
10. **自审实施形态**（m11558 新增）：独立上下文复核 agent——同进程二次调用（带干净 messages）vs 子进程/spawn 独立会话；推荐**同进程独立上下文**（成本低、可观测），自审 prompt 只含「材料 + VU 清单 + 三问」，不含构造理由与修订历史（避免自我确认偏误）。

## 11. 语言放置与工程规范（m11443 用户裁定：Rust/Python/Node 按特性分工，非唯一选项）

**判定核心是数据不是代码**（七型检查器=SQL/文件/命令/agent，spec/VU/报告=JSON 契约）——语言选择只发生在组件层，契约层语言中立：

| 层 | 语言 | 为什么是它 | 工程形态 |
|---|---|---|---|
| **产品壳**：CLI/存储/版本/WebUI/API/事件 | **Node，TypeScript 优先**（m11452；ygl-trees 主体本就 TS strict） | Cordis 运行时、artifacts/source 数据模型、R16 门禁、React 前端全在此；SQL 型检查器在本层执行（纯数据驱动，无语言问题） | npm 包（现有 bundle） |
| **提取层**：xlsx/PDF 解析、OCR、视觉前处理 | **Python** | 文档解析/数据科学生态最强（pandas/pdfplumber/openpyxl）；**.157 的运费审计工具链就是 Python（audit_freight_bill.py 一脉）——血统直接复用** | 独立脚本/子进程，JSON stdin/stdout 契约；`verify prepare` 经 command 型边界调用 |
| **确定性内核 / 交付形态**：单静态二进制校验器 | **Rust**（m11659 升为交付形态，不再「后置」） | 单静态二进制零运行时漂移——交付对象是无 Node/Python 环境的业务方；性能；供应链可信 | cargo 产物，同一 JSON 契约进出；**M13-1b 交付**，与 TS 参考实现同吃一份黄金语料 |

**跨语言工程规范**（不管几种语言都守）：

1. **契约先行**：spec/VU/报告三 JSON schema 是唯一接口真相——任何语言实现同一契约即可互换（这本身就是「检查器闭集」的语言面）；契约变更走版本（同 §6.5）。
2. **进程边界**：语言间只经子进程/服务 + JSON（command 检查器同款边界），**禁跨语言 FFI 纠缠**——每个组件可独立测试、独立发布。
3. **门禁随语言**：Node=vitest/contract:audit（现有四段制）；Python=pytest+ruff（提取层自己的黄金样本测试：已知附件→期望提取值）；Rust=cargo test+clippy——全部门禁汇总进 ygl-trees 的 pnpm test 编排。
4. **发布单元分离**：npm（壳）/脚本随包或独立仓（提取）/二进制 artifact（内核）——互不绑架升级节奏。
5. **语言准入判据**：新语言进入（含 Go 等）必须声明组件归属 + 契约遵守 + 门禁接入，无例外。
6. **四向 parity 门禁（评审小项）**：黄金语料矩阵 = {SQLite, PG} × {TS 参考实现, Rust 二进制} 四向逐字一致（除时间戳）——双实现门禁不能只测单方言。

9. **M13 语言切分**（m11443 新增、m11659 重排）：**M13-1 全 Node**（构造面：submit/prepare/自审/export/运行时刻引擎/黄金语料 corpus）；**M13-1b Rust 二进制**（同一契约的执行面，语料双实现门禁，交付 `yglverify`）；提取层 Python 适配器随 M13-1 的 prepare 接口预留（command 边界），真实附件样本到位后接入；WebUI 三视图随 M13-2。

## 12. 实现前仍需拍板的运营性选择（m11466 整理）

| # | 问题 | 推荐 | 影响 |
|---|---|---|---|
| A | **首发验收靶子**：第一个真实跑通的验证规范选哪条？ | **裁定（fdc757f6 direct-1711f5bf）：.157 运费对账**，四类判据现成、验收锚就是它、patrol/adopt 线可交叉对账副作用。**硬口径：首发只跑库快照副本**——.157 是业务在用库，验证器首秀不得有写入面（只读连接也先导快照），报告记明快照 `as_of` 与来源 | 决定 M13-1 的验收用例与 demo 断言 |
| B | **真实附件样本**：提取层黄金样本从哪来？ | **裁定（同上）：xlsx/png/pdf 各 ≥2 正例 + ≥1 反例**；**file 型 v1 判据限定结构/签名/清单类**（存在性、文件数、行数、哈希、页数）——**OCR/内容理解不进 v1**，报告中标注「内容级判据待 M13-2」；脱敏规则写进 prepare 契约（样本数据不出 .157 机） | 决定提取适配器接入时点与 file 检查器的能力边界 |
| C | **批次节奏** | **裁定（同上）：跟版本不跟日历**——每个 ygl-trees 版本 = 一次冻结语料快照 + G2/G3/G4 全量跑；**语料只增不改**（要改 = 升 `corpus_version` 并在 CHANGELOG 记差异）；M13-1（TS 构造面 + 黄金语料）→ 0.96.0；**M13-1b（Rust 二进制 `yglverify`，双实现门禁）→ 0.97.0**；M13-2（前端三视图）→ 0.98.0；**M13-1b 前不接真实网关凭证**（封包 fact-only 闭环优先） | 后端可先给 .157 用起来；二进制独立版本可单独发布给第三方 |
| D | spec 粒度 | 1 spec = 1 业务问题域（如「运费对账」含 N 条 VU），非 1 条判据 | 影响 prepare 交互粒度 |
| E | FAIL 是否自动开 task | 首版只在报告呈现（例外清单），不自动开（避免噪音）；NEEDS-MATERIAL 自动开（已定） | 影响 task 表噪音 |
| F | 报告导出 | 首版 WebUI 看板 + CLI 文本；PDF/HTML 导出后置 | 业务专家对质/汇报场景 |
| G | 毕业阈值（patrol 化） | 同结果稳定 3 轮 + 跨度 ≥1 个月；首版不实现，只留接口 | 不阻塞首版 |
| H | 封包与交付包（m11659+m11703） | 交付物 = 单个封包二进制（spec 内嵌、不可变更）；`yglverify build --spec … --out …` 封包；业务数据与提交物运行时传入 | 决定分发包形态与 CI 产物（每 spec 一个二进制哈希） |

其余九条（命令名/七检查器/artifacts 存储/PG/管线组合/自审形态）均为推荐默认，风险低可逆，开工即按推荐执行；语言切分已由 m11659 钉为「TS 构造面 + Rust 二进制执行面」。

**A/B/C 裁定记录**：dsh/fdc757f6 `direct-1711f5bf`（2026-10-19）给出 A/B/C 三项结论并入上表；其下一介入点 = ①prepare 契约三轮拍板后的形状合并终审 ②`corpus_version` 钉 1.0 前冻结快照全量复跑。掘金帖/Glama/cold-user-test 不属工程席，归运营线。

**评审记录**：评审席 dsh/fdc757f6（task direct-30389fca，意见 tmp/review-m13-spec-validator.md）判 **CHANGES**，三条必改已并入——C1 角色语义 → §5.1 + §5.5；C2 封包×agent → §8.5.1；C3 威胁模型 + per-type 守卫 → §8.5.1 + §4.3。小项（agent 不可读=NEEDS-MATERIAL、报告首屏全对照硬规则、四向 parity）亦已落文。
