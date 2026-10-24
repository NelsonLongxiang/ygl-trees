---
name: review-cordis-depth-r33
description: Cordis 框架应用深度独立评审（r33）——五裁定确认/修正 + 事件/配置/启动就绪改进清单
kind: 评审
---

# Cordis 框架应用深度 · 独立评审（r33）

> 触发：发版席转外部评审「ygl-trees 只用 Cordis 三成功力」，派单要求与 fdc757f6 并行独立评审、互不通气。
> 本报告不引用 fdc 意见；结论基于 HEAD `c84a449` 的代码取证。对照开发席《Cordis 使用面架构评估》（anchor `dadf3e0`）。
> 口径：每条给 Cordis 机制轴（事件/作用域/配置/命令/fork）、真实痛点、成本量级（天）、YAGNI 判断。

## 0. 结论摘要

| 开发席裁定 | 本席判定 | 差异 |
|---|---|---|
| group/子 Context 缓接（条件触发） | **确认** | 补充「先事件作用域化」的顺序与 R16 证据 |
| hmr 缓接，1–2 天 spike | **方向确认，成本/前置修正** | hmr 直接 import loader + include（`vendor/hmr/src/index.ts:3-4`），1–2 天不够；改 3–4 天 dev-only 或暂缓 |
| logger-console 不接 | **确认（YAGNI）** | 无差异 |
| loader 不接 | **确认（0.40 实证）** | 无差异；并指出它是 hmr 的前置，强化不接 |
| include 不接 | **确认（YAGNI）** | 无差异 |

**核心短板确认**：开发席说「真正短板 = 事件面自研桥」——**成立**，且比其描述更具体（见 §2）。但**排序要改**：开发席把 hmr spike 放第一；本席认为应先做**事件作用域化 + 启动就绪**（低风险、清掉 0.65 P0 类隐患），hmr 因 loader/include 依赖降为条件项。另新增两条开发席未覆盖的实用改进：**用户层配置校验**与**fork API 漂移护栏**。

## 1. 五裁定逐项

### 1.1 group/子 Context：确认缓接
- R16 选择键在 DB `meta`（`current_project@<sid>`）与进程 env `YGL_SELECTION_VIA`：`packages/core/database/src/selection.ts:33/38/96`；子 Context 不改变 `sessionId()`，也不隔离 env。
- 事件桥固定在 DatabaseService 的 root ctx（`packages/core/database/src/plugin.ts:61-82`），子 Context 的监听器仍收到同一事件流——group 单独接不能产生「作用域事件」。
- `.ygllock`、`ormState` 均为进程级单例假设；per-context 隔离成本大于当前收益。
- 同意条件触发；若接，顺序必须是「事件作用域化 → D1–D5 选择语义裁定 → group」，成本 3–5 天（触发后）。

### 1.2 hmr：方向确认，成本与前置修正（**与开发席有差异**）
- `vendor/hmr/src/index.ts:3-4` 直接 import `@deepseek-ai/cordis-plugin-loader` 与 `@deepseek-ai/cordis-plugin-include`（还依赖 timer）。hmr **不是独立插件**。
- loader 已被 0.40 四轮探针判 no-go：`lib/` 不暴露 `moduleNamespace`、运行时 specifier 破坏 tsdown 单文件产物。因此 hmr 只能在 **dev/source profile**（loader 可解析、非发布 bundle）里谈，且必须先有 loader dev harness。
- 结论：接受「缓接」，但**1–2 天 spike 不成立**；若做，3–4 天 dev-only（`YGL_DEV` 开关），验收=改用户插件源码→`webui serve` 热替换且 SSE/timer 不丢；**不得进发布路径**。当前证据下优先级低于事件/就绪，可暂缓。

### 1.3 logger-console：确认不接（YAGNI）
- 现有 `events` 表（写路径留痕）+ `fmt` + stderr 已覆盖观测；没有「分级过滤的长驻服务日志/多租户请求域」消费者。
- logger-console 是控制台适配，不解决域/分级；接入会引入 events 与 logger 双写漂移。
- 触发条件成立前不做（成本 0）；若触发，1 天。

### 1.4 loader：确认不接（实证）
- 0.40 探针结论仍成立：编译产物无 `moduleNamespace`、运行时 import 破坏单文件；R14 已用 profile-boot + 静态 `PLUGINS` 映射覆盖用户层。
- 附加理由：loader 是 hmr 的前置，接 loader 等于同时打开 hmr 的复杂度。
- 成本 0；重开条件：上游暴露静态可追踪 module namespace 且放弃单文件发布（短期不会）。

### 1.5 include：确认不接（YAGNI）
- 单应用 + base bundle（`ygl.bundle.json`）+ user bundle（`ygl.user.bundle.json`）+ profile 已覆盖层叠；没有第二层配置源。
- 成本 0；触发条件：多环境 profile 片段共享的真实需求。

## 2. 真正短板：事件面（确认 + 四条具体缺陷）

开发席结论成立，但代码事实更细：

1. **生产端不持 ctx**：`emitEvent()` 调用点 13 处（HEAD `c84a449`；开发席写 22，可能含 `logEvent`/历史计数，排期前重数）；`packages/core/text/src/eventbus.ts` 是进程级 EventEmitter 单例。插件监听得到事件，但事件没有「从哪个 ctx 发出」的语义。
2. **桥在 root ctx**：`(ctx as any).emit("ygl", evt)`（`plugin.ts:72-73`）把所有事件广播给 root 下所有监听者；即使接 group，桥不变，事件仍不隔离。
3. **清理用 fork 内部 API**：`(ctx as any).fiber?.collect?.(...)`（`plugin.ts:78`）而非 Cordis 的 `ctx.effect`（`vendor/cordis/src/fiber.ts:415`）或 `ctx.on` 的自动随 fiber 销毁（`vendor/cordis/src/events.ts:256`）；`ctx as any` 丢类型，注释「this fork has no ctx.dispose」与 `ctx.effect` 的存在不一致。
4. **同步派发无隔离**：`ctx.emit` 的 `emit()` 用 `.map(cb => cb(...args))` 同步调用（`vendor/cordis/src/events.ts` `emit`），一个插件监听器抛错会中断后续监听器；桥的 `try { } catch { }` 把错误吞掉——事件静默丢失，且无告警。
5. 类型面：`ctx.emit("ygl", evt)` 无事件映射声明，`as any` 掩盖了事件名/载荷变化。

**改法（P1，2–4 天）**：新增 `ctx.events` 风格的 `EventService`（Cordis Service，封装持久化 + `ctx.emit`），生产端逐步改注入；过渡期保留 eventbus 作内部传输；桥改用 `ctx.effect(() => onEvent(...))`；补 `declare module` 事件映射与「监听器抛错隔离/告警」回归测试；13 个 emit 点分批迁移，先 webui 消费面 + 用户插件面。

## 3. 开发席未覆盖的两条实用改进

### 3.1 用户层配置校验（P2，1–2 天）
- base bundle 有 Schemastery 校验（`apps/cli/src/bin.ts:36-48`），**用户层没有**：`readUserBundle` 对 `ygl.user.bundle.json` 的 JSON parse 错误直接 `catch → []`（`packages/ops/tools/src/plugins.ts:112-129`），非法条目被静默过滤，`config` 原样传给 `apply`——插件配置写错时，启动看起来正常，错误延迟到运行期。
- 改法：用户 bundle 加 Schemastery schema（name/spec/enabled/config），插件可选导出 `configSchema`（Schemastery，已有依赖）；启动诊断点名文件+条目，不静默丢弃；`plugin config` 写入前校验。轴：配置。

### 3.2 启动就绪去轮询（P1，0.5–1 天）
- `bootApp` 用 50 次 `setImmediate` 轮询 `app.database?.db`，取不到就 `new DB(...)` 兜底（`apps/cli/src/profile-boot.ts:84-88`）——兜底会在 DatabaseService 稍后构造时**双开 DB**（0.65 P0 的同类隐患），且轮询是时序赌注。
- Cordis 已提供 `ctx.inject(deps, callback)` 与可 await 的 `ctx.plugin` Fiber（`vendor/cordis/src/registry.ts:176/316`）。改为 `await app.inject(["database"], ...)` 或 `await app.plugin(...)`，删除轮询/兜底；服务起不来就 fail-loud。轴：作用域/生命周期。

## 4. 待触发项与 YAGNI

- **命令面**（轴：命令）：`bin.ts` 982 行手写 argv、usage 文本与路由表并存；但**不是 Cordis 短板**——Cordis 从不提供 CLI 解析，且插件命令注册点已存在（`exports.commands`，dispatch 顺序 plugin → DOMAIN_ROUTES → unknown；`docs/plugin-authoring.md:58`）。真痛点是 usage/别名与路由表重复、插件命令不可发现。若做：由 `DOMAIN_MODULES` 生成 help + 命令注册表类型化，2–3 天；**当前 YAGNI**，除非用户插件命令出现真实需求。
- **fork**（轴：fork）：vendor/cordis 4.0.5-alpha.2 的 fork 合理（R6 家族一致性）；不建议为「用满」扩大 fork 面。但桥已用 fork 内部 `fiber.collect`，而上游同步没有 API 面检查（R6 只看版本/upstream 基线）。建议 0.5 天护栏：把用到的 ctx API（plugin/inject/effect/on/emit）做一条上游 parity smoke，vendor 升级时先跑。**P2/P3**。
- **hmr** 见 §1.2；**group** 见 §1.1；**logger-console/loader/include** 不做。

## 5. 优先级清单（给发版席汇总）

| P | 项 | 轴 | 痛点 | 成本 |
|---|---|---|---|---|
| **P1** | 事件作用域化（EventService + 桥改 ctx.effect + 类型/隔离） | 事件 | 插件事件无作用域、监听器抛错静默丢事件、group 前置 | 2–4d |
| **P1** | 启动就绪去轮询/去兜底 | 作用域/生命周期 | 双开 DB 类 0.65 P0、时序赌注 | 0.5–1d |
| **P2** | 用户层配置 Schemastery 校验 + 启动诊断 | 配置 | 坏 JSON 静默禁用、config 错误延迟暴露 | 1–2d |
| **P2** | fork API 漂移护栏（上游 parity smoke） | fork | vendor 升级静默破桥 | 0.5d |
| **P3** | 命令注册表/help 生成 | 命令 | 982 行手写、usage 漂移；插件命令已可注册 | 2–3d（条件） |
| **P3** | hmr dev-only spike（先 loader/include dev harness） | 事件/生命周期 | 用户插件开发回环 | 3–4d（条件） |
| **P3** | group/子 Context（先事件 + D1–D5） | 作用域 | webui 请求级隔离 | 3–5d（条件） |
| **不做** | logger-console / loader / include / CLI 重写 | — | 无真实消费者或已被实证否决 | 0 |

**总账（P1+P2）**：4.5–7.5 天；P3 全部触发再加 8–12 天，不建议打包承诺。

## 6. 一句话给发版席

「三成功力」事实成立，但**收益不在接更多 vendor 件**：先做事件作用域化（2–4d）与启动就绪（0.5–1d），再把配置校验补上（1–2d）；hmr 因 loader/include 依赖应从「1–2 天第一优先」降为条件项，group 等 D1–D5，命令面不是 Cordis 短板。**不要为「用满」接 logger/loader/include。**
