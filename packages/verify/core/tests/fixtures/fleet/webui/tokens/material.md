# WebUI 设计令牌对比度验收（tokens）

验收对象：被验提交的 DESIGN.md 两套色板（colors = 深色，colors-light = 浅色）。
数据源：probe.mjs 解析两套色板，对每个文字角色（text / secondary / primary / tertiary / text-dim / success / danger / warning）在两种底色（neutral 页面底、surface 卡片底）上计算 WCAG 2.1 对比度，写入只读 SQLite 快照表 token_pairs(theme, fg, bg, fg_hex, bg_hex, ratio)。

## 判据

T1 正文类文字令牌必须达到 WCAG AA：token_pairs 中 fg 为 text、secondary、primary、tertiary、success、danger、warning 且 ratio 小于 4.5 的行必须为 0。
T2 弱化令牌 text-dim 只作非文字装饰（小地图节点等），必须达到 WCAG 1.4.11 非文字对比度：token_pairs 中 fg 为 text-dim 且 ratio 小于 3 的行必须为 0。
T3 两套色板都必须完整可解析：token_pairs 的行数不得少于 32。

## 纪律

- text-dim 禁止承载文字：一旦用回文字，视图层实测对比度（view 的 R5）按 4.5:1 判定。
- 改色先改 DESIGN.md，再同步 tokens.ts / tokens.css（被验仓库自有漂移守卫）；本验证器只读 DESIGN.md。
