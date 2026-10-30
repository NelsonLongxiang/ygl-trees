---
name: ygl-trees release
description: 发布流程——pack-check 门禁（打包→隔离安装→真实运行）、pnpm publish 纪律、workspace 协议重写、Windows .cmd shim 污染陷阱与验证记录。
kind: 参考
---

# 发布流程

## 零、仓库级门禁：push 时自动跑（无 CI 的等效方案）

**现状**：本仓库的 Gitee Go 服务不可用——`gitee pipeline` 的每个命令（含最轻的
`pipeline list` 服务状态检查）都返回 `giteego: HTTP 403 {"msg":"您无此操作权限！"}`
（2026-10-17 复测两次一致，非瞬时）。Gitee Go 未对本账户开放，**不是配置问题**，
也无 API 可自助开通（需在页面开通且当前账户无权限）。

**替代**：门禁下沉到 **push 时**，与 CI 等效且离线可测——

```bash
git config core.hooksPath .githooks     # 一次性安装（仓库自带 .githooks/pre-push）
```

| 触发 | 跑什么 |
|---|---|
| push 分支 | `pnpm test`（单测 + 构建 + demo 12 组断言） |
| push **tag** | `pnpm test` + `pnpm pack:check`（发布产物级验证，防未验证产物出门） |

**旁路纪律**：只能显式旁路，且留痕——
`YGL_SKIP_HOOKS=1 git push ...`（钩子会打印跳过原因，不静默）。

**已知交互：慢钩子 × 远端空闲超时**（2026-10-17 实测并已根治）。钩子跑完整门禁约 2 分钟，
期间与远端**零流量**；远端 SSH 会话会在此期间空闲断开，于是钩子通过后的传输立刻失败——
`send-pack: unexpected disconnect while reading sideband packet`、`Connection ... closed by
remote host` 或进程 `rc=141`（SIGPIPE），**而门禁本身是绿的**。

**根治：SSH 心跳**（已写入本仓库配置；换机器要重设一次）：

```bash
git config core.sshCommand "ssh -o ServerAliveInterval=20 -o ServerAliveCountMax=10"
```

空闲期每 20s 发一个 keepalive 包，会话不再被回收，钩子跑多久都能接着传。
验证方式：`git push` 走完整钩子（约 2 分钟）后传输正常落地，无需旁路。

**兜底**：若仍遇到断连，门禁输出即证据——`YGL_SKIP_HOOKS=1 git push` 重推，
不要在已断的连接上重跑两分钟门禁。钩子本身也会打印这条提示。

## 一、发布前门禁（必跑）

> **tag 前文档一致性核对（2026-10-28 F1 教训，gate 家族候选）**：打 tag 前必须核对
> README/CHANGELOG/llms.txt 与**最新裁定/最新实测**一致——0.117.0 曾把「撤钦定数值」
> 的修正留在 tag 之后，导致发布件带着已撤回的分析（README:338）。核对项：
> ①README 计数句 vs 本机实测/基准机口径 ②CHANGELOG 版本节 vs 实际 diff ③llms.txt 版本头
> ④docs 内所有引用裁定编号的数值（如 1219/1183）是否已被后续裁定推翻。

### G1 离线门（roadmap/#96 条目 1）

```bash
bash scripts/offline-gate.sh          # 干净克隆 + env -i 无凭证 install + pnpm test，rc≠0 即阻断
```

### G2 全量 diff 门 / G3 真调用门（评审过程门禁，检查清单项）

- [ ] **G2**：任何快审/双审盖章前**读完整 diff**——按 grep 过滤过的行不算读过（PR#140 事故）。
- [ ] **G3**：工具/MCP 类判据必须有**一次真实往返**——`tools/list` 里出现不算证明。
- [ ] **G4**：`node scripts/commit-claims.mjs <发版区间>` ——提交说明声称的路径逐条对 `--stat`，声称了却不在 diff = 红。
      豁免面：message 里 `reads:<path>` 行显式声明只读不称；跑批 `--allow p1,p2`（须在发布记录注明理由）。
      本批示例（6e5d84e..830db22）：`--allow skills/ygl-trees-research,scripts/dual-backend-matrix.mjs`（前者为文档引述、后者为被读对象的引用，非改动声称）。

### G7 真 PG 矩阵门（总工裁 direct-2c7c431a：本地 docker 门，发版必跑）

```bash
bash scripts/pg-gate.sh               # pinned postgres:16.4-alpine → B8 real PG → dual-backend-matrix --strict
```

结果（rc、双腿、镜像 tag、`b8_pg: N passed, 0 skipped` 与报告路径）贴进发布记录；**「矩阵绿」包括 B8 真库测试，是发布收口条件的一部分**。G7 在自己的 loopback 临时容器上设置 `B8_TEST_PG_ADMIN_URL`，必跑 business/research/query/claim-cli/kb-loop/removal/claim-state 七份 B8 PG spec；offline primitives 单列，不冒充真库覆盖。用例数从本次报告读取，不硬编码旧 issue 计数。缺 Docker、PG 不可达、任一失败/跳过或缺文件报告均红，不回落 skip。默认 `pnpm test` 不启动 Docker，其 PG 跳过数不算 G7 通过。容器清理只使用本轮 `docker run` 成功返回的不可变 ID，创建失败不按同名删除。直调 `--b8-pg-only` 仅接受显式端口的数值 loopback（127.0.0.1/::1）、`/postgres` 且无 query/fragment 的 URL；这是误配防线，不证明本地库可丢弃，调用者仍须使用隔离测试实例，标准 G7 自动创建该实例。

G7 同时必跑 SQLite 字节黄金门（#132）：`node scripts/dual-backend-matrix.mjs --b8-sqlite-only`，设置 `B8_SQLITE_BASELINE_BIN` 执行 `b8-sqlite-golden.spec.ts`。基线固定 npm `ygl-trees@0.117.1`（下一版相对当前已发布版），源码内记录下载 URL、tarball SHA-256 与 bundle SHA-256；不跟随 latest 漂移。下一次选择新基线必须显式改 pin、记录来源与哈希并走评审，不自动接受字节变化。发布记录必须附 `b8_sqlite_golden: 1 passed, 0 skipped (baseline ygl-trees@<v> sha256 <…>)`、原始报告与 summary 路径。下载/解包/版本/哈希不符、spec非零/skip/缺报告均失败，不冒绿；离线可用 `--baseline-tgz <已下载包>`，仍必须通过同一 pin 的 tarball+bundle 哈希。黄金门只保留 #114 已明示两条输出差异，不批量更新基线。

### G8 发布后复跑基线（发布完成后）

> **禁 shallow clone**：G8 的 tag 克隆必须 full clone——`--depth 1` 会让 `meta-tooling --audit --against-git` 的 chain-first 锚（pinned genesis）误红 11 项（0.116.1 复跑实测）。`scripts/post-release-check.mjs` 用的是普通 clone，符合要求。
>
> **0.116.1 已知红腿（如实入账）**：该版 `readme-verify` 59/60——唯一红是 unit 计数行（README=1204 基准机值 vs 非基准机实测 1168，跨平台计数差）。计数门前置（非基准机显式 SKIP 打原因）随 #107 合入 master、下一版生效；**不构成功能回归**。


```bash
node scripts/post-release-check.mjs <version>   # npm 装 + tag 克隆 pnpm test + verify meta .，JSON 结果进记录
```

### G12 解释器锚（防回归注记）

**处置**：pnpm scripts 的 shell 链**不得直写 `bash -c '…'`**——Windows 下 pnpm 经 cmd 解析，
裸 `bash` 会按 PATH 序漂移（本机实证漂到 WSL：`/mnt/d` 下旧 node 跑 tsc 报 `SyntaxError: ??`，
2026-10-27 假红同根）。四条 shell 链（build / test / prepublishOnly / bench）一律经
`node scripts/run-sh.mjs "<chain>"`：解释器钉在代码里（win=Git Bash 绝对路径或 `GIT_BASH`，
缺失大声红；posix=`/bin/bash`）。`node scripts/interp-anchor.mjs`（`pnpm gate:g12`）守两件事：
`scripts/*.sh` shebang 锚 bash、scripts 字段的 shell 链必须经 run-sh。**新增 shell 链照此写**。

### G11 仓内体量门

```bash
node scripts/volume-gate.mjs      # spec.md 26KB / docs 活跃 880KB 双上限；超阈归档（spec §5）
```

### G9 合并祖先守卫（pre-push 内建 + 事后复核）

- pre-push 钩子内置非快进拒推（不可经 YGL_SKIP_HOOKS 跳过——只跳测试套件）。
- 合并后复核：`node scripts/merge-check.mjs <合并 sha>` ——防「回执是真的、代码不在主干上」。

```bash
pnpm test          # 单测 + 构建 + demo
pnpm pack:check    # 发布就绪门禁：打包 → 隔离安装 → 真实驱动发布产物
pnpm readme:verify # 文档真值：README 每条命令示例实测可跑（含冻结契约 rc=2）
pnpm contract:audit # 写路径契约体检：幂等 / duplicate 回执 / 坏引用点名 / 用法 rc=2
```

`pnpm pack:check`（scripts/pack-check.sh）拦的是**源码树测试拦不住的一类 bug**：

| 检查 | 拦什么 |
|---|---|
| 依赖重写 | `workspace:` 协议残留 → 消费者 `npm install` 直接失败 |
| tarball 完整性 | 构建产物未进 `files` → 装完没有 bin |
| 隔离安装 | 依赖闭包从 npm 解不出（undecalred runtime dep） |
| 真实命令面 | bin 路径错、shebang 丢、缺运行时文件 |
| `--json` 纯净 | 输出被污染 → agent 侧 `JSON.parse` 崩 |
| README 真值 | 命令示例引用了尚未创建的对象 / 前置缺失 → 读者照抄即失败 |
| 写路径契约 | 写命令重跑崩（UNIQUE/FOREIGN KEY 裸异常）、不幂等、坏引用不点名实体 |

**实测记录（0.38.0）**：tarball 52 包闭包，`@deepseek-ai/cordis@~4.0.5-alpha.2` 等 fork 版本
在 npm 上均有源（DSH 自己发布）——`workspace:~` 重写后可解；9 条命令面 + doctor 全通过。

### 可复现打包（0.105.0，0.105.1 修正）

`pnpm pack` 打出的 tarball 带打包机的 mtime、属主与 gzip 头，**同一 commit 每次打指纹都变**，
只能记账不能当篡改校验。`pnpm pack:repro` 产出确定性 tarball：

```bash
pnpm pack:repro                    # -> ygl-trees-<version>.tgz，打印 bytes 与 sha256
node scripts/pack-repro.mjs --json # 机器可读：{path, bytes, sha256, files}
```

**内容源必须是 pnpm 的产物**（0.105.1 修正）：`pnpm pack` 负责 `workspace:` 依赖重写与
`files`/`.npmignore`/`publishConfig` 的文件选择，脚本只把它的条目重写成确定性字节——
条目按路径字节序、`mtime=0`、`uid/gid=0`、`uname/gname` 空、`mode=0644`、ustar 格式
（无 pax 扩展）、gzip level 9 且不带文件名与时间戳、gzip 头 OS 字节固定 `0xFF`。
全程 Node 实现，不经过 shell `tar`/`gzip`，Windows 与 Linux 产出同字节。

> 0.105.0 的事故：脚本当时直接读仓库原始 `package.json` 手工组装 tar，绕过了 pnpm 的
> 依赖重写——四个 `workspace:~` 包原样进了 npm，全新 `npm install` 必失败。所以现在
> 重打包前有一道硬闸：清单里仍有 `workspace:` 就直接拒绝封包。

分工：`pack:check` 回答「这个包能不能装、能不能跑」——5b 段除了两次哈希相同与条目清单
一致，还会在空目录用 **npm 真装一次**并跑装出来的 `bin --version`（只比哈希不比可安装性，
正是 0.105.0 漏过门禁的原因）；`pack:repro` 只回答「同一个包每次字节是否相同」。发布交接
时给两个指纹并说明差异来源——**repro sha256 作篡改校验**，npm 官方 tarball 的 sha256 只是
记账（`npm publish` 仍走 npm 自己的 pack 路径）。

**发布前自扫（0.110.3 起，外部复审常态化后的例行步）**：以 reviewer 视角过一遍本版 diff——
谓词/SQL 注入面、根级命令 JSON 单对象、发布生命周期钩子（`prepublishOnly` 单键）、
tag→npm 顺序；本轮 #17-#20 即来自这一视角，模板见 GitHub issue 复盘。
**clean-tree guard（0.110.1，0.110.0 事故沉淀）**：`pnpm pack` 的文件选择面向**工作树**，
主树里未提交的 `docs/*` 或旧 CRLF 检出会进入 tarball——官方字节因此可能与审计 commit 不符。
`pack:repro` 打包前强制 `git status --porcelain` 干净（含 untracked、排除 gitignored）：

```bash
node scripts/pack-repro.mjs --check-dirty   # {"dirty":false} 才可出包
node scripts/pack-repro.mjs                 # 官方字节（clean worktree + 本树 build）
```

`--allow-dirty` 仅供本地实验，**不得用于发布字节**。官方流程固定为：干净主检出@release-commit（共享检出按文件/窗口协调，不用 worktree）
→ 该树 `pnpm install && pnpm build` → `pack:repro`；主树脏时禁止出包。

## 二、发布命令

**必守顺序（#131）**：release 提交先并入 master → push 项目主远端 master →（创建并 push tag）→ guard → publish。tag 可先准备，但 tag commit 和远端 master 两者都必须先于 npm 可见；不能只推 release 分支/tag 就发布。`--remote` 使用项目主远端名字（当前 `github`，不是固定要求名为 origin）。guard 每次新 fetch 该远端 master，验证远端 tag 的 peeled commit 与本地 HEAD 一致，再验证该 commit 是远端 master 的祖先；失败输出双方 SHA。离线 `--no-network` 或未给 `--remote` 仅为本地 tag 检查，`remote_verified:false`，不能作为发布门通过证据。

**0.117.1 R4 属主豁免**：npm 发布于 2026-10-30 05:20:31.517Z，source merge 08a785d 于 05:22:47Z 才 push master（#131 时间线）；发布内容正确不等于当时顺序合规。该偏差已由[属主豁免](https://github.com/NelsonLongxiang/ygl-trees/issues/131#issuecomment-6516781684)覆盖并登记于评审验证器 `r4_exemptions[]`：npm 先于 master 约 2 分钟，但 tag 早于发布且内容已核。属主同时要求发版席「以后先并 master 再发布」。豁免只覆盖 0.117.1，不扩展到后续发版；下一次 npm 发版必须使用新门并附发布记录，#131 关单仍需下一版 npm+tag 复核。

**官方字节流（0.110.1 起）**——tarball 直发，保证「审计字节 = 发布字节」：

```bash
node scripts/pack-repro.mjs --check-dirty        # 必须 clean
node scripts/pack-repro.mjs                      # 产出并记录 bytes + sha256
git switch master                             # release PR 已按授权合入
git push github master                        # 先让 tag commit 可从远端 master 到达
git switch --detach <release-commit>           # 主检出干净/无他席在用才切；不是 worktree
git tag -a v<version> <release-commit> -m "v<version>"
git push github v<version>
node scripts/prepublish-guard.mjs --remote github  # npm publish 前最后一步：远端 tag 一致且 master 祖先门
npm publish <pack:repro 产出的 tgz> --registry=https://registry.npmjs.org/
```

`prepublishOnly` 只覆盖**目录发布**（`npm/pnpm publish` 在包目录内），对 `npm publish <tgz>`
**不执行**——所以 exact-bytes 流程必须显式跑 `prepublish-guard.mjs --remote github`，作为 `npm publish <tgz>` 前最后一步（GitHub #17/#131）。目录流中的默认本地检查不替代这个联网检查。

目录发布仍可用 pnpm（`workspace:` 协议重写是 npm 的缺口）：

```bash
pnpm publish        # 目录发布：prepublishOnly = tag guard && pnpm test && pnpm pack:check
```

**为什么优先 pnpm 发布（目录流）**：npm 不重写 `workspace:` 协议 → 发出去的包消费者装不上。

## 三、Windows `.cmd` shim 污染陷阱（重要）

`node_modules/.bin/ygl-trees.cmd` 在某些 Windows 主机上会先输出一行
`Active code page: 65001`——来源是**主机级 cmd 启动钩子**
（`HKCU\Software\Microsoft\Command Processor\Autorun`），污染**所有** npm 包的
`.cmd` shim（实测 `cordis.cmd` 同样如此），**不是本包的缺陷**。

后果：经 `.cmd` shim 调用的 `--json` 输出无法整体 `JSON.parse`。

**验证过的干净调用路径**（实测均输出纯净 JSON）：

```bash
node node_modules/ygl-trees/dist/bundle/bin.cjs --json db stats   # ✓ 直接 node
pwsh -c "& .\node_modules\.bin\ygl-trees.ps1 --json db stats"     # ✓ .ps1 shim
./node_modules/.bin/ygl-trees.cmd --json db stats                 # ✗ 被主机 AutoRun 污染
```

Agent/CI 消费 JSON 时用前两条之一；`.cmd` 仍可用于人类交互（输出仅多一行噪声）。

## 三点五、版本标签与 Release

```bash
# 1. 版本号已在 package.json（收口提交里 bump）
# 2. 打标签并推送（pre-push 钩子会对 tag 额外跑 pack:check）
git tag -a v0.39.1 -m "v0.39.1 — <一句话主题>"
git push origin v0.39.1

# 3. 建 Gitee Release（说明取自 CHANGELOG 对应版本节）
gitee release create -R NelsonLongXiang/ygl-trees --tag v0.39.0   --name "v0.39.0" --body "$(sed -n '/^## 0.39.0/,/^## 0.38/p' CHANGELOG.md | head -n -1)" --no-tui
```

要点：
- **tag 必须走钩子**——tag push 触发 `pack:check`，拦的是「版本号对了但产物装不上」
- Release 说明**从 CHANGELOG 取**，不另写一份（单一事实源）
- 语义化版本：CLI 命令面/字段名/退出码属冻结契约，破坏性变更进主版本

## 四、发布面构成

```
bin        dist/bundle/bin.cjs     ← tsdown 单文件（cordis + 全部 packages 已内联）
files      dist/ ygl.bundle.json README.md docs/ skills/ examples/ LICENSE
externals  better-sqlite3 · typeorm · reflect-metadata · pg
           @deepseek-ai/dsh-atomic-write（native/可选，不进 bundle）
```

**关键纪律**：根 `package.json` 的 `dependencies` 是**发布面**（消费者安装什么），
`packages/*/*/package.json` 是**依赖图真相**（workspace 内部谁依赖谁）。两者并存，
改依赖时两处都要看——只改一处会分别导致「本地跑不起来」或「装完跑不起来」。

## Worktree 纪律（2026-10-24，总工席 obs-2026-10-24 批）

**单一 release-wt 复用**：发布流程使用固定 worktree（`tmp/release-wt`），每版 `git checkout <anchor> --detach`
覆写——不新建、不累积。此前 0105-0114 每版建新 worktree 未回收（本机 50 个），根因防复发即此条。
