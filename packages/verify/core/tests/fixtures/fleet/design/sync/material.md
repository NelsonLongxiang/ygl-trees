# 令牌面与 DESIGN.md 逐键一致（sync）

验收对象：被验提交的两个令牌消费面——apps/web/src/tokens.css（CSS 变量，[data-theme="dark"] 与 [data-theme="light"] 两个规则块里的 --color-*）与 apps/web/src/tokens.ts（DARK / LIGHT 两个字面量色板）。DESIGN.md 是唯一事实源：colors = 深色，colors-light = 浅色。
数据源：probe.mjs 解析三份文件（先把 CRLF 归一成 LF），对每个令牌面、每套主题，取 DESIGN.md 与该面的键的并集逐键写一行，写入只读 SQLite 快照表 token_sync(face, theme, key, design_value, face_value)。两个取值都是规范写法（十六进制统一成六位小写），某一边没有该键就记为空；两边是否一致由本 spec 比较，探针不判。同一份 spec 用于两个叶子，每个叶子的快照只含一个面（tokens.css 或 tokens.ts）。

## 判据

S1 令牌面的每个色值都必须与 DESIGN.md 同主题同键的取值一致：token_sync 中 face_value 与 design_value 都不为空且两者不相等的行必须为 0。
S2 DESIGN.md 的每个色键在令牌面的两套主题里都必须声明：token_sync 中 face_value 为空的行必须为 0。
S3 令牌面不得声明 DESIGN.md 没有的色键：token_sync 中 design_value 为空的行必须为 0。
S4 两套主题都必须完整可解析：token_sync 的行数不得少于 38（DESIGN.md 现有 19 个色键 × 两套主题）。

## 纪律

- 改色先改 DESIGN.md，再同步两个令牌面；本验证器只读，不替被验仓库改任何文件。
