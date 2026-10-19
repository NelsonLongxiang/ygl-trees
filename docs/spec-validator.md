# spec-validator 设计（验证规范驱动器）— M13 提案（2026-10-19，用户目标 m11350）

> 一句话：**业务专家用人话填「什么算对」，系统把每条判据变成确定性可执行的检查，agent 负责驱动（翻译/采证/编排）但判定本身零概率，最终交付带证据的结论报告。**

## 1. 为什么是这个（血统）

本会话反复验证的核心命题——「eval 门过≠解锁」（kb f4a2a9299f）、「模型读到五步在跑就判数据已入账」（tta-target 人审推翻）、「决策模型比 agent 直觉审慎一级」（50+ 轮实测）——全指向同一结论：**语义概率可以辅助分类，不能当结论**。本工具把这个结论产品化：

- agent（模型）出现在**预处理**（人话→判据结构化）与**采证编排**，永远不出现在**判定**。
- 与 .157 ops-handbook 的血缘：其 SOP 巡检四问判据 + S1/S2/S3 信号 + 零未处置铁律，就是本工具表单与检查器的实战祖先（10-17 起在产运转）。
- 与 patrol 的分工：patrol=**持续**巡检（同一 SQL 反复跑+处置队列）；spec-validator=**按规范**的一次性/里程碑验证（表单驱动+人保真+报告交付）。两者共享 SQL 门语法。

## 2. 三段流（谁干什么）

```
业务专家 ——填——> 验证规范表单（人话判据）
   agent ——预处理——> 验证单元 VU 清单（机器判据，专家过目确认）
     agent ——驱动——> 逐项跑确定性检查器 → 采证 → 汇总
       ——交付——> 结果报告：每项 PASS / FAIL / NEEDS-HUMAN / ERROR + 证据
```

## 3. 材料提交（业务专家面——模糊输入是常态，不是例外）

**专家的真实输入不是结构化表单，是业务材料**：一段话 + 任意附件（图片/表格/PDF/扫描件）。设计原则随之翻正：

> **结构化是预处理的输出，不是专家的输入义务。**

提交形态（WebUI 表单编辑器 / `verify submit` CLI）：

```
标题：FBA 头程运费对账
一段话（意图/判据，自由文本）：
  「每张运费发票金额要跟订单应付对得上；附的是这批的报价基准和几张账单截图；
   超过一周没对账的要暴露出来」
附件：
  报价基准.xlsx   （期望值表——基准价在文件里，不在专家脑子里）
  账单截图-1.png  （图片型业务资料）
  合同条款.pdf    （规则出处）
```

附件注册为 source（file://），可追溯、可重放。专家零 SQL、零代码、零字段义务——写不清楚的部分交给预处理，判定不了的会在确认环节被点名。

## 4. 预处理（agent 辅助，人保真——模糊消解器）

`verify prepare <spec>` → 三步：**提取 → 翻译 → 待确认清单**。

### 4.1 提取（值从哪来——三源）

| 值来源 | 说明 | 例 |
|---|---|---|
| **材料提取值** | agent 读附件挖出的数字/规则（xlsx 解析、PDF 抽取、图片走视觉模型），**每个值带出处锚点**（哪份文件·哪页/哪sheet哪行/哪区域） | 基准价 2.35/kg ← 报价基准.xlsx·Sheet1·R5C3 |
| **专家显式值** | 一段话里明确给出的数/期限 | 「7 天内」→ 容差窗口 7d |
| **运行时查询值** | 验证时才从数据库取（当前态） | Odoo 运费发票金额 |

提取值在 prepare 阶段**一次性冻结进 VU**（静态期望值）——run 阶段零模型调用，确定性不受附件模糊性影响。

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
    "tolerance": 0.01
  },
  "expected_from": {
    "kind": "runtime-query",
    "note": "两侧均为运行时查询"
  }
}
```

- **判据原文永远伴随 VU**（source_clause）——翻译可审计、可回放。
- **每个期望值带出处**（expected_from）：专家显式 / 材料提取（source_id + 锚点：文件·页/sheet/行/区域）/ 运行时查询。确认视图左列判据原文+材料出处，右列翻译出的 checker——专家能看到「基准价 2.35 来自报价基准.xlsx Sheet1 R5C3」再决定 ✓/✗。
- 翻译产物必须**专家过目确认**（`verify prepare` 产出待确认清单，`verify confirm <id>` 后才可跑）——「由 agent 驱动但人保真」的接缝。
- 模型在此阶段做三件事：①读附件提取值/规则（表格解析、PDF 抽取、图片走视觉模型）②分类判据→建议 checker 类型 ③把数据描述→表/列引用（需数据 schema 可达）。**全部模型调用前压到 prepare，一次性；run 阶段零模型**。
- 模糊消解梯度：一段话里能翻成六型×七域的→候选 VU；翻不动的→标 `human`（专家亲验）；材料本身是基准数据的→提取冻结为期望值表（文件表 vs 数据库表的对账模式）。

## 5. 检查器类型（确定性枚举——闭集）

| type | 语义 | 确定性来源 |
|---|---|---|
| `sql` | 断言查询，违规行=FAIL（patrol 同语法：SELECT 前缀门+分号拒绝） | 行数 |
| `sql-pair` | 两表按键值比对（容差 ±ε） | 数值比较 |
| `count` | 计数窗口（telemetry 同语法 `kind[:win] op N`） | 计数 |
| `exists` | 记录/文件/证据存在性 | 存在性 |
| `command` | CLI 命令 rc=0 / stdout 匹配 | 退出码/字面匹配 |
| `human` | 显式人工项（专家亲验） | 人（**不做假确定性**） |

**闭集纪律**：新增 type = 破坏性变更（走 schema 版本）。判定输出永远不含概率；语义判不了的判据（如「文案语气合规」）在 prepare 阶段就该被建议为 `human`。

## 5.5 管线组合（函数语义，m11413 裁定）

**每个 VU 是一个纯函数**：输入 → {verdict, evidence, **outputs**}。输出带类型（七域 + rowset 行集型），可被下游 VU 引用——一个验证器的结果是另一个验证器的输入：

```
VU := (环境查询值, 附件提取值, 上游输出 $Vx.out) → { verdict, evidence, outputs: {name: type} }

V1 (sql)      : 「拉超期未对账账单」      → outputs: {rows: rowset}
V2 (sql-pair) : 「$V1.rows 逐行 vs 报价基准」 → inputs: $V1.rows → outputs: {violations: rowset}
V3 (count)    : 「$V2.violations == 0」   → verdict FAIL 带样例行
```

- **引用语法**：`$Vx.<output>` 出现在下游 checker 的参数位（sql 的 WHERE IN、sql-pair 的一侧、count 的集合源）。
- **执行序 = 拓扑序**：复用科技树引擎的 DAG 语义（拓扑排序 + 环检测）——规范内引用成环在 prepare 阶段拒绝（同 `node validate`）。
- **级联语义**：上游 FAIL → 其 outputs 仍然产生（FAIL 的行集正是下游要消费的证据）；上游 ERROR（表不存在/连接断）→ 下游标 ERROR（原因=上游不可用），不装死也不中断独立分支。
- **确定性保持**：组合是纯数据流——同输入同输出同判定；报告=管线执行 trace（每级展示收到什么、产出什么、判了什么）。
- **与科技树同构**：spec 内 VU 图是 mini-DAG，树引擎的闭包/拓扑/环检测直接复用；跨 spec 组合（一个 spec 的报告作为另一个 spec 的输入）未来走 artifact 引用，首版不做。

## 6. 交付契约：真 + 产物（m11429 用户裁定）

**交付 = 一定为真的结论 + 可持有的产物。**

### 6.1 真（判定纪律）

- 每项 verdict ∈ {PASS, FAIL, NEEDS-HUMAN, ERROR}：
  - PASS/FAIL 是**事实陈述**——必须带证据（违规行数、样例行、两侧数值），且**可重放**（同一数据快照+同一 spec 版本重跑，逐字段一致；时间戳仅入 meta 不入判定）；
  - **NEEDS-HUMAN / ERROR 是诚实的非真态**——判据语义型/数据不可达/检查器自身失败，绝不冒充真假（与 FAIL 严格分开：数据问题 ≠ 判据不满足）；
  - 只有可证伪、可复验的结论才允许交付——「一定为真」的工程含义。
- 报告不可变：每个 run 一个 artifact（kind=verify-report），永不覆写、永不清洗。

### 6.2 产物（专家拿走的东西）

1. **验证报告**（处置清单优先：FAIL 项=工作清单，含单号/差值/判据原文/基准出处/管线 trace）
2. **证据包**（可追溯锚点全链：判据原文→附件出处→违规行→两侧数值）
3. **规范资产**（已确认的 spec——可重跑、可毕业 patrol、可挂树）
4. **人工项 task**（NEEDS-HUMAN 自动落账，零未处置）

## 6.5 版本管理（m11429 用户裁定：验证器必须版本化）

| 对象 | 版本语义 | 机制 |
|---|---|---|
| **spec（规范）** | 每次 confirm 产生新版本（v1→v2…）；修订=新 draft→重新 prepare/confirm | artifacts.version 自增；旧版本只读保留 |
| **run（报告）** | 钉住 spec 版本 + 附件 source id 快照 | 报告头记 {spec_id, spec_version, sources[], db 快照标识}——重放=同版本+同输入 |
| **附件（基准文件）** | 不可变 source：报价基准换版=新 source 行，**旧报告的锚点永不断链** | source 本就 append-only（file:// + 哈希 id） |
| **毕业（patrol）** | 毕业产物记 spec 版本来源 | graduation 引用 {spec_id, version} |

对比视图的版本对：同数据两版规范（判据修订影响面）/ 同规范两次 run（数据漂移）——报告看板的 diff 就是这两个轴。

## 7. 前端支持（WebUI，用户裁定 m11362）

业务专家的主界面就是浏览器，不是 CLI。React 客户端（apps/web，现有 webui serve 承载）新增三个视图：

1. **材料提交视图**（专家填写面，m11390 修正）：**标题 + 一段话 + 附件上传**（图片/表格/PDF 拖拽区）——不是结构化字段表单；结构化是预处理的产物，不是专家的输入义务。附件上传即注册 source（file://，归属当前项目）。草稿自动保存（artifact kind=verify-spec, status=draft）。
2. **VU 确认视图**（人保真面）：prepare 产物左右对照——左列判据原文 + **材料出处**（期望值锚点：报价基准.xlsx·Sheet1·R5C3；图片值标注提取区域），右列翻译出的 checker（类型+表+列+容差+期望值来源），逐项 ✓ 确认 / ✗ 驳回（带理由，驳回项回到待翻译池）。专家确认后 spec 进 runnable 态。
3. **报告看板**（结果交付面，m11428+m11429 修正）：**处置清单优先**（FAIL 例外项=工作清单置顶，四态统计退居摘要行）——每项可展开证据明细（判据原文/基准出处/违规行/两侧数值/管线 trace）；NEEDS-HUMAN 一键转 task；版本对比视图（同规范两次 run=数据漂移轴；两版规范同数据=判据修订影响轴）。

**服务端端点**（webui.ts，R16 选择门 + P1-1 归属校验同规）：

```
GET  /api/verify/specs            # 规范清单（状态 draft/prepared/runnable/done）
POST /api/verify/spec             # 表单保存（draft/publish）
POST /api/verify/prepare          # 触发预处理（服务端调判定网关做翻译辅助，同 claim evaluate 通道）
POST /api/verify/confirm          # 逐项确认/驳回
POST /api/verify/run              # 跑验证（同步跑小型规范；长跑先返回 run-id + SSE 进度——事件桥已就位）
GET  /api/verify/report/<runId>   # 报告载荷
```

SSE 实时进度走既有 ctx.on("ygl") 公共通道（verify.report / verify.progress 事件），无新通道。前端组件复用 antd 表单/表格/标签生态（Pipeline.tsx 同款模式：类型化载荷 + 渲染验证测试 + token 纪律）。

## 8. 命令族（CLI 面，与 WebUI 同一后端）

```
verify submit                      # 材料提交向导（标题+一段话+附件登记为 source）
verify prepare <spec-id>           # 提取+翻译 → 候选 VU 清单（待确认）
verify confirm <spec-id>           # 专家过目确认（VU 忠实于判据与材料）
verify run <spec-id> [--db <path|url>]   # 跑全部检查器 → 报告
verify report <run-id>             # 复核历史报告
verify list                        # 规范清单与状态
```

数据面：ygl 工作区 db（默认）+ 任意 SQLite 文件路径 + PG URL（**复用 0.89 的 getPgOrm 方言地基**——.157 的 Odoo/PG 直连即在此）。

## 9. 与树/毕业协议的接缝（复用而非新建）

- 验证规范可挂树节点：`rel add node:<tree>/<key> artifact:<spec-id> --rel decided-by`（规范=节点的验收判据）。
- 报告挂节点：`--rel evidenced-by`（验证结果=节点证据）。
- **毕业通道**（未来，先记设计）：一条验证规范稳定通过 N 轮 → `verify graduate <id>` 生成 patrol 检查（一次性验证 → 持续监控），走 graduation-protocol 的 executes 织物。

## 10. 待裁定点（实现前需拍板）

1. **提交载体**（m11362+m11390 两次裁定后收窄）：**WebUI 材料提交视图为主入口**（标题+一段话+附件上传）+ CLI `verify submit`/Markdown 留 power 用户——模糊输入（图片/表格/PDF）是常态，结构化是预处理输出。
2. **命令名**：`verify`（推荐，避开 produce spec 重名）vs `checklist` vs 顶层 `spec`。
3. **第一版检查器范围**：sql / sql-pair / count / exists / command / human 全上，还是先 sql + sql-pair + human 三件最小闭环？——推荐全上（sql/count 引擎已在 patrol/telemetry 现成，边际成本低）。
4. **VU 存储**：新表 verify_specs/verify_units（schema v13）vs 复用 artifacts（kind=verify-spec，VU 存 meta JSON）——推荐 artifacts 起步（九触点成本减半），查询面成型再升表。
5. **多数据源连接**：第一版是否带 PG（.157 直连）——推荐带（地基已在），但连接串安全（不入库，运行时传入）。
6. **前端批序**（m11362 新增）：CLI 后端先行（M13-1 命令族+检查器+报告，可独立验收）→ WebUI 三视图（M13-2 材料提交/VU 确认/报告看板）——推荐此序（前端依赖后端契约稳定，避免双头改）；若要并行则 WebUI 先做材料提交视图（依赖最少）。
7. **附件提取通道**（m11390 新增）：xlsx/csv 表格解析（纯库，如 xlsx 包）；PDF 文本抽取（pdf-parse 类）；图片值提取走**视觉模型**（Vercel AI Gateway 同通道，prepare 一次性）——推荐第一版表格+图片先上、PDF 视样本再定；提取值全部带出处锚点。
8. **管线组合深度**（m11413 新增）：VU 间 `$Vx.out` 引用 + 拓扑执行 + 环检测拒绝 + 级联语义——推荐首版就上（DAG 引擎复用科技树现成件，边际成本≈引用解析器）；跨 spec 组合推后。
