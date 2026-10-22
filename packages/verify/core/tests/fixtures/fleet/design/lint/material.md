# DESIGN.md 格式检查（lint）

验收对象：被验提交的 DESIGN.md（google-labs-code design.md 格式）。
数据源：probe.mjs 用本仓库 node_modules 里钉死版本的 @google/design.md（0.4.0）执行 designmd lint --format json，把每条发现写入只读 SQLite 快照表 lint_findings(rule, severity, path, message)，把这次运行本身写入 lint_run(version, rc, parsed)，parsed 为 1 表示输出是可解析的 JSON。

## 判据

D1 DESIGN.md 格式检查不得有 error 级发现：lint_findings 中 severity 为 error 的行必须为 0。
D2 格式检查必须真的跑完并给出可解析的结果：lint_run 中 parsed 为 1 的行数不得少于 1。

## 纪律

- warning（如 orphaned-tokens：页面级令牌没被组件引用，属格式 alpha 限制）与 info 只记录、不判。
- 检查器版本钉死；升级 @google/design.md 等同改判据，要走 build-specs → run --prepare → selfcheck。
