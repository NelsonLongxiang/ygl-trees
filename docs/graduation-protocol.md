# 毕业通道协议（T4/T5 · 0.93 批设计，0.94 落地）

> 研究结论 → 执行规则的接缝约定。ygl-trees 是认知台账（研究/预测/验证），执行归执行系统（.157 专家团 + Odoo）。本协议只定义两侧交割的握手件，不给 ygl 加执行能力——replace-esm 抵制裁定（2026-10-18，ygl-overlap 12 断言）保持有效。

## 一、两侧各自拥有什么

| 环节 | 归属 | 载体 |
|---|---|---|
| 研究证据/断言/仲裁 | ygl-trees | sources / evidence / claims |
| 意图解析→本体→SOP 渲染 | 执行侧（.157 ontology：intention_parser → sop-renderer → migrate_to_odoo） | 本体库 / pi-web-sop-bindings.json |
| 执行与执法 | 执行侧 | Odoo / SOP 引擎 |
| 毕业裁决 | **人**（claim resolve 即人审仲裁） | ygl events |

## 二、毕业握手件（ygl 侧三件套）

一个研究成果「毕业」为执行规则，须在 ygl 侧形成：

1. **断言终态**：`claim resolve <id> --as supported`（人审仲裁，证据齐）。
2. **SOP 源登记**：`research source add <执行侧SOP引用> --tags sop` —— tags=sop 即毕业候选的机器可检索标记（T4 裁定：零 schema，不用 v13）。
3. **执行织物**：`rel add node:<tree>/<key> source:<id> --rel executes` —— 树节点（能力位）↔ SOP 源（执行体）的 executes 边；同节点已有 evidenced-by 时两读并存（有证据 → 有执行）。

可选：`produce artifact --kind sop` 产出 SOP 草案工件（ygl 产出的是**草案**，渲染与迁移归执行侧）。

## 三、词汇表（rels 值约定）

| rel 值 | 语义 | 方向 |
|---|---|---|
| `evidenced-by` | 节点的证据依据 | node → evidence |
| `decided-by` | 节点的决策依据 | node → claim |
| `executes` | 节点的能力由该 SOP 承接执行 | node → source(tags=sop) |
| `tracked-by` | 节点跟踪该资产 | node → task/artifact/kb |

执行侧消费方式：按 `tags=sop` 拉源 + 按 executes 边定位能力位 → intention_parser 吃 claim 文本 → 渲染 → migrate_to_odoo。各环两侧都已存在，缺的只是本约定。

## 四、验收（0.94 时）

- demo 断言：毕业三件套全序列（resolve → source --tags sop → rel executes → rel list 复核）。
- skills/ygl-trees-relating 增 executes 词条。
- .157 侧一次真实试点（候选：bill-audit 树某 supported 断言 → SOP 草案 → 专家团渲染）。

## 决策记录

- 2026-10-19（M11）：T4 零 schema 裁定——真实消费者成型再开 v13；T5 接缝协议化、不加执行能力。
