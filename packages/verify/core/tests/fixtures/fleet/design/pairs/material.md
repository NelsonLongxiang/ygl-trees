# 两主题文字配对对比度（pairs）

验收对象：被验提交 DESIGN.md 的两套色板与 components 段，以及知识图谱实际使用的实体填充色（apps/web/src/KnowledgeGraph.tsx 的 typeFill）。
数据源：probe.mjs 在两套主题下分别计算 WCAG 2.1 对比度，写入只读 SQLite 快照表 contrast_pairs(theme, kind, name, fg, bg, fg_hex, bg_hex, ratio)：
- kind 为 role：8 个文字角色（text、secondary、primary、tertiary、success、danger、warning、text-dim）× 3 种底色（neutral 页面底、surface 卡片底、surface-hover 悬停行）；
- kind 为 component：DESIGN.md components 段里同时声明了 textColor 与 backgroundColor 的组件，颜色引用按该主题的色板解析；
- kind 为 entity：on-entity 标签色在 typeFill 用到的每一种实体填充色上。

## 判据

P1 正文类文字角色在三种底色上都必须达到 WCAG AA：contrast_pairs 中 kind 为 role、fg 不为 text-dim 且 ratio 小于 4.5 的行必须为 0。
P2 text-dim 只作非文字装饰，在三种底色上都必须达到非文字对比度 3:1：contrast_pairs 中 kind 为 role、fg 为 text-dim 且 ratio 小于 3 的行必须为 0。
P3 DESIGN.md 声明的每个组件文字与底色配对都必须达到 AA：contrast_pairs 中 kind 为 component 且 ratio 小于 4.5 的行必须为 0。
P4 知识图谱实体标签在每种实体填充色上都必须达到 AA：contrast_pairs 中 kind 为 entity 且 ratio 小于 4.5 的行必须为 0。
P5 文字角色配对必须完整：contrast_pairs 中 kind 为 role 的行数不得少于 48（8 个角色 × 3 种底色 × 2 套主题）。
P6 组件配对必须完整：contrast_pairs 中 kind 为 component 的行数不得少于 24（12 个组件 × 2 套主题）。
P7 实体标签配对必须完整：contrast_pairs 中 kind 为 entity 的行数不得少于 10（5 种实体填充色 × 2 套主题）。
