# ygl-trees （猿光 · 科技树）

面向 AI Agent 的命令行工作台：**研究 → 产出 → 知识应用**，外加一套完整的**科技树节点数据模型**。

- 单一 SQLite 文件就是全部状态，没有 sidecar JSON，没有"用 git 当数据库"
- 依赖面（0.8.0 起引入 TypeORM 查询层）：`node-sqlite3-wasm`（纯 WASM 免编译）+ `typeorm` / `better-sqlite3` / `reflect-metadata`（TypeORM 栈，better-sqlite3 走 prebuild 免编译）+ 可选 `pg`（仅用 PostgreSQL 镜像/迁移时）
- 框架层 **vendored**（`vendor/`，与 DSH 同版本同源）：`@deepseek-ai/cordis` 4.0.5-α + `cosmokit` + `schemastery` + 六件 cordis-plugin（timer 已启用）
- 全部命令支持 `--json`，方便 Agent 直接解析

```bash
pnpm install
pnpm build          # tsc -> dist/ + tsdown -> dist/bundle/bin.cjs（单文件发布产物）
node dist/bundle/bin.cjs db init     # 发布产物（bin 字段指向它；比 tsc 树快 ~8%）
# 开发树：node dist/apps/cli/src/bin.js   二者同代码，demo/bench 优先测发布产物
```

---

## 一、科技树节点数据模型（核心）

要求：**父子节点、每个节点可存在的关联与索引、必检与可选条件**。schema 四张表分头承担：

| 关注点 | 表 | 说明 |
|---|---|---|
| 节点定义 | `nodes` | key（存档用的稳定 ID）、kind、tier、cost、payload |
| 父子 + 关联 | `node_edges` | 邻接表，**唯一事实来源** |
| 传递索引 | `node_closure` | 祖先/后代闭包，`depth` 区分直接父与远祖 |
| 派生索引 | `node_index` | 拓扑序、tier 分桶、入度表 |
| 非结构条件 | `node_conditions` | 资源/等级/任务等，必检或可选 |
| 运行时 | `node_state` | 按 context（存档槽）存 locked/available/unlocked |

> **先建一棵树**：节点都活在树里，全新工作区直接跑 `node ...` 会报 `no tree selected`。
> `ygl-trees tree new demo`（建并选中）→ `ygl-trees tree list` / `tree use <name>` 切换。

### 父子与关联：四种 rel × 四种 mode

`node link <parent> <child>` 可指定：

- `--rel` 关联语义
  - `prereq` 前置依赖（默认）
  - `unlock` 父节点揭示子节点
  - `excludes` 排斥，父已解锁则子被封死
  - `enables` 软关联，只做提示/加成
- `--mode` 多个父节点如何组合
  - `AND` 全部满足（默认）
  - `OR` 任一满足
  - `XOR` 恰好一个满足
  - `NOT` 父必须**未**解锁

### 必检 vs 可选

这是模型里最容易糊掉的界线，两处都显式区分：

- **边级**：`node_edges.required`（`--optional` 置 0）
  - 必检：不满足即无法解锁
  - 可选：不阻塞，但会进入 `missing_optional`，可作为"本可打折"的提示
- **条件级**：`node_conditions.required` + `effect`
  - `gate`（必检）：资源/等级/任务门槛
  - `cost_mul`（可选）：满足条件则成本打折，`weight` 即系数

```bash
ygl-trees node add steel                                                            # 先有节点
ygl-trees node cond add steel --name research_lab_level --kind level --value 3       # 必检
ygl-trees node cond add steel --name has_engineer --kind flag --op has \
            --optional --effect cost_mul --weight 0.8                                # 可选，打八折
ygl-trees node cond rm steel --name research_lab_level                               # 按自然键删除
```

### 索引：查询不再递归

- `node_closure` 让 `ancestors` / `descendants` / `reaches` 走 O(1) 查表
- `node_index.topo_order` 让 `node ready` 单次拓扑序扫描搞定，不必反复 DFS
- 运行时状态（locked/unlocked）**CLI 可直接对账**：`node list` 有「状态」列，`node show <key>` 带
  `state` + `unlocked_at`（`--json` 同名字段）——解锁是维护动作，看不见就无法执行「解锁后必须挂依据」的纪律
- `node index` 重建两者；**遇到环直接报错**，坏数据在构建期暴露，而不是运行时

```bash
ygl-trees node index        # 重建闭包 + 拓扑序
ygl-trees node validate     # 环（含可选边）、悬空边、自环、脏索引、缺阈值的必检条件
```

### 完整一组命令

```bash
ygl-trees tree new demo
ygl-trees node add mining && ygl-trees node add smelting
ygl-trees node link mining smelting                 # 必检 AND
ygl-trees node link bronze steel --optional         # 可选，不阻塞
ygl-trees node link bronze iron --mode OR           # 任一即可
ygl-trees node link a b --rel excludes              # 互斥分支
ygl-trees node move stray --to demo              # 跨树搬节点（树内还有边则拒绝，先 unlink）
ygl-trees node can steel --state "research_lab_level=3,has_engineer=1"
ygl-trees node can a b c --state-file probe.json   # 批量判定：一进程测 N 节点（探针冷启动 1s×N → 1s）
ygl-trees node ready                                # 当前可解锁集合
ygl-trees node ready --all                          # 跨树扫描就绪集（无需逐树 tree use）
ygl-trees node cond --due                           # 临期 eval 门槛（问题文本带 YYYY-MM-DD 期限）
ygl-trees node cond --due --days 30                 # 放宽窗口；--eval 到期自动送判定模型
ygl-trees node path advanced-alloy                  # 到目标的最省顺序 + 累计成本
ygl-trees node ancestors bronze                     # 闭包索引，直接父 depth=1
ygl-trees node timeline demo                        # 单树成长时间线（add/link/unlock 倒序）
ygl-trees node export --out tree.json               # 可移植 JSON
ygl-trees node import --file tree.json --tree copy  # 严格校验、事务导入
```

`node import` 校验失败（引用缺失、枚举非法、必检条件缺阈值、门控环）即整体拒绝、零副作用；同名树默认拒绝，`--merge` 按 (tree, key) upsert。

`node can` 的输出把三类失败分开列：**必检未满足 / 被排斥 / 可选未满足（不阻塞）**，外加成本系数。

**批量判定 + `--state-file`（0.79.1）**：`node can k1 k2 k3` 一次进程判定多节点（多键自动进批模式，`--json` 返回数组）；`--state-file <json>` 喂状态袋，两种形状——**扁平计数** `{"y_imported": 40}` 全节点共享，或**按节点** `{"a": {"y_imported": 40}, "b": {...}}` 各取各袋。探针脚本从此每树起一次进程而非每节点。

**跨树巡检 + 临期门槛（0.82）**：`node ready --all` 一次扫全部树（12 棵树 24 条命令 → 1 条）；`node cond --due [--days N]` 列出问题文本带 `YYYY-MM-DD` 期限且 N 天内到期（含逾期）的 eval 条件——w1/d90 预测门槛不再依赖人记得看；`--eval` 逐条送判定模型（离线安全回落 pending），**判定只报告不仲裁**（通过 ≠ 自动解锁，resolve/unlock 保持人工，与 predict audit 同纪律）。

**并发钉住 + 半写防护（0.83，真实用户报告）**：并发会话共享 `current_project` 指针互踩导致资产碎片化——研究/产出/树三域写命令全部接受长旗标钉住：`research * --project <p>`、`produce/task * --project <p>`、`node * --tree <t>`（短旗标 `-p`/`-t` 不变）；写回执带 `· project <名>` 回显落点，写错项目当场可见。`source add --query` 引用不存在时**先拒绝后写入**（rc=1、零落地），不再出现"源已落、链接失败"的半写；`job run/tick` 的子命令以无锁环境启动（WAL 并发读），`ygl-trees …` 型任务命令不再与运行器自身死锁。`--help` 在任意深度（如 `kb add --help`）打组帮助 rc=0；`db init` 前的报错提示 `YGL_HOME` 工作区根因；到期巡检可直接挂 job（`job add "到期巡检" --every 1440 -- ygl-trees node cond --due --days 30`）。

**决策模型评估门（spec R8；0.14 布尔 → 0.26 三题型 → 0.27 混批 → 0.80 织物并入）**：语义型必检条件用 eval 题型声明，`node can <key> --eval` 会把**节点元数据 + 直接父（关联）+ 祖先链（闭包索引）+ 条件组 + 已解锁集 + --state 袋 + rel 挂接摘要**组装为上下文包，交给评估模型（TypeSafe jev，经 Vercel AI Gateway）判定：

- **rel 织物并入（0.80）**：节点挂接的 evidence（quote 摘要）/ claim（text+status+confidence）/ kb/source（标题）等 rel 关系（双向，≤12 条，文本截 120 字）自动进上下文包的 `attachments`——「证据挂链」纪律从此对语义门槛可见，不必再 `--state k=v` 手动携带裁决事实（实测 P 0.30 → 0.92 的差距由挂链补平）
- **attachments 快照（0.83）**：`node can <key> --eval` 的输出（`--json` 的 `eval_attachments[]` + 人类视图 `attachments ×N:`）回显本次判定实际吃到的 rel 挂接——P 值过了也能一眼看出依据是哪几条 evidence/claim，复现不必翻库

- **三题型**：`--op eval`（布尔 P(true)）/ `--op eval-choice`（多选一，判 **P(期望答案)**，`--options "k=desc,..."` + `--answer k`）/ `--op eval-score`（等级评分 `--levels "级0,..."` 2-10 级 + `--min-score n`，判概率加权均值 ±1 灰带）
- P≥0.7 通过 · P≤0.4 未通过 · **灰带 pending**（过程态，禁作终态，单列不阻塞也不放行）；score 的灰带是 [min−1, min)
- **离线安全**：未配置凭证（`AI_GATEWAY_API_KEY` 或 `~/.vercel.ai-gateway.env`）时该条件回落 pending、rc=0——评估器是增强不是依赖；`YGL_EVAL_OFFLINE=1` 可强制离线（测试用）
- 判定留痕 events（`eval.gate`），`--json` 输出附加 `evaluated[]`（带 `type` 字段）与 `pending[]` 字段
- **`node ready --eval`（0.16 布尔批 → 0.27 混批）**：仅被 eval 门槛阻塞的节点每节点**一次混题型请求**（协议原生：boolean/choice/score 同 state 单请求）批量判定——全过者提升进 ready（标 `eval_verified`），其余进 `eval_pending`（逐题带 P/score）；离线全部 pending、rc=0；留痕 `eval.ready`
- `ygl-trees doctor` 的 `eval_envelopes` 检查（0.28.0）会对坏信封条件（choice 的 answer 不在 options、score 级数越界等）报 fail
- **判定落账 + 校准读出（0.84）**：`claim evaluate` 与链接自动评估均写 `claim.eval` 事件（此前判定蒸发在 stdout：自动评估被 CLI 短进程退出截断、手动评估不落账）；`research claim calibration [--all]` 汇总模型档位 vs 人工仲裁档差（每断言最新评估胜出），输出 `模型低≥1档` 份额——直接服务"决策模型置信度系统性低于人工一档"预测（判据 ≥60%）的测量。链接 `--json` 回执并入 `model_label`/`model_confidence`（保持 stdout 单对象）
- **会话选择分辨率（0.85，spec R16）**：项目/树选择优先级 = 显式 flag > env（`YGL_PROJECT`/`YGL_TREE`）> **会话键**（`current_project@<sid>`，每个 Agent 会话独立）> 全局键（仅兜底展示）。多项目工作区未选择时 `research`/`produce`/`agent brief`/`project show` fail-closed（rc=2 单错误对象点名出路），工作区级命令照常；单项目自动命中零摩擦。`project/tree show --json` 带 `selection_source`，`tree show` 汇报选择来源 + 树统计；WebUI 未选择显示选择入口不回退全局。并行会话互踩 `current_project` 指针自此根治
- **Cordis 服务化 + 事件桥真修（0.86）**：evalClaim/assessEvidence/semanticRank 进 `ctx.ops` 服务（域包不再跨包 require 运维实现，eval 网关统一入口）；零消费壳服务（ctx.techtree/ctx.webApp）删除，base bundle 收敛为 database/ops/research/timer；WebUI SSE 改走 Cordis 公共通道 `ctx.on("ygl")`（事件驱动 + 轮询降级）；**事件桥 ESM 静默死亡缺陷根治**——桥原用 require() 包 try/catch，ESM 宿主下 ReferenceError 被静默吞、桥直接死亡，改静态 import 后桥链有了单测防线；kind 专用通道从 11 种硬编码清单改为动态桥接（`ygl:<kind>`），不再静默丢弃清单外事件
- **研究管线视图 + 视觉 token 单源化（0.92）**：WebUI 管线视图 React 重建（0.88 退役的 HTML 实现正式接替）——断言按状态四列水流（已证实/有争议/未验证/已反驳），claim 卡状态色左沿 + 证据折叠列表（stance 着色 + 引文摘录），渲染验证测试锁面；视觉 identity 单源化——DESIGN.md 为唯一调色板真相源，antd 主题/统计卡/知识图谱（含服务端色板）全走 token，漂移守卫 ×7 解析 DESIGN.md 断言两面一致，改色只能从 DESIGN.md 起改

- **spec-validator 验证器（0.96 → 0.103）**：把「业务规范」变成可执行的验证器——业务专家交一段话+附件，agent 构造判据（`prepare` P0–P5 含盲审与红队），引擎跑七型检查器（sql/sql-pair/count/exists/file/command/agent）出报告，**判定链上没有人工确认**（构造追溯视图只读审计）。契约（`docs/verify-contract.md`）与黄金语料钉 `contract_version 1.1` / `corpus_version 1.1`，TS 引擎与 Rust 单二进制 `yglverify`（`rust/yglverify/`）**整份报告逐字节 parity**（33 例语料机械门）；`--draft` 无损试跑、`file` 检查支持 `ignore` 排除集、归档包（确定性 zip + `archive verify` 全链重算）、`verify self-check`（六环自校验）、封包形态（spec 内嵌 + footer v1 + **ed25519 签名 + 认表不认报文**；发布物应要求 signed 登记）。CLI 命令族：`verify submit/prepare/run/graduate/report/trace/archive/register/signature/self-check`（`graduate` = 资格冻结 + 常驻检查，0.103.0）；WebUI 三视图（0.100.0 起，0.101.0 接附件上传，0.102.0 起作业式 `prepare`/`run` HTTP 端点由 `webui serve --enable-verify-jobs` 打开、默认 403）：材料提交 / 构造追溯 / 报告看板（`/api/verify/*`）
**退出码**：`0` 成功（含"重复已存在"）、`1` 运行错误（含 404：`query done` / `job enable|disable` / `source rm` 命中不存在的 id）、`2` 用法错误。Agent 可放心按 rc 分支。

---

## 二、研究 → 产出 → 知识应用

### research：证据先行

```
query add       登记检索式
query attach    检索式 ↔ 来源关联（query list 显示召回数）
source add      收来源，按 (project, url_hash) 去重；--query 顺带关联（引用不存在 → 整体拒绝 rc=1，零落地）
                全组接受 --project <p> 长旗标钉住目标项目（并发会话不依赖共享 current 指针；回执带 · project 回显）
                --adjudication "<裁决摘要>"：会话内裁决原生载体（url 自动 session://adjudication/<时刻>，摘要兼作标题）；--url 收任意 <scheme>://（https/file/session/a2a/… 跨 Agent 引用免落盘）
source fetch <url>  直接抓取网页入库：title/meta description/去标签正文；15s 超时、非 html 拒收、失败零副作用，正文过薄自动打 needs_review
evidence add    从来源摘原文片段，带 locator（页码/章节）；长摘录用 --file <path> 免转义
evidence rm     删除证据：仍被任一断言链接时默认拒绝（点名先 claim unlink）；--force 级联删链并重算状态
claim add       写下断言；--confidence 收 A|B|C 或数值档（0.92 / 85% 原样入库）
                --channel <台账通道>（0.90）：预测注册时登记结算数据通道（github-issues|review-rounds|npm-registry|manual…），结算防通道错配
claim link      断言 ↔ 证据，自动算 supported / refuted / contested
                --by-source：传来源 id 一次挂齐其全部证据；误传来源 id 会列出该来源的证据 id
                [预测·…] 断言不自动晋升（0.82.1）：挂证据≠仲裁，状态保持 unverified 直到显式 resolve / 到期回测
claim resolve   人工仲裁出口：--as supported|refuted|contested，事件留痕；后续新证据链接会重新推导
claim unresolve 复位通道：把断言重置回 unverified（撤销链接副作用 / 抢跑仲裁），幂等 duplicate:true
claim unlink    解除单条 断言↔证据 链接：重算状态（[预测·] 断言保持原状态，避免把预测降级）、事件留痕 claim.unlink
predict list    结算投影（0.90）：全部 [预测·] 断言一表出 outcome（未结算/1/0/ND）+ channel + 期限；
                结算三段式 note（evidence --note 尾部 `outcome=1|0, brier=…, settler=…`）解析出 brier/settler——校准曲线 SQL 直出
predict audit   预测回测：扫描 [预测·N天] 断言，本地可测判据自动测（树/kb 计数、npm 版本数），判 hit/miss/pending/manual——只报告不仲裁，给出待 resolve 建议
                --state <file|url>：外部计数桥接（如 DSH API 快照），判据里的裸键名后缀匹配嵌套键（y_imported≥12 ← counts.y_imported）
                已 claim resolve 的预测默认隐藏（回测终态），--all 查看全表
```

**JSON 纪律**：写命令在 `--json` 下 stdout 只有一个 JSON 对象（重复时带 `duplicate: true`），Agent 可直接 `JSON.parse` 全量输出。

断言的状态**由证据链接自动推导**：有支持有反对 → `contested`，只有支持 → `supported`，都没有 → `unverified`。

### produce：从证据生成报告

```
outline   按 claim 状态自动生成骨架
section   写章节
report    组装：摘要 → 主要结论（带证据编号）→ 章节 → 证据清单 → 来源 → 局限
export    落盘 markdown
```

报告里每条结论后跟引用编号，未获支持的断言会进"局限与未决问题"，不会伪装成结论。

### kb：让研究产生复利

```
kb ingest <artifactId>    报告入库
kb import <dir|file.md>   批量导入 markdown（frontmatter：title/tags/confidence/url；按内容 hash 幂等）
kb search "<q>"           中文可用（CJK 二元切分）
kb promote <note>         把笔记提升为可复用 skill（L1 自动从正文提炼，含来源标注）
agent match "<task>"      Agent 靠 L1 描述命中该 skill
agent brief               状态 + 建议动作 + 健康度（脏索引、存量重复数据会提示修复命令）
```

闭环：**报告 → 笔记 → skill → 下次自动命中**。

### skill：L1/L2/L3 渐进披露

- L1 `description`：常驻上下文，写"做什么 + 何时触发 + 同义词"
- L2 `body`：激活才加载
- L3 `skill_refs`：按需读取

`skill import <SKILL.md>` 直接解析 frontmatter。

`skill link [--global] [--ai pi|claude|cursor|windsurf]` 一键软连接到 `.agents/skills/`（DSH/Claude 等 Agent 的技能发现路径即刻可用）。

### rel：关联织物（把研究资产挂到树节点）

研究与建树是两条会各自漂移的流水线；`rel` 把它们钉在一起——八类引用任一两端可连：

```bash
ygl-trees rel add node:steel claim:<id>       --rel decided-by     # 决策依据
ygl-trees rel add node:steel evidence:<id>    --rel evidenced-by  # 证据
ygl-trees rel add node:steel kb:<id>          --rel explained-by  # 知识沉淀
ygl-trees rel add node:steel artifact:<id>    --rel tracked-by    # 产出/任务
ygl-trees rel list --src node:steel           # 双向浏览（对端解析成显示名）
```

`<type>:<ref>` 词表：`node claim evidence source query kb artifact task skill`。`/api/node` 同时返回双向 `related[]`，WebUI 节点详情直接可见。

### task：任务状态机（todo → doing → done）

```bash
ygl-trees task add "<标题>" [--note ...]                 # 建任务（todo）
ygl-trees task add "验证 X" --node <tree>/<key>          # 建任务并挂到树节点（tracked-by）
ygl-trees task list [--status todo|doing|done]
ygl-trees task doing <id> | task done <id> # 推进（每次状态变更留痕 events）
```

任务本体是 `artifacts` 的 `kind='task'` + meta 状态信封（**没有独立的 tasks 表**）——与产出工件同源，可被 `rel ... tracked-by` 挂到节点（`task add --node` 一步到位，`task:<id>` 也是合法引用类型）。

### produce spec / design：工程产出形态

```bash
ygl-trees produce spec <title> --body|-f ...              # 需求规格工件
ygl-trees produce design <title> --body|-f --design-type ui-ux|arch|decision
```

`design_type` 存进 `artifacts.meta` 信封；ui-ux 用 [DESIGN.md](DESIGN.md) 格式（google-labs-code：YAML tokens + rationale 节序 + lint 工具链），arch/decision 用 ADR 三段。方法详见 `ygl-trees-design-capture` 技能。

### plugin：用户层插件（业务域扩展位，spec R14 L3）

**不改源码就能给工作台加业务域**——插件是一个普通 npm 包，导出 `apply(ctx, config)` + 可选 `commands`：

```bash
ygl-trees plugin init                                  # 建 $YGL_HOME/plugins profile
ygl-trees plugin install ./my-domain-plugin            # 本地目录自动 link:；也收 npm 包 / git 地址
ygl-trees mydom ...                                    # 插件贡献的命令组即刻可达
ygl-trees plugin config my-domain-plugin '{"k":1}'     # apply(ctx, config) 收到它
ygl-trees plugin disable my-domain-plugin              # 保留安装，启动时不挂载
ygl-trees plugin list                                  # 版本 / 状态 / config / 可解析态
```

- 契约：`export apply(ctx, config)`（可用 `ctx.database / ctx.research / ctx.techtree / ctx.webApp`）+ `export commands = { <组名>: { run } }`
- 逐插件隔离：单个插件加载失败不影响其余，汇总进启动诊断（报告落 `$YGL_HOME/logs/startup-<uuid>.log`）
- 安装走文件锁；名字按依赖键差集精确解析；`YGL_PACKAGE_MANAGER` 可换包管理器
- 示例与指南：[examples/plugin-demo](examples/plugin-demo) · [docs/plugin-authoring.md](docs/plugin-authoring.md)

---

## 三、为什么用 SQLite 而不是文件

| 需求 | 文件的做法 | 数据库的做法 |
|---|---|---|
| 来源去重 | 扫全目录比对 | `UNIQUE(project_id, url_hash)` |
| 断言溯源 | 手工维护引用 | `claim_evidence` 联结表 |
| 祖先查询 | 递归遍历 | 闭包表一次查 |
| 全文检索 | grep | FTS5 + CJK 二元切分 |
| 调度状态 | 标记文件 | `jobs` / `runs` 表 |
| 审计 | 翻日志 | `events` 表 |

CJK 检索是个坑：FTS5 默认 `unicode61` 会把整句中文当成一个 token。这里在写入时把中文按字切二元组（`科技树` → `科技 技树`），再逐 token 匹配并按命中数排序，长句也能召回。

### 数据安全（schema v8）

- **写入幂等**：`claim / evidence / query / kb / job` 的写命令按内容 hash 判重，重复执行返回已存在行（`! duplicate, kept existing`），Agent 重试不产生脏数据；`--force` 显式保留重复（job 用标题序号后缀）
- **完整备份**：`db export <file>` 覆盖全部数据表（含七张科技树表）并输出逐表行数摘要；dump 自带 `PRAGMA foreign_keys` 开关，可直接重放恢复。`--lean` 跳过闭包/拓扑等派生表数据
- **PostgreSQL 镜像/迁移**：`db sync pg <url>` 把整库单向全量镜像到 PG（可刷新，供 SQL 工具/团队分析）；`db migrate pg <url> [--fresh]` 一次性完整保真迁移（FK/UNIQUE/索引约束齐全，目标库可独立持有）。两者都不做双后端同写，中文检索在 PG 侧用 tsvector+GIN 等价召回（详见 docs/pg-compat.md）。url 可走环境变量 `YGL_PG_URL`；`pg` 为可选依赖，不用 PG 则零影响
- **TypeORM 查询层**（0.8.0 起，研究域试点 `project show`）：实体是 schema v8 的类型化快照（`synchronize` 永久 false，迁移权威仍在 user_version 轨道；FTS5/PRAGMA 路径保持裸 SQL）。依赖 typeorm + better-sqlite3 + reflect-metadata
- **重复可见**：`db dups` 列出同内容多行（含迁移前存量重复）
- **自动迁移**：v2 老库首次打开自动升级 schema v3（补 content_hash 列 + 回填 + 唯一索引），无人工介入

```bash
db time-travel "<ts>"        # 工作区在历史时刻的状态
db timeline [--actor <a>] [--session <s>]   # events/day 增长视图；过滤时附最近 20 条原始事件（多 Agent 对账）
db workspace list|create    # 多工作区管理
db obsidian [dir]           # 导出 Obsidian markdown vault
```

---

## 四、调度

```bash
ygl-trees job add "nightly" --every 1440 -- "ygl-trees produce report"
ygl-trees job add "闸门探针" --every 30 -- "node ~/.local/lib/ygl-trees/tmp/dsh-tree-probe.mjs"   # 树自带节奏化监控（0.79.1 实证用法）
ygl-trees job tick          # cron 每分钟调它，只跑到期的任务
ygl-trees job logs
```

`job tick` 幂等，重复执行安全；并发安全（mkdir 锁，活锁跳过、>15 分钟陈旧锁自动抢占），并回收被杀进程留下的悬空 run（>30 分钟，rc=126）。

---

## 五、给 Agent 的入口

```bash
ygl-trees agent brief      # 我在哪、有什么、下一步做什么
ygl-trees agent match "…"  # 这个任务该用哪个 skill
ygl-trees agent ask "<question>"     natural language interface
  agent log        # 审计事件流
```

`agent brief --json` 直接给出结构化状态和建议动作序列，Agent 可以照着执行。

## 五b、开发与运维工具

```bash
pnpm test          # 四段制回归：build + unit (vitest 967 例) + demo（128 条断言）+ contract:audit（144 项）
pnpm bench         # 性能基准七席（startup/写路径/检索/索引），每席含 RSS 内存端点 → tmp/bench-results.json
pnpm verify:run    # 验证器组合入口：submit → prepare → run 串接（rc 只表达过程错误，overall 不进退出码）
node scripts/meta-tooling.mjs [--check]   # verify/meta.json tooling[] 登记维护（charter R3 登记制）：刷新/比对 sha256，--add <path> --role <role> 追加
ygl-trees verify meta .                   # 本仓元验证（R1–R3 + R5a，meta_index_version 2）；contract-audit 12 也跑它
node benchmarks/bench.js --quick   # 缩小规模快速跑
pnpm pack:check    # 发布就绪门禁：打包 → 隔离安装 → 驱动发布产物跑命令面 + --json 纯净性
pnpm pack:repro    # 可复现打包：mtime/owner/顺序/gzip 全固定，同一 commit 任意机器 sha256 相同
ygl-trees --version    # 打印版本号
ygl-trees llms          # 结构化能力清单（LLM 参考一次性获取全部命令面）
pnpm contract:audit # 写路径契约体检：写命令跑两次必须 rc=0、重复回执 duplicate、坏引用点名、用法 rc=2
pnpm smoke:bun     # Bun 运行时探针（Windows 当前受阻，见 docs/bun-compat.md）
ygl-trees doctor   # 工作区健康检查 10 项（--fix 一键安全修复）（schema/索引/FTS/重复/孤儿/config/锁存活/eval 信封/插件 profile/幻影写入）
ygl-trees db unlock    # 清残留 .ygllock：查 pid 存活，死 pid 直接清；活 holder（回显其命令行）拒绝并说明，--force 才强清
ygl-trees node timeline <tree>   # 单树成长时间线（add/link/unlock 事件倒序）
ygl-trees webui serve  # React 富客户端（http://127.0.0.1:8642/，SSE 实时推送，Ctrl+C 停）
ygl-trees webui serve --help   # 打印用法即退出，不启服务（0.79.1：--help 短路）
ygl-trees webui export --out d.json     # 服务形态快照（与 /api/data 同载荷；HTML 仪表盘已于 0.88 退役）
```

**锁身份（0.79.1）**：`.ygllock` 里除 pid 外记录**持有者命令行**；撞锁报错、`db unlock`、`doctor`
三处都会回显真实持有者（如 `node bin.cjs node unlock trend-collector`），不再把 CLI 会话误标成
serve。serve 从不取写锁（WAL 并发读写安全），`db unlock` 也以无锁模式启动——自己的诊断命令
不该被诊断对象卡住。

**多会话安全（0.79）**：`tree use` / `project use` 全部落 `tree.use` / `project.use` 事件（带
`YGL_SESSION` 会话标识）；`agent brief` 的 `selection_changed` 字段暴露最近 10 分钟的选择变更，
跨会话变更会置顶提示命令带 `-t/-p` 固定上下文。`kb add` 回执自带 `verified` 自检与工作区回显，
`doctor` 第 10 项回放近 2 天 kb/source/evidence 写事件对账基表，幻影写入当场点名。`doctor --fix`（0.82）把已知幻影标记 `reconciled`（payload 留痕、扫描跳过、审计轨迹保留）——db 恢复/导入实验造成的旧幻影一键对账。

**提交门禁（无 CI 环境的等效方案）**：`.githooks/pre-push` —— push 分支跑 `pnpm test`，
**push tag 追加 `pnpm pack:check`**；旁路只能显式 `YGL_SKIP_HOOKS=1`。安装一次：
`git config core.hooksPath .githooks`。（本仓库 Gitee Go 服务对当前账户 403 不可用，见 [docs/release.md](docs/release.md)。）

---

## 五c、WebUI

一个界面，一份载荷：

| 入口 | 是什么 |
|---|---|
| `/` | **React 客户端**（`apps/web`：@xyflow/react 水平树视图 + 时间轴 + react-markdown 产出渲染）——0.88 起唯一前端，npm 包自带 `dist/apps/web/dist`，开箱即用 |
| `/api/data` `/api/events` | 数据/实时通道（SSE 表指纹推送；`webui export` 落同一载荷的 JSON 快照） |

**诚实故障（0.88 单3）**：React dist 缺失时 `webui serve` 直接拒绝启动（rc=1，提示构建/重装命令），
不再静默回落内嵌 HTML；`/classic` 路由随内嵌仪表盘一并退役。

**中文友好**：界面标签、空态、面板文案全中文；设计系统单一事实源是 [DESIGN.md](DESIGN.md)（13 色 / 5 字号 / 9 组件，`designmd lint` 全绿）。

```bash
pnpm --filter @ygl/web build     # 构建 React 客户端（vite）
ygl-trees webui serve --port 8642
```

---

## 六、环境变量、路径与配置

- `YGL_HOME`：工作区根目录，默认 `~/.ygl-trees`
- 数据库：`$YGL_HOME/ygl-trees.db`
- `--db <file>` 可指定其他库；`--json` 全局机器输出
- `ygl-trees config list|get|set|reset`：**用户可调配置**（schema v6 `config` 表，注册表默认值 + 覆盖；写入即校验并留痕 events）。现有键：`eval.pass_threshold`/`eval.fail_threshold`/`eval.offline`、**`decision_model_llm_token`/`decision_model_llm_api_base`**（决策模型凭证与端点，**优先于**环境变量与默认网关；api_base 给主机名自动补标准路径）、`fetch.timeout_ms`/`fetch.user_agent`、`search.limit`、`default_confidence`、`job.stale_minutes`——都真实接线到对应行为
- `YGL_PG_URL`：PostgreSQL 连接串（`db sync pg` / `db migrate pg` 可用，凭证不进 shell 历史）
- `AI_GATEWAY_API_KEY`（或 `~/.vercel.ai-gateway.env`）：Gate 决策模型布尔评估的凭证（0.14.0 / spec R8——op=eval 的必检条件经评估模型判定 P(true)，灰带阈值可用 config 调整；未配置时该类条件安全回落 pending）；`YGL_EVAL_OFFLINE=1` 强制离线（优先于 config 的 eval.offline）

## 七、专属 Skills（Agent 学习/使用入口）

十二个技能覆盖工具全域，位于 `skills/<name>/SKILL.md`（frontmatter L1 + 正文 L2，可被本工具 `skill import` 直接导入，也可被宿主 Agent 的技能系统发现）：

| 技能 | 覆盖 |
|---|---|
| `ygl-trees-quickstart` | 冷启动、退出码/--json 契约、备份、PG 镜像/迁移、调度、tmp/ 规范 |
| `ygl-trees-research` | 证据先行研究管线（query/source/evidence/claim/produce） |
| `ygl-trees-knowledge` | 知识复用闭环（kb/skill/promote/agent match） |
| `ygl-trees-techtree` | 科技树建模（rel×mode、必检/可选、索引、can/ready/path） |
| `ygl-trees-eval-gates` | 决策模型评估门（三题型：boolean/choice/score、三态灰带、混批、离线安全） |
| `ygl-trees-tree-building` | 树构建方法论（领域分解四步、tier 语义、反模式立靶、≥30 节点自检清单） |
| `ygl-trees-relating` | 关联织物方法论（rel 词汇表、何时挂什么、防平行流水线反模式） |
| `ygl-trees-design-capture` | design 捕获法（ui-ux=DESIGN.md 格式、arch/decision=ADR 三段、挂接纪律） |
| `ygl-trees-verify` | **验证器全线**（submit 冻结材料 → prepare 构造判据 P0–P5 → run 七型检查器 → report/trace；归档链、封包签名、递归自校验） |
| `ygl-trees-ops-patterns` | 自动运维三件套（采纳监测、预测回测巡检、边界巡检 patrol） |
| `ygl-trees-repo-research` | 开源项目研究法（作者意图树、发布史与社区证据） |
| `ygl-trees-lifecycle` | **更新时机与维护节奏**（事件→动作触发表、改结构后必索引、解锁后必挂证据、会话收口纪律、漂移反模式） |

`.agents/skills/` 下为指向 `skills/` 的目录联接（Windows junction，不入库）。克隆到新机器后一行重建：

```bash
node -e 'const fs=require("fs"),p=require("path");fs.mkdirSync(".agents/skills",{recursive:true});for(const s of fs.readdirSync("skills"))fs.symlinkSync(p.resolve("skills",s),p.join(".agents/skills",s),"junction")'
```

## 八、反馈

用得顺手或踩了坑都欢迎留痕：[Gitee Issues](https://gitee.com/NelsonLongXiang/ygl-trees/issues)——仓库自带**问题反馈**与**功能建议**两套模板（`.github/ISSUE_TEMPLATE/`），报 bug 时带上 `ygl-trees --version` 与 `ygl-trees doctor` 输出最省事。

## 九、文档地图

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | **Agent 常驻守则**（仓库布局、命令、契约、开发规则——入口文件） |
| [CHANGELOG.md](CHANGELOG.md) | 逐版本聚合 |
| [docs/research.md](docs/research.md) | 初始调研与差距分析（历史归档） |
| [docs/spec.md](docs/spec.md) | 需求规格与验收标准（R1–R14） |
| [docs/plan.md](docs/plan.md) | 开发计划与逐版本执行记录 |
| [docs/conventions.md](docs/conventions.md) | 数据模型应用规范（加表九触点、幂等决策树、FTS 纪律、TypeORM 边界、tmp/ 规范） |
| [docs/pg-compat.md](docs/pg-compat.md) | PostgreSQL 兼容方案（镜像/迁移；L2 双后端已取消） |
| [docs/layout.md](docs/layout.md) | 项目目录层级规划与设计 |
| [packages/AGENTS.md](packages/AGENTS.md) | **包级开发纪律**（插件导出契约、写路径铁律、测试/README 纪律） |
| [benchmarks/AGENTS.md](benchmarks/AGENTS.md) | 性能基准纪律（按用户路径组织、合成输入、测量纪律） |
| [docs/webui-design.md](docs/webui-design.md) | WebUI 方案（React 客户端 + 零依赖内嵌仪表盘 + SSE 实时通道） |
| [docs/plugin-authoring.md](docs/plugin-authoring.md) | 用户插件编写指南（契约、profile、config/enable、故障排查） |
| [docs/release.md](docs/release.md) | 发布流程（pre-push 门禁 / `pnpm publish` 纪律 / Windows shim 陷阱 / 标签与 Release） |
| [docs/bun-compat.md](docs/bun-compat.md) | Bun 目标运行时兼容方案（Windows 受阻：fs.openSync O_CREAT 上游缺陷 + 迁移清单） |

## 十、许可

MIT
