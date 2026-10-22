# WebUI 单视图结果验收（view）

验收对象：被验提交的一个 WebUI 视图（路由），在三个场景下各打开一次：深色主题、浅色主题、存储被禁用（深色，localStorage 与 sessionStorage 一访问就抛 SecurityError，模拟隐私模式或站点数据被拦）。
数据源：probe.mjs 用无头 Chromium 打开 webui serve 上的该路由（种子库副本，1280×860），等网络空闲后在页面里实测，写入只读 SQLite 快照表 renders(route, theme（记场景：dark / light / no-storage）, nav_ok, interact_ok, console_errors, error_alerts, main_chars, text_nodes, marker_found)；控制台错误原文另存 console_messages(route, theme, text)；每个可见文字节点的实测值另存 text_contrast(route, theme, text, ratio, size_px, font_weight)——ratio 是前景色对最近不透明祖先背景的 WCAG 对比度，size_px 是计算字号，font_weight 是计算字重；探针不做任何门槛判断。marker_found 只对声明了标记的视图有值：画布视图记是否画出 .react-flow__node，验证器视图记报告详情的判据表是否画出（看板里的两份报告由 probe 用被验提交自己的 CLI 生成，见 tests/fixtures/board/README.md），其余视图为空。部分视图在测量前要先依次点击（例如概览任务表的列筛选下拉；验证器切到「报告看板」并点开第一条运行记录），interact_ok 记点击是否都成功，没有交互步骤的视图为空；打开着的弹层（下拉、气泡、选择框、对话框）与主区一起计入对比度实测。

## 判据

R1 视图必须在每个场景下都能打开：renders 中 nav_ok 为 0 的行必须为 0。
R2 视图不得产生控制台错误：renders 中 console_errors 大于 0 的行必须为 0。
R3 视图不得显示错误告警：renders 中 error_alerts 大于 0 的行必须为 0。
R4 视图必须渲染出内容：renders 中 main_chars 小于 20 的行必须为 0。
R5 可见文字必须达到 WCAG AA 对比度：text_contrast 中 ratio 小于 4.5 且不属于大字（大字 = size_px 不小于 24，或 font_weight 不小于 700 且 size_px 不小于 18.66）的行，以及属于大字但 ratio 小于 3 的行，都必须为 0。
R6 声明了标记的视图必须画出标记：renders 中 marker_found 为 0 的行必须为 0。
R7 三个场景都必须实测：renders 的行数不得少于 3。
R8 声明的交互步骤必须能完成：renders 中 interact_ok 为 0 的行必须为 0。

## 纪律

- 对比度按实际渲染算（前景色对最近的不透明祖先背景）；禁用控件、aria-hidden、小地图与 SVG 内文字不进 text_contrast。门槛只写在 R5（P0.2：探针只测不判）。
- 同一份冻结 spec 用于每个视图，只有快照不同。
