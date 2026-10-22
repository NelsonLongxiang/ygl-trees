---
name: doc-governance
description: 账本与文档治理工作流——体量预算、前置元数据、归档纪律与验证器判据
kind: 规范
---

# 文档账本治理规范 v2

范围：CHANGELOG.md、docs/plan.md 两个账本主文件与 docs/ 全体文档的体量治理、元数据与归档纪律（2026-10-20 发版席立此规范；v1 体量治理规则全量继承，本轮吸收 DeepSeek Harness 文档治理标准 doc-budgets/一事实一家/slop 清单的可适配项）。

## 判据（可机械验证）

- 治理规范本体登记必须恰好一条，标题为『文档账本治理规范 v2』。
- 归档登记（不钉日期，按路径模式核验）：每个 `docs/CHANGELOG-archive-*.md` 恰好一条笔记、标题为其仓库路径；每个 `docs/plan-archive-*.md` 同样恰好一条。新归档随拆分当轮补登（title=仓库路径，body 记体量+sha256+范围）。
- 文档预算清单登记必须恰好一条，标题为『文档预算清单 2026-10-20』。
- docs 元数据清单登记必须恰好一条，标题为『docs 元数据清单 2026-10-20』。

## 工作流程（账本拆分时执行）

1. 账本主文件超过自身预算天花板（见『文档预算清单 2026-10-20』台账）即拆分：尾部历史逐字移动到 docs/<主名>-archive-<拆分日YYYY-MM-DD>.md，主文件保留现行纪元；内容未改动仅移动。
2. 主文件底部指针行只指向最新归档；AGENTS.md 决策链同步登记归档文件名。
3. 归档与规范登记入工作区数据库：kb add --tags doc-governance，归档笔记标题=仓库路径，body 记录体量与 sha256。
4. 每次拆分收口前必须走验证器（verify submit → prepare → run）出 PASS 报告；周维护巡检每周复核账本体量并记录观察名单（docs/spec-validator.md、docs/verify-contract.md）体量趋势。

## 体量预算（借鉴 DSH doc-budgets）

- 天花板清单与超限处置政策以『文档预算清单 2026-10-20』台账为单一事实源；预算是护栏不是缩减目标，低于目标保持 ≥5% 余量，提额须在提交信息说明理由。
- 超限三步序：先 relocate（内容移归其归属层/归档），再 condense（本层内压缩），最后才 raise 天花板。

## 一事实一家（借鉴 DSH tier taxonomy 普适内核）

- 规则一处归属、他处链接：契约在 docs/spec.md，决策记录在 docs/plan.md，日常命令在 README.md，历史在归档；文档不重述 CHANGELOG 条目，不写"已实现/未来计划"状态注记（状态归属数据库与提交史），推理过程与被否方案不进文档。

## 前置元数据（借鉴 DSH kind-mapped metadata）

- docs/*.md（归档冻结件豁免）应带 YAML front-matter：name（稳定标识）、description（信息性一句话，拒绝广告语）、kind（枚举：规范/参考/设计/评审）。
- 基线与补齐节奏以『docs 元数据清单 2026-10-20』台账为准：新建或大改时顺手补齐，不专门开 diff。

## 冻结史

- 归档文件只追加不改写（对齐 DSH archived notes 冻结纪律）；文档描述现状——历史只在提交史、归档与 plan.md 执行记录。

## 验证器局限注记

- 判据落在工作区库 kb_notes（P2 构造面仅放行 count/exists/sql 且基线 DDL 列；tags/created 等 ALTER 列被拒，缺口已上报开发席）。台账判据核对"登记存在且唯一"，文件现实性由周维护巡检补位；待 command/file 构造面开放后升级为直接文件检查。
