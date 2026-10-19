# M13 复核 r19：0.101.0（301d2fe / v0.101.0）

评审对象：0.101.0（HEAD=301d2fe，tag v0.101.0），r18 P1–P3 + 三条 WIP 提醒。
评审方式：源码读取（`verify-web.ts:55-70` safeJoin、`webui.ts` 上传分支、`Verify.tsx`）+ 隔离 home 动态探针（`tmp/r18home`，0.101.0 bundle，端口 18679）＋ CLI 归档链 + 全量门禁复跑。

## 0. 结论

**PASS。** r18 的 P1（路径穿越）、P2①（archives/reports?spec 缺失与文档漂移）、P2②（报告详情不可读）与三条 WIP 提醒全部实证修复；未发现回归。余 5 条非阻塞项（N1–N5），其中 N1 文档计数订正仍是错的、N4 需口径确认。

## 1. 实证通过

| 项 | 实测 |
|---|---|
| 路径穿越 | `report?run=../../leak`、`..%2F..%2Fleak`（双编码）、`spec?id=../../evil`、`material?id=../../evil2` → 全 404，响应无泄漏内容（safeJoin 白名单 + resolve 包含性断言，`verify-web.ts:55-70`） |
| 报告详情 | `report?run=run_first_signed` → 200，报告完整（overall PASS），`archives: 1`（r18 WIP 的 `.json` 拼接 bug 已修，suffix 拼在 id 上） |
| 归档端点 | `archives` → 200，n=19，首项 `arc_8b717422ca3a` |
| `reports?spec` | 全量 23 → 过滤后 7，全部 `spec_id` 匹配 |
| 写端点校验 | `POST material` text/plain → 415 JSON；body 超 64KB → 413 JSON（`verify-web.spec.ts:205-219` 有用例） |
| 附件上传 | `PUT blob` → 200 `{sha256:74f81fe1…, size:5, mime}`；同字节二次上传 sha 相同（全局去重）；`POST material {attachments:[{sha256}]}` → 200，files 投影；不存在 sha → 400 点名 "attachment blob not found: 0000… — upload it to PUT /api/verify/blob first" |
| 上传开关 | 绑 0.0.0.0 → `403 {"error":"blob upload is disabled: serve bound a non-loopback address; set YGL_VERIFY_ALLOW_UPLOAD=1 to enable"}`；默认拒绝（`opts.allowUpload === true` 才开） |
| 归档附件 | `verify archive run_first_signed --with materials` → items=5；`verify archive verify <zip 路径>` → `{ok:true, items:5}` |
| 前端 | `Verify.tsx` Upload → `/api/verify/blob`（服务端算 sha）→ 提交只带 sha256 引用；错误态 Alert、空态 Empty 分离 |
| 门禁 | unit 423/423（68 文件，119s）、demo rc=0、contract 100/100、readme:verify rc=0、`pnpm build` OK；HEAD=301d2fe=tag，工作树仅未跟踪 `ygl-trees-0.101.0.tgz` |
| npm | 06:2x 仍 0.100.0（CDN 传播滞后，按纪律不重发） |

## 2. 非阻塞项

- **N1 文档计数订正仍错**：`docs/plan.md:335/337` 写「0.100.0 实为 5 读 + 1 写」「5 个只读端点（specs/spec/reports/report/materials/material 中除 archives 外）」。`git show 38d1f58:packages/ops/tools/src/verify-web.ts` 的路由实为 **6 读**（specs/spec/reports/report/materials/material），没有 archives。正确表述：「0.100.0 = 6 读 + 1 写；0.101.0 = 7 读（+archives）+ 1 写（+PUT blob）」。建议改一行。
- **N2 坏报告静默丢弃仍在**（r18 P3-1）：`listReports` 用 `.filter((r) => !!r && !!r.run_id)` 丢弃解析失败的报告，无健康信号。要么显式 WONTFIX 记入 docs，要么在 UI 显示「N 份报告不可读」。
- **N3 `*.tgz` 未 ignore**：`ygl-trees-0.101.0.tgz`（pack:check 产物）落在仓库根且未被 `.gitignore` 覆盖；建议加 `*.tgz` 或清理。
- **N4 评审报告进产品仓库需口径**：301d2fe 提交了 20 个 `REVIEW-*.md`（含 `REVIEW-0.84.0.md`、r2–r18、`REVIEW-webui-0.89.1.md`）。若作为证据链归档，建议移到 `docs/reviews/` 并在 AGENTS/README 记一句；若只是过程产物，建议移除。请作者席/负责人裁定。
- **N5 blob PUT 的 HTTP 413 缺直接用例**：sink 层有 `BLOB_LIMIT + 1` 测试（`blob-store.spec.ts:52`），但 HTTP 面只有 material 的 413 用例；建议补一条 blob PUT 超限断言（或明确由 sink 测试覆盖）。

（另：`verify archive verify` 只接受文件路径、不接受 archive_id——本人体会：按 id 验证更符合 `archives` 端点的心智模型；可作为 M13-2 的 UX 小项，非 0.101.0 缺陷。）

## 3. 发布侧

- tag `v0.101.0` → 301d2fe ✓；Gitea/Gitee Release id 1220305 为开发线自报（未独立复验）；npm 传播中。
- 建议发布窗口纪律照旧：diff/门禁由评审线过目后再最终确认（本版已过目）。
