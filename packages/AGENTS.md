# AGENTS.md — ygl-trees Packages

本文件是 packages/ 树内的**包级开发纪律**，补充（不重复）仓库级 [AGENTS.md](../AGENTS.md)。进入任何 `packages/<group>/<pkg>/` 前先读本文件；改 schema 前再读 [docs/spec.md](../docs/spec.md)，写路径规范在 [docs/conventions.md](../docs/conventions.md)。

## 包的形状（gate 强制）

- **五件套**：`package.json`（workspace 成员，声明真实依赖图）+ `tsconfig.json`（extends 根 base）+ `README.md`（YAML frontmatter）+ `src/index.ts`（@module JSDoc 导出面）+ `tests/*.spec.ts`
- **零散 .ts 禁区**：`packages/` 根与 `<group>/` 根不允许任何 loose 文件（scripts/gate.js 硬检查）
- 依赖方向单向：`core/* → 域模块 → apps`；域间不互相 import（例外：ops/tools 跨切面可依赖 techtree/web——须在 package.json 如实声明；research/pipeline → ops/tools 的 eval-enhance 为 0.84 评审 F3 认定的既有例外，已声明——架构待办：下沉 core/ 或改 Cordis 服务注入）

## 插件导出契约（Cordis）

- **Service 插件**：`export class XxxService extends Service`（`super(ctx, "name")`）+ `export function apply(ctx, config)` + `declare module "cordis"` 声明合并（参照 `core/database/src/plugin.ts`）
- **构造必须同步**——CLI 短进程不赌 rc 版插件链时序（0.19 教训）；异步就绪只在长驻进程（serve）有意义
- 插件清单进 `ygl.bundle.json`（base）或 `$YGL_HOME/ygl.user.bundle.json`（用户层）；id→模块映射在 `apps/cli/src/bin.ts PLUGINS`

## 写路径铁律

1. **写命令必须走事务化服务**（`research/pipeline/src/writes.ts` / `techtree/model/src/writes.ts`）——幂等判定 + 基表 + FTS 影子 + events 在**同一个 ds.transaction**
2. **schema 变更九触点**（见 conventions §一）：SCHEMA_SQL + 迁移 + 实体 + export/mirror/migrate-DDL + doctor 口径（读 `SCHEMA_VERSION` 常量，禁硬编码）
3. **读路径不做写**——usage 计数已批量化（单语句 IN），新增读命令不得引入逐行 UPDATE（0.23 教训：12.7× 差距）

## 事件与遥测

- `logEvent(mgr, kind, entity, id, payload, level?)`——level 三态 info|warn|error；对象 payload 自动携带 `run`（YGL_RUN_ID）
- 树域已推翻 0.12 "不写 events" 例外——新写操作**必须**留痕

## 测试纪律

- 测试在包级 `tests/`，不在 `src/__tests__/`；vitest include = `packages/*/*/tests/**` + `apps/*/tests/**`
- **scratch 自清理**：beforeAll 建 tmp 目录 → afterAll `closeOrm()` + `db.close()` + `rmSync`（Windows 句柄占用目录删不掉 = EPERM，0.34 教训）
- 新行为必须有 demo 断言或单测；demo 断言 grep 的字段名以实际 JSON 输出为准（`rel list` 输出 `dst` 拼串而非 `dst_type`——0.32 教训）

## README 纪律

- frontmatter：`name` / `description` / `kind`（组|参考|库|bundle）
- 内容顺序：服务 API → 配置 → 事件 → 扩展点 → 设计说明 → 已知限制
- README 与行为同 commit 更新；版本收口前过一遍（根 AGENTS 规则 5 的包级体现）

## 命名（沿用 DSH 角色词表）

- 当前稳定职责命名，不用首个实现/未来扩展/Cordis 基类命名；单数 ctx key（service/store/runtime/resolver…），复数仅用于 registry
