---
name: verifier-pack-plan
description: 把稳定钉住的验证器打包成可组合的「验证器包」——按领域 / 业务范围 / 工作流命名与标记，由预设工作流模式组合成新的工作流；现状评审、边界、命名模块、预设模式与分期日程
kind: 评审
---

# 验证器包：命名、标记与工作流组合（方案）

> 评审席 Claude-OPS-5.5 · 2026-10-22 · 基线：ygl-trees `a66d3c0`（0.114.14 源码；npm 0.114.13）＋ 舰队 9 个验证器仓库。
> 依据：用户 2026-10-22 提出的架构方向——「把稳定钉住的验证器版本做成插件集合，根据领域、业务范围或者工作流进行打包封装为独立 ygl-trees 插件……验证器可以根据需要组合成全新的工作流……最基础的我们需要一个验证器集合模块负责命名与标记以及工作流运作方式，就是预设的几种模式可以跟什么业务结合」。
> 承接：`verifier-sdk-plan.md`（SDK-0..5）、`verifier-production-line-plan.md`（§5 未裁定）、charter §4.7。
> **本文只是方案：D1–D6 由属主裁定，什么都没有排期。**

## 0. 结论

1. **方向成立，舰队已经在手工做这件事。**
   - 9 个验证器仓库各自用约 1.1–1.8 千行编排脚本，把「规格 + 数据绑定 + 树」拼成工作流，合计约 1.19 万行。
   - 同一个概念被各仓重复书写：例如每个仓库都有 4 条判据的 `aggregate` 规格，却分化成 6 种文本（§2 F2）。
   - 缺的正是用户说的那一层：可命名、可标记、可钉版、可组合的单元。
2. **单元应该是「验证器包」（verifier pack），并且是纯数据，不能是代码插件。** R14 用户插件以进程全权限执行 `apply` / `commands`，与 charter P1（CLI 唯一执行面）、P2（禁止临时编码执行）、P4（判据语言封闭）直接冲突。所以：
   - 包里只有冻结的规格、绑定接口、树模板、夹具和清单，执行永远由 `verify` 命令完成；
   - 分发可以复用插件 / npm 通道，但加载方式是读数据，不是 `require`。
3. **组合的公式是：规格（模板）× 绑定（数据从哪来）= 节点；节点 + 预设模式 = 工作流。** 舰队里已经有现成的例证：
   - webui 验证器里，一份 `view` 规格挂在 6 个节点上；
   - 舰队聚合仓库里，一份 `member` 规格挂在 7 个成员上。
4. **「验证器集合模块」的职责是三件事：命名、标记、模式。** 详见 §4。
   - 命名：`ygl-v-<name>@<semver>`（第三方 `@<scope>/ygl-v-<name>`），并钉住其中每份规格的 `spec_id@spec_version` + sha256 和引擎版本。
   - 标记：三条轴，领域 / 业务范围 / 工作流模式；只有模式轴是受控词表。
   - 模式：6 种预设，见 §5，每种都已经在舰队里跑过。
5. **最大的前置依赖是 `verify tree run`（SDK-2）。** 没有它，组合只能继续靠每仓的编排代码。本方案的分期（§6）因此排在 SDK 路线之上，而不是另起一条线。

## 1. 输入与方法

- 读了 R14 用户插件契约（`docs/plugin-authoring.md`）、charter §0 / §4.7、SDK 方案、生产线方案 §5，以及 `verify export`、`yglverify seal`、`verify register` / `signature`、`report import` 的现有行为。
- 盘点了 9 个验证器仓库（引擎钉版、编排行数、树节点、规格清单、`aggregate` 判据文本），计数可复跑。
- 实测：`verify export <spec>` 产出 `.yglverify.json`（键：`contract_version / spec_id / spec_version / title / domain / runtime_min / verifier / as_of / vu / attachments / sealed / materials_sha256`）。这就是「稳定钉住的验证器」现成的可移植形态。

## 2. 现状评审

### F1 已有的零件：冻结、可移植、可签名，但不能组合

| 零件 | 现状 | 对验证器包的意义 |
|---|---|---|
| 冻结规格 | `prepare` → `spec_id` + 只增的 `spec_version`；`verify export` → `.yglverify.json` | 包内最小单元，天然钉版 |
| 封包与签名 | `yglverify seal` → 单二进制 + ed25519 footer；`verify register` / `signature` 认表不认报文 | 第三方包的信任链已经具备 |
| 外部报告导入 | `report import <report.json>`（payload / binary / version 校验） | 跨包结果引用的雏形 |
| 准入 | `verify meta`（R1/R2/R3/R5a） | 每个包本身就该是一个过 meta 的验证器 |
| 插件分发 | `plugin install` / `ygl.user.bundle.json`（npm 包、git 地址、本地目录） | 分发通道可复用，**加载语义不可复用**（见 F3） |

缺的是组合层：树、绑定、聚合、命名。charter §4.7 的 `tree run` / `snapshot build` / `collect` / `import-report` 全部还是 `unshipped`。

### F2 舰队证据：同一概念被各仓手工重写

| 仓库 | 引擎 | 编排 + 工具（行） | 树节点 | 规格 |
|---|---|---|---|---|
| ygl-review-verifier | 0.114.13 | 1,232 | 9 | aggregate, contract, issues, ledger, prs, releases, sync |
| ygl-webui-verifier | 0.114.13 | 1,458 | 15 | aggregate, api, bundle, tokens, unit, view（×6 节点） |
| ygl-fleet-verifier | 0.114.13 | 722 | — | aggregate, member（×7 成员） |
| ygl-design-verifier | 0.114.13 | 1,729 | 13 | aggregate, artifact, chart, lint, literals, pairs, refs, solid, sync |
| a2a-net-verifier | 0.114.13 | 1,476 | 11 | aggregate, build, deps, mesh, nexus, release, runtime, unit, wire |
| a2a-frontend-verifier | 0.114.13 | 1,101 | 9 | aggregate, board-theme, first-run, header, module-size, nexus, tokens |
| workbench-market-review-verifier | 0.114.13 | 1,779 | 18 | aggregate + 11 个领域规格 |
| ygl-issue27-verifier | 0.114.13 | 1,079 | 6 | aggregate, docs, gates, merge, plan |
| ygl-taste-pilot-verifier | 0.114.9 | 1,282 | 4 | aggregate, ledger, service, statistics |

- **`aggregate` 规格在 9 个仓库各写了一遍。**
  - 4 条判据 G1–G4 的含义完全相同：子节点全 PASS、归档自校验通过、同一轮测量、非空。
  - 文本却分成 6 个变体（material.md 的 sha256 前 12 位：`5980ca89ebc7`×3、`26dea283b79f`×2，另有 4 个各 1 份），差别集中在 G3 的措辞。
  - 这正是命名模块要解决的问题：同一个验证器需要一个名字和一个版本，而不是 6 份抄本。
- **规格复用已经存在，但只在仓内。** webui 的 `view` 规格挂 6 个节点，舰队的 `member` 规格挂 7 个成员。也就是说，「规格 × 绑定 = 节点」在实践中成立，只是没有跨仓、带版本的名字。
- **钉版一致性靠人工维护。** 今天 9 仓中 8 仓在 0.114.13，taste-pilot 在 0.114.9，靠舰队 M9 规则人工对齐。包清单应该把引擎版本写进身份。

### F3 为什么不能直接做成 R14 代码插件

| R14 插件能力 | 与 charter 的关系 |
|---|---|
| `apply(ctx, config)` 以进程全权限执行 | 包内代码即「为完成验证现场写代码」→ 违反 P2 |
| `commands` 贡献命令组 | 第二个执行入口 → 违反 P1 |
| 可在 `apply` 里读写数据库、改判定 | 第二个判定层 → 违反 P4 |

所以验证器包必须是**纯数据**：引擎读清单，执行用的都是已有的 `verify` 动词。代码只允许出现在 charter v1.1 的过渡例外里（登记、只经 CLI、带 `sunset`），而且不随包分发。

### F4 命名与标记的现状

- `spec_id` 是哈希式的不透明标识（如 `spec_ae877807ced2`），没有可读名，也没有版本语义。`spec_version` 只在同一 id 内单调递增。
- 规格里的 `domain` 是自由字符串，各仓自定，例如 `review.releases`、`webui`。
- 没有标签字段，也没有目录命令。`verify list` 只列本地工作区的规格。
- 建议：**命名和标记放在包清单里，不进规格契约**。这样不必升 `contract_version`，P4 不受影响。规格本身保持冻结，清单只是引用它（`spec_id@spec_version` + sha256）。

## 3. 边界

**是**：
- 一个可命名、可标记、可钉版、可签名的**数据包**；
- 一组**预设工作流模式**（树模板 + 运行节奏 + 放行规则）；
- 一个在本地工作区里登记包的**目录**。

**不是**：
- 可执行插件，也不是第二个执行面；
- 新的判据语言，也不是第二个判定层；
- 舰队专用的脚本库。

**不变的**：
- 判定唯一出自 `verify run`；
- 证据仍是 report + archive + payload_sha256 + 签名链（P5）；
- 每个包本身必须先过 `verify meta`（P3）。

## 4. 验证器集合模块：命名、标记、模式

### 4.1 包清单（建议形状，`ygl-verifier-pack/1`）

```json
{
  "pack": "ygl-v-core-aggregate",
  "version": "1.0.0",
  "engine": "0.114.13",
  "contract_version": "1.2",
  "tags": {
    "domain": ["verification-infra"],
    "business": ["any"],
    "mode": ["tree"]
  },
  "specs": [
    { "name": "aggregate", "spec_id": "spec_…", "spec_version": 6, "sha256": "…",
      "requires": { "tables": { "children": ["overall", "archive_ok", "target_sha", "round_sha"] } } }
  ],
  "nodes": [ { "id": "group", "spec": "aggregate", "binding": "children-of(<node>)" } ],
  "fixtures": { "good": "fixtures/good.sqlite", "bad": ["fixtures/g1-red.sqlite"] },
  "signature": { "key_id": "…", "footer": "…" }
}
```

- **名字**（用户 2026-10-22 定：最低要有前置 `ygl-v-*`）：包名一律以 **`ygl-v-`** 开头，包身份 = npm 包名，不另设映射。
  - 官方 / 舰队包：`ygl-v-<name>`，例：`ygl-v-core-aggregate`、`ygl-v-pr-gate`、`ygl-v-release-audit`。
  - 第三方包：`@<scope>/ygl-v-<name>`，前缀照样保留。
  - 前缀是硬规则：`pack lint` 拒绝不带前缀的包名（rc=2）；`pack list` 也按前缀发现已装的包，与 `eslint-plugin-*` 一样，前缀即类别。
  - 2026-10-22 查询 npm：`ygl-v-*` 下没有任何已发布的包，`ygl-v-core-aggregate`、`ygl-v-pr-gate`、`ygl-v-release-audit` 均未被占用。
  - 包版本的规则：
    - 改判据材料 → 升 major；
    - 加节点或规格 → 升 minor；
    - 只换夹具或文档 → 升 patch。
- **钉版**：清单写死引擎版本和每份规格的 `spec_id@spec_version` + sha256。装包时逐一核对，不符即拒。
- **接口**：`requires` 声明每份规格需要哪些快照表和列。这就是「绑定」的契约：谁提供这些表，谁就能用这个包。在 `snapshot build` / `collect` 交付之前，数据由使用方自己准备。

### 4.2 三条标记轴

| 轴 | 词表 | 用途 |
|---|---|---|
| 领域 `domain` | 登记式开放词表（例：`release-eng`、`frontend`、`finance`、`content`） | 按专业领域查找 |
| 业务范围 `business` | 登记式开放词表（例：`pr-review`、`monthly-close`、`vendor-onboarding`） | 按业务场景查找 |
| 工作流模式 `mode` | **受控词表**，即 §5 的 6 种预设 | 决定这个包能被怎样运行和组合 |

模式轴必须受控。它决定运行语义（门禁要 rc，巡检要节奏，聚合要子报告），可以由引擎检查；另外两条轴只用于检索，不影响执行。

### 4.3 目录命令（建议）

`verify pack build | lint | install | list [--tag k=v] | show | verify`：
- `pack lint` 是包的一致性套件：清单校验、meta PASS、夹具「好的全绿、坏的只翻对应叶子」、规格在钉定引擎上能 prepare 到 ready。也就是评审席这一轮对 0.114.9 / 0.114.13 做的 15 份规格预检，固化成一条命令。
- `pack install` 走现有插件通道，但只读数据，不执行任何 `apply`。

### 4.4 安装与激活：项目根 `.ygl-trees/plugins` + 全局 CLI（用户 2026-10-22 定方向）

用户方向：「目前 ygl-trees 还是 CLI 为主，通过项目根目录 `.ygl-trees/plugins` 进行安装与识别，全局 ygl-trees CLI 激活子命令」。

**现状（`a66d3c0`）**，与这个方向有三处差距：
- 插件装在 `$YGL_HOME/plugins`（`plugins.ts:49 profileDir(home)`），默认是 `~/.ygl-trees/plugins`，属于**用户级**目录，不是项目级；
- 用户层声明在 `$YGL_HOME/ygl.user.bundle.json`；
- 没有从 cwd 向上找项目根 `.ygl-trees/` 的发现逻辑。唯一和 cwd 有关的，是 `repoRoot()` 在 cwd 找 `ygl.bundle.json`（`bin.ts:55-61`）。

**建议的模型**：
1. **项目层**：`<项目根>/.ygl-trees/plugins/` 是一个 npm / pnpm profile，形状与今天的用户层 profile 相同。
   - `package.json` 和锁文件入 git，`node_modules/` 不入 git。
   - 加载顺序：base bundle → 用户层（`$YGL_HOME`）→ 项目层。后者叠在前者之上，与今天的 DSH user-layer 叠加同一语义。
2. **发现规则**：从 cwd 向上找最近的 `.ygl-trees/plugins/`，走到 git 根为止。这与 #25 ③ `verify meta` 的仓库根判定同一规则：git 内只认索引或 git 根。
3. **激活子命令**：全局 CLI 启动时，扫描项目层里 `ygl-v-*` 前缀的包，读清单里声明的命令，例如：
   ```json
   "commands": { "pr-gate": { "mode": "gate", "tree": "trees/pr-gate.json" } }
   ```
   然后注册成子命令，如 `ygl-trees pr-gate`，或统一挂在 `ygl-trees v <命令>` 下。
   - **子命令的执行体是内建的模式运行器（`verify` 动词），不是包里的代码**，与 D1 纯数据一致；
   - 包清单里不能出现 `apply` / `commands.run` 这类可执行入口，`pack lint` 拒绝。
4. **版本委派**：全局 CLI 的版本不一定等于包钉定的引擎版本。
   - 规则：项目层有 `node_modules/ygl-trees@<钉定版本>` 时，委派给它执行，与 jest / eslint 的全局命令优先用项目本地安装同一做法；
   - 没有时拒绝（rc=1），并点名 `npx ygl-trees@<钉定版本>`。
   - 舰队今天就是每仓 `node_modules` 精确钉版（M9），这条规则让「全局 CLI 激活」不破坏钉版。
5. **信任**：全局 CLI 在 cd 进别人的仓库时自动激活项目层，等于新的供应链入口，与 git hooks 同类风险。
   - 项目层首次激活前需要显式 `ygl-trees plugin trust`：信任记录存在 `$YGL_HOME`，键为项目路径 + 锁文件哈希，锁文件一变就要重新信任；
   - 第三方包还要过签名（D5）。

**工作区数据库放哪里**：项目根 `.ygl-trees/` 只放插件，还是同时做工作区（数据库）？
- 本席建议**只放插件**，数据库仍在 `$YGL_HOME`；
- 依据：`kb add` 的真实用户事故（「三次写入返回成功、读不回」）根因正是工作区分裂（`skills/src/cmds.ts:48-51` 注释），而 #44 / #51 也都出在多处共享与选择上；
- 是否让项目根成为独立工作区，列为 D7 由属主裁定。

### 4.5 项目根工作流文件：持久化节点、连线与接面（用户 2026-10-22：「就像 ComfyUI」）

用户方向：项目根目录跟随一份文件，持久化工作流、连接与接面，像 ComfyUI 的工作流文件一样。

**格式建议用 JSON，不用 YAML。** 依据（`a66d3c0` 实测）：
- 仓库里所有组合与契约文件都是 JSON：`ygl.bundle.json`、`ygl.user.bundle.json`、`verify/meta.json`、规格 `.yglverify.json`、舰队 `tree.json`；
- 仓库里没有一份 YAML 配置文件，也没有 YAML 解析依赖；
- 这份文件要被哈希、被钉版、被 JSON Schema 校验，还要由 CLI 和 webui 机器写回。JSON 有确定的规范化写法，和 `canon()` 与 sha256 登记的现有做法一致；YAML 有锚点、隐式类型（`no` → false 这类）和注释，同一语义能写出多种字节。
- ComfyUI 自己的工作流文件也是 JSON。
- 想要可读性的话，人可以写 YAML 草稿，再由 `ygl-trees v import` 转成规范 JSON；入库和被执行的只认 JSON。

**文件位置**：
- 单文件：`<项目根>/.ygl-trees.json`，与 `.ygl-trees/plugins/` 并列；
- 或者每个工作流一份：`<项目根>/.ygl-trees/workflows/<名字>.json`，像 ComfyUI 一张图一个文件。
- 本席建议后者，多个工作流互不干扰。由 D11 裁定。

**图模型**（对照 ComfyUI 的 nodes / links / widgets，建议 `ygl-workflow/1`）：

```json
{
  "format": "ygl-workflow/1",
  "name": "pr-gate",
  "mode": "gate",
  "engine": "0.114.14",
  "packs": { "ygl-v-core-aggregate": "1.0.0", "ygl-v-release-audit": "1.0.0" },
  "nodes": [
    { "id": "rel",  "pack": "ygl-v-release-audit",  "spec": "releases" },
    { "id": "root", "pack": "ygl-v-core-aggregate", "spec": "aggregate" }
  ],
  "sources": [
    { "id": "rel-data", "kind": "snapshot", "path": "work/snap/releases.sqlite" }
  ],
  "links": [
    { "from": "rel-data",   "to": "rel.in.releases" },
    { "from": "rel.report", "to": "root.in.children" }
  ],
  "ui": { "rel": { "x": 120, "y": 80 }, "root": { "x": 420, "y": 80 } }
}
```

- **接面（端口）**：
  - 节点的输入端口就是包清单里规格的 `requires`（表 + 列），例如 `rel.in.releases`；
  - 输出端口是报告：`overall` / `run_id` / `payload_sha256` / 归档；
  - 组节点的 `children` 输入由子节点报告自动拼成。今天这一步由各仓编排手写，SDK-2 `tree run` 交付后由引擎内建。
- **连线类型检查**：连线两端的表名和列必须对上，否则 rc=2，并点名缺哪张表、哪一列。这就是 ComfyUI「插槽类型不匹配不能连」的同一规则，在这里是静态可查的。
- **语义与布局分离**：`ui` 块只存画布坐标，不参与哈希、不参与执行。工作流的 sha256 只算除 `ui` 外的规范化内容。对照 ComfyUI 的 UI 格式与 API 格式两分。
- **与已有面衔接**：
  - §4.4 的全局 CLI 子命令，从这里的 `name` 与 `mode` 注册，例如 `ygl-trees v run pr-gate`；
  - webui 已经在用 `@xyflow/react`（`apps/web/package.json`，spec R13.5 树视图），可以直接长成 ComfyUI 式的图编辑器，编辑结果写回同一份 JSON；
  - 文件纳入 D8 的信任键（路径 + 锁文件 + 工作流哈希）。
- **边界不变**：文件里只有引用和连线，没有判据、没有代码、没有 shell。判定仍然唯一出自 `verify run`，满足 P1 / P2 / P4。

## 5. 预设工作流模式：每种都已在舰队里跑过

| 模式 | 运行语义 | 舰队里的现成实例 | 可结合的业务（例） |
|---|---|---|---|
| **gate 门禁** | 被验对象（提交、PR、产物）一次性跑；根 PASS 才放行 | webui 验证器：PR 的精确 tip 根 PASS 后才登记合并（`pr-verifications.json`） | PR 评审、上线审批、供应商准入 |
| **patrol 巡检** | 按节奏重复跑同一快照源；违规进处置队列 | `verify graduate --schedule` + `patrol`（0.93 / 0.103 落地） | 月结对账（sql-pair）、数据质量、合规巡检 |
| **tree 递归聚合** | 后序遍历，组节点聚合子报告 | 每仓的 `aggregate` 组节点；舰队仓库聚合 7 个成员 | 多部门联合验收、集团汇总 |
| **release 发布审计** | 跨源核对发布序（源码 → 标签 → 制品） | 评审验证器的 `releases` 叶（R1–R6） | 软件发布、合同版本归档 |
| **construct 构造自证** | 冻结前核对「材料条款 ↔ 候选判据 ↔ 盲审」一一对应 | `tools/check-construction.mjs` + #34 反例 | 任何新领域规范的首次落地 |
| **loop 判断闭环** | 案例 → 统计 → 认定 → 冻结 → 执行 → 推翻回流 → 新规格 | #27 taste-pilot（六轮实证：推翻 → 新规格 → 登记） | 品味 / 专业判断的沉淀（`taste-extraction-plan.md`） |

- 组合规则：一个工作流 = 一棵树，叶子来自一个或多个包的节点，组节点的语义由模式决定。
- 例：「发布审批」= gate(根) ← { release 包的 R1–R6、frontend 包的 view 节点、ygl-v-core-aggregate }。
- 「时空可组合性」：
  - **空间**：同一个包可以在多棵树里绑定不同数据（规格 × 绑定）；每棵树有自己的工作区，与今天舰队成员各用自己的 `state/home` 一致。
  - **时间**：包和引擎精确钉版，规格的 `as_of`、`supersedes` 与谱系（#27 的推翻回流），加上升级时的 A/B 并跑（SDK 方案的 K 轮一致）。

## 6. 分期日程（建议，挂在 SDK 路线上）

| 期 | 内容 | 验收 | 依赖 |
|---|---|---|---|
| **VP-0 裁定与命名** | 属主裁定 D1–D6；发布 `ygl-verifier-pack/1` 清单 JSON Schema、模式词表、领域与业务的登记表；不写代码 | 文档 PR 合入；schema 进包内 `schemas/` | — |
| **VP-1 `pack build / lint`** | 从一个验证器仓库产出确定性包（复用归档的确定性 zip）；`lint` = 一致性套件 | 对 `ygl-v-core-aggregate` 两次 build 字节相同；夹具「好全绿、坏只翻对应叶子」；坏清单 rc=2 | SDK-0（契约与 schema） |
| **VP-2 `pack install / list / show` + 项目层激活** | 装进项目根 `.ygl-trees/plugins`；从 cwd 向上发现；`plugin trust`；全局 CLI 按清单 `commands` 注册子命令（执行体为内建模式运行器）；版本委派；核对钉版与签名；按标签检索 | 钉版或 sha 不符时拒装 rc=1；未 trust 的项目层不激活；钉定版本不在时拒绝并点名 `npx`；`list --tag mode=gate` 只列门禁包；装包不执行任何代码（grep 装包路径无 `require`） | VP-1、签名（已有） |
| **VP-3 模式即树模板** | 6 种模式各出一个模板；工作流 = 项目根 `ygl-workflow/1` 文件（节点 + 接面 + 连线，§4.5）；连线类型检查；webui xyflow 图编辑器读写同一文件 | 评审验证器改由「ygl-v-release-audit + ygl-v-core-aggregate + 本仓叶子」组成，A/B 连续 K 轮根结论、叶子结论一致 | **SDK-2 `tree run`** |
| **VP-4 跨包与跨仓** | 组节点引用外部包的报告（payload_sha256 验签、验归档、时效） | 舰队聚合仓库改用包 + `import-report`，`ledger.mjs` 退场 | SDK-5 `import-report` |

首个试点建议用 `ygl-v-core-aggregate`：
- 9 个仓库都在用；
- 判据只有 4 条；
- 收敛 6 种抄本本身就是可量化的收益（6 → 1）。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 包被当成代码插件来写（P1/P2/P4） | VP-2 验收「装包不执行代码」；`pack lint` 拒绝包内出现 `*.js` / `*.mjs` |
| 钉版漂移：包对 0.114.13 冻结，引擎升级后判定口径变化 | 清单写死引擎版本；升级走 A/B K 轮，与今天舰队 M9 和本席预检同一纪律 |
| 绑定接口不稳：快照表结构变化让包静默变空 | `requires` 声明表和列；`prepare` 已有空转守卫，`pack lint` 再加「缺表即拒」 |
| 第三方包的信任 | 复用 ed25519 签名与 key table（`verify signature`）；无签名包只能本地使用 |
| 命名膨胀：每个仓库都发包 | 模式受控；领域和业务登记制；只有被两个以上工作流引用的规格才值得独立成包 |
| 构造面缺口随包扩散（#34 类） | 包必须携带构造夹具；`pack lint` 跑 #34 四类反例 |
| 依赖面（#54 类原生驱动问题） | 包不带依赖，只依赖引擎；引擎安装配方由舰队预检固化 |

## 8. 需要裁定的事项（属主）

| # | 事项 | 本席建议 |
|---|---|---|
| D1 | 包的形态：纯数据包，还是可执行插件 | 纯数据。可执行插件与 charter P1/P2/P4 冲突 |
| D2 | 命名与标记放在哪里：包清单，还是规格契约 | 包清单。不升 `contract_version`，规格保持冻结 |
| D3 | 6 种预设模式是否作为首版受控词表；首批与哪些业务结合 | 6 种全收；首批试点 tree（`ygl-v-core-aggregate`）与 gate（PR 评审） |
| D4 | 分发与安装位置 | **用户已定方向（2026-10-22）**：装在项目根 `.ygl-trees/plugins`，由全局 CLI 识别并激活子命令（§4.4）；npm 包名即包名（`ygl-v-*`）。待定细节为 D7–D9 |
| D5 | 第三方包是否强制签名 | 强制；无签名只允许 `--local` |
| D6 | 与 SDK 路线的先后 | VP-0/1 可与 SDK-0 并行；VP-3 起排在 SDK-2 `tree run` 之后 |
| D7 | 项目根 `.ygl-trees/` 只放插件，还是同时做工作区（数据库） | 只放插件；数据库仍在 `$YGL_HOME`（工作区分裂的事故先例，见 §4.4） |
| D8 | 项目层自动激活的信任模型 | 首次激活前显式 `plugin trust`（键为路径 + 锁文件哈希）；第三方包另验签名 |
| D9 | 全局 CLI 与包钉定引擎版本不一致时 | 委派给项目层 `node_modules/ygl-trees@钉定版本`；没有就拒绝并点名 `npx` |
| D10 | 项目根工作流文件的格式：JSON 还是 YAML | JSON（规范化、可哈希、可 schema 校验、机器写回；仓库零 YAML 先例）；YAML 只作人写草稿，经 `v import` 转换 |
| D11 | 文件位置：单文件 `.ygl-trees.json`，还是 `.ygl-trees/workflows/<名字>.json` | 每个工作流一份（ComfyUI 一张图一个文件） |
| D12 | 画布布局（`ui`）是否与语义同文件 | 同文件、单独一块，不参与哈希与执行 |

## 9. 评审席的复核方式

- 每期交付后，从 npm 发布版复跑该期验收，结果进对应 issue 与台账。
- 重点盯四件事：
  1. 装包不执行代码；
  2. 钉版和 sha 不符必拒；
  3. 同一包在两棵树里绑定不同数据，结论互不串扰；
  4. A/B 迁移期间根结论、叶子结论、spec 哈希逐轮一致。
- 本席的评审验证器作为 VP-3 的首个接入方。

## 10. 持闸评审补充（fdc757f6 / GLM-5.3，2026-10-23，总评 APPROVE）

评审席的六条补充（P3）全部采纳，作为本方案的正文约束：

1. **source 内容锚**：`sources[]` 每项除 `path`（本地位置）外加 `sha256`（数据是什么），与内容寻址纪律对齐。同路径不同数据 → 拒绝执行（rc=2，点名 source）。
2. **多包引擎钉版冲突**：`pack lint` / `v run` 规则：工作流的 `engine` 必须等于全部引用包的 `engine` 钉版，任一不等即拒（rc=2）。D9 委派也因此只有唯一目标。
3. **非 git 目录不激活项目层**：§4.4 的向上发现「走到 git 根为止」，**没有 git 根就不激活项目层**，防止误拾上级目录的 `.ygl-trees/plugins`。
4. **可执行件闭集单一真相**：`pack lint` 拒绝包内可执行件，所用的扩展名闭集与 charter R3 的闭集（已含 `.ts/.mts/.cts`）**同源引用**，不各写一份，避免出现「R3 放行、lint 拒绝」之类的漂移。
5. **清单携带 meta 状态**：包清单增 `meta: {meta_version, result, checked_at}`。目录面可直接看到包是否过 `verify meta`，`pack lint` 复核它与实测一致。
6. **fixtures 走语料纪律**：包内夹具（「好的全绿、坏的只翻对应叶子」）冻结时沿用 digest 血统。同一包版本内夹具变更必须带取代记录（old/new digest + 理由），与 meta 重登记、#59 / V13 同纪律。

评审席对 D1–D12 的立场（供属主裁定时参考）：

- D1、D2、D3、D7、D10、D11、D12 支持本席建议。
- **D5 加强**：不发明第二种签名格式。`signature` 域对「去掉 signature 自身后的清单规范字节」签名，域分隔与封包 footer 同款，验签认既有 key 表。
- **D8 加强**：`plugin trust` 动作写 events，与 `--no-meta` / `meta.bypass` 的审计同族。
- **D3**：受控词表的版本随清单 schema 版本走。
- **D9**：受第 2 条约束。

另记：frontmatter 的 `kind: 评审` 与索引里的「方案」标注不一致，属 `docs/reviews/` 既有枚举粒度问题，不在本 PR 处理。

## 附录：fdc 评审六条补充（P3，合入后 follow-up 吸收）

> fdc757f6 APPROVE 附六条（GitHub PR#56 review 转贴）；作者 24h 窗未响应，按约定合入后由开发线 follow-up 落文。

1. **sources[].path 内容锚**：每 source 增 `sha256` 内容锚（path 说本地在哪、sha 说数据是什么）——可携性与防「同路径不同数据」两收。
2. **多包引擎 pin 冲突**：lint 规则 = `workflow.engine` 必须等于全部引用包的 pin；冲突 → 拒（D9 委派同样需要唯一目标）。
3. **非 git 项目层**：无 git 根即不激活项目层（防误拾上级目录 `.ygl-trees/plugins`）。
4. **pack lint 可执行闭集与 R3 同源**：两处闭集必须单一真相（charter §4.4 R3 已扩 `.ts/.mts/.cts`），否则出现「R3 放行、lint 拒绝」或反向漂移。
5. **manifest 携带包 meta 状态**：lint 有「meta PASS」但清单/目录面可携带（微改进）。
6. **fixtures digest 血统**：fixtures 是 mini-corpus——「好全绿、坏只翻对应叶子」沿用语料纪律；冻结沿用 digest 血统（同版本内变更带取代记录，同 corpus freeze / tree-contract-matrix 机制）。
