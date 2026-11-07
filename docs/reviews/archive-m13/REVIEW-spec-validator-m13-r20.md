# M13 复核 r20：0.101.1（38ae8c4 / tag v0.101.1）

评审对象：0.101.1 热修（blob 收尾并发热修 + r19 N1–N5 收口）；开发线回执 task direct-149905a3。
评审方式：HEAD/远端 tag 核对 + `git show 38ae8c4` 源码/测试差异 + 动态探针（0.101.1 bundle，隔离 home `tmp/r18home`，端口 18681）＋ 门禁复跑。

## 0. 结论

**PASS。** N1–N5 全部落点正确；blob 并发护栏实证有效（六路并发同内容 PUT 全 200 同 sha；65 MiB → 413 JSON 且服务不崩）。余两条文档返工（D1、D2）与一条并发 flake 观察（D3），均不阻塞 0.101.1 发布。

## 1. 零信任核对

- HEAD=`38ae8c4`，tag `v0.101.1` 本地与 `git ls-remote` 均指向 `38ae8c4^{}`；工作树干净（无未跟踪 tgz/REVIEW）。
- npm `view ygl-trees version` 仍 0.101.0（CDN 传播滞后，按纪律不重发）；Gitee Release 1220341 为开发线自报。
- 源码唯一功能差异：`packages/ops/tools/src/blob-store.ts` 的 `finish()` rename 护栏；其余为测试/文档/`.gitignore`。

## 2. N1–N5 落点

| 项 | 证据 |
|---|---|
| **N1 端点计数** | `docs/plan.md` 已按正确口径重写：「0.100.0 = **6 读**（specs/spec/reports/report/materials/material）+ 1 写；0.101.0 = **7 读**（+archives）+ **2 写**（material、blob）」，并注明 r18/r19 两次漂移的抓取来源；「5 读（…除 archives 外）」的自相矛盾句式已删。 |
| **N2 坏报告 WONTFIX** | `verify-web.ts:156-162` 的 `filter` 上方显式注释：一条损坏 report 不该让看板 500，单条诊断走 `verify report <run>`；将来加「N 条损坏」脚注走旁路计数、不塞 `ReportRow`。 |
| **N3 tgz ignore** | `.gitignore:14` 新增 `*.tgz`；`git check-ignore -v ygl-trees-0.101.1.tgz` 命中。 |
| **N4 评审证据链** | 21 份 `REVIEW-*.md` 以 R100（内容零改动）移入 `docs/reviews/`；新增 `docs/reviews/README.md`：三条约定（文件名/原文不改写/新增即登记）+ 区间索引行覆盖全部 21 份（r2–r6、r7–r9、r10–r12、r13–r15、r16、r17、r18、r19、m13、0.84、webui-0.89.1，计数核对无遗漏）。 |
| **N5 blob 413** | `verify-web.spec.ts` 新增「blob PUT 超 64 MiB → HTTP 413 JSON」（65 MiB 全零缓冲）；定向 22/22 通过。 |
| **blob 并发热修** | `blob-store.ts` `finish()`：`renameSync` 包 try/catch → 清临时文件 → `dest` 已存在即返 ref（与 `putBlob` 同款）；`blob-store.spec.ts` 新增「同内容并发收尾」回归。 |

## 3. 动态实证（0.101.1 bundle）

- 小文件 PUT → 200 `{sha256:63d987d1…, size:4, mime:application/octet-stream}`；`POST material` 带 sha 引用 → 200，`files[0].blob=true`。
- 65 MiB PUT → `413 {"error":"blob too large: exceeds 67108864 bytes"}`，随后 `GET /api/verify/specs` → 200（服务存活）。
- 六路并发同内容 PUT → 全 200、同一 sha（`90c238ed…`），无 500 —— 热修目标场景实证通过。
- 归档链沿用 r19 已验：`archive --with materials` items=5、`archive verify <zip>` `{ok:true}`。

## 4. 门禁复跑

- 定向：`verify-web.spec.ts + blob-store.spec.ts` 22/22。
- 全量 unit：68 文件 **425/425**（干净复跑 rc=0）。
- `pnpm build` rc=0；demo rc=0（128 断言）；readme:verify rc=0；contract:audit 复跑 **100/100**。
- **D3 并发观察**：首次全量 unit 与 `pnpm build` 并发时 `selection.spec.ts` 两例失败（R16.1「project use writes the SESSION key…」71ms、「project show --json annotates selection_source」654ms，非超时）；同 spec 隔离 12/12、干净全量 425/425。`contract:audit` 在并发重活期间曾 99/100（`json channel: node parents` 输出 EMPTY），单跑 100/100。两者均表现为负载相关而非代码回归，建议记入既有并发 flake 台账（webui ECONNRESET / pg 锁超时之外的新样本），或把重负载门禁串行化；不阻塞本版。

## 5. 文档返工（不阻塞）

- **D1**：`CHANGELOG.md` 0.101.1 第二段「**热修（发布后 P3）**：`createBlobSink().finish()`，代码实际是 >200（`blob-store.ts` 的 `clientMimeOf`）——代码无需动，口径以代码为准。」语句损坏：主语重复了并发热修、缺「client mime 上限 200 而非 128」的口径勘误原文（plan 里是完整句）。建议重写为独立一句：「另：口径勘误——client 声明 mime 上限为 200 字符（非 128），以 `clientMimeOf` 为准，代码无需改动。」
- **D2**：`CHANGELOG.md` 0.101.0 段仍写「当版实为 5 读 + 1 写」，与 0.101.1 的 N1 订正（6 读 + 1 写）自相矛盾。建议在该行加括注勘误或由 0.101.1 条目显式声明「同时更正 0.101.0 段计数」。

## 6. 放行意见

**PASS，N1–N5 关闭。** D1/D2 建议随下一版（或 0.101.1 的后续文档提交）修掉；D3 作为门禁健壮性样本归档。下一节点仍是 M13-2 HTTP prepare/run（等网关凭证），排序不变。
