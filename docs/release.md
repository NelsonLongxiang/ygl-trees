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

**已知交互：慢钩子 × 远端空闲超时**（实测 2026-10-17）。钩子跑完整门禁约 2 分钟，
期间与远端**零流量**；Gitee 的 SSH 会话会在此期间空闲断开，于是钩子通过后的传输立刻
失败——表现为 `send-pack: unexpected disconnect while reading sideband packet`、
`Connection to gitee.com closed by remote host` 或进程 `rc=141`（SIGPIPE），
**而门禁本身是绿的**。处置：门禁输出即证据，直接
`YGL_SKIP_HOOKS=1 git push` 重推（不要在网络已断的情况下重跑两分钟门禁）。
若需长期避免：把重门禁留给 tag 推送，普通 push 手动跑 `pnpm test`。

**若日后 Gitee Go 开放**：用 `gitee pipeline example -R <owner>/<repo>` 取官方 YAML 基线
（**不要手写字段**），改造为 `pnpm install && pnpm test && pnpm pack:check` 后
`gitee pipeline commit` 提交。阻断点只有一个：账户权限。

## 一、发布前门禁（必跑）

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

## 二、发布命令

```bash
pnpm publish        # 必须用 pnpm，不能用 npm
```

**为什么必须 pnpm 发布**：npm 不重写 `workspace:` 协议 → 发出去的包消费者装不上。
`prepublishOnly` 已挂 `pnpm test && pnpm pack:check`（发布前强制全绿 + 产物验证）。

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
externals  better-sqlite3 · node-sqlite3-wasm · typeorm · reflect-metadata · pg
           @deepseek-ai/dsh-atomic-write（native/可选，不进 bundle）
```

**关键纪律**：根 `package.json` 的 `dependencies` 是**发布面**（消费者安装什么），
`packages/*/*/package.json` 是**依赖图真相**（workspace 内部谁依赖谁）。两者并存，
改依赖时两处都要看——只改一处会分别导致「本地跑不起来」或「装完跑不起来」。
