# vendor/ — 上游框架落盘

从上游 npm tarball 落盘的框架件（**不是** git clone，**不是** @deepseek-ai fork——根 AGENTS 规则 7）。pnpm workspace 成员，`workspace:~` 引用。

| 包 | 上游 | 我们版本 | 用途 |
|---|---|---|---|
| cordis | cordiverse/cordis | 4.0.0-rc.11 | Context/Service/插件系统——四内建插件 + 用户插件的运行时 |
| cosmokit | cordis 生态 | 1.8.1 | cordis 依赖的工具库 |

## 纪律

- **来源**：npm tarball（`npm pack` 或 registry 下载）解包落盘——保留上游 package.json/README；不是 git submodule
- **升级路径**：下载新版 tarball → 替换目录 → `pnpm install` → 全量 `pnpm test`；**先跑 rc.11 时序探针**（tmp/svc-probe 模式：named-apply/inject 链/setImmediate 泵）确认行为面
- **已知漂移**（记录于 docs/plan.md 0.34）：上游停在 rc.11，DSH fork 已到 4.0.x——T2 级 fork 插件不可直接引用（会拖 fork 双运行时，违反规则 7 精神）
- **候选挂账**：schemastery（cordis 生态件，现从 npm 消费 ^3.18.4）——下次动 bundle 校验时评估 vendoring 一致性
- 禁止在此目录开发业务代码；它只镜像上游

## 对照

DSH vendor 九件（cordis/cosmokit/schemastery/loader/include/group/hmr/timer/logger-console，全 fork 版）——其余七件对我们均为“否”，裁决依据见 docs/plan.md 0.36.x 执行记录。
