# 组件只引用 DESIGN.md 的色键（refs）

验收对象：被验提交 apps/web 下的源文件（同 literals 的扫描范围，去掉服务端 webui.ts）。
数据源：probe.mjs 逐行找出令牌引用——var(--color-键) 在所有文件里都认；C.键 与 C["键"] 只在从 ./tokens 导入了 C 的文件和 tokens.ts 本身里认——写入只读 SQLite 快照表 token_refs(file, line, ref, key, via, dark_value, light_value)；dark_value / light_value 是该键在 DESIGN.md colors 与 colors-light 里的取值，没有就记为空。

## 判据

R1 源码引用的每个色令牌键都必须是 DESIGN.md 两套色板都有的键：token_refs 中 dark_value 为空或 light_value 为空的行必须为 0。
R2 引用扫描不得空转：token_refs 的行数不得少于 100（2026-10-21 上游 master f2f91de 实测 119 处）。
