# 源码无硬编码色值（literals）

验收对象：被验提交的 apps/web/src 下全部 .ts / .tsx / .css 文件、apps/web/index.html，以及服务端知识图谱配色 packages/ops/tools/src/webui.ts。
区域：令牌面（token-face）= apps/web/src/tokens.ts、apps/web/src/tokens.css、packages/ops/tools/src/webui.ts；其余文件都是消费面（consumer），只许用 C.* 或 var(--color-*) 取色。
数据源：probe.mjs 逐行扫描色值字面量（#rgb、#rgba、#rrggbb、#rrggbbaa，以及 rgb()、rgba()、hsl()、hsla()），每处写入只读 SQLite 快照表 color_literals(file, line, literal, kind, zone, design_occurrences)；design_occurrences 是该字面量（去空白、小写后，十六进制另按六位写法）在 DESIGN.md 全文里逐字出现的次数，是计数不是判定。扫描过的文件写入 scanned_files(file, zone, literals)。

## 判据

L1 消费面不得出现任何色值字面量：color_literals 中 zone 为 consumer 的行必须为 0。
L2 令牌面里的每个色值字面量都必须写进 DESIGN.md（色板取值、按钮状态色、阴影与描边都算）：color_literals 中 zone 为 token-face，且 design_occurrences 为空或小于 1 的行必须为 0。
L3 扫描不得空转：scanned_files 的行数不得少于 20（2026-10-21 上游 master f2f91de 实测 21 个文件）。
L4 三个令牌面都必须在扫描范围内：scanned_files 中 zone 为 token-face 的行数不得少于 3。

## 纪律

- transparent、currentColor、inherit 不是色值，不算字面量。
- "写进 DESIGN.md"指 DESIGN.md 是唯一事实源：令牌面出现的每一个色值都能在 DESIGN.md 里找到出处。
