# 0.100.0 / M13-2 第一批复核（评审线 · 2026-10-20）

评审对象：commit `38d1f58`（tag `v0.100.0`；M13-2 第一批：`verify-web.ts` 316 行 + `Verify.tsx` 326 行 + `apps/web/src/api.ts` +146 + webui 挂载 + r17 P3 四项）。
方式：源码逐段读 + 隔离 home 动态探针（`tmp/r18home`，拷贝真实 `$YGL_HOME/verify/{materials,specs,reports,archives}`；`webui serve --port 18677`；探针 `tmp/r18probe.mjs`）。

## 结论

**CHANGES**——三视图与服务面骨架成立、r17 P3 四项实证落地，但服务面存在**一个 P1 安全缺口（路径穿越，三个端点均可读任意 `.json`/材料目录）**，须在第二批（HTTP prepare/run、附件上传）之前修掉；另有 2 项 P2 口径/文档不一致、5 项 P3。

## 一、实证通过（正向）

| 项 | 证据 |
|---|---|
| specs 清单投影 | GET `/api/verify/specs` 200，10 行（spec_id/version/units/verdict/rounds/runs/last_overall） |
| spec 追溯载荷 | GET `spec?id=spec_24a0b30d47d1` 200，`spec.vu` 58 条 + prepare 存在 |
| reports / report | 200，23 条；report 详情含 report 原文 + `archives` 侧车 |
| materials / material | 200，11 条；正文 3317 字符，`text_path` 为相对名 `material.txt`（不泄漏绝对路径） |
| 材料草稿幂等 | 同正文 POST 两次 → 同一 `mat_f729a9d4873f` |
| 附件拒收 | POST 带 `attachments` → 400，`attachments are not accepted by the WebUI yet — use CLI: ygl-trees verify submit --attach <file>` |
| 方法守卫 | POST 到 GET-only 端点 → 405 `GET only — material drafts are POST /api/verify/material` |
| 渲染安全 | `Verify.tsx` 无 `dangerouslySetInnerHTML`/`innerHTML`，材料与 trace 均按文本渲染；例外项置顶排序（`Verify.tsx:286`） |
| r17 P3 ① | `verify-cli.spec.ts:365`（binary identity mismatch）+ `:451`（refusing to archive） |
| r17 P3 ② | `prepare.spec.ts:76` 断言 `corpus_version === CORPUS_VERSION` |
| r17 P3 ③④ | `docs/verify-signing.md:37`（降级不保留身份）+ `:109`（archive verify 只做哈希链与登记项一致性、不重验签名） |
| 测试 | 定向 8/8（verify-web）+ 3/3（三视图渲染） |

## 二、P1（阻塞第二批）

### P1-1 三个 detail 端点路径穿越 → 任意 JSON / 材料目录读取

- 根因：`specId` / `runId` / `materialId` 直接拼进路径，无校验：
  - `packages/ops/tools/src/verify-web.ts:105-107` `const dir = join(p.specs, specId)`；
  - `:165` `readJson(join(p.reports, \`${runId}.json\`))`；
  - `:199-211` `join(p.materials, materialId)`（读 `material.json` + `material.txt`）；
  - 路由层 `:277/:288/:299` 仅 `q.get("id") || ""`，无白名单。
- 实测（隔离 home 放置标记文件）：
  - `GET /api/verify/report?run=../../leak` → `200 {"report":{"marker":"traversal-report-ok"},"archives":[]}`（读 `$YGL_HOME/leak.json`，已在 verify 根之外）；
  - `GET /api/verify/spec?id=../../evil` → `200 {"spec":{"marker":"traversal-spec-ok"},"prepare":null,"trace":null}`；
  - `GET /api/verify/material?id=../../evil2` → `200` 返回 `material.json` + `material.txt`。
- 影响：本机任意进程（或 `--host 0.0.0.0` 时的 LAN 客户端）可读取文件系统上任意 `.json`（report 端点自动补 `.json`）以及任意 `material.json/material.txt` 组合；与「材料是业务事实原文」的定位叠加，泄漏面是真实的。当前无鉴权、无 CORS/Origin 校验（`webui.ts` 无 `access-control`/`Origin` 处理），P1 因此不可降级。
- 修法（最小）：
  1. id 白名单 `^[A-Za-z0-9_-]+$`（spec_/run_/mat_ 前缀可选），`..`、`/`、`\`、`%2f` 解码后一律拒；
  2. 解析后 `resolve(path).startsWith(resolve(root) + sep)` 断言，失败按 404 处理（不区分「不存在」与「非法」，避免探测）；
  3. 测试补三条穿越用例（本 home 内 + 越出 verify 根 + 编码混合），并把 `listMaterials/listSpecs` 的 dir 名同样纳入白名单（当前来自 `readdir` 可信，但统一守卫更省事）。

## 三、P2（口径/文档不一致）

- **P2-1 端点声明与实现不一致**：`docs/plan.md` 0.100.0 执行记录写「7 个只读端点（specs/spec/reports/report/**archives**/material）」+ 1 写入；实测 `GET /api/verify/archives` → `404 {"error":"unknown verify endpoint: /api/verify/archives"}`。`docs/spec-validator.md` §9 表格已按实现写（无 archives），两处文档互相矛盾；发给开发线的说明还提到 `reports?spec` 过滤，而 `:288` 只读 `run`，`GET /api/verify/reports?spec=<id>` 实测仍返回全部 23 条。前端未调用 archives / 未传 spec 过滤，所以不是用户可见故障——修正文档或补实现，二者择一即可。
- **P2-2 §9「R16 选择门 + P1-1 归属校验同规」已过期**：验证器工件是 home 级全局（`verify/` 下无 project 维度），`App.tsx:199` 的验证器卡片在未选择项目状态也渲染（未选择提示卡之外）。这本身合理（工件不属于任何项目），但文档不该再声称有选择门；建议写清「验证器面为工作区级、与 R16 选择态正交；材料正文因此对能访问该端口的浏览器一律可见」，并决定是否给材料加项目维度（若加，是批次 2 的 schema 决策）。

## 四、P3

1. **坏报告静默消失**：`listReports`（`verify-web.ts:133-140`）对解析失败的 `.json` 返回 null 后被过滤；实测写入 `run_zzcorrupt.json` 后列表计数不变、无告警。报告看板应显示「N 个文件不可读」的健康项，而不是当它不存在（fail-closed 文化的一致性问题）。
2. **前端把 API 失败渲染成空态**：`Verify.tsx:92/97/103/211/216` 全部 `.catch(() => setX([]/null/""))`，服务挂掉时显示「还没有规范/还没有运行记录」，与「真没有」无法区分。建议区分加载中/错误/空三态。
3. **超大 body 直接断连**：`webui.ts:520` 超 `VERIFY_BODY_LIMIT` 后 `req.destroy()`，实测 70KB → `UND_ERR_SOCKET`，无 413、无 JSON 错误体。建议先回 413 JSON 再结束连接。
4. **POST 无 Content-Type / Origin 校验**：跨站 `text/plain` 简单请求可写入材料草稿（无 CORS 头，读不回响应）；与 P1 叠加时风险放大。至少校验 `content-type: application/json`，并考虑 `Origin/Sec-Fetch-Site` 拒绝跨站。
5. **每次 `/api/verify/specs` 都全量重读**：`listSpecs`（`:75-101`）逐 spec 读 `spec.json/prepare.json` 且调用 `listReports` 全读 23 份报告；工件增长后是 O(全部工件)。当前量级无感，批次 2 前可加 mtime 索引或缓存。

## 五、对开发线两个问题的口径

### 5.1 HTTP 上的 prepare/run 由谁注入 runner/reviewer

**建议：M13-2 不给 HTTP prepare/run；GUI 先只读 + 材料草稿。** 若将来要 GUI 触发，形态应是显式的「验证作业服务」，不是给 dashboard 加两个 POST：

- **注入位置 = 服务进程启动时**（`webui serve --enable-verify-jobs --verify-runner <config>` 或专用 `verify serve-jobs`），runner/reviewer 由 CLI 从 env/`$YGL_HOME` 配置构建，**请求体只携带 material_id/spec_id**。理由：
  1. 构造面是模型调用（网关凭证、成本、时长）——请求携带 runner 配置等于让浏览器指定模型端点与钥匙，审计链无法回答「这份 spec 是谁造的」；
  2. 同步 HTTP 跑不完（prepare 有三轮自审+红队），必须作业队列 + SSE，这是新服务面而非现有只读面；
  3. 本机端口无鉴权，加一个烧模型的写端点就是本机 DoS 面。
- 若做作业服务：单独端口/进程、启动参数显式开启、loopback-only、每作业记录 runner 身份（模型/网关/prompt 版本）进 prepare trace 与报告 verifier，作业结果仍落文件工件（与 CLI 同一路径），HTTP 只做提交与查询。
- **按请求携带 runner**：反对——凭证穿越、审计失真、无法限流。

### 5.2 附件 multipart 与 content-addressed blob 的边界

- **只在提交阶段收字节**（`POST /api/verify/materials/:id/attachments` 或 CLI `verify submit --attach`），prepare/run 只认 `material.json` 里记录的 `sha256/size/mime/name`，**永不接受客户端声明的哈希或路径**。
- 服务端：流式计算 SHA-256 → 若已存在同 sha 直接复用；大小上限（建议 100MB）、MIME/扩展名白名单（xlsx/pdf/png/jpg/zip，按 magic bytes 二次校验）、文件名仅存原名元数据（落盘用 `<sha256>.<ext>`），拒绝 `..`/绝对路径/符号链接。
- 布局建议：`$YGL_HOME/verify/blobs/<sha256>`（全局去重）+ `materials/<id>/material.json.files[] = {sha256,size,mime,name}`；报告 `attachment_sha256[]` 从 material 记录投影，不信任请求。
- WebUI 读面只列元数据（名称/大小/sha256），**不提供字节下载**——在 P1 修掉且加了路径守卫之前，不要新增任何按 id 取文件的端点；若必须预览，走「按 blob 目录 + 白名单 mime + `Content-Disposition: attachment`」，且 id 仍是 sha256 本身（无路径拼接）。
- 当前 400 拒收 + CLI 指向是正确过渡态，保留。

## 六、门禁

- 定向：`verify-web.spec.ts` 8/8、`apps/web/tests/verify.spec.tsx` 3/3。
- **全量 unit 实测 408/410（exit 1，05:27:44，`--maxWorkers=2`）**，两例失败均在 `verify-web.spec.ts`：①「报告详情 = 报告原文 + 归档侧车」`reportDetail` 返回 null；②附件 POST 期望 `verify submit --attach` 却收到 `attachment sha256 must be 64 lowercase hex chars`。
- **归因：工作树在评审期间被开发线并发修改（未提交 WIP），不是 `38d1f58` 的缺陷。** 证据：`git status` 显示 `verify-web.ts`/`webui.ts`/`verify-web.spec.ts` 等 7 文件 M；失败断言引用的 `attachment sha256…` 只存在于工作树（HEAD 版本无此串），`safeJoin` 亦只存在于工作树；HEAD 的 `reportDetail` 仍是 `join(p.reports, `${runId}.json`)`、HEAD 测试仍断言 CLI 提示。旧测试恰好抓住了 WIP 里 `safeJoin(p.reports, runId, ".json")` 的路径拼接错误（见 §七）。
- 结论：`0.100.0` 的**干净树门禁未被本评审复现**（工作树已脏）；合并 WIP 前请以干净树跑一次 `pnpm test:unit`（410）再提交。`cargo` 本轮未变。
- `npm view ygl-trees version` 仍 0.99.1（传播中，按纪律不重发）。

## 七、评审期间观察到的 WIP（供开发线参考，不属于 0.100.0 判定）

评审过程中工作树出现未提交的第二批改动（`blob-store.ts` 新增、`verify-web.ts` +175、`webui.ts` +76、`Verify.tsx` +82 等），方向与 §五口径一致（内容寻址仓 + `PUT /api/verify/blob` 原始字节流式上传 + 材料只收 sha 引用 + 405/415 + 非回环默认禁传 + archives 端点 + `reports?spec` 过滤 + `safeJoin` 穿越守卫）。观察到三处需要修：

1. **`safeJoin(..., ".json")` 解析错误（会立刻被现有测试抓住）**：`reportDetail` 与归档侧车写成 `safeJoin(p.reports, runId, ".json")`，`resolve()` 结果是 `<reports>/<runId>/.json` 而非 `<reports>/<runId>.json`，因此报告详情恒为 null。修法：`const at = safeJoin(p.reports, runId); if (!at) return null; const report = readJson(at + ".json")`（或给 helper 加一个「单段文件名」变体，id 仍走白名单）。
2. **blob 超限没有 413**：`sink.write` 返回 false 后 `req.destroy()`，但 413 只在 `'end'` 分支发送；实测客户端看到的是断连而不是 JSON。建议 destroy 前直接 `send(413, …)`（并仅 abort sink），或补 `'close'/'aborted'` 分支统一收尾。这与 §四 P3-3 是同一类问题的第二处。
3. **`allowUpload` 默认值**：`createDashboardServer` 默认 `{}` 时上传是放行的（`opts.allowUpload === false` 才拒），真实 `serve` 已正确传入 `uploadAllowed(host)`；建议默认改为 `opts.allowUpload ?? false`，避免未来其他调用方（测试/嵌入）漏传即开放写面。
