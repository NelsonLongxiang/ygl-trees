# 文档账本治理规范 v1

范围：CHANGELOG.md 与 docs/plan.md 两个账本主文件的体量治理与历史记录归档（2026-10-20 发版席立此规范，验证器常驻检查）。

## 判据（可机械验证）

- 治理规范本体登记笔记必须恰好一条，标题为『文档账本治理规范 v1』。
- CHANGELOG 归档登记笔记必须恰好一条，标题为其仓库路径 docs/CHANGELOG-archive-2026-10-20.md。
- plan 归档登记笔记必须恰好一条，标题为其仓库路径 docs/plan-archive-2026-10-20.md。

## 工作流程（账本拆分时执行）

1. 账本主文件超过 60KB 即拆分：尾部历史逐字移动到 docs/<主名>-archive-<拆分日YYYY-MM-DD>.md，主文件保留现行纪元；内容未改动仅移动。
2. 主文件底部指针行只指向最新归档；AGENTS.md 决策链同步登记归档文件名。
3. 归档与规范登记入工作区数据库：kb add --tags doc-governance，归档笔记标题=仓库路径，body 记录体量与 sha256。
4. 每次拆分收口前必须走验证器（verify submit → prepare → run）出 PASS 报告；周维护巡检每周复核账本体量并记录观察名单（docs/spec-validator.md、docs/verify-contract.md）体量趋势。
