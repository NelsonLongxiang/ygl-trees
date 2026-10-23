---
name: cordis-usage-architecture-eval
description: Cordis 框架使用面评估（group/hmr/logger-console/loader/include）——按 ygl-trees 真实痛点过滤 YAGNI
kind: 评审
---

# Cordis 使用面架构评估（2026-10-23）

> 触发：发版席转述外部评审「ygl-trees 只用了 cordis 三成功力」，并给出候选优先级（group/hmr/logger-console/loader/include）。
> 本报告**不照单全收**：逐项按「解决 ygl-trees 真实痛点」过滤，给出接/不接/缓接、理由、顺序与影响面。
> 结论对 R6（0.114.21）无冲突：扩展使用面仍在 engine 档，规则不需改。

## 0. 结论摘要

| 候选 | 结论 | 一句话理由 |
|---|---|---|
| **group / 子 Context 作用域** | **缓接（条件触发）** | 它隔离的是**服务图**，不隔离 R16 的「选择桶」（DB meta + 进程 env）；拿它治裸壳互扰是错配。仅当出现「每会话独立服务图/独立 DB 句柄」的真实需求再接。 |
| **hmr** | **缓接（先做 1–2 天 spike）** | 客户端已是 Vite HMR；服务端是一次性 CLI 进程，热替换收益只在长驻 `webui serve` + 用户插件开发回环，当前不是瓶颈。 |
| **logger-console** | **不接（YAGNI）** | 现有 `fmt` + `events` 表 + stderr 诊断已覆盖；没有分级/请求域日志的真实消费者。 |
| **loader** | **不接（已有实证 no-go）** | 0.40 探针：`lib/` 不暴露 `moduleNamespace`、运行时 specifier 会破坏 tsdown 单文件产物；R14 自研 profile-boot 已工作。 |
| **include** | **不接（YAGNI）** | 单应用、bundle 分层已由 base/user bundle + profile 实现；include 的嵌套叠加没有第二消费者。 |

「三成功力」**在事实面成立**：vendor 五件 0 import，事件面是自研 EventEmitter 桥而非 Cordis 事件主链，子 Context 嵌套未用于业务隔离。但「功力」不等于「收益」——本仓的真实痛点是 **R16 选择隔离**、单文件发布产物、CLI 一次性进程，不是服务图组合度。

## 1. 现状取证（可复核）

### 1.1 已用的 Cordis 面

- **core**：`vendor/cordis/src` 12 文件（context/service/fiber/events/registry/reflect/logger/utils…）。
- **3 个 Service**：`DatabaseService`（`packages/core/database/src/plugin.ts:21`）、`OpsService`（`packages/ops/tools/src/plugin.ts:25`）、`ResearchService`（`packages/research/pipeline/src/plugin.ts:16`）。
- **timer**：唯一启用的 vendor 插件（`apps/cli/src/bin.ts:16`；webui 心跳 `webui.ts:666/714`）。
- **ctx.emit 桥**：`DatabaseService.apply` 把内部 eventbus 的 `ygl` / `ygl:<kind>` 动态桥到 `ctx.emit`（`plugin.ts` apply 段），并用 `fiber.collect` 清理订阅。
- **生命周期**：`DatabaseService.stop()` 关 SQLite 句柄 + ORM（`plugin.ts`），这是 Cordis 生命周期承诺的真实使用。

### 1.2 未用的五件

`grep apps packages --include=*.ts "vendor/(loader|include|group|hmr|logger-console)"` → **0 命中**（timer 除外）。

### 1.3 事件面：自研桥，不是 Cordis 事件主链

`packages/core/text/src/eventbus.ts` 是**进程级 `EventEmitter` 单例**；写路径调用 `emitEvent()` 后，由 DatabaseService 桥到 `ctx.emit`。全仓 `emitEvent` 调用点 22 处。含义：

- 插件能 `ctx.on("ygl", …)`，但事件的**生产者不持有 ctx**（写服务在 core/research/techtree，拿不到 Context）；
- 单例事件总线与子 Context 作用域**天然不兼容**——就算引入 group，监听器仍共享同一个单例；要真正吃到「作用域事件」，先要把生产端改成 ctx 作用域，这比接 group 更靠底层。

### 1.4 R16 选择桶的真实机制（关键反证）

`packages/core/database/src/selection.ts`：

- 选择键是 **DB `meta` 表**里的 `current_project@<sid>` / `current_tree@<sid>`，`sid = YGL_SESSION || DSH_SESSION_ID || "default"`；
- 解析优先级 flag > env > session key > global key；`recordSelectionVia` 把 layer 写进**进程 env** `YGL_SELECTION_VIA`（文件内已注明：长驻 host 的并发请求会串味，需 request scope）。
- 因此「裸壳互扰」的根因是**没有会话身份**，两个进程都用 `default` 键；不是「共享了同一个 Cordis Context」。`job` 已用 `<parent>/<job>` 命名空间解决（`job-cmds.ts:170`）。

**推论**：子 Context 隔离对 R16 无效——除非把选择键也改成 per-Context（那是 DB/身份语义改动，属主 D1–D5 裁定面），而不是 Cordis 组合改动。

## 2. 逐项评估

### 2.1 group / 子 Context 作用域：缓接（条件触发）

**支持点**：子 Context 是 Cordis 的核心组合能力；长驻 `webui serve` 若未来按会话/请求隔离服务、或作业并行需要独立 DB 句柄/日志域，group 是正解。

**反方（当前）**：

1. **不治 R16**：选择在 DB meta + env，不在 Service 图；子 Context 不改变 `sessionId()`，也不隔离 `process.env.YGL_SELECTION_VIA`。
2. **与事件总线冲突**：eventbus 是进程单例，子 Context 的监听器仍共享同一总线；引入 group 前先要事件作用域化。
3. **成本**：Service 构造签名、锁策略（`.ygllock` 是进程级文件锁）、ORM 单例缓存（`ormState`）都假设单进程单图；per-context 隔离需要状态去单例化，影响面大于收益。
4. **观测已补**：0.114.22 的 `tree use`/写时刻/doctor 三面已把事故类变成「有声」；#44/#47 的观测绊线是**当前性价比最高的层**。

**条件触发（任一条成立再立项）**：

- webui HTTP 并发请求需要**请求级选择**（替代 process env `YGL_SELECTION_VIA`），且属主裁定走 Context 而不是 AsyncLocalStorage；
- 作业并行需要每作业独立 DB 句柄/插件实例（当前共享进程 + WAL 已够）；
- 用户插件要求 per-session 隔离（R14 深化）。

**若接**：先做事件作用域化（eventbus → ctx 事件）再拆子 Context，顺序不能反；且必须与 D1–D5 选择语义裁定同批，不能只改框架。

### 2.2 hmr：缓接（1–2 天 spike）

- 客户端：`apps/web/package.json` 的 `dev: vite`，**Vite HMR 已在**；cordis hmr 不服务前端。
- 服务端：CLI 是**一次性进程**（每次命令启动/退出），HMR 无对象；长驻的只有 `webui serve` 与 job runner。
- DSH 插件面验证过 hmr 价值，但 ygl 的用户插件（R14）是**启动时装载**（profile-boot），开发回环目前靠重启 `webui serve`；这是真实但**低频**的痛点。
- **spike 验收**：改 `ygl.user.bundle.json` 指向的插件源码 → `webui serve` 不重启即生效，且 SSE/定时器不丢；若 2 天内不能稳定，判 no-go。
- 风险：hmr 对 `vendor` 包的 `@deepseek-ai/*` 依赖解析、bundle 单文件入口、WAL 句柄生命周期都有耦合；仅限 dev（`YGL_DEV`）启用，绝不进发布路径。

### 2.3 logger-console：不接（YAGNI）

- 现有观测面：`events` 表（22 个 emit 点，doctor/patrol/观测序列消费）+ `fmt` 输出 + stderr note；发布产物单文件，日志没有独立消费者。
- 缺的是**请求域/分级**，而 `logger-console` 是控制台 logger 适配，不解决域问题；引入后还要决定 events 与 logger 的双写关系（重复/漂移）。
- 触发条件：出现「需要按级别过滤的长期运行服务日志」或「多租户请求日志隔离」；当前无。

### 2.4 loader：不接（已有实证）

`docs/plan-archive-2026-10-23.md` 的 0.40 记录（四轮探针）：

- loader **兼容**四种模块形态、config 透传/update 重配 OK；
- 但 ① 编译产物不暴露 `moduleNamespace`（源码有、`lib/` 无）→ 拿不到 `commands`；② 按 specifier 运行时导入 → tsdown 不可追踪 → **破坏 0.38 自包含单文件产物**；
- 结论「采纳能力不采纳机械」：用户层 bundle 支持 `config`/`enabled`，`plugin install` 自研实现已覆盖 R14。

**重开条件**：上游 loader 暴露静态可追踪的 module namespace，且 ygl 放弃单文件 bundle（本仓发布面红线，短期不会）。

### 2.5 include：不接（YAGNI）

- ygl 的层叠已由 `ygl.bundle.json`（base）+ `$YGL_HOME/ygl.user.bundle.json`（user）+ profile 完成；`include` 的嵌套 include 是给多 profile 组合用的，当前没有第二层配置源。
- 触发条件：出现「多环境 profile 共享片段」的真实需求（目前 profile 是单文件声明）。

## 3. 建议顺序与影响面（若全部立项）

1. **hmr spike（dev-only）**——低风险、可独立回滚；只动 `webui serve` dev 路径 + 用户插件装载；验收见 §2.2。
2. **事件作用域化（前置基建）**——把 `emitEvent` 的生产端逐步改为持有 ctx 的路径，或提供 ctx 绑定适配层；这是 group 的前置，不是新包。
3. **group / 子 Context（与 D1–D5 同批）**——只做 webui 请求级/作业级隔离；需 D 项裁定 + 锁/ORM 去单例化评估；影响 R16 语义、测试面（选择/并发）、bundle 体积（ratchet 认账）。
4. **logger-console**——只有 §2.3 触发条件成立才做；否则不做。
5. loader/include——不做；重开条件见 §2.4/§2.5。

**与 R6 的关系**：R6 engine 档只要求 vendor 家族 `workspace:~`、bundle 四插件顺序、服务锚、上游基线+fork 后缀；新增使用面不改变这些判据。若引入 hmr/loader 作为**运行时插件**，需同步 R6 的 bundle 校验口径（否则 R6 会红）——这是接任何新 vendor 插件的**前置检查**，不是事后补。

## 4. 明确不做的事（YAGNI 清单）

- 不为「用满 Cordis」而接 loader/include/logger-console；
- 不用子 Context 替代会话身份（裸壳问题应通过 `YGL_SESSION`/显式 `-p/-t`/写时刻告警解决，0.114.22 已落）；
- 不把 hmr 带进发布产物（仅 dev 开关）；
- 不在 group 之前改选择键语义（顺序反了会把观测绊线也拆掉）。

## 5. 给发版席/属主的一句话

「三成功力」属实，但**当前短板不是 Cordis 组合度，而是会话身份与事件作用域**：前者已用 0.114.22 的观测面兜住，后者才是接 group 前真正的基建。建议先批准 hmr spike（dev-only、低风险），group 等 D 项裁定与事件作用域化同批；loader/include/logger-console 维持不接。
