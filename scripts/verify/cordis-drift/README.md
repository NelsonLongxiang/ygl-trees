# cordis-drift：把一次性 Cordis 评审变成每轮可重跑的验证器 spec

m00310 的 Cordis 应用评审（`tmp/review-cordis.md`，P0 三项已在 0.86 闭环）是一次性的。
这里把它固化成 **verify spec**：一轮评审 = 一次 `verify run`，跨轮漂移 = 两份报告 diff。

## 组成

| 文件 | 作用 |
|---|---|
| `material.md` | 冻结材料：五条不变量（I1–I5）逐字文本，判据只能引用它 |
| `candidates.json` | 机械准备的 5 个判据（count / count floor / exists / sql find-violation / count ceiling） |
| `reviews.json` | 盲审三问（faithful / decidable / not-vacuous）的结论 + 锚点，供 P3 fail-closed |
| `../../../scripts/cordis-scan.mjs` | 采集器：扫 `packages/**`、`apps/**` 的 src → sqlite 快照（四表 + `meta`） |
| `../../../scripts/cordis-drift.mjs` | 编排：扫描 →（首次/`--prepare`）prepare → verify run，打印逐 VU 结论 |

快照四表：

- `cross_domain_imports(file, from_pkg, to_pkg, specifier, allowed)` —— 跨域相对 import；
  允许面 = 同域 / → core / apps/* → 任何包 / `ALLOWED_PAIRS` 里写明理由的历史直连。
- `event_sites(file, api, detail)` —— `ctx.on` / `ctx.emit` / `onEvent` / `onEventKind` / `emitEvent` 调用点。
- `service_defs(file, class, ctx_key, has_declare_module)` —— `extends Service` 与同文件 `declare module`。
- `bare_event_inserts(file, line)` —— `INSERT INTO events` 的裸写点（冻结基线 13）。

## 跑法

```bash
node scripts/cordis-drift.mjs              # 扫描 + 跑冻结 spec（无 spec 时自动 prepare）
node scripts/cordis-drift.mjs --prepare    # 材料变更后重新准备（spec 版本 +1）
node scripts/cordis-drift.mjs --json       # 机器可读：run_id/overall/summary/units/data_source/archive
node scripts/cordis-drift.mjs --root <dir> # 扫别的目录（验收注入用）
```

退出码：`0` = overall PASS；`1` = 非 PASS 或流程错误；`2` = 用法错误。
**判定不在退出码里**：`verify run` 自己对 FAIL 仍 rc=0，这里是评审脚本，才把 overal 映射成 0/1。

## 验收证据（0.97.0 trial，2026-10-20）

- HEAD：`overall PASS`，5/5（V1 0 行、V2 23 ≥ 20、V3 0 行、V4 0 行、V5 13 ≤ 13）。
- 注入漂移：把 `packages/`+`apps/` 拷到 `tmp/cordis-drift-bad/`，新增
  `packages/knowledge/skills/src/leak.ts` 引用 `../../../techtree/model/src/cmds` → 重扫 → 同一冻结 spec：
  `overall FAIL`，**只有 V1 失败**，witness `rows_scanned=151 / rows_matched=1`，
  `evidence {count:1, op:"==", expected:0}`，`rendered.findSql` 进报告。
- `verify archive verify` → `ok:true, items:5`；`verify report import` → `imported:true`；
  归档名 `yglverify-cordis-cordis-v3-…yglverify.zip`（`--title/--domain` 生效）。
- 数据源纪律：只读快照副本，报告 `data_source{kind:"sqlite-snapshot", sha256, source, captured_at}`。

## 纪律

- **白名单只减不增**：新增跨域直连一律视为漂移；确需新增时先改 `material.md` 升 spec 版本再进 `ALLOWED_PAIRS`。
- **判据只许来自材料**：改判据 = 改材料 + prepare 新版本，不能手改 `spec.json`。
- 每轮扫描都换 `source_digest`：`meta.source_digest` + 报告 `data_source.sha256` 是跨轮 diff 的锚。
