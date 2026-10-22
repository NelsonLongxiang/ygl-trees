# 实心按钮 on-primary 六态（solid）

验收对象：被验提交的 apps/web/src/tokens.ts（themeConfig）在被验提交自己锁定的 antd 版本下渲染出的实心按钮。
数据源：probe.mjs 在本地克隆里按锁文件安装依赖，用 Node 直接加载被验提交的 tokens.ts，对两套主题调用 themeConfig 并交给 antd 的 theme.getDesignToken 推导；六种状态（colorPrimary、colorPrimaryHover、colorPrimaryActive、colorError、colorErrorHover、colorErrorActive）的填充色优先取 Button 组件覆盖值，否则取 antd 推导值，与按钮文字墨色（主色族用 primaryColor，危险色族用 dangerColor）计算 WCAG 对比度，写入只读 SQLite 快照表 solid_states(theme, state, fill_hex, ink_hex, source, ratio)。Button 的三个墨色键（primaryColor、dangerColor、solidTextColor）的取值与 DESIGN.md 同主题 on-primary 的取值并排写入 solid_inks(theme, ink_key, ink_hex, design_on_primary)，两者都是六位小写十六进制。

## 判据

O1 实心主按钮与危险按钮的六种状态在两套主题下文字对比度都必须不低于 4.5：solid_states 中 ratio 小于 4.5 或为空的行必须为 0。
O2 实心按钮的文字墨色必须取 DESIGN.md 的 on-primary：solid_inks 中 ink_hex 为空、design_on_primary 为空或两者不相等的行必须为 0。
O3 两套主题的六种状态必须都测到：solid_states 的行数不得少于 12。
O4 三个墨色键在两套主题下必须都测到：solid_inks 的行数不得少于 6。
