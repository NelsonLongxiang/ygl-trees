---
name: project-selection-review
description: 「为何一定要 project use 才能关联数据？」——项目选择机制（spec R16）的现状评审：哪些命令真需要选择、哪些只是摩擦、default 桶的残余风险，以及待属主裁定的方向
kind: 评审
---

# 项目选择机制评审：为何一定要 `project use`？（方案）

> 评审席 Claude-OPS-5.5 · 2026-10-22 · 基线：ygl-trees `5919127`（0.114.6）。
> 依据：用户 2026-10-22 提问「为何一定要使用 ygl-trees project use？才可关联数据？」。
> 实测缺陷另见 issue #44（F1–F3）。本文只评审与建议，不改代码；结论须属主裁定。

## 0. 结论

1. **`project use` 并不是必需的。** 授权项目作用域命令的有四条路：
   - `-p/--project`
   - `YGL_PROJECT`
   - 会话键
   - 单项目工作区自动命中

   0.87.0 的属主裁定（m07308，2026-10-18）把显式 `--project` 排在第一推荐（「环境变量不保险，显式指定最重要」）。
2. **用户会以为它是必需的，原因在可发现性：**
   - `--help` 全文没有一处提到 `-p/--project` 或 `YGL_PROJECT`，全局选项只列了 `--json --no-color --db --home`；
   - `project new` 的帮助写的是「create + select」；
   - 技能与 README 教的主路径也是 `project new/use`。
3. **对「关联数据」这件事，选择基本是纯摩擦：**
   - `claim link` 要求先有一个选择，拿到后却不使用它，任何项目都能放行跨项目关联（#44 F2）；
   - `rel add` 根本不要求选择。

   真正需要选择的，只有**创建类**命令（`claim add` / `source add` / `task add` / `produce *`）：参数里没有任何东西能指明数据该落在哪个项目。
4. **真正的风险不在「没选」，而在「被别人改了选择」。** 所有没有会话标识的进程（包括本机并行的多个 Claude 会话）共用一个 `default` 桶。任何一个进程 `project new`，其他进程下一次裸写就会 rc=0 落进新项目；`--json` 模式下没有任何信号（#44 F1）。这正是大家「每次都得先 `project use` 一下才放心」的真实来由：防的是被人改过的指针。

## 1. 输入与方法

- 读了 spec R16（`docs/spec.md:169-178`）、`plan.md` 0.85 裁决记录（第 7–9 行）与 0.106.0 记录（「default 桶」残余洞）、`CHANGELOG-archive` 0.83/0.85/0.87.0（m07308）、`selection.ts` 全文、`pipeline/src/cmds.ts` 入口门禁与各个按 id 寻址的子命令、`project-cmds.ts`。
- 在空 `YGL_HOME`、未设 `YGL_SESSION`/`DSH_SESSION_ID`/`YGL_PROJECT` 的环境下逐条实测，退出码直接读取。复现命令见 #44。

## 2. 为什么会有「选择」：历史与设计意图

| 时间 | 事件 | 处置 |
|---|---|---|
| 0.76 / 0.79 / 0.83 | 三次写错项目：全局 `current_project` 是共享可变指针，被并行会话互相覆盖 | 0.83：写命令可内联 `--project` 钉住（治标） |
| 0.85（R16，属主 10-17 裁定「读写都 fail-closed」） | 根因判为「选择分辨率缺失 + 旁路直读」 | 解析链 flag > env > 会话键 > 全局键；全局键不再授权；多项目且未选择 → rc=2 |
| 0.87.0（m07308） | 裸 shell 并行终端互踩 `default` 桶 | `project use` 在 sid=default 时打非阻断提示（**仅人类模式**），第一推荐 `--project` |
| 0.106.0 | K3：「8 个 verifier 节点落错树」→ 两个残余洞：`default` 桶、worker 粒度 | worker 注入 `YGL_SESSION=<parent>/<job>`；`doctor` 加 `session_identity` 警告；**`default` 桶只给了警告，未封堵** |

数据模型上，`claims / evidence / sources / artifacts` 都带 `project_id NOT NULL`。研究管线以项目为分区单位，所以创建一条数据必须知道它落在哪个项目。这是「选择」存在的正当理由。

## 3. 现状评审

### 3.1 各类命令对选择的真实依赖（实测）

| 类别 | 例子 | 参数能否确定项目 | 现行要求 | 评估 |
|---|---|---|---|---|
| 创建 | `claim add`、`source add`、`task add`、`produce outline` | 否 | 多项目时必须有选择（rc=2） | **必要**：没有选择就不知道写到哪 |
| 按 id 写 | `claim link <c> <e>` | 是（id 全局唯一） | 要求有选择，**但不使用**：`-p` 指向两端都不属于的项目也 rc=0 | **纯摩擦**（#44 F2） |
| 按 id 写 | `claim resolve/unresolve/unlink`、`evidence add <source>` | 是 | 要求有选择且必须匹配；拒绝时不说归属 | 摩擦，且报错不点名出路（#44 F3） |
| 按 id 读 | `claim show`、`evidence show` | 是 | 必须匹配；拒绝时点名归属（`use -p p1`） | 摩擦，但出路清楚 |
| 按 id 读 | `source show` | 是 | **不检查** | 与 R16.3「读写都 fail-closed」矛盾（#44 F3） |
| 工作区级 | `rel add claim:<id> evidence:<id>` | 是 | **不要求选择**（R16.3 豁免） | 关联本可以不用选择，这里就是反证 |

**[E] 关键事实：** 同样是「把一个 claim 和一条 evidence 关联起来」，`rel add` 零门槛，`claim link` 必须先选一个与两端无关的项目才放行。用户问的「为何一定要 project use 才可关联数据」，在 `claim link` 上答案是「没有理由」。

### 3.2 `default` 桶：选择被别人改掉（#44 F1）

- `sessionId()` = `YGL_SESSION || DSH_SESSION_ID || "default"`。本机的 Claude Code 会话不导出这两个变量，因此全部落进 `current_project@default`。
- `project new <名>` 默认写入当前会话键；`project new <已存在名>` 走 duplicate 分支，**同样写入**。在 `default` 桶里，这等于改写所有无会话进程的选择。
- 提示只在人类模式出现：`project new` 打印「prior project … no longer selected」，`project use` 打印「shells without a session id share one default selection」。Agent 一律用 `--json`，返回里没有 `selected` / `prior` 字段，也没有警告。
- `doctor` 的 `session_identity` 会 WARN，但写路径上没有任何闸。
- 评审席 2026-10-21 实际踩过一次：在台账上 `project new` 改掉了他席的选择，导致他席 webui 验证 FAIL。此后本席每次台账写入后都要手工 `project use webui-redesign` 恢复。

### 3.3 可发现性

| 位置 | 是否出现 `-p/--project` / `YGL_PROJECT` |
|---|---|
| `ygl-trees --help` 全局选项 | 否（只有 `--json --no-color --db --home`） |
| `research` / `produce` / `task` 帮助行 | 否 |
| `project` 帮助 | 否；`new` 写「create + select」 |
| rc=2 报错文本 | 是（「pass --project <name> or run project use」） |
| `skills/ygl-trees-quickstart` | 是（0.83 / 0.85 条目），但写在版本历史段落里 |

用户只有先撞上 rc=2，才会知道 `--project` 的存在。

## 4. 方向（待属主裁定）

| # | 事项 | 选项 | 本席建议 |
|---|---|---|---|
| D1 | 按 id 寻址的命令（link / resolve / unresolve / unlink / show / `evidence add <source>`）是否还要选择 | (a) 保持作用域过滤，但所有拒绝都点名归属项目；(b) **从 id 推导项目**：多项目门禁对这类命令豁免，跨项目时（如 claim 与 evidence 分属两个项目）要求显式 `--cross-project`，或沿用现有的 `cross_project` 提示 | (b)。id 本身已唯一确定项目，选择在这里只拦人、不防错；真正需要防的是跨项目，应该单独显式化。此项部分推翻 10-17「读写都 fail-closed」在 id 类命令上的适用范围，须属主裁定 |
| D2 | `default` 桶的会话键能否授权写入 | (a) 维持现状，只加信号（`--json` 返回 `selected/prior/session` 与警告字段）；(b) 多项目工作区里，`default` 桶视同全局键：不授权，必须 `-p`、`YGL_PROJECT` 或真实会话 id | 至少 (a)；(b) 能彻底封住第四次写错项目，代价是裸 shell 多打一个 `-p`，与 m07308「显式指定最重要」一致 |
| D3 | `project new` 是否自动选中 | (a) 维持「创建并选中」；(b) 在 `default` 桶里只创建、不选中；(c) 一律只创建 | (b)：有真实会话 id 时保留便利，共享桶里不再动别人的指针 |
| D4 | 可发现性 | 全局选项与 research / produce / task 帮助列出 `-p/--project` 和 `YGL_PROJECT`；技能把「`-p` 钉住」写成 Agent 主路径，`project use` 降为交互便利 | 直接做，不涉及契约 |
| D5 | `source show` 不检查作用域、`claim link` 与 R16.3 原文不符 | 按 D1 的结论统一，并同步改 spec R16.3 原文 | 随 D1 |

D4 不改变行为，可以先行。D1–D3 会改变行为（rc 或默认语义），属于契约面变化：需要 CHANGELOG 升级说明，并补 `contract:audit` 断言。

## 5. 对用户问题的直接回答

- **「为什么要选择？」** 研究数据按项目分区，而创建命令的参数里没有项目信息。三次写错项目之后，R16 改为没选就拒绝。
- **「为什么非得 `project use`？」** 并非如此：`-p <项目>`、`YGL_PROJECT=<项目>` 都可以，而且属主裁定把 `-p` 排在第一推荐。问题出在帮助里看不到这些。
- **「关联数据为什么也要？」**
  - `rel add` 不要。
  - `claim link` 要，但只是走个门禁，选的是什么并不影响结果（#44 F2）。这是该收掉的摩擦。
- **「为什么总觉得要先 `use` 一下才放心？」** 因为共享的 `default` 桶会被其他会话改写，而 `--json` 下看不到任何信号（#44 F1）。这才是该修的风险。

## 6. 评审席的复核方式

- #44 的修复发布后，从 npm 包复跑 #44 的三组复现。
- 并行进程实验：一个进程 `project new`，另一个进程随即裸写。按 D2/D3 的结论，应得到拒绝或带信号的结果，不允许静默 rc=0。
- 帮助文本 grep：`-p/--project` 与 `YGL_PROJECT` 出现在全局选项里。
- `contract:audit` 新增断言条数与 rc 逐条核对。
