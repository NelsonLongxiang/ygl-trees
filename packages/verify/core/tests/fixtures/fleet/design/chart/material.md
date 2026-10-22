# chart-* 色觉缺陷区分度（chart）

验收对象：被验提交里概览活动时间线实际使用的系列色——堆叠顺序取自 apps/web/src/timeline.ts 的 SERIES，每个系列用的色键取自 apps/web/src/ActivityTimeline.tsx 的 SERIES_FILL，色值取自 DESIGN.md 两套色板。
数据源：probe.mjs 按堆叠顺序取相邻两个系列，在正常视觉（normal）与 Machado-Oliveira-Fernandes 2009 严重度 1.0 模拟的红色盲（protan）、绿色盲（deutan）、蓝色盲（tritan）下计算 OKLab 欧氏距离 ×100，写入只读 SQLite 快照表 chart_adjacent(theme, a, b, vision, delta_e)；每个系列色对卡片底 surface 的 WCAG 对比度与 OKLCH 明度、彩度写入 chart_series(theme, position, series, key, hex, contrast_surface, ok_l, ok_c)。这与被验仓库 apps/web/README.md 写明的色板验证器口径一致。

## 判据

C1 时间线上相邻两个系列在红色盲与绿色盲模拟下都必须可区分：chart_adjacent 中 vision 为 protan 或 deutan 且 delta_e 小于 8 的行必须为 0。
C2 相邻两个系列在正常视觉下必须明显可区分：chart_adjacent 中 vision 为 normal 且 delta_e 小于 15 的行必须为 0。
C3 每个系列色对卡片底色都必须达到非文字对比度 3:1：chart_series 中 contrast_surface 小于 3 或为空的行必须为 0。
C4 两套主题的系列都必须解析出来：chart_series 的行数不得少于 8（4 个系列 × 2 套主题）。
C5 相邻对必须全部测到：chart_adjacent 的行数不得少于 24（3 个相邻对 × 4 种视觉 × 2 套主题）。

## 纪律

- tritan 只记录、不判（色板验证器的门槛只针对 protan / deutan，蓝色盲约万分之一）；记录值供处置参考。
- 系列身份不只靠颜色：图例、表格视图与读数都写系列名。
