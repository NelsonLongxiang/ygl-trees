# 设计系统 artifact 与 DESIGN.md 一致（artifact）

验收对象：已发布的设计系统 artifact（https://claude.ai/artifact/UqDBxMgeu48CUmJTB6eGNc，Design System 类型）的 project/tokens.json 与 project/design-system.json，对照被验提交的 DESIGN.md 与源码。
数据源：artifact 是私有页面，探针无法直接拉取；它的这两个文件由维护者用 Claude Code 的 Artifact read 导出，连同 artifact 版本号、导出时间与文件 sha256（artifact/SOURCE.json）一起提交进本仓库的 artifact/ 目录，probe.mjs 读这份导出。比较结果写入只读 SQLite 快照表：
- artifact_values(kind, token, theme, key, artifact_value, design_value, design_occurrences)：kind 为 palette 是色令牌（color-键 或与 DESIGN.md 同名的键）在每套主题下的取值与 DESIGN.md 同键取值并排，DESIGN.md 有而 artifact 没有的色键以 artifact_value 为空入表；kind 为 entity 是 entity-类型 令牌的取值与被验提交 KnowledgeGraph.tsx 里该类型实际用的色键取值并排；kind 为 scale 是 radius-档 / spacing-档 与 DESIGN.md 的 rounded / spacing 并排；kind 为 literal 是其余取值（描边、阴影、DESIGN.md 没有档位的圆角），design_occurrences 是它在 DESIGN.md 全文里逐字出现的次数。取值都是规范写法（十六进制六位小写，其余去空白小写），artifact 自身的 {color-键} 引用按同一主题解析。两边是否一致由本 spec 比较，探针不判。
- artifact_refs(stamp, ref, resolvable)：artifact 声明的同步源提交（tokens.json 的 meta.ref 与 design-system.json 的 lastChange.via），resolvable 表示该提交在被验仓库能解析。
- artifact_ref_palette(stamp, ref, theme, key, ref_value, target_value)：每个能解析的版本戳提交，其 DESIGN.md 两套色板与被验提交的色板按键并集逐键并排。
- artifact_paths(path, present)：tokens.json meta 里引用的源文件路径在被验提交里是否存在。

## 判据

A1 artifact 的每个色令牌在两套主题下都必须与 DESIGN.md 同键取值一致，且 DESIGN.md 的每个色键都必须出现在 artifact 里：artifact_values 中 kind 为 palette，且 artifact_value 为空、design_value 为空或两者不相等的行必须为 0。
A2 artifact 记录的知识图谱实体配色必须与组件实际用色一致：artifact_values 中 kind 为 entity，且 artifact_value 为空、design_value 为空或两者不相等的行必须为 0。
A3 artifact 的圆角与间距档位必须与 DESIGN.md 一致：artifact_values 中 kind 为 scale，且 artifact_value 为空、design_value 为空或两者不相等的行必须为 0。
A4 artifact 的版本戳必须指向能在被验仓库解析的提交：artifact_refs 中 resolvable 为 0 的行必须为 0。
A5 artifact 引用的源文件路径必须在被验提交里存在：artifact_paths 中 present 为 0 的行必须为 0。
A6 artifact 的色令牌必须覆盖两套主题：artifact_values 中 kind 为 palette 的行数不得少于 38（19 个色键 × 2 套主题）。
A7 两处版本戳都必须在：artifact_refs 的行数不得少于 2。
A8 artifact 的其余取值（描边、阴影、DESIGN.md 没有档位的圆角）都必须写在 DESIGN.md 里：artifact_values 中 kind 为 literal，且 design_occurrences 为空或小于 1 的行必须为 0。
A9 版本戳提交的 DESIGN.md 色板必须与被验提交逐键一致：artifact_ref_palette 中 ref_value 为空、target_value 为空或两者不相等的行必须为 0。
A10 两处版本戳的色板都必须逐键比到：artifact_ref_palette 的行数不得少于 76（2 处版本戳 × 19 个色键 × 2 套主题）。

## 纪律

- artifact 每次重新发布后，维护者重新导出 artifact/ 并提交（SOURCE.json 记下 artifact 版本号）；导出与线上不一致的风险由这条纪律承担，验证器不假装能看到线上。
