# WebUI 单测结果验收（unit）

验收对象：被验提交的 apps/web/tests（vitest 逐例结果）。
数据源：probe.mjs 在独立 worktree 里跑 `vitest run apps/web/tests --reporter=json`，逐例写入只读 SQLite 快照表 test_cases(file, name, status, duration_ms)；导入即崩的测试文件记一条 status=failed 的伪用例。
同一份 spec 还用于 CRLF 检出场景（git core.autocrlf=true 重写工作区，模拟 Windows 新检出）：贡献者在任何平台的新检出上，前端测试都必须照样通过。

## 判据

U1 apps/web 的单测必须全部通过：test_cases 中 status 不为 passed 的行必须为 0。
U2 前端测试面不得萎缩：test_cases 的用例总数不得少于 81。

## 纪律

- 跳过（skipped/todo）也算未通过：前端没有平台差异，跳过等于没验。
- 用例下限只升不降：删测试先改这份材料再升 spec 版本。
