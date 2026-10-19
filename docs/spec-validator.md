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

## 3. 表单（业务专家面——零 SQL、零代码）

Markdown 模板（`verify form` 输出空白模板）：

```markdown
# 验证规范：FBA 头程运费对账（v1）
meta:
  领域: 物流对账
  填写人: 张三
  日期: 2026-10-19

### V1 发票金额一致性
- 判据: 每张运费发票金额与对应订单应付金额一致
- 容差: ±0.01 元
- 数据: Odoo 运费发票 + 采购订单
- 严重度: S1

### V2 超期未对账
- 判据: 账单入库后 7 天内必须完成对账
- 数据: 对账记录
- 严重度: S2
```

专家只声明三件事：**什么算对（判据）、容差在哪、数据在哪**。不写查询、不写代码。

## 4. 预处理（agent 辅助，人保真）

`verify prepare <form.md>` → 把每项翻译成**验证单元（VU）**：

```json
{
  "id": "V1", "title": "发票金额一致性", "severity": "S1",
  "source_clause": "每张运费发票金额与对应订单应付金额一致（容差 ±0.01）",
  "checker": {
    "type": "sql-pair",
    "left":  {"table": "freight_invoices", "key": "order_id", "value": "amount"},
    "right": {"table": "purchase_orders",  "key": "id",       "value": "payable_amount"},
    "tolerance": 0.01
  }
}
```

- **判据原文永远伴随 VU**（source_clause）——翻译可审计、可回放。
- 翻译产物必须**专家过目确认**（`verify prepare` 产出待确认清单，`verify confirm <id>` 后才可跑）——「由 agent 驱动但人保真」的接缝。
- 模型在此阶段只做两件事：分类判据→建议 checker 类型；把数据描述→表/列引用（需数据 schema 可达）。

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

## 6. 结果契约（确定性核心）

- 每项 verdict ∈ {PASS, FAIL, NEEDS-HUMAN, ERROR}：
  - PASS/FAIL **必须带证据**（违规行数、样例行、两侧数值）；
  - NEEDS-HUMAN 带原因（判据语义型 / 数据不可达 / 容差无法机判）；
  - ERROR = 检查器自身失败（表不存在、连接失败）——与 FAIL 严格分开（数据问题≠判据不满足）。
- **重放一致性**：同一数据快照重跑，报告逐字段一致（检查器全确定性；时间戳仅入 meta 不入判定）。
- 报告形态：artifact（kind=verify-report）+ `verify.report` 事件 + 控制台汇总（N 项：x PASS / y FAIL / z NEEDS-HUMAN / w ERROR）。
- NEEDS-HUMAN 项 → 自动落 task（复用 artifacts kind=task 状态机，零新表）。

## 7. 命令族（命名避开 produce spec 的「spec 工件」重名）

```
verify form                        # 输出空白表单模板
verify prepare <form.md>           # agent 辅助翻译 → VU 清单（待确认）
verify confirm <spec-id>           # 专家过目确认（VU 忠实于判据）
verify run <spec-id> [--db <path|url>]   # 跑全部检查器 → 报告
verify report <run-id>             # 复核历史报告
verify list                        # 规范清单与状态
```

数据面：ygl 工作区 db（默认）+ 任意 SQLite 文件路径 + PG URL（**复用 0.89 的 getPgOrm 方言地基**——.157 的 Odoo/PG 直连即在此）。

## 8. 与树/毕业协议的接缝（复用而非新建）

- 验证规范可挂树节点：`rel add node:<tree>/<key> artifact:<spec-id> --rel decided-by`（规范=节点的验收判据）。
- 报告挂节点：`--rel evidenced-by`（验证结果=节点证据）。
- **毕业通道**（未来，先记设计）：一条验证规范稳定通过 N 轮 → `verify graduate <id>` 生成 patrol 检查（一次性验证 → 持续监控），走 graduation-protocol 的 executes 织物。

## 9. 待裁定点（实现前需拍板）

1. **表单载体**：Markdown 模板（人友好，prepare 严格化）vs YAML schema（机器严格，人难写）——推荐 Markdown。
2. **命令名**：`verify`（推荐，避开 produce spec 重名）vs `checklist` vs 顶层 `spec`。
3. **第一版检查器范围**：sql / sql-pair / count / exists / command / human 全上，还是先 sql + sql-pair + human 三件最小闭环？——推荐全上（sql/count 引擎已在 patrol/telemetry 现成，边际成本低）。
4. **VU 存储**：新表 verify_specs/verify_units（schema v13）vs 复用 artifacts（kind=verify-spec，VU 存 meta JSON）——推荐 artifacts 起步（九触点成本减半），查询面成型再升表。
5. **多数据源连接**：第一版是否带 PG（.157 直连）——推荐带（地基已在），但连接串安全（不入库，运行时传入）。
