# Changelog

## 0.85.0（2026-10-18）会话选择分辨率（R16）+ job --at 修复 + npm SEO

- **升级注意**：跨会话不再自动继承项目选择——`project new`/`project use` 现写**会话键**（`current_project@<sid>`，sid=YGL_SESSION||DSH_SESSION_ID||"default"），旧全局 `current_project` 仅作展示/迁移兜底。多项目工作区里并行会话互踩共享指针的问题（0.83 用 --project 钉住治标）就此根治。
- **R16.1 选择分辨率**：优先级 显式 flag > env（YGL_PROJECT/YGL_TREE）> 会话键 > 全局键；`project/tree show --json` 增 `selection_source`（flag/env/session/global/only/none）；新增 `tree show`（选择来源 + 节点/边/解锁统计）。
- **R16.3 严格门禁（fail-closed）**：多项目工作区 + 选择来源 ∈{global,none} 时，`research *`、`produce *`（含 task）、`agent brief`、`project show` 一律 rc=2 单错误对象（点名项目数与前 8 项目名 + 两条出路）；工作区级命令（db/doctor/project list/kb/node/job/rel/config）不受影响；单项目工作区自动命中（source=only）零摩擦。
- **R16.4 WebUI 未选择态**：多项目未选择不再回退全局——面板显示「未选择项目」+ 可选列表 + 指引；`/api/artifact` 改按 id 直查（join projects 鉴归属，跨项目 id 404）；树面板显示选择来源。
- **R16.5 树侧护栏**：`tree new --project <未知>` rc=2 点名（原静默落空）；`tree use` 跨项目选择 WARN 不阻断；`tree use --global` 显式写全局。
- **doctor 2b selection_hygiene**：仅全局指针 + 多项目 → WARN 提示迁移；会话键健康则 pass 并报来源。
- **`job add --at` 命令面修复（Windows shim 陷阱）**：带空格的一次性计划值（`"YYYY-MM-DD HH:MM"`）两条路径都失效——前置 flag 式经 npm `.cmd` shim 被再切分成散词落入 command（flags.at 空 → "manual"）；尾式回收正则只吃单 token。现尾式正则接受裸 `YYYY-MM-DD HH:MM[:SS]`（含 `T` 连写），shim 无关路径跨平台可解析；job-at.spec.ts ×3（尾式裸/尾式引号/前置式直调）。
- **npm 可发现性（npm-seo）**：package.json 补 `keywords`（research/ai-agents/tech-tree/knowledge-base/cli/mcp 等 15 个）+ 描述改为英文检索词前置（中文品牌后置）——此前 `npm search research workbench` 完全不命中，keywords 字段 undefined。
- 测试：selection.spec.ts ×11（spawn 端到端：门禁/豁免/三路放行/ghost 点名/单项目/calibration --all 工作区豁免）；demo 5m 段 ×4 → 122；契约 +6（R16 门禁/豁免/calibration --all/会话恢复）→ 93；webui SSE 用例随会话化修正。

## 0.84.0（2026-10-18）判定落账：claim.eval 事件 + 校准读出

- **链接自动评估修复（截断缺陷）**：`claim link` 的自动置信度评估此前是 fire-and-forget——CLI 短进程在网关调用（3-5s）结算前退出，评估从未落账（工作区 112 次 link 零 `claim.eval` 事件）。现在 await 结算后写事件再打回执。
- **JSON 纯度修复（顺带抓到）**：`--json` 模式下 [模型] 行曾污染 stdout（对象后追加文本，违反契约②）。现在评估先结算、`model_label`/`model_confidence` 并入 JSON 对象，人类视图只在非 json 模式输出。
- **手动评估落账**：`claim evaluate` 在线成功时写 `claim.eval` 事件（mode: manual，含 human_status/human_confidence/evidence_count）——判定史从 stdout 蒸发改为可对账。
- **新增 `research claim calibration [--all]`**：每断言最新评估胜出，模型档位（A/B/C/D→4/3/2/1）vs 人工仲裁档位（supported/contested/refuted→4/2/1）档差表 + `模型低≥1档` 份额——直接测量"决策模型置信度系统性低于人工一档"预测（判据 ≥60%）。
- 离线安全不变：无凭证回落离线提示、零事件、rc=0；demo 5l 断言 ×4；单测 claimeval.spec.ts ×4（spawn 端到端——只有端到端能抓进程退出截断类缺陷）。

### 0.84.0 评审修复（REVIEW-0.84.0.md 四 P1 + tmp/review-0.84.0.md F2-F4）
- **P1-1**：`claim calibration` 的 `evaluated` 曾报全工作区 claim.eval 数——`-p` 项目模式下分母虚高、份额失真；现按同口径计数（`evaluated === rows.length`，spec 断言锁定）
- **P1-2**：`pnpm test` 顺序改 `build → test:unit → demo → audit`（claimeval.spec 依赖 dist/bundle/bin.cjs，干净克隆原顺序必挂）；spec 另加 BIN 缺失守卫（describe.skipIf + 指路 pnpm build）
- **P1-3**：demo / contract-audit / readme-verify 三脚本 scratch home 改 `mktemp -d` + `trap … EXIT` 清理（并发门禁互删数据实测事故；$$ PID 后缀仍可跨 shell 撞），`YGL_DEMO_HOME` 覆盖口子保留
- **P1-4**：db 缺失路径 `--json` 纯度（`bin.ts` no-db 分支曾输出"错误对象+人类 3 行"）——提示走 stderr，stdout 单对象；契约审计 +1 用例（86→87）
- **F2/F4**：`claim link --by-source` 批量路径补齐评估落账（此前校准数据源盲区）；duplicate link 不再付全价网关评估（回执如实带 `duplicate:true`）；link 后置评估抽成公共函数
- **F3**：research/pipeline → ops/tools（eval-enhance）跨域依赖在 package.json 如实声明 + packages/AGENTS.md 例外清单补记（架构待办：下沉 core/ 或 Cordis 服务注入）
- **#6 文档**：AGENTS.md 契约计数 73→87、demo 断言数改"以运行时实测为准"；llms.txt 刷新至 0.84.0；readme:verify 新增 llms 版本头一致性断言

## 0.83.1（2026-10-17）job 运行史持久化热修
- **`jobFinish` 漏传 runId（UPDATE 静默 no-op）**：`UPDATE runs SET finished=?,rc=?,output=? WHERE id=?` 的参数数组只有 3 个值——缺失的占位符绑定为 NULL，WHERE id=NULL 匹配 0 行且不报错。后果：**runs 运行史从未落库**（rc/output/finished 恒空，job logs 看到的 rc 全部来自 reaper 兜底）；jobs 侧的 last_run/status 更新正常，掩盖了缺陷。在验证 0.83 到期巡检任务的落库输出时捕获。demo §7 增回归断言（job run 后 runs 表 rc=0 可读回）→ 114

## 0.83.0（2026-10-17）并发防护：指针钉住 + 半写拒绝 + 帮助面
- **写命令长旗标钉住**（用户上报①，最重：并发会话两次劫持共享 current-project 指针，资产碎片化跨 3 项目）：`research *` / `produce *`（含 task）/ `project *` 全部接受 `--project <p>` 长旗标，`node *` 接受 `--tree <t>`（短旗标 `-p`/`-t` 不变；`node import --tree` 仍是目标树名，别名不遮蔽）；source/evidence/claim/task 写回执带 `· project <名>` 回显落点——写错项目当场可见，不必事后对账
- **`source add --query` 半写防护**（上报①：attach 失败仍落源）：引用不存在时**先拒绝后写入**（rc=1 点名、零落地），不再"源已落、链接失败"；attach 落库后失败的路径改报已落 id + `research query attach` 重试指路
- **`--help` 任意深度**（上报②：`kb add --help` 不识别直接 rc=2）：任意子命令带 `--help` 打印所在组的用法切片 rc=0（`--json` 返回 `{help}`），在 flag 校验与 db boot 之前短路；`webui serve --help` 等原有短路兼容
- **no-db 报错点名工作区根因**（上报③：`db init` 前报错不提示 YGL_HOME）：无库时错误带 `workspace: <path>` 与来源（YGL_HOME 显式 / 默认 ~/.ygl-trees），冷启动错环境一眼可辨
- **`node can --eval` attachments 快照**（建议④：P 值过了看不出吃了哪些 rel 证据）：输出回显本次判定实际吃到的 rel 挂接——`--json` 增 `eval_attachments[]`，人类视图 `attachments ×N:` 逐条（rel ← type:id 摘要），复现不必翻库；无挂接时字段省略（字节兼容）
- **job 子命令无锁启动**（建议⑤配套）：`job run/tick` 的子进程带 `YGL_SERVE=1` 启动——此前 runner 自持应用级写锁，任何 `ygl-trees …` 型任务命令必撞自身死锁（rc=1 "locked"）；WAL 并发读 + SQLite 层写串行，与 webui serve 同推理。到期巡检范式：`job add "到期巡检" --every 1440 -- ygl-trees node cond --due --days 30`（真实工作区已挂，30 天窗口即刻命中 w1 三门槛）
- 测试：demo 5k 段 7 断言（--project 钉住 / 落点校验 / 半写拒绝+零落地 / --help rc=0 / attachments 快照）+ 5h `--tree` 别名断言 → 113；readme-verify +3（kb add --help、source add --project、node list --tree 点名）→ 46

## 0.82.1（2026-10-17）预测生命周期护栏：挂证据 ≠ 仲裁
- **`claim link` 不再抢跑预测仲裁**（用户上报③：`--stance supports` 自动把 [预测·…] 断言置 supported，predict audit 判 supported||refuted → resolved——预测刚挂证据就退出跟踪表，实际无人仲裁）：预测前缀断言挂证据时跳过自动晋升，状态保持 unverified 直到显式 `claim resolve` / 到期回测；证据链接与 stance 照常落库，回执明示 `auto_promote: false`（`--json` 返回 `{claim, evidence, stance, status, auto_promote}`）；普通断言的自动推导不变（回归护栏）
- **`claim unresolve <claimId>`**（建议②：误晋升后无归位命令）：复位通道把断言重置回 unverified（撤销链接副作用 / 抢跑仲裁），幂等（已 unverified → `duplicate:true`），落 `claim.unresolve` 事件留痕——0.82.1 前被误晋升的预测可用它归队
- **predict audit `--json` 覆盖确认**（建议③）：`--json` 始终输出全量 rows（含 resolved 终态行），人类视图默认隐藏终态——机器读全量、人看增量，同构无缺口
- 测试：predlink.spec.ts 5 例（预测不晋升 / 普通照常推导 / unresolve 复位+事件 / 幂等 / 坏 id 点名）→ 177；demo 5j 段 5 断言（挂证据不晋升 / 普通推导回归 / unresolve 复位 / 幂等 / 复位后仍在跟踪表）→ 106

## 0.82.0（2026-10-17）跨树巡检 + 临期 eval 门槛 + 幻影对账一键修复
- **`node ready --all`**（用户建议②：12 棵树巡检要 24 条命令——每树 tree use + ready）：一次进程扫全部树的就绪集，无需 tree use / `-t`；`--json` 返回 `[{tree, ready[]}]`，人类输出按树分节
- **`node cond --due [--days N] [--eval]`**（建议③：w1/d90 检验依赖人记得看）：扫描全部 eval 族条件，提取问题文本中的 `YYYY-MM-DD` 期限，列出 N 天内到期（含逾期）的条件（树/节点/deadline/剩余天数）；`--days` 放宽窗口（默认 7）；`--eval` 逐条组装上下文包送判定模型（三题型按 op 自动选择，离线安全回落 pending）——**判定只报告不仲裁**，通过 ≠ 自动解锁，resolve/unlock 保持人工（与 predict audit 同纪律）；跨树扫描前置于树解析，无当前树也能跑
- **`doctor --fix` 覆盖 write_integrity**（上报①：幻影写入事件只能围观不能修）：`--fix` 把已知幻影事件标记 `reconciled`（payload 增补时间戳，扫描豁免），审计轨迹保留不删事件；warn 文案指路。实测真实工作区：10-16 恢复实验造成的 10 个幻影（kb 47d0d78b18、source f0ad79350f 等）一键对账回 pass
- 测试：demo 5i 段 7 断言（跨树 ready / 期限提取 / --days 窗口 / --eval 离线 pending / 幻影 warn→fix→pass 全循环）→ 101；`readme-verify.sh` +2（ready --all、cond --due）→ 41

## 0.81.0（2026-10-17）命令面五处修正 + task 挂树 + 事件流对账
- **doctor write_integrity 误报修复**（用户上报①：合法 `kb remove` 后 doctor 报 phantom write fail）：`kb rm` 现在落 `kb.rm` 事件（与 source/evidence 对齐）；check 10 的幽灵扫描加 `NOT EXISTS rm 事件` 豁免，且整体降级 fail→warn——无 rm 事件的缺行可能是 0.81 前的合法删除或 db sql 手工清理，不值得炸掉脚本门禁
- **`--url` 收任意 scheme**（上报②：a2a:// 被拒，跨 Agent 引用被迫落盘）：正则放宽为 RFC-3986 `<scheme>://`，https/file/session/a2a/… 均可；url_hash 去重照常兜底
- **`node list` 未知旗标点名 rc=2**（上报③：`node list --tree X` 静默吞 flag 列出当前树——冻结契约⑤违约）：允许集 {t, json, no-color}，其余旗标点名拒绝并指路 `-t <tree>`
- **`node cond add|rm` 动作词**（上报④：`cond add p0` 被解析成 key="add" 报 node not found）：add/rm/remove 动作词前置，与 link/unlock 风格一致；**新增 `node cond rm <key> --name <n>`**（此前只能 db sql 手工清理）——事务删除 + `node.cond-rm` 事件 + 缺失时点名并列出该节点剩余条件名
- **rel 节点引用的错误指引**（上报⑤：裸 `node:<key>` 在 current_tree 未设时报泛型 not found）：无当前树 →「qualify as node:<tree>/<key> 或先 tree use」；有当前树但未命中 → 附「searched current tree 'X'」
- **`claim add --confidence` 数值档**（建议⑥）：A|B|C 之外收 0-1 小数与 0-100(%)（0.92 / 85% 原样入库，列仍 TEXT）；nonsense 仍 rc=2
- **`task add --node <tree>/<key>`**（建议⑦：task 与 rel 织物脱节）：建任务同时挂 `tracked-by` 关系；`task:<id|title>` 成为第九类引用类型（REL_TYPES 8→9）
- **`db timeline --actor <a> --session <s>`**（建议⑧：多 Agent 并发对账）：按 events.actor / payload.session 过滤增长视图，过滤时附最近 20 条原始事件尾
- 测试：`condrm.spec.ts` 3 例（自然键删除+事件 / 点名+剩余条件 / node not found）、`rels.test.ts` +1（task 引用解析）→ 单测 172；demo 5h 段 12 断言（含 doctor warn 降级、a2a://、confidence 三态、task --node、timeline actor、无树指路）→ 94；README 修复 db 命令表被 PG 段落吞并的排版缺陷 + `db timeline --actor` 文档

## 0.80.0（2026-10-17）rel 织物并入 eval 上下文 + 会话内裁决载体
- **eval 上下文包并入 rel 挂接摘要**（用户实测发现：裁决已 `decided-by` 挂链，P 仍 0.30，必须 `--state k=v` 手动携带事实才 0.92）：`evalContext` 新增 `attachments`——节点挂接的 relations 双向查询（≤12 条），claim 摘录 text+status+confidence、evidence 摘录 quote（截 120 字）、kb/source 标题、node key+name、其余 id-only；无挂接时字段缺省（与旧形状逐字节兼容）
- **`research source add --adjudication "<裁决摘要>"`**：会话内裁决原生载体——url 自动 `session://adjudication/<yyyymmddhhmm>`，摘要兼作缺省标题；`--url` 校验放宽收 `session://`；裸 `--adjudication` 旗标缺值 rc=2
- 测试：`packages/techtree/model/tests/evalctx.spec.ts` 5 例（无挂接兼容 / decided-by 摘要 / 反向 evidenced-by / 截断与悬空退化 / 12 条上限）；`scripts/readme-verify.sh` +1（--adjudication rc=0）

## 0.79.1（2026-10-17）锁身份 + serve --help 短路 + 批量判定 + 回测状态桥
- **异常①锁归属**：`.ygllock` 记录持有者命令行；撞锁报错、`db unlock`（含 `holder_cmd` JSON 字段）、`doctor` 三处回显真实持有者身份——CLI 撞 CLI 不再被误标为 serve（serve 从不取写锁，报错明示这一点）
- **异常②**：`webui serve --help` 短路打印用法即退出，不再直接启动服务（随机端口误触发实证）
- **异常③**：serve 写锁警告改为如实措辞（WAL 并发读写安全，批量写才建议停 serve）
- **回归修复**：无锁进程（serve / db unlock）退出不再误清并行会话的活锁（ownsLock 所有权守卫——自 serve 时代潜伏的 unconditional releaseLockFor）；`db unlock` 改为无锁模式启动，自身诊断命令不再被诊断对象卡死，其"活 holder 拒绝/--force/死 pid 清理"三条路径首次真正可达
- **特性①** `node can` 批量判定 + `--state-file <json>`：多键一进程（探针冷启动 1s×N → 1s）；状态袋两种形状——扁平计数共享 / 按节点 `{key: bag}` 各取各袋；多键 `--json` 返回数组；`ready --state-file` 同步支持（扁平）
- **特性②** `job add` 接探针实证可用（任意命令 + `--every N` 本就支持，README 补闸门探针模式）
- **特性③（m02806）** predict audit：已 `claim resolve` 的预测默认隐藏（回测终态 resolved），`--all` 查看全表；空表提示
- **特性④（m02801）** predict audit `--state <file|url>`：外部计数桥接（HTTP 3s 超时 / 本地文件），嵌套对象扁平化（`{counts:{y:12}}` → `counts.y=12`），判据裸键名后缀匹配（`y_imported≥12` ← `counts.y_imported`，实测列显示来源键）；加载失败回落 manual 并警告
- 修复 `node can` 无 `--state-file` 时误报 usage rc=2 的回归（demo 门禁当场抓获——无标记路径此前未测）
- 单测 163（+7：state 桥接/后缀匹配/resolved 终态/loadStateSource）、demo 82（+8：5g 锁身份+批量+状态桥）、readme:verify 38（+4）

## 0.79.0（2026-10-17）真实用户反馈硬化（四异常 + 六特性）
- **报告②新命令** `db unlock`：清残留 .ygllock——pid 存活检测，死 pid 直接清；活 holder（并行会话/serve）拒绝并解释，`--force` 才强清；自持锁（boot 期间获得）自清不死锁
- **报告②** doctor 锁检查升级 pid 存活判定：外进程活锁=PASS（多会话正常态），死 pid 才告警；`--fix` 只清死锁（此前会误删并行会话的活锁）
- **报告③** 选择变更事件化：`tree use`/`project use`/`tree new`/`project new`/`node import` 全落 `tree.use`/`project.use` 事件（带 `YGL_SESSION`）；`agent brief` 新增 `selection_changed`（最近 10 分钟），跨会话变更置顶提示带 `-t`/`-p`
- **报告③** node not found 增强：key 在其他树 → 点名树并给 `-t` 提示；不存在 → 显示当前树名（并行会话翻转 current_tree 后错误自解释）
- **报告①** kb add 回执自检：提交后立即 kbGet 回读，`--json` 带 `verified:true` + `workspace`；人类模式回显 `@ <home>`（防写错 home 的"丢笔记"）；doctor 第 10 项 write_integrity：回放近 2 天 kb/source/evidence 写事件对账基表，幻影写入点名
- **报告④** claim link 三 id 纲目修复：误传来源 id → 列出该来源证据 id + 建议；无证据来源 → 提示先 evidence add；`--by-source` 批量挂齐来源下全部证据
- **报告⑤新命令** `node timeline <tree>`：单树成长时间线（add/link/unlock 事件倒序 30 条）
- **报告⑤** `research evidence add --file <path>`：长摘录免 shell 转义（与 --quote 互斥，空文件 rc=2）
- **确认①** produce spec 拒绝 `--design-type`（rc=2 并指向 produce design）
- **确认②** project new 回执提示前项目不再选中 + 回切命令
- 单测 156（+5：pidAlive/lockHolder 语义）、demo 74（+5：5f 反馈硬化断言）、contract 86

## 0.78.0（2026-10-17）预测回测管线
- **新命令** `research predict audit`：扫描 [预测·N天] 断言——deadline 解析（显式日期优先,created+horizon 推导兜底）、本地可测判据自动实测（树/kb 计数,或语义 any-hit）、npm 版本数 registry 探测（3s 超时,--offline 关闭）
- 判定四态：hit / miss / pending（含已达标标记）/ manual（外部判据）——只报告不仲裁,给出待 resolve 命令建议
- 修复 lifecycle 测试并行负载超时抖动（5s→20s 余量）
- 解锁 pred-val/backtest-pipeline（能力落地即解锁）

## 0.77.3（2026-10-17）node list 位置参数 UX + 树漂移修正
- **UX**：node list <tree> 位置参数现在真的选中该树（此前静默忽略并回退 current_tree——巡检中实际踩中）
- 非树名位置参数给显式提示而非静默误导；-t 标志仍优先
- 树漂移修正：v2-roadmap 三个已实现节点解锁（time-travel/nl-interface/multi-workspace，138/154=90%）

## 0.77.2（2026-10-17）JSON 纯净性修复
- **契约修复**：unknown-group 错误路径的 try 提示不再泄漏到 --json stdout（冷启动之旅实测发现）
- degraded mode 提示在 json 模式改走 stderr
- 冷安装全链路验证通过（npm install → init → doctor → research → tree → kb → webui）

## 0.77.1（2026-10-17）DEP0190 hotfix
- 所有 shell:true 消除（resolvePm 的 where/version 检查改用无 shell 调用）
- plugin install/remove 零弃用警告

## 0.77.0（2026-10-17）plugin 安全加固 + DEP0190 消除
- **P0 修复**：plugin install 坏路径不再被记录——存在性校验 + package.json name 校验（a2a 7aa5c871）
- **P0 修复**：StartupError 时 plugin 命令走 degraded mode——坏插件不再砖死 home，plugin remove 自愈可用
- **P1 修复**：启动失败退出码 rc=1（修复前 rc=0，违反冻结契约）
- **P2 修复**：包名从 package.json 读取真实 name（不再退化为 basename）
- **DEP0190 消除**：pnpm spawn 改用 cmd /c 显式调用（不再传 args 给 shell:true）

## 0.76.1（2026-10-17）--ai 多 Agent 支持 + ctx.emit 桥接
- **skill link --ai <agent>**：一键连接到多种 AI Agent 的技能目录——pi(~/.pi/agent/skills/) · claude · cursor · windsurf · custom(--to)
- **ctx.emit 桥接**：eventbus 内部事件自动转发到 Cordis ctx.emit——插件可用 ctx.on("ygl") 监听（文档承诺兑现）
- **plugin-authoring.md**：补 ctx.on 事件监听用法

## 0.76.0（2026-10-17）Cordis 深化——生命周期+事件驱动（A2A 任务 fedc7ab9）
- **生命周期真实化**：DatabaseService 补 stop() 钩子（关 SQLite + 释放 .ygllock + 关 ORM）；bin.ts finally 走 Service.stop() 链（fallback DB 仍手动收口）；3 项单测证明 boot→stop 后资源释放
- **事件驱动真实化**：新建 eventbus（EventEmitter 单例）；logEvent 落表后同步 emitEvent（node.unlock/kb.add/claim.resolve 等）；webui SSE 升级为事件驱动即时推送（1.5s 轮询保留为兜底）
- **env 命名文档化**：env.ctx（fmt 输出）vs env.cordis（Cordis 运行时）——AGENTS.md 新增对照表
- **插件增强**：用户插件可通过 eventbus 的 onEvent/onEventKind 获得反应能力

## 0.75.1（2026-10-17）npm 包修复 hotfix——skills/ 确认进入 tarball
- 0.75.0 发布时 files 字段更新未被 pnpm pack 拾取（时间窗口 bug）——0.75.1 确认 12 个 skills 文件在 tarball 中
- 包大小：352KB → 381KB（+29KB = 9 个 SKILL.md）
- 验证：干净安装 → node_modules/ygl-trees/skills/ 存在

## 0.75.0（2026-10-17）npm 包修复——skills/ 进 tarball + 乱码修复 + fail-loud
- **修复（P0）**：npm tarball 现在包含 skills/ 目录——9 个内置技能随包分发，db init 的 "auto-imported" 承诺兑现
- **修复**：autoImportBuiltinSkills 找不到技能时不再静默返回 0——显式警告 "skills/ directory not found"
- **修复**：Linux 管道/重定向输出乱码——ANSI 颜色严格检测（isTTY===true 才开色）+ NO_COLOR/FORCE_COLOR 环境变量支持
- files 字段：dist + ygl.bundle.json + README + docs + CHANGELOG + llms.txt + **skills/**

## 0.74.0（2026-10-17）export-markdown + v2 测试 + 技能同步
- **db export-markdown**：一键生成工作区 Markdown 报告（Summary/Projects/Claims/Knowledge/Trees）
- **v2 功能测试**：6 项新单测覆盖 time-travel/timeline/workspace/obsidian/help-suggestions/llms-sections
- **技能同步 v0.73.0**：quickstart/knowledge/research/techtree 全部更新到最新命令面
- **141 单测**（+6）

## 0.73.0（2026-10-17）引导增强 + Token 优化 + A2A 修复
- **首启引导**：无数据库时显示 Welcome + 3 步入门指南
- **空态引导**：列表为空时显示具体命令建议（kb/project/task）
- **Token 优化**：表格列 40 字符截断 · brief 技能描述 60 字符 · 输出减 24-28%
- **A2A 修复**（应用测试席反馈）：F1 agent ask 子进程锁自撞（YGL_TEST 旁路）· F2 timeline --json 纯净 · F4 job 子进程锁旁路
- **命令建议**：未知命令模糊匹配（rsrch→research · databse→db · healh→doctor）

## 0.72.0（2026-10-17）v2 功能包——8 项新能力
- **db time-travel**：查询过去某时刻的工作区状态（实体计数+已解锁节点）
- **db timeline**：工作区增长可视化（events/天 + 实体里程碑）
- **db workspace list/create**：多工作区管理
- **db obsidian**：导出为 Obsidian markdown vault（frontmatter 兼容）
- **agent ask**：自然语言接口（关键词路由到 CLI 命令）
- **skill init**：模板创建新技能（引导式）
- **skill refs**：展示技能关联引用（L3 渐进披露）
- **llms --section/--json**：节选输出 + 结构化 JSON
- **help 引导**：未知命令模糊匹配建议（前缀+子序列+别名）

## 0.70.0（2026-10-17）`agent metrics`——从 R11 手动测量到自动化指标
- **`ygl-trees agent metrics`**：一条命令输出工作台全量量化指标——冷启动（brief 耗时/next actions/可用技能）、知识（总量/7日增长/增长率）、研究（来源/证据/断言/验证率/证据密度）、技能（总数/命中/均命中）、科技树（棵数/节点/解锁率）、活动（7 日 events）
- **来源**：R11 冷启动量化研究的手动测量 → 自动化——从 `time agent brief` + 手动 grep 统计变为一键输出
- 135 单测全绿

## 0.69.0（2026-10-17）MCP Server——R8 研究设计的工程落地
- **`ygl-trees mcp`**：启动 stdio MCP 服务器（JSON-RPC 2.0），Claude Desktop / Cursor / VS Code 等 IDE Agent 可直接连接
- **8 工具面**（三支柱理论驱动）：agent_brief · agent_match · kb_search · claim_evaluate · tree_state · produce_report · doctor · task_advance
- **每个工具继承 CLI 冻结契约**（幂等写入、JSON 纯净、snake_case）——Agent 调用工具不需要解析命令行
- **实现**：`packages/ops/tools/src/mcp.ts`——readline stdio + JSON-RPC 路由 + `cliJson()` 子进程调用（`process.argv[1]` 自引用，bundle/源码双兼容）
- 实测：initialize ✓ · tools/list(8) ✓ · agent_brief(project) ✓ · kb_search(CJK 命中) ✓ · doctor(9 项) ✓

## 0.68.0（2026-10-17）锁设计修复——serve/CLI 共存 + PID 活锁检测 + JSON 纯净 + v9 时间纪律
- **F1（P0）：webui serve 不再持排他锁**——原实现进程级锁让 serve 生命周期内挡掉一切 CLI 命令；现 serve 跳过锁（`YGL_SERVE=1` 旁路），SQLite WAL 天然支持并发读 + 序列化写；CLI 短命令仍锁（单写者保护写窗口）
- **P1（用户反馈）：PID 活锁检测替代 15 分钟 mtime**——Windows 上 `process.on("exit")` 的 rmSync 句柄未释放时静默失败→锁残留→下进程撞白锁；现用 `process.kill(pid, 0)` 探测持有者是否存活（EPERM=活/ESRCH=死），死 PID **立即清锁**（不看 mtime），活 PID **如实报告**（不误报 stale）
- **F2：--json 模式锁错误纯净**——原锁提示文本泄露到 stdout 破坏 JSON 通道契约；现 --json 模式抑制人类提示，且提示本身也改为 PID 活锁感知（活锁不叫 stale）
- **F3：taskSetStatus 更新 artifacts.updated**——任务状态变更现在同步写 updated 时间戳（v9 纪律补漏）
- **exit 清理加固**：`beforeExit` + `exit` 双钩子 + 3 次重试（Windows EBUSY 容忍）
- **vendor/cordis bin 字段清理**：bin.js 已删但声明残留——移除
- **发布面补遗（0.68.0 后置修）**：Gitea 私仓补发 `@nelsonlongxiang/ygl-trees@0.68.0`——d950bdf 声称 "+ Gitea" 实未落上（私仓曾停留 0.66.0，npmjs 侧本就 latest）；tarball 直验通过（`.ygllock` 标记物在产物内、无 .npmrc/token 泄露）
- **pack-check.sh 语法修复 + 名字无关化**（3542ab3）：b62e866 将 `export YGL_TEST=1` 插入 `REPO=$(...)` 命令替换中部，注释吞掉 `&& pwd)` → 子壳永不闭合、脚本必死——0.68.0 的 npmjs 发布实际绕过了发布门禁；修复后 tarball glob/BIN 发现兼容 scoped（Gitea）与 unscoped（npmjs）双名

## 0.67.0（2026-10-17）WebUI antd 迭代——Ant Design 组件库升级 React 客户端
- **antd v6 + @ant-design/icons**：专业组件库驱动的富客户端
- **组件替换**：Layout（Header/Content）、Card 统计卡片、Statistic 数字展示、Table 任务清单（可筛选）、Tag 状态标签、Alert 错误提示、Space/Row/Col 布局
- **DESIGN.md token 映射**：ConfigProvider theme（colorPrimary=#7c9885 sage、darkAlgorithm 暗色主题、zh_CN 中文语言包）
- **代码分割**：manualChunks 拆分 vendor/antd/xyflow/markdown 四块，antd 不阻塞首屏
- **保持不变**：xyflow 树视图、react-markdown 产出渲染、SSE 实时推送、内嵌 dashboard 回退

## 0.66.0（2026-10-17）新增 `llms` 命令——结构化能力清单（Ant Design for-agents 模式）
- **`ygl-trees llms`**：一条命令输出完整 markdown 能力清单——冻结契约表（6 项）+ 16 个命令组全部用法 + 决策模型说明 + Quick Start + 设计系统入口——**任何 LLM 一次性获取全部能力面**
- **静态 `llms.txt`**：仓库根目录，可被任何 LLM 爬取/注入上下文（同 Ant Design 的 llms.txt 模式）
- 不走 DB 路径（纯静态输出，无锁无延迟）
- README 补 `ygl-trees llms` 用法

## 0.65.0（2026-10-17）GPT-6.1 SOL 评审三项缺陷修复
- **① cost_mul 折扣方向反转**：原实现 `!pass` 才打折（条件不满足反而优惠），README 承诺"满足条件则成本打折"——修为 `pass` 才应用折扣；补 2 例单测（条件满足→0.8 / 不满足→1.0）
- **② DB 锁主路径接通**：DatabaseService 构造改传 `{lock: true}`（原仅 profile-boot 回退路径加锁，但 base bundle 必走 Service 路径→锁永不生效）；保留 YGL_TEST=1 旁路
- **③ node path 帮助文案修正**：原承诺 "cheapest unlock order" 但 OR 分支未做最省选择——改为如实描述 "dependency-order path (OR branches not optimized)"；readme:verify 34/34 通过

## 0.64.0（2026-10-17）最终文档同步——skill link / kb rm / --host / --fix 全部入档
- README + quickstart 补 `skill link [--global]`
- readme:verify + 全量门禁

## 0.63.0（2026-10-17）新增 `skill link`——一键软连接技能到 .agents/skills
- **`ygl-trees skill link [--global]`**：对 `skills/*/SKILL.md` 建 junction——默认到当前工作目录 `.agents/skills/`，`--global` 到 `~/.agents/skills/`；自动创建目标目录；幂等（已存在的跳过）；输出连接清单
- 效果：DSH / Claude / 其他 Agent 技能发现机制即刻可用，不再需要手动建 junction 的 Node 一行代码
- 同步修 relations INSERT 语法错误（多余括号 + 缺 created 参数——0.62 schema v9 引入）

## 0.62.0（2026-10-17）采集席 P1+P2 修复——fresh init schema 缺口 + 锁文件
- **P1（严重）：全新工作区 research 链不可用**——`db init` 的 SCHEMA_SQL 缺 v9 列（sources.created / claims.updated / artifacts.updated / node_conditions.created），upgrade8to9 的条件 `v>0 && v<9` 在 fresh init（v=0）时不触发 → fresh 库无这些列 → `source add` 报 `no such column: Source.created`。修：SCHEMA_SQL 直接包含全部 v9 列（init 即 v9 完整 schema）
- **P2：clean clone 无法 `--frozen-lockfile`**——锁文件重生成（清理 vendor/cordis 多余 plugin 条目 + .npmrc autoInstallPeers=false 与锁文件对齐）
- **UNIQUE 59 口径**：来自迁移前 SQLite 侧的 `sqlite_master` UNIQUE 约束计数（含 PK 的隐式 UNIQUE），PG 侧因 PK/UNIQUE 实现方式不同导致数字不一致——非错误，但口径应统一为 PG 侧 `pg_constraint` 计数
- 附带修复：claimAdd 创建时设 `updated = nowIso()`（v9 NOT NULL 约束，前一轮已修 `6927379`，此处确认）

## 0.61.0（2026-10-17）终态同步——0.57-0.60 变更同步到技能面 + README
- **技能更新**：quickstart 补 kb rm / doctor --fix / webui --host / PG preflight；research 补 --relevance 整数校验；knowledge 补 kb rm
- **README**：kb rm / --host / --fix 新命令
- readme:verify 34/34 全绿

## 0.60.0（2026-10-17）用户六条反馈全修——lockfile 卫生 + kb rm + webui --host + PG 预检 + doctor --fix
- **① lockfile 卫生**：`.npmrc` 创建（`auto-install-peers=false`，消除 pnpm 9 默认值差异导致的 lockfile 漂移）；lockfile 清理 tmp 绝对路径污染（-381 行）
- **② relevance 值域**：已修（0.59），确认生效
- **③ `kb rm <id>`**：命令面补齐（skill rm 有而 kb rm 无——不对称迫使裸 db sql DELETE）；not-found 干净 rc=1
- **④ `webui serve --host`**：默认 127.0.0.1（安全），`--host 0.0.0.0` 开放 LAN/WSL 访问（不再需要外部转发器）
- **⑤ PG migrate 类型预检**：迁移前逐表扫描 INTEGER 列的 typeof()，发现非整数值即报错并**点名 `table.column rowid=N: value "X"`**——排障从十分钟缩到十秒
- **⑥ doctor 语义修正 + `--fix`**：warning 态下不再同时输出"all checks passed"（改为 `checks passed (N warning)`）；`--fix` 一键安全修复（index dirty flag 清理 + stale lock 移除）

## 0.59.0（2026-10-17）relevance 值域校验——PG 迁移暴露的跨库类型陷阱（用户 R284 反馈）
- **来源**：用户在 PG 迁移（L1.5 db migrate pg）时发现 `sources.relevance` 的 REAL 值 0.95 在 SQLite 弱类型下静默落库，到 PG 迁移才爆 `invalid input syntax for type integer`
- **修复**：`source add --relevance` 现在只收整数 0-5（非整数/超范围 → rc=2 `must be an integer 0-5`）
- **护栏**：contract:audit 84→86 项（+2：REAL 0.95 拒绝 / 超范围 99 拒绝）
- **根因**：SQLite 弱类型照单全收 vs PG 强类型严格拒绝——CLI 是第一道门，不应把类型问题留给迁移时才爆

## 0.58.0（2026-10-17）时间字段补齐（schema v9）——时间是不可缺的维度
- **用户需求**：「时间是非常重要的指标」——审计发现 25 表中仅 4 表有完整 created+updated（16%），12 表完全无时间字段（48%）
- **schema v8→v9**：六表七列新增——`sources.created`（录入时间≠抓取时间）、`claims.updated`（resolve 时更新）、`artifacts.updated`（版本升级时更新）、`node_edges.created`、`node_conditions.created`、`relations.created`
- **迁移策略**：ALTER TABLE ADD COLUMN + **events 表回填**（sources←source.add 最早记录 / claims←claim.resolve 最新记录 / artifacts←artifact 系列最新记录）；结构表无 events 可溯，回填当前时间
- **实体 + 写服务同步**：Source/Claim 实体加 created/updated 列声明；sourceAdd 写 created、claimResolve 更新 updated、treeWrites.link 写 created
- **实测**：新 source `created=2026-10-16 22:27:36` ✓ · claim resolve 后 `updated=22:27:38`（变化可观测）✓ · 存量数据 11/11 回填 ✓

## 0.57.0（2026-10-17）收尾审计——修复一个从未生效的修复 + 记忆 v8
- **修复：`neverBuiltDependencies` 从未生效**——0.52 把它放在 `package.json` 的 `pnpm` 字段里，但 **pnpm 9 不再读那个位置**（每次 install 都打印警告说 "ignored"）；现在移到 `pnpm-workspace.yaml` 的正确位置，better-sqlite3 豁免实际生效
- **修复：tsdown `--external` → `--deps.never-bundle`**——消除 deprecation 警告
- **记忆 v7 → v8**：0.45-0.57 全部变更（R15、flag 校验、冷启动、React 构建、5 轮冷用户反馈）

## 0.56.0（2026-10-17）技能与文档刷新——0.49–0.55 变更同步
- **4 个技能更新**（命令面同步到 0.55）：
  - `ygl-trees-research` v0.14→v0.56：补 `claim evaluate`（决策模型置信度）+ `evidence assess`（证据质量）
  - `ygl-trees-knowledge` v0.14→v0.56：补 `kb search --eval`（语义重排）
  - `ygl-trees-techtree` v0.14→v0.56：补节点状态可见性（`node list` 状态列、`node show` unlocked_at）
  - `ygl-trees-quickstart` v0.38→v0.56：补冻结契约五项表（含 flag 校验）+ `--version` + `contract:audit` 84 项
- **README**：更新测试计数（123）、契约审计（84 项）、加 `--version` 用法
- readme:verify 34/34 全绿

## 0.55.0（2026-10-17）flag 校验护栏收口——0.54 遗留
- **contract:audit 73 → 84 项**：新增 contract 6「flag validation」——11 项断言（8 个裸 flag 拒绝 + 3 个枚举拒绝），确保 0.54 的 flagcheck 代码不被 revert 后静默回归
- **spec 补 flag 校验契约**：裸 flag → rc=2 `needs a value`（不落库为 `"true"`）；枚举非法 → rc=2 `must be one of ...`（不触发写入）——与退出码/JSON 通道/幂等等已有契约并列

## 0.54.0（2026-10-17）全命令面 flag 校验审计——14 个缺口一次关死
- **背景**：0.51 修了 P1-1/P1-2 两个 flag 校验缺口，但审计发现同类问题成片存在——**全命令面扫描**暴露 **14 个缺口**（9 个裸 flag 静默落库 + 5 个枚举未校验）
- **新增 `flagcheck.ts`**：`rejectBare(ctx, flags, names)` 裸 flag 检测 + `validateEnum(ctx, flags, name, allowed)` 枚举校验——一处定义，各命令复用
- **修复的 14 个缺口**：
  - 裸 flag（`--flag` 无值 → parser 返回 boolean `true` → 落库为 `"true"` 字符串）：
    `source --abstract/--confidence/--tags` · `claim --confidence/--text` · `kb --body/--tags` · `node --name/--kind/--tier/--cost/--tags` · `cond --name/--value/--op/--effect/--weight` · `task --note`
  - 枚举未校验（非法值静默落库）：
    `node --kind`（只收 tech|skill|quest|milestone|resource|flag）· `cond --op`（只收 >=|==|<=|!=|has|eval|eval-choice|eval-score）· `cond --effect`（只收 gate|cost_mul）· `claim/source --confidence`（只收 A|B|C）
- **效果**：任何 `--flag` 缺值或枚举非法值 → **rc=2 + 明确错误消息**（`--X needs a value` / `--X must be one of ...`），不再有 `"true"` 或 `"nonsense"` 落库

## 0.53.0（2026-10-17）React 客户端构建链缺口修复——冷用户反馈三件
- **来源**：用户在 :8322 部署后发现 `/` 显示内嵌 dashboard 而非 React 客户端（React dist 缺席 + 静默回落）
- **P1 根因修复**：`pnpm build` 现在包含 React 客户端构建（`tsc → tsdown → vite build`），新 clone 不再默认落后一态
- **P2 静默回落消除**：`webui serve` 启动时检测 React dist 是否存在，缺席则输出醒目 warn `⚠ React 客户端未构建 — 当前为内嵌 dashboard 回落态` + 构建命令——违背「显式契约」哲学的静默行为已消除
- **P3 `/classic` 永远 200**：回落态下 `/classic` 原先 404 但首页是同一内容——语义混乱；现在无论 React 是否构建，`/classic` 始终返回内嵌 dashboard（兑现「零依赖版永远可达」承诺）
- 事故链：`apps/web/dist` 缺席 → `resolveDistRoot()` 返回 null → `hasWebApp=false` → 内嵌版占 `/` → 用户看到的是简化版但**没有任何提示**

## 0.52.0（2026-10-17）真实使用反馈修复——数据安全三件 + 仓库卫生
- **来源**：用户在 :8322 部署运行后的实测反馈（含 DEV-LEDGER 483MB 事故复盘）
- **P0-1 kb import 文件大小护栏**：>1MB 的 .md 默认跳过并在 summary 列出（`--force` 覆盖）——防止 483MB 单文件把库撑到 472MB 并损坏的事故重演
- **P0-2 写库互斥（单写者锁）**：DB 构造时检测 `.db.lock` 目录，第二个进程 fail-fast 并提示（15 分钟过期自清，同 job tick 策略）；`process.on("exit")` 兜底释放——node-sqlite3-wasm 无并发写保护，两个 CLI 同时写 = malformed
- **P1 malformed 报错附带自愈指引**：`database disk image is malformed` 时输出三步恢复路径（备份→db reset→kb import 重灌），不再让用户自己悟「库可从源文件重建」
- **P2 vendor/cordis/bin.js 移出 git 追踪**：本地 `pnpm install` 会改写该文件导致每次 pull 冲突；加入 .gitignore
- **P4 --version 打印版本号**：parser 把 `--version` 吞成 flag 而非 positional——修在 flags 检查处（0.51 遗留的错位修复）

## 0.51.0（2026-10-17）冷用户验证修复——2 处数据完整性 + 2 处环境级 + 体验
- **来源**：外部冷用户验证报告（干净 clone + 全门禁 + 手工全链演练），发现 2 处校验缺口 + 4 类工程问题
- **P1-1 修复**：`research source add --title`（无值）原先**静默写入 `{"title":"true"}` 垃圾行**（rc=0 违反契约）→ 现在检测 boolean `true` 值并拒绝 `rc=2`；另增 `--url` 格式校验（须 http(s):// 或 file://）
- **P1-2 修复**：`claim link --stance nonsense` 原先**静默接受并把 supported 断言降级为 unverified** → 现在只收 `supports|refutes`，其余 `rc=2` 且**不触发任何写入**
- **P2-1 修复**：vite 升到 ^6.4（vitest 5.0.5 的 peer 要求 ^6.4||^7||^8）→ `pnpm test:unit` 在干净 clone 可跑（此前 ERR_PACKAGE_PATH_NOT_EXPORTED 启动即崩）
- **P2-2 修复**：锁文件重生成 → `pnpm install --frozen-lockfile` 通过（此前 OUTDATED_LOCKFILE）
- **P3-1**：`pnpm.neverBuiltDependencies` 豁免 better-sqlite3（自带 prebuilds，node-gyp rebuild 多余且失败）
- **P4 修复**：`--version` 现在打印实际版本号（如 `0.50.0`）而非整个 usage 文本（parser 把 `--version` 吞成 flag 而非 positional，修在 flags 检查而非 group）
- contract:audit 新增两项护栏可加入：flag 缺值 rc=2 / stance 枚举 rc=2（当前由代码修复保障，待加门禁）

## 0.50.0（2026-10-17）R15 深度集成——模型评估从手动命令变为自动行为
- **`claim link` 自动触发置信度评估**（R15 深度集成）：链接证据后静默调用决策模型，评估结果写 events 表（`claim.eval`）+ 终端提示一行 `[模型] 置信度 B (3.5/5)`；best-effort（模型失败不阻塞链接动作）
- **`produce report` 自动附带模型置信度**：报告输出各断言时，从 events 表读取最近的 `claim.eval` 记录，有则追加 `_模型置信度 B（3.5/5）_` 行——人工置信度与模型置信度并排可见
- **spec.md 补 R15 条目**（R15.1 语义重排 / R15.2 置信度评估含自动触发 / R15.3 证据质量），与 R1-R14 同格式
- **skills 更新**：ygl-trees-research 补 evaluate/assess、ygl-trees-knowledge 补 --eval
- **eval-enhance 单测 3 例**（离线安全路径：空 token → null/uncertain/不炸）；修 token 默认值逻辑（显式空串=离线，未传参=环境变量）
- 单测 120 → **123**

## 0.49.0（2026-10-17）R15：决策模型增强——语义检索重排 + 断言置信度评估 + 证据质量评估
- **R15.1 `kb search --eval`**：FTS5 召回后由决策模型逐条评估语义相关性 P(relevant) 并重排——实测：搜"插件系统"命中 drift 教程（P=0.05），模型正确判定低相关
- **R15.2 `research claim evaluate <id>`**：收集关联证据 → 决策模型综合评估置信度（0-5 分 → A/B/C/D 映射）——实测：人工标 A 的断言，模型基于证据评为 **3.5/5 → B**（比人工更保守，有依据）
- **R15.3 `research evidence assess <id>`**：决策模型评估证据来源可靠性 + 引文质量——实测：源码引文评 **2.9/5 → 中等**
- **复用 R8 基础设施**：同一模型连接（AI_GATEWAY_API_KEY / TypeSafe jev）、同一三态映射、同一离线安全（无凭证 → 显示"离线"并回退，不炸）
- **新增模块 `eval-enhance.ts`**：semanticReRank / evaluateClaimConfidence / assessEvidenceQuality 三个可复用函数，任何搜索/评估场景可调用
- 中文输出（断言/当前状态/模型评分/可靠性 全中文标签）

## 0.48.0（2026-10-17）冷启动技能自动导入——修产品入口的最后一道缝
- **问题**（冷启动实战发现）：`db init` 后的全新工作区 `agent match` 返回空——技能需手动 `skill import`，冷用户会以为工具没有能力
- **修复**：`db init` 自动导入内置 9 个技能（向上探测包内 skills/ 目录，逐技能隔离导入），全新工作区的 `agent match` **立即可用**；三种不同查询实测全命中（"插件系统设计"→quickstart / "怎么建一棵科技树"→techtree / "做调研收集证据"→research）
- **效果**：冷启动体验从「db init → 什么都搜不到 → 困惑」变为「db init → 9 技能就绪 → match 即可用」——产品入口不再有缝

## 0.47.0（2026-10-17）冷启动实战 + 完整研究闭环——产品承诺的终极验证
- **冷启动验证**：全新工作区，零上下文 Agent 仅靠 `agent brief`（给出 next_actions）+ `agent match`（命中 ygl-trees-research 技能）即上手——产品入口有效
- **真实研究（非功能测试）**：「AI Agent 插件系统设计模式对比（Cordis vs DSH vs VSCode）」——4 检索式 → 4 来源（1 网页抓取 + 3 本地第一手源码知识）→ 6 条证据摘录 → 5 条断言（全部链接证据 + 仲裁为 supported）→ outline + 对比章节 + **61 行报告**（含四维对比表与四条核心发现）
- **知识复用闭环全通**：报告 `kb ingest` → `kb promote` → 技能 `plugin-design-patterns` 生成 → **跨进程 `agent match` 命中**（换两种完全不同的问法均命中）——下次任何 Agent 问插件框架选型，L1 描述自动浮现
- **核心发现**（报告摘要）：① 粒度决定架构（VSCode 面向功能面、Cordis 面向服务、DSH 面向组合）② declare module 是 Cordis 杀手锏 ③ 有界停机 + 诊断落盘是 CLI 层必备 ④ 采纳能力 ≠ 采纳机械（loader 裁定范例）
- **产品验证结论**：冷启动→研究→产出→知识复用→下次命中，完整闭环在真实数据上走通——**工具是好用的，不只是好测的**

## 0.46.0（2026-10-17）WebUI 端到端验证 + 基准刷新（用户确认不发布 npm）
- **WebUI 全量验证**（维护后数据）：37 节点树（React 客户端水平布局）+ 34 解锁/3 锁定态可见 + 45 条边；SSE 实时推送实测（首帧 + 变更帧携带新任务标题）；`/classic` 内嵌回退 200；中文标签 8/8 命中（科技树/任务清单/产出工件/下一步操作/技能/知识笔记/断言/证据）
- **基准刷新**（0.45.0 构建，bundle 入口）：startup p50 571ms / claim-write 21.6ms/op / kb-import 2672 rows/s / kb-search p50 24ms / node-index 577ms / node-search p50 2.8ms——各席均在正常区间，含 RSS 内存端点
- **npm 发布决策**：用户明确选择「先不发布」——不再追问，待后续再定
- **用户洞察**（记录）：「你自己就是用户」——ygl-trees 面向 AI Agent，本会话中的 Agent 即目标用户，`real-users` 门槛的四个条件（非作者/真实用户/日常使用/受益）在字面上均满足；保留：热用户（知内部实现）≠ 冷用户（首次接触仅靠 brief/match 上手），后者才是生产级工具的终极验证

## 0.45.0（2026-10-17）应用 lifecycle 技能做了一次真实维护回合——挖出三处缺陷并修
- **背景**：用户要求「使用技能 ygl-trees-lifecycle」。按其 §3 节奏对真实工作区（tmp/research-dogfood）执行：`agent brief` → 对账 → 动作 → 收口 `doctor`
- **对账发现的漂移（技能 §5 反模式 #1/#6 大规模发生）**：evolution 树 **32 节点全部未解锁**，而实际已交付 0.1.0–0.44.0；且交付期间新增能力（用户插件/bundle 产物/SSE/契约门禁/JSON 错误契约）**在树上根本没有节点**（§1「未建模子能力」）
- **维护动作**：新增 5 个能力节点并挂接（`packages→user-plugins`、`packages→bundle-dist`、`webui-serve→sse-live`、`json-contract→json-errors`、`idempotency+json-contract→contract-gates`）→ **同轮** `node index`（268 闭包行）+ `node validate`（无 issue）→ 建证据链（1 源 + 6 条 CHANGELOG 原文摘录 + 6 条交付簇断言，链→resolve）→ **34 节点解锁且每个同轮 `rel … --rel decided-by` 挂依据** → 既有 report/spec/design 工件挂到相关节点 → `kb ingest` 报告 + 2 条方法论笔记 → 清理自己的临时任务 → 收口 `doctor`（all checks passed）。终态：**34 unlocked / 3 locked**（bun-runtime、npm-publish、real-users 的门槛实测仍生效）
- **顺带修的三处真缺陷**：
  1. **假状态（比缺状态更坏）**：任务「发布到 npmjs」显示 done 但从未发布——events 显示它创建后 2 秒被状态机演练走完（演练用了真实标题）。已回退为 `doing`
  2. **未宣传的能力**：`task todo` 可逆生效（实现与另一处 usage 都支持），但**顶层 usage 只写 doing|done** → 补齐；demo 增回退护栏（done→todo→done）
  3. **投影盲区**：`node_state` 权威表有解锁行，而 CLI 的 `node list/show` **不返回 state/unlocked_at**（只有 WebUI 与裸 SQL 看得到）→ **节奏纪律要求「解锁后对账」而 CLI 无从对账**；已补 `state`/`unlocked_at`（`nodeStateOf` 独立方法，**不碰写路径复用的 `nodeGet`**——多 context join 会让行数放大、`db.get` 静默取错行），`node list` 增「状态」列，demo 增 3 条断言（含锁回可逆）
- 契约兼容：JSON 只增字段（`node.list[].state`/`node.show.node.state`），不改名不删——符合「只增字段」承诺

## 0.44.0（2026-10-17）JSON 通道契约：失败也必须机器可读（+31 读/6 错误路径机械断言）
- **侦察（读侧对称体检）**：常用 21 条读命令**全绿**（纯 JSON + 零 camelCase 泄漏）；但角落与错误路径抓到两处真问题
- **修复 1：`--json db path` 输出裸路径文本**（成功路径的纯净性违规，agent 侧 `JSON.parse` 直接崩）→ 改 `{"path": ...}`
- **修复 2：所有错误写到 stdout 污染机器通道**（`--json` 下 `✗ parent not found: …`）→ `bad()` 单点修（129 个调用方受益）：json 模式输出单对象 `{"error": "<msg>"}`，rc 仍 1/2 承载类别；非 json 模式人类文本不变。另修 bin.ts 两处 `out(ctx, usage())` 在 json 模式泄漏用法转储
- **契约措辞落文档**：spec「兼容性承诺」明确 `--json` 成功与失败同样可整体 parse、`error` 非空字符串、snake_case 硬约束、人类文本只在非 json 模式；AGENTS 契约表增两行
- **门禁扩展**：`contract:audit` 增 **contract 5: JSON 通道**——31 条读命令（含角落：parents/children/ancestors/descendants/path/ready/export/validate/search）断言 stdout 可**整体** parse + 无 camelCase；6 条错误路径断言 `{error}` 形状 + rc（1 运行 / 2 用法）。门禁 37 → **73 项**，四段制全绿
- **工具化**：内联 node 校验器改为独立 `scripts/json-check.mjs`（消除 bash 内嵌引号地狱，单测与门禁共用同一判定）
- **根治推送摩擦（0.43 记录的交互）**：2 分钟钩子期间与远端零流量 → SSH 会话被远端回收 → 传输 `rc=141`。已配置 `core.sshCommand` 带 `ServerAliveInterval=20`（空闲心跳），并**用带钩子的真实推送验证**不再需要旁路；docs/release.md 记根治方案，旁路降为兜底

## 0.43.0（2026-10-17）写路径契约体检 + 常驻审计门禁（同类违规不能再悄悄回归）
- **背景**：0.42 发现 `node link` 幂等崩溃，是"写技能时顺手实测"撞出来的——说明冻结契约需要**机械化体检**而非靠人记得。先做侦察 sweep（16 条写命令 × 2 + 11 条坏引用），确认缺陷边界
- **修复 1：`project new` / `tree new` 同名幂等**——原先 rc=1 `SqliteError: UNIQUE constraint failed` 崩溃，违反「同内容重跑 rc=0 + duplicate:true」；改为**选中既有行**并回执 `duplicate: true`（`new` 同时也是切换动词），仍更新 `current_project`/`current_tree`；文本回执区分 `created and selected` / `exists, selected`
- **修复 2：`research claim link` 坏引用裸异常**——传不存在或类型错的 evidence id 抛 `FOREIGN KEY constraint failed`；改为两端预解析、点名实体（`claim not found: X` / `evidence not found: Y`）。审计确认**其余 10 条引用命令本就干净**（evidence add / claim resolve / query attach / kb ingest / kb link / rel add / task doing / node link…），纪律已在、仅漏这一处
- **新增 `pnpm contract:audit`（scripts/contract-audit.sh，37 项）**——把四类冻结契约变成可执行断言：① **幂等**（16 条写命令各跑两次，均须 rc=0）② **duplicate 回执**（project new / tree new / node link 重复须 `duplicate:true`）③ **坏引用点名**（11 条引用命令遇坏 id 须 rc=1 且消息点名实体，**断言不出现 SqliteError/constraint/TypeError 裸异常**）④ **用法 rc=2**（5 条）
- **门禁自证有效**：临时还原 claimLink 缺陷 → 门禁 34/37 红、rc=1；恢复后 37/37 绿（不是空跑）
- `pnpm test` 升为**四段制**（unit + build + demo + contract:audit），pre-push 钩子因此自动把关该项；README/AGENTS/release.md 同步
- **实测到并记录一个运维交互**：钩子跑完整门禁约 2 分钟、期间与远端零流量，Gitee 的 SSH 会话会在此期间空闲断开 → 钩子通过后的传输立刻失败（`unexpected disconnect while reading sideband packet` / `closed by remote host` / rc=141 SIGPIPE），**而门禁是绿的**。处置：以门禁输出为证据，`YGL_SKIP_HOOKS=1 git push` 重推；钩子现会主动打印这条提示，docs/release.md 记入「已知交互」

## 0.42.0（2026-10-17）新增 lifecycle 技能（更新时机）+ 修复 node link 幂等契约违规
- **新技能 `ygl-trees-lifecycle`（用户指出缺口）**：现有 9 个技能全在讲「**怎么动**」（机制）与「动成什么样」（方法论），**没有一个讲「什么时候动」**——「时机/维护/节点更新/cadence」类词汇全库零命中，agent 机制全会却在该动的时刻不动，树与研究两条流水线各自漂移。新技能补上：**事件→动作触发表**（树侧 9 行：达成→unlock+挂证据、发现子能力→add+link、路线互斥→excludes、语义门槛→eval、方向变更→先加边再索引再 unlink、重新拆解→先建后删、重复 link→幂等语义…；研究资产侧 10 行：何时 source/evidence/claim/link/resolve/kb/promote/task/produce/rel）、**节奏纪律**（改结构后同轮必 `node index`+`validate`、解锁后必挂证据、会话收口前 `brief`+`doctor`、批量改写前 `db export`）、**五个自问**判定口诀、**漂移六反模式**、与专职技能的分工表。已 junction 进 `.agents/skills`，`agent match` 四类时机查询全部命中；README 技能表 8→9，quickstart/techtree/research 加交叉引用（讲机制时指向时机）
- **修复冻结契约违规：`node link` 不幂等**（写新技能时实测暴露）——重复 link 同一 (父,子,rel) 不再报 `duplicate:true`，而是 **TypeError 崩溃 rc=1**。根因：upsert 冲突后既有行保留**原 id**，而回读用**新算出的 id** → 查不到 → 返回 undefined → 调用方读 `row.rel` 崩。修：按自然键 (parent,child,rel) 预查 + 回读，重复时回执 `duplicate:true`（rc=0，原地更新 `--mode/--optional` 即改属性）；demo 加护栏（复用已有边命中重复路径）
- 顺带修正新技能里写错的命令名（`link --rm` → 真实子命令 `node unlink`）——技能命令面也经实测核对

## 0.41.0（2026-10-17）README 前门刷新 + 客户端测试覆盖 + Bun 根因精确化
- **README 全面刷新**（265 → 350 行；规则 5「README 健康」此前跳过 0.37–0.40）：入口改为**发布产物** `dist/bundle/bin.cjs`（附开发树对照）、依赖面补 vendored cordis 家族、schema v5→**v8**；
  **新增四节**——`rel` 关联织物（八类引用 + 双向浏览）、`task` 状态机（并澄清**没有 tasks 表**，是 artifacts kind='task'、+meta 状态信封）、`produce spec/design`（design_type 信封 + DESIGN.md 格式）、**`plugin` 用户层插件**（install/config/enable/disable/list + 契约 + 隔离与诊断）；
  **新增 WebUI 节**（React 客户端 `/` vs 零依赖 `/classic` 回退、SSE 实时通道、中文友好、DESIGN.md 单一事实源）；工具节计数修正（112 单测 / 61 断言 / doctor **9** 项）+ 补 `pack:check`、`bench --quick` 与 RSS 端点、**pre-push 提交门禁**；环境变量补 `YGL_PACKAGE_MANAGER` / `YGL_SKIP_HOOKS`；技能数 5→**8**；文档地图补 packages/AGENTS、benchmarks/AGENTS、plugin-authoring、release，spec 范围 R1–R8→**R1–R14**
- **`pnpm readme:verify`**（scripts/readme-verify.sh）：README 命令示例的**文档真值门禁**——在 scratch 工作区逐条跑并断言退出码（含冻结契约 rc=2）。首跑 **34 项**即挖出两处真实顺序缺陷：① §一 的 node 示例缺 `tree new` 前置（新工作区照抄报 `no tree selected`）② `node cond steel` 用了**后面才创建**的节点（报 `node not found: steel`）——两处已修，现 **34/34 通过**
- **React 客户端测试覆盖从 0 → 8 例**（apps/web/tests/api.test.ts）：SSE 订阅建立与首帧立即拉取、帧解析投递、**接管后轮询静默**、未接管时 10s 降级仍工作、断线回落、坏帧只报错不炸、EventSource 构造失败仍可轮询、disposer 关闭连接、非 2xx 抛错
- **Bun 根因精确化（复探，取代早前描述）**：早前记录的「`fs.openSync` + O_CREAT 对不存在文件 ENOENT」在 1.3.0 下**已不复现**；真实边界更窄——**bun 进程内新建的目录，其内文件 openSync(O_CREAT) 报 ENOENT**（`existsSync`/`statSync`/`readdirSync` 与**其他进程**都说目录存在），而目录由进程外预建时**开库/建表/写入全部正常**。四个 workaround（逐级 mkdir / 中间插 IO / 原参数重试 / realpath）**实测全败**。已给最小复现 + 边界表 + 穷尽的 workaround 否定结果，判定脚本不变（`bun-smoke` pass=1/fail=10）

## 0.40.0（2026-10-17）CI 门禁（Gitee Go 不可用的等效方案）+ 发布链路 + loader 裁决
- **`.githooks/pre-push`**：无 CI 环境下的仓库级门禁——分支 push 跑 `pnpm test`，**tag push 追加 `pnpm pack:check`**（产物级）；旁路只能显式 `YGL_SKIP_HOOKS=1`（打印跳过原因，不静默）；安装 `git config core.hooksPath .githooks`
- **Gitee Go 阻塞留证**：`gitee pipeline` 全部命令返回 `giteego: HTTP 403 您无此操作权限`（两测一致）——账户无该服务权限，非配置问题；docs/release.md 记录日后接入法（`pipeline example` 取官方 YAML 基线，不手写字段）
- **发布链路打通**：`v0.39.1` tag 推送（经钩子全流程验证：`pnpm test` + `pack-check: PASS`）+ Gitee Release `id 1210127`（说明取自 CHANGELOG）；docs/release.md 补「标签与 Release」章
- **loader 架构裁决（探针实证 no-go，能力采纳）**：四轮探针证明 loader 与我们的插件模块**完全兼容**（四种形态全通、config 透传、`update()` 重配），但 ① 编译产物不暴露 `moduleNamespace`（源码有/lib 无）→ 拿不到 `commands`；② 按 specifier 运行时导入 → tsdown 不可追踪 → 用于基础插件会**破坏自包含单文件产物**。裁决记录于 vendor/README（含三项重审触发条件）
- **能力采纳（不引入 loader 机制）**：用户层 bundle 支持 `config` 与 `enabled`——`plugin config <name> '<json>'` / `--clear`、`plugin enable|disable <name>`（停用保留安装）、`plugin list` 增 state/cfg 两列；`apply(ctx, config)` 实收配置
- **修复 0.37.1 引入的契约回归**：`unknown group → rc 2` 守卫被误删，未知组改为 TypeError 崩溃（违反冻结退出码契约）——修复并加 demo 断言防复发
- demo 断言 +4（未知组 rc=2 / config 往返 / disable 后仍干净 rc=2 / enable 恢复）；单测 109 → **112**

## 0.39.1（2026-10-17）仓库级 commit 门禁（Gitee Go 不可用的等效方案）+ 发布/标签流程入档
- **`.githooks/pre-push`**：push 时自动跑仓库级门禁——分支 push 跑 `pnpm test`（单测+构建+demo），**tag push 追加 `pnpm pack:check`**（产物级验证，防未验证产物出门）；安装 `git config core.hooksPath .githooks`；旁路只能显式 `YGL_SKIP_HOOKS=1`（钩子打印跳过原因，不静默）
- **Gitee Go 阻塞留证**：`gitee pipeline` 全部命令（含最轻的服务状态检查）返回 `giteego: HTTP 403 {"msg":"您无此操作权限！"}`，两次复测一致——**账户无该服务权限**，非配置问题、无 API 可自助开通；已记录开通路径与日后接法（`pipeline example` 取官方 YAML 基线，不手写字段）
- **docs/release.md 补两章**：门禁章（现状/等效方案/旁路纪律/日后接 Gitee Go 的步骤）+ 标签与 Release 章（`git tag -a` → `push` 经钩子验证 → `gitee release create --body "$(sed -n ...)"` 从 CHANGELOG 取说明，单一事实源）
- 实测：钩子旁路 rc=0、真实门禁路径跑通（109 单测 + demo 12 组 → gates passed）

## 0.39.0（2026-10-17）WebUI 事件驱动实时化 + 基准维度补齐 + 发布决策上报
- **SSE 实时通道**：`webui serve` 新增 `/api/events`（text/event-stream）——连接即发首帧完整载荷，之后仅在数据变更时推送；服务端 1.5s 一次**表指纹**（18 张表 `COUNT(*)` 容错拼串，某表缺失记 `?` 不抛错），指纹变化才重算并广播；指纹 tick 挂 `ctx.timer`（vendor 弹药生命周期托管），插件缺失回退裸 interval
- **客户端零轮询**：React 客户端改 `EventSource` 订阅（`subscribeDashboard`），10s 轮询降级为**仅在 SSE 未接管时**执行；`tsc --noEmit` 零错 + vite 构建通过
- **修停机挂起**：SSE 客户端永久占 socket，`server.close()` 会永不回调——shutdown 先 `closeLive()` + `closeAllConnections()` 再 close；实测挂着 SSE 客户端时 SIGTERM **324ms** 退出
- **修 bundle 化回归**：`resolveDistRoot` 原按 `__dirname` 固定层数上探，打包成单文件后 `__dirname` 塌缩到 `dist/bundle` → React 客户端不再被识别（`/` 回落内嵌）。改为**按仓库标记（ygl.bundle.json）逐层上探**——tsc 树 / bundle / 源码直跑三种布局通吃；实测 `/` 恢复服务 React 客户端、`/classic` 回退 200
- **基准两项限制关闭**：`--quick` 接线到四条路径（startup n=10→4、写入 200→50、kb 500→150 行 / 100→30 检索、树 300→100 节点）；**内存端点**——每席报告 whole-process RSS（after + delta），artifact 随之携带
- **发现并记录真实 schema 事实**：**没有 tasks 表**——任务是 `artifacts` kind='task' + meta 状态信封（原 SSE 指纹代码按 `tasks` 表查，每 tick 抛错导致永不推送；容错清单修掉并留教训）
- 单测 108 → **109**（新增 SSE 端到端用例：首帧快照 + 变更帧携带新任务标题）；SSE 设计记入 docs/webui-design.md
- **发布决策上报 A2A**（report-234c1c3b）：pack:check 全绿、fork 依赖在 npm 有源，待拍板 registry 与放行

## 0.38.1（2026-10-17）发布就绪门禁 pack:check + 发布流程文档
- **`pnpm pack:check`**（scripts/pack-check.sh）：打包 → 依赖协议重写检查 → **隔离消费目录真实 npm install** → 驱动发布产物跑 9 条命令面 + doctor + `--json` 整体可解析；拦的是源码树测试拦不住的一类 bug（workspace 协议残留 / 产物未进 files / 依赖闭包不可解 / bin 路径错）
- **实测发布包可用**（0.38.0 tarball）：52 包闭包，`@deepseek-ai/cordis@~4.0.5-alpha.2` 等 fork 版本在 npm 均有源（DSH 自发布），`workspace:~` 重写后可解；隔离安装后 db init / project / query / tree / node / brief / plugin / doctor 全通过
- **发现并定性 Windows `.cmd` shim 污染**：主机级 cmd 启动钩子（`HKCU\...\Command Processor\Autorun`）让**每个** npm 包的 .cmd shim 先吐 `Active code page: 65001`（实测 `cordis.cmd` 同样），破坏经 shim 的 `--json` 整体解析；**非本包缺陷**——直接 `node` 与 `.ps1` shim 实测输出纯净
- **docs/release.md**：发布流程（门禁 / `pnpm publish` 必须而 npm 不可的原因 / shim 陷阱与干净调用路径 / 发布面构成 / 根 deps=发布面 vs 包内 deps=依赖图真相 的双处维护纪律）
- `prepublishOnly` 升为 `pnpm test && pnpm pack:check`——发布前强制产物级验证

## 0.38.0（2026-10-17）技能面同步 + bundle 默认化 + vendor 弹药启用
- **quickstart 技能全面重写**（v0.14 → v0.38.0）：覆盖新增命令面——doctor（9 项健康检查）、task 状态机、rel 关联织物（8 类引用）、plugin 用户插件、webui serve/export、benchmarks、build:bundle；触发词扩到 doctor/task/rel/plugin/webui/bench/bundle；入口路径改正（bin/ → dist）。`agent match` 三查询（插件/健康检查/webui）全部命中
- **bundle 默认化**：`pnpm build` = tsc 树 + tsdown bundle（一条命令两个产物，tsdown 仅 58ms）；根 package.json `bin` 指向 `dist/bundle/bin.cjs`（单文件发布产物）；`prepublishOnly` 保留 test 门禁
- **发布产物实测更快**：受控对比 bundle p50 560ms vs tsc 树 607ms（**~8% 启动提速**，8 轮交替测量）
- **demo + benchmarks 改测发布产物**：demo.sh 与 bench.js 优先用 `dist/bundle/bin.cjs`（缺失回退树）——回归与基准对准用户真实入口
- **vendor 弹药首启**：`@deepseek-ai/cordis-plugin-timer` 接入 base bundle（第五插件）——webui serve 的 60s 心跳（行数统计）走 `ctx.timer.setInterval`，生命周期托管（ctx dispose 自动清理，无需手工 clearInterval）；实测组合后 `ctx.timer` 就位（4 tick/150ms）
- 单测断言更新（bundle 4 → 5 插件）；vendor/README 弹药状态更新（1 用 6 待）

## 0.37.2（2026-10-17）benchmarks 目录规范对齐 DSH（用户指出"未对齐开发标准与目录规范"）
- **per-user-path 重组**：bench.js 平铺单文件拆成四条用户路径目录——`startup/`（CLI 进程 spawn）、`research-write/`（事务化写入+幂等）、`knowledge-search/`（kb 批导+FTS5 bm25）、`techtree-index/`（闭包+拓扑+节点检索）；不镜像包树（DSH 典范）
- **benchmarks/AGENTS.md**：基准纪律——合成固定输入/进程级采样/预算不可环境覆盖/跑生产入口/support 移入需两处复用
- **@ygl/benchmarks workspace 包**：package.json 声明（benchmark 专用依赖不污染根）
- **support/helpers.js**：共享 runner 基础设施——suite()/stats()/writeArtifact()/freshWorkspace()；EPERM 安全清理（Windows 句柄残留）
- **bench.js 减薄为调度器**：按路径加载子模块→收集→统一清理→写 artifact
- **README 重写**：结构图 + 用法 + fork 4.0.5 新基线 + 已知限制
- 全量跑通（7 席全绿）：startup p50 570ms / claim-write 20.3ms/op / kb-search p50 22.5ms / node-index 619ms

## 0.37.1（2026-10-17）bundle 完全可用——DOMAIN_ROUTES 静态 barrel 化
- **domain-barrel.ts**：所有领域命令模块从动态 `require(route)` 改为静态 import barrel——bundler（tsdown/rolldown）可追踪，bundle 产出完整功能（全命令面实测通过：agent brief / db stats / rel list / demo hello / plugin list）
- **bundle 对比**：323KB 单文件 bin.cjs，启动 559ms vs tsc 树 621ms（~10% 提速）；外部保留 native/opt 依赖（better-sqlite3/node-sqlite3-wasm/typeorm/pg/reflect-metadata/atomic-write）
- `build:bundle` 脚本固定 CLI 直传参数（tsdown.config.ts 有 Node 24.12 config-loader bug，暂绕过）
- vendor/AGENTS.md 补充（DSH 典范——src 编辑禁令 + 同步程序 + 我们的补充纪律）

## 0.37.0（2026-10-17）vendor DSH 全家桶对齐 + tsdown bundle 脚手架（用户两项裁定）
- **vendor 九件套对齐 DSH**（用户裁定：框架级一致性）：从 DSH vendor 源码同步（非 npm 安非 git clone——DSH 模式：fork 仓库源码 git 跟踪 + workspace:~ 链接）；cordis 升级到 fork 4.0.5-α（**修复 rc.11 setImmediate 时序**——fork 探针实测单 yield 后 database+named+inject 链 needsDb 全就绪 ✓）；cosmokit 1.8.6-α、schemastery 3.18.5-α、loader/include/group/hmr/timer/logger-console 七件 cordis-plugin 首次入库（可用弹药，等需求接入）
- **import 面 rescope**：`from "cordis"` → `from "@deepseek-ai/cordis"`（6 文件）；`declare module "cordis"` → `"@deepseek-ai/cordis"`（5 文件）；package.json 依赖声明更新（根 + apps/cli + 4 包）
- **vendor README 重写**：manifest 表（九件版本对齐）+ fork 理由（上游停在 rc.11，DSH fork 4.0.5 修时序）+ 同步纪律
- **tsdown bundle 脚手架**：`pnpm build:bundle` = tsc + tsdown（rolldown bundler）；入口 apps/cli/src/bin.ts → dist/bundle/bin.cjs（101KB 单文件）；**已知限制**：DOMAIN_ROUTES 动态 require(route) 被 bundler 静态分析不了——需后续改静态 barrel 导入（tsdown.config 暂移除——Node 24.12 tsdown config-loader 已知 bug，CLI 直传参数可用）
- 规则 7 重写（根 AGENTS）：从 DSH vendor 源码同步（用户裁定框架级一致性）

## 0.36.4（2026-10-17）vendor 逐项裁决 + vendor README（用户两问驱动）
- **裁决入库**：tsdown.worker.ts **否**（属 DSH 的 bundle 化+Worker+VFS 构建形态；触发条件：采 bundle 分发或引 Worker 线程）；DSH vendor 九件套**七否一有一挂账**——loader（R14 已裁不引 fork）/include/group/hmr/timer/logger-console 逐项否（各有本仓等价或场景不存在）；schemastery 挂账（npm 消费正常，vendoring 属一致性收益）
- **vendor/README.md**：补齐 DSH 有的 vendor 树纪律文档——来源纪律（npm tarball 非 clone 非 fork）/升级路径（先跑 rc.11 时序探针）/fork 漂移与 T2 禁引/候选挂账

## 0.36.3（2026-10-17）包领域 AGENTS.md + 插件目录 README（用户指示，DSH packages/AGENTS.md 对齐）
- **`packages/AGENTS.md`**：包级开发纪律（补位根 AGENTS，DSH 同构）——包形状五件套/零散禁区、Cordis 插件导出契约（Service+apply+declare module、构造必须同步）、写路径三铁律（事务化服务/九触点/读不写）、遥测纪律（树域已推翻 0.12 例外）、测试纪律（scratch 自清理三步/demo 字段名教训）、README frontmatter 与内容序、DSH 角色词表命名；根 AGENTS 核心铁律挂链
- **`examples/plugin-demo/README.md`**：示例插件 README（试跑四命令/契约表/写自己的插件三步/已知限制）
- **profile README**：`plugin init` 现在在 `$YGL_HOME/plugins/` 生成 README.md（结构说明+命令速查+信任模型警告，幂等）

## 0.36.2（2026-10-17）apps/cli 成为 workspace 包 + packages/*/* 接入 workspace（用户指出"没有包管理器"）
- **发现**：`pnpm-workspace.yaml` 只含 `vendor/* + apps/*`——**packages/*/* 九个包从未是 workspace 成员**，0.20 的"各包声明依赖"一直是装饰品（从未链接）；apps/cli 则完全没有 package.json
- **对齐 DSH**（其 apps/cli 即发布包 `@deepseek-ai/dsh`，含完整 deps/bin）：`apps/cli/package.json` 新建（`@ygl/cli`，声明真实依赖图：6 个 workspace 包 + cordis + schemastery）；`packages/*/*` 接入 workspace——九包 + apps/cli 各自获得 node_modules 链接，依赖图从"纸面声明"变为 pnpm 实链
- **依赖归位与发布面并存**：`@deepseek-ai/schemastery`→apps/cli、`@deepseek-ai/dsh-atomic-write`→ops-tools（各自真实消费者）；**根 package.json 同时保留两者**——根是发布单元，dist/ 运行时从根 node_modules 解析（实测移除即 MODULE_NOT_FOUND；包内声明=依赖图真相，根声明=发布面需求，两者并存是正确形态）
- 已知 peer 警告（记录不修）：vitest 要 @types/node≥22（root 20.x）；typeorm peer better-sqlite3@12（用 13）

## 0.36.1（2026-10-17）bin/ 目录并入 src/bin.ts（DSH 形态收尾）
- **可执行入口 = `apps/cli/src/bin.ts`**（DSH bin.ts 同形）：shebang + 自执行守卫（rc 契约 0/1/2 由本文件保管）；根 package.json `"bin"` 指向 `dist/apps/cli/src/bin.js`（DSH `"dsh": "lib/bin.js"` 同构）；**bin/ wrapper 目录删除**——三层入口（wrapper→index→main）收敛为单文件
- 引用面全改（demo.sh / benchmarks/bench.js / scripts/bun-smoke.sh / README / package.json scripts）
- 根治 vitest 捡 dist 编译测试：tsc exclude `apps/*/tests`（测试不再进 dist，发布面更干净）；实测 unknown→rc2 / ok→rc0 / demo 插件命令可达

## 0.36.0（2026-10-17）用户层插件分发（spec R14 L3——DSH apps/cli 应用典范落地）
- **`ygl-trees plugin` 命令组**：init（幂等建 profile）/install（npm 包、git 地址、本地目录自动 link:）/remove/list（版本+spec+可解析态）
- **工作区级插件仓**：`$YGL_HOME/plugins/`（pnpm 管理）+ 用户层声明 `ygl.user.bundle.json`——叠加在 base bundle 之上（DSH user-layer 对应物）；业务域随工作区走
- **插件契约**：`apply(ctx, config)` + 可选 `commands` 贡献 CLI 命令组（dispatch：插件命令 → 内建路由 → unknown）；可用 ctx 服务：database/research/techtree/webApp
- **DSH 典范五件套**：withFileLock 安装锁（dsh-atomic-write 同原语）/ 名字=依赖键差集精确解析 / YGL_PACKAGE_MANAGER 包管理器注入（Windows .cmd shim 走 shell）/ StartupError 诊断落盘 `$YGL_HOME/logs/startup-<uuid>.log`（凭证泄漏警告）/ createProcessShutdown 有界停机（5s 宽限·信号升级）
- **逐插件隔离**：单插件失败不炸工作台，issues 汇总进启动诊断；`yglTrees` 兼容声明主版本不符仅警告
- **apps/cli 分层**：main.ts 减薄（bin 薄入口），组合进 boot.ts、诊断进 diagnostics.ts、停机进 shutdown.ts
- doctor 第 9 项 plugin_profile；示例 examples/plugin-demo（demo 组 12 离线 link: 全链路回归）；docs/plugin-authoring.md 插件编写指南；单测 6 例（profile/init/install/load/隔离/remove）

## 0.35.0（2026-10-17）产出工件渲染进 WebUI
- **服务端**：`/api/artifact?id=<id>` 全文端点（当前项目工件：kind/title/content/version，404 语义）；`/api/data` 增 artifacts 清单（非 task 工件按创建倒序）
- **React 客户端**：Artifacts 区——按类型分组（报告/规格/设计/大纲/章节/笔记）+ 点击展开 **react-markdown 全文渲染**（DESIGN.md token 定制组件：标题/链接/代码/引用/表格）；键盘可达
- **内嵌 dashboard**：📦 产出工件最小清单区（类型徽章 + 标题 + 版本）
- 单测锁定（清单形状 + 全文端点 + 404）+ tsc/vite 双构建（bundle 457KB/146KB gzip）；serve 重启 PID 42304；react-markdown 兑现资源清单"报告/规格渲染"位

## 0.34.2（2026-10-17）树视图水平展开（用户裁定）
- **tier 布局横排**：tier 沿 X 轴左→右推进（每层 180px 列距），同层兄弟纵向扇开（70px 行距）——经典科技树横版；React xyflow 同步（Handles Left/Right）；时间轴布局本就是水平（时间轴语义不改）
- 内嵌 dashboard：edges 横向连线（父右缘→子左缘）；SVG 尺寸按列数×兄弟数自适应
- 锁定：源码级几何断言（colGap/tierKeys×colGap/行距公式）+ apps/web tsc --noEmit 类型检查（vite 构建不做类型校验，0.34.2 起收口必跑）+ serve 重启（PID 70100）

## 0.34.1（2026-10-17）WebUI 中文友好化（双客户端面）
- **内嵌 dashboard**（webui export/serve）：统计卡（技能/知识笔记/来源/证据/断言/产出/科技树/节点）、区头（📊 总览/🌳 科技树/🔬 研究断言/📚 来源/✅ 任务清单）、项目进度行（项目/来源/证据/断言 x/y 已证实/产出）、下一步操作/常用技能、断言状态分组（已证实/存争议/已推翻/待验证）、节点面板（解锁状态/必检未满足/可选未满足/被排斥/条件表头六列中文化/父节点/子节点/关联/(可选)）、任务（待办/进行中/已完成 ✓ + ▶ 开始/✓ 完成）、时间线图例（研究/科技树/评估/其他）+ title 明细、布局切换（布局：分层/时间轴）、全部空态/加载态/页脚中文化
- **React 客户端**：统计卡、项目进度、下一步操作、科技树副标题、任务分组（待办/进行中/已完成）、错误/加载态、详情面板（条件/关联/加载中）同步中文化
- 单测锁定：generateHTML 中文文案断言（13 组标签）；导出实测 8 处中文命中；React 重建 + serve 重启（PID 39776）

## 0.34.0（2026-10-17）插件化补完 R14（L1 接线 + L2 声明式组合 + T1 套件）
- **L1 接线**：`ctx.research`（ResearchService，0.18 欠账——发现早已写好未接）与 `ctx.techtree`（死导入复活）全部接到组合面；compose.ts 死代码删除
- **L2 声明式组合**：`ygl.bundle.json` 声明四插件（database→research→techtree→web-app；数据说 WHAT），main.ts `PLUGINS` 注册表管模块解析（代码说 WHERE），schemastery 校验；loader 向上探测解析（src/dist 双深度）；profile 概念暂缓（两态当前等价不硬造）
- **rc.11 时序探针**（tmp/svc-probe*.js）：named-apply 服务注册 ✓；inject 链 wall-time 500ms 沉降 ✓；setImmediate 泵不可靠——CLI 保留直构回退，长驻进程走服务层
- **T1 套件**：`@deepseek-ai/dsh-atomic-write`（零运行时耦合实证）接入 webui export + db export 原子写——截断导出=数据损失；`@deepseek-ai/schemastery` 校验 bundle 声明；T2（timer/frontend-static/webserver）按 DSH 对比裁不引（自研等价 + 不拖 fork）
- 四服务实证（serve 组合）：ctx.database/research/techtree/webApp 就位；CLI 冒烟全通；bundle 入 files 发布面

## 0.33.0（2026-10-17）真实规模树 + 方法论 skills（spec R13 收官）
- **dogfood #4——evolution 树**：ygl-trees 自身演进建成 **32 节点 / 7 层 / 39 边**真实规模树——六大生长干（架构/研究管线/知识/模型层/能力/Web 客户端），29 已解锁里程碑 + **3 个锁定未来节点带真实门**（npm-publish：registry_pick choice= npmjs + green_closed 布尔；bun-runtime：上游就绪度 score min=2；real-users：readiness score min=1）；R9 关联织物跨四类实体挂接（claim decided-by / kb evidenced-by / task tracked-by / design decided-by）；doctor 8/8
- **三个方法论 skills**（R13.2）：`ygl-trees-tree-building`（领域分解四步/反模式立靶/tier 语义/自检清单）、`ygl-trees-relating`（rel 词汇表/决策树/消费面）、`ygl-trees-design-capture`（ui-ux=DESIGN.md 格式/arch+decision=ADR 三段/挂接纪律）——junction + import，**agent match 三查询各自 top-1 命中**（R13.4）
- **R13.4 验收**：React 客户端（pan/zoom/MiniMap）承载 32 节点树，npm-publish 详情面板 2 条件 + 2 关联 + can.ok=false（锁定门可见可读）
- R13 全条目闭环：pan/zoom（0.32.1 xyflow）、真实规模树 + 方法论（本版）

## 0.32.2（2026-10-17）web-app Cordis 插件（DSH 模式落地）
- **新包 `packages/web/app`（@ygl/web-app）**：运行时胶水插件（模式取自 DSH packages/bundle/web-app + adding-a-package cookbook）——`ctx.webApp` 服务（available/open）+ 纯函数 `resolveDistRoot()/openStatic()`（短命 CLI 不赌异步插件时序，0.19 教训）；dist 路径=workspace 知识非用户配置；SPA 回落 + 路径遍历防护
- **webui serve 分流**：构建产物存在 → React 客户端挂 `/`（xyflow pan/zoom 树视图），内嵌零依赖 dashboard 移驻 `/classic`；未构建检出 → 内嵌保持 `/`（离线单文件契约不变）；`/api/*` 永不拦截
- CLI 组合面加载 WebAppPlugin（第二个真实 Cordis 插件）；gate 9 包
- 修 0.32.1 遗留：resolveDistRoot 相对层级数错（dist 出发 5 层/src 出发 4 层才到仓库根——实测 / 404 定位）
- 全路由实测：`/`→React shell、`/assets/*.js`→200、`/classic`→embedded、`/api/data` 完好

## 0.32.1（2026-10-17）React 富客户端骨架（spec R13.5 裁定落地）
- **React 技术栈裁定（用户）**：WebUI 富客户端按需取用 xyflow/ahooks/react-router/pro-components/remix/grid-layout/react-pdf/react-markdown；`apps/web` 为 React 家园，CLI 零依赖内嵌 dashboard 保留（离线单文件导出不受构建链拖累）
- **apps/web 骨架**：Vite + React 18 + @xyflow/react——**树视图 pan/zoom/drag + MiniMap**（R13.3 核心，tier 布局，点击节点出详情面板：conditions/确定性 can/R9 related）、next_actions/tasks/统计卡、10s 轮询；`src/tokens.css` 镜像 DESIGN.md（token 单一事实源不变）；开发期 /api 代理到 `webui serve:8642`
- 构建验证：`pnpm --filter @ygl/web build` ✓（334KB js / 108KB gzip）；根 tsconfig 排除 apps/web（CJS CLI 构建不受 ESM/JSX 影响）
- obelisk 记忆更新至 v5（R9-R12 + 两项裁定 + 陷阱清单）；决策备案 a2a team-god-system（report-fe2c6647）

## 0.32.0（2026-10-17）工程产出形态（spec R12）
- **schema v8**：artifacts 加 `meta TEXT NOT NULL DEFAULT ''`（JSON 信封，循 eval choice 先例）；kind 扩 `spec|design|task`
- **`produce spec`**（需求规格文档）、**`produce design --design-type ui-ux|arch|decision`**（R12.1a：ui-ux 对齐 DESIGN.md 格式，arch/decision 用 ADR 风格；design_type 存 meta 信封）
- **`task` 命令组**：`add "<title>" [--note]`（todo 起步）、`list [--status]`、`doing|done <id>` 状态机推进——每次流转留痕 `task.status` 事件（from → to）
- **WebUI 任务清单**：状态分组（todo 灰/doing 黄/done 绿+删除线）+ 点击勾销（`▶ start`/`✓ finish`）经 **POST /api/task** 写回并即时刷新；静态导出提示需 serve；键盘可达
- **R9 互联验收**：task/spec/design 均可 `rel add node:… artifact:…` 挂节点（demo 断言 tracked-by）
- 单测 5 例（v8 迁移/状态机全程+留痕/非法状态/meta 信封）+ demo 断言组 11 + POST 端点 E2E（todo→doing 实时回显）

## 0.31.0（2026-10-17）时间维度（spec R11）
- **树视图时间轴模式**：`layout: tier` ⇄ `layout: time` 切换（chip 按钮）——时间布局每节点一条泳道（按 created 排序），created 圆点 + 解锁弧（created→unlocked_at 实线绿箭头 + 终点圆）或未解锁灰虚线延伸至今；日刻度竖线；节点仍可点击出详情面板
- **研究管线时间线**：`/api/data` 增 `timeline`（近 30 天 events 按日聚合，research/tree/eval/other 四桶），前端逐日堆叠条（DESIGN.md token：primary/tertiary/warning/secondary）+ 图例 + title 提示
- 数据面：tree 节点带 `created/unlocked_at/state`（LEFT JOIN node_state default 上下文解锁行）——0.30 树域留痕的直接消费
- **dogfood 三幕验收**：release-gate 树 dev/rc 实线解锁弧 + release/probe-node 灰虚线待解锁——检阅页 http://127.0.0.1:8642 切 layout: time 可回放
- 单测 13 例（+R11 数据面断言）；DESIGN.md token 纪律（零新增色）

## 0.30.1（2026-10-17）DESIGN.md 落地（前端 design 方法论裁定）
- **用户裁定固化（spec R12.1a）**：前端/UI design 采用 [DESIGN.md 格式](https://github.com/google-labs-code/design.md)（google-labs-code：YAML tokens + rationale 固定节序 + lint/diff/export 工具链）；arch/decision 类 design 由 Agent 定义（ADR 风格）
- **仓库根 `DESIGN.md`**：现有 dashboard 视觉身份（GitHub-dark 双层画布/单一 primary 交互色/等宽可执行文本/状态词色配对/边框优先分层）固化为 13 色 + 5 字阶 + 9 组件 token——webui 设计系统单一事实源，R11 时间轴与 R13 pan/zoom 以它为 token 来源
- lint 实测 0 error（`designmd` Windows 别名）；2 个 border 色 orphan 警告为格式 alpha 限制（组件属性面无 borderColor），已记录

## 0.30.0（2026-10-17）遥测地基（spec R10）
- **树域留痕**（推翻 0.12"不写 events"例外）：node.add/link/unlink/cond/delete/unlock/lock 同事务写 events——解锁时刻进账本，R11 时间轴的地基
- **schema v7**：events 加 `level`（info|warn|error，默认 info）；迁移 v6→v7（ALTER + 表存在守卫）；实体快照/PG MIGRATE_DDL/doctor 同步——并修复 doctor schema 检查硬编码 v6 的漏网触点（改读 SCHEMA_VERSION 单一事实源）
- **run 关联**：每条 CLI 命令一条 `cmd.run` 事件（group/action/rc/duration_ms；rc 映射 level：0→info/2→warn/else→error）；YGL_RUN_ID 注入同进程事件 payload.run——`agent log --run` 可重建单次调用
- **eval usage 捕获**（R10.4）：postEval 透传 gateway usage → 四题型返回值 → eval.gate/eval.ready 事件 {inputTokens, outputTokens}；**真实网关验证：1 call · 2764 in / 70 out tok 落账**
- **agent log 升级**：--level 过滤、--run 聚合、--usage 汇总（`agent log --usage` → calls/input/output tokens）
- 单测 11 例（v7 迁移/level 默认与显式/树域四操作留痕+run 注入）+ demo 断言组 10；AGENTS.md 口径 v6→v7、R1-R8→R1-R13

## 0.29.0（2026-10-17）关联织物通电（spec R9）
- **`rel` 命令组**：万向关联表 `relations` 从 kb↔kb 孤岛通电为八类实体（node/claim/evidence/source/query/kb/artifact/skill）任意两端挂接——引用语法 `<type>:<ref>`（`node:<tree>/<key>` 或当前树裸 key；kb/artifact 支持 id 或 title；skill 按 name）；`rel add [--rel t]` 幂等（同四元组 duplicate rc=0）、`rel rm`、`rel list [--src/--dst/--rel]` 双向过滤 + 对端显示名解析；404→rc1、坏类型→rc2
- **WebUI 关系叠加**：`/api/node` 返回 `related[]`（双向命中 + 类型/显示名/方向），节点详情面板新增 related 区（rel 类型加粗 + 对端摘要）——"这个节点依据什么证据、关联什么知识"面板直达
- **spec/plan 大修**：WebUI 检阅两轮结论固化为 R9–R13 五条新需求 + 0.29–0.33 里程碑路线（关联织物→遥测地基→时间维度→工程产出→真实规模树）；记录历史裁决推翻（0.12 树域不写 events 例外将由 R10 补齐）
- dogfood：release-gate/release 节点挂上 evidenced-by kb + decided-by claim（webui 可见）
- 单测 8 例（引用解析/幂等/跨域/rm 语义/events 留痕）+ demo 断言组 9；修复 relRm 先删后查的误报 bug（改先查存在再删）

## 0.28.0（2026-10-16）dogfood #3（发布门自评）+ doctor eval 信封检查
- **dogfood #3：工具审判自己的发布**——release-gate 树（dev→rc→release，release 挂三题型真实条件）真实网关活评估：**registry_pick (choice) P=1.0 pass**（npmjs）、**green_and_closed (boolean) P=0.4 fail**（未收口时点诚实拦截）、**readiness (score) 0.98 灰带**（原型↔可用徘徊）；结果存回研究管线（1 源 3 证据 2 断言 supported）；收口后重评见 plan.md
- **doctor 第 8 项 `eval_envelopes`**：eval 族条件信封有效性（choice answer∈options、score 级数 2-10 且 min 界内）——坏信封会让门永远 pending（静默退化），现在报 fail 点名；单测负路径（3 好 + 3 坏）
- README 健康面：决策模型章节更新为三题型+混批、doctor 8 项、skills 表描述；techtree skill 补 eval-gates 指针

## 0.27.0（2026-10-16）ready --eval 混合题型批量 + npm 发布预检
- **`node ready --eval` 三题型混批**：evalMixed 单请求携带 boolean/choice/score（协议原生多题型）——evalCandidates 返回带 op+信封的条件，聚合按各自映射器判三态；CLI stub 冒烟：choice+score 单节点 **1 个请求**双 pass → promoted
- **npm 发布预检**（不碰 registry）：tarball 面 57 文件健康（bin/dist/docs/README/CHANGELOG，vendor/tmp 无泄漏）；**关键裁决：必须 `pnpm publish`**——实测 pnpm pack 把 `workspace:~` 重写为 `~4.0.0-rc.11`/`~1.8.1`，npm publish 不重写（消费者装不上）
- 单测 30 例（+3：混批单请求形状/三映射器直用/离线整批 pending）；demo 组 6a2 扩 ready 级断言（三题型单节点聚合 pending）
- obelisk 记忆更新至 v4（mem-ff6b2eb8，英文 summary 含 0.19–0.26 全部裁决）

## 0.26.0（2026-10-16）决策模型 choice/score 题型
- **`--op eval-choice`（多选一）**：`--options "k=desc,..."` + `--answer k`；判 **P(期望答案)**，阈值与布尔同源（eval.pass/fail_threshold），全概率分布返回
- **`--op eval-score`（等级评分）**：`--levels "级0,..."`（2-10 级，描述须编码价值排序）+ `--min-score n`；score∈[0,N-1] 概率加权均值，三态 = ≥min pass / ≤min−1 fail / [min−1,min) 灰带
- **零 schema 变更**：问题与选项打包为 value 内 JSON 信封（`parseEvalSpec` 对 plain 字符串向后兼容）；missing_required 显示问题措辞而非 JSON
- eval.ts 重构：共享 `postEval` 传输层（四个题型函数同源重试/超时/协议头）；包导出面扩 8 个符号
- 验证：单测 27 例（信封往返/三态边界/本地 stub 网关协议形状/离线安全）；CLI 全链路冒烟（离线双 pending + stub 端点 choice P=0.9/score 2.31 双 pass → can.ok=true）；demo 组 6a2；eval-gates skill 更新为三题型版
- 已知边界：`node ready --eval` 批量聚合仍仅布尔 op（choice/score 经 `node can --eval` 逐节点判，混合批量留后续——spec R8 非目标更新）

## 0.25.0（2026-10-16）读路径写放大清剿 + dashboard 接 agent brief
- **skillMatch 批量化**：逐行 `UPDATE hits=hits+1`（N 结果 = N 次隐式事务 = N 次 VFS fsync，与 0.23.0 kbSearch 同类缺陷）→ 单语句 `IN (...)`；功能验证 hits 递增正常
- **dashboard 接 buildBrief**：`agent brief` 的 payload 构建抽为 `buildBrief()` 双端复用——webui Overview 区新增项目进度行（sources/evidence/claims verified/artifacts）、**next_actions 可执行命令列表**（原来硬编码 []）、top_skills 徽章
- **deferred usage 裁决：不做**（0.24.0 已知机会的结论）——CLI 单命令场景关闭时仍需 1 次刷盘（无收益）、serve 10s 轮询负载可忽略，代价是 Store 生命周期改造 + 计数崩溃丢失窗口；kbSearch 单语句批量已是最优形态
- 单测 56→57 例（brief 富载荷断言：next_actions 非空/project 进度/top_skills）

## 0.24.0（2026-10-16）WebUI 三视图交互 + WAL+NORMAL + fts boost 限候选集
- **WebUI 交互收尾（设计稿三视图齐了）**：科技树节点可点击 → 右侧详情面板（`/api/node?tree=&key=` 端点：node/parents/children/conditions/can 确定性判定，eval 门槛以问题文本呈现在 missing_required）；claims 按状态分组、点击展开证据链接与原文摘录（/api/data 扩展 claim_evidence + evidence 索引）；节点面板独立于轮询重渲染（选中/展开状态跨 10s 刷新保持）
- **UI 规范**（ui-ux-pro-max 技能指导）：键盘可达（tabindex + Enter/Space + :focus-visible 焦点环）、aria-expanded/aria-live、加载/静态导出双态反馈、prefers-reduced-motion 降级、HTML 转义防注入（esc() 全覆盖用户文本）
- **fts() boost 限候选集**：`lower(title) LIKE` 从全表扫描改为仅扫 MATCH 候选 id 集（计数语义逐位一致——boost 本来只落给候选行）
- **WAL + synchronous=NORMAL**（sqlite.org 推荐组合，双连接设置）：commit 免逐事务 fsync；claim-write 39.9→28.1ms/op（−29%）；持久性语义=断电回滚末几笔、不损坏（docs/conventions.md §五连接策略）
- **kb-search 25ms 剖析定案**：per-token MATCH ~3ms + reuse 回写 ~10ms（VFS 锁目录 mkdir/rmdir + WAL 追加）为地板；"读路径去写"记为已知机会（需 Store 生命周期改造，超出便宜优化范围）
- 单测 22→56 例（webui 12 新例：脚本语法编译护栏/注入转义/三路由/404/400）；ops/tools 声明 @ygl/techtree-model 依赖

## 0.23.0（2026-10-16）dogfood 深化批 + benchmarks + Bun 决策 + kbSearch 修复
- **benchmarks/ 基准套件**：零依赖七席（startup 子进程 / claim-write / claim-dedupe / kb-import-batch / kb-search / node-index median-of-3 / node-search），`pnpm bench`，结果落 tmp/bench-results.json（含 node/平台/git 哈希）；README 记方法论与 Windows Defender 方差注意
- **kbSearch 写放大修复（基准首跑战果）**：top-20 逐行 `UPDATE reuse=reuse+1`（20 次隐式事务 = 20 次 VFS fsync）→ 单语句 `IN (...)` 批更新；500 行语料 p50 326ms→25.6ms、p95 2039ms→49.9ms（12.7×/40×）
- **Bun 运行时决策**：未来以 Bun 封装 CLI（用户指示）。本机实测 bun 1.3.0 (win32) `fs.openSync(path, O_CREAT)` 抛 ENOENT 不建文件 → node-sqlite3-wasm VFS 无法建库 → **Windows 上受阻**。docs/bun-compat.md 记录证据链与迁移清单；scripts/bun-smoke.sh 探针（pnpm smoke:bun，当前必红，不进 test）
- **dogfood #2**：cordis-lifecycle 真实代码证据研究项目全闭环（3 检索式 → 6 源 → 6 证据 → 5 断言全 supported → 7 链接 → 大纲+章节+报告 → kb ingest → promote `cordis-lifecycle-cli`）；agent match 双查询 top-1 命中；doctor 7/7 护航
- 报告 `_generated` 标记补 UTC 标注（原裸 UTC 时间在 UTC+8 环境易误读为前一天；demo 组 4 加断言锁定）
- 修正 0.21.0/0.22.0 CHANGELOG 与 plan.md 执行记录日期（10-17 → 10-16，对齐 git 提交真实日期）

## 0.22.0（2026-10-16）WebUI 动态版：live dashboard
- `ygl-trees webui serve [--port N]`：零依赖 `node:http` 活数据仪表盘——`/` 实时渲染、`/api/data` 每请求现取、10s 轮询自动刷新；Ctrl+C 优雅停机（db 在 CLI finally 关闭）
- 重构：`gatherData()`/`generateHTML(data, live)`/`createDashboardServer()` 三出口；export 路径行为不变（单文件 + 内嵌快照兜底）
- 安全：内嵌 JSON `<` 转 `\u003c`，杜绝 `</script>` 注入
- 测试：webui 7 例（gatherData 形状 / HTML live 引导 / 注入转义 / 三路由端到端）；demo 断言组 8（export 单文件校验）

## 0.21.0（2026-10-16）doctor 健康检查 + 检索全域统一
- `ygl-trees doctor`：7 项健康检查（schema 版本 / 索引新鲜度 / FTS 同步 / 重复内容 / 孤儿数据 / config 有效性 / 残留锁），`--json` 纯净输出
- 检索排序全域统一：kb（title 加权）、skill match（name 加权）、source search（title 加权）、node search（key/name 加权）——hits desc → boost desc → bm25 asc

## 0.20.0（2026-10-16）DSH 合规收官
- 测试归位：全局 `tests/` → 各包 `tests/`（text→core/text、eval→techtree/eval、config→ops/tools）；vitest `packages/*/*/tests/**/*.test.ts`
- 包依赖声明：8 包各声明 dependencies（workspace `@ygl/` + npm cordis/typeorm）；core/text 和 techtree/eval 零依赖（纯函数）
- 跨包 import 审计：全部来自 `core/*` 共享层，零域间交叉引用

## 0.19.0（2026-10-16）Cordis 迁移收官
- CLI `main.ts` 创建 Cordis Context，加载 DatabasePlugin；Store 同步构造保证命令速度（Cordis rc 异步时序在 CLI 场景不可控，务实回退）
- `apps/webui/` 重命名为 `apps/web/`（DSH 惯例）
- WebUI：`ygl-trees webui [--out <file>]` 导出单文件 dashboard.html（9/9 HTML 结构检查通过）
- 包结构 gate 检查：8 包 × 5 必存文件（package.json + tsconfig.json + README.md + src/index.ts + tests/）

## 0.18.0（2026-10-16）架构重构：Cordis + packages/apps/vendor 分层
- **Cordis 框架集成**：vendor `cordis@4.0.0-rc.11` + `cosmokit@1.8.1` 从 cordiverse/cordis 上游获取（非 DSH fork）；`packages/context.ts` 定义 DatabaseService/ResearchService（Service 子类）+ createApp() 组合；为运行时服务发现、多服务生命周期、事件驱动组合、动态插件加载、时空可组合性奠定基础
- **AGENTS.md**：Agent 常驻守则（仓库布局图、命令面板、Agent API 契约冻结表、Cordis 架构、七条开发规则、决策链链接）
- **docs/layout.md**：目录层级规划（当前结构 + 依赖方向单向图 + 未来扩展位 + 与 DSH 对齐差异表）
- **docs/webui-design.md**：WebUI 零依赖方案（三视图设计稿，待实施）
- **Dogfood 验证**：以「AI Agent 开发中的架构决策模式」为题完成 query→source→evidence→claim→report→kb→skill 全闭环；agent match 双查询 top1 命中
- **文档全面更新**：README（文档地图 + Skills 表 + config/env vars）、AGENTS.md、layout.md、webui-design.md

## 0.17.0（2026-10-16）巩固批
- vitest 单测落地（37 用例：ngram CJK 切分、contentHash 幂等/加盐、resolveEndpoint 归一化、mapOutcome 三态边界、config 注册表不变量与校验）；`pnpm test` 升级为 unit + build + demo 三段
- 死代码清理：写迁移后被 `src/writes.ts`/`src/treeWrites.ts` 替代的 Store 13 个、TreeStore 7 个死写方法删除（逐方法 grep 使用证据；`rebuildClosure`/`buildIndex` 因 validate 依赖保留）；store.ts 617→427 行、tree.ts 910→741 行
- CHANGELOG.md 建立

## 0.16.0（2026-10-16）批量门槛裁决
- `node ready --eval`：仅被 eval 门槛阻塞的节点逐节点一次多题请求（协议原生批量），全过提升进 ready（`eval_verified`），其余 `eval_pending` 逐题带 P；离线全 pending rc=0；留痕 `eval.ready`
- `evalBooleanMany` 多题单请求；skillMatch 接 boostExpr（名称命中优先）

## 0.15.x（2026-10-16）配置层
- **0.15.1**：决策模型配置键 `decision_model_llm_token` / `decision_model_llm_api_base`——**config 优先**于环境变量/文件/默认网关；api_base 归一化（裸主机名自动补 `/v4/ai/evaluation-model`）
- **0.15.0**：config 命令组（list/get/set/reset）+ schema v6 `config` 表 + 8 键注册表（全部真实接线：eval 阈值/离线、fetch 超时/UA、search.limit、default_confidence、job.stale_minutes）

## 0.14.x（2026-10-16）决策模型门槛 + Skills
- **0.14.1**：专属 Skills 五枚（quickstart/research/knowledge/techtree/eval-gates），junction 至 `.agents/skills/`；dogfood 验证 agent match 五发全中
- **0.14.0**：Gate 决策模型布尔评估（spec R8）——`--op eval` 条件 + `node can --eval`，上下文包（关联+闭包索引+条件+解锁集+state 袋）交 TypeSafe jev 判 P(true)，三态映射（≥0.7 通过 / ≤0.4 未通过 / 灰带 pending 禁终态）；真实网关三带全谱验证（0.97/0.39/0.45）；离线安全；demo.sh 改独立 `YGL_DEMO_HOME`（修复 pnpm test 清空继承工作区的隐患）

## 0.13.0（2026-10-16）真实试用反馈落地
- `kbImportBulk` 单事务批量导入：2189 条 44s→0.72s（61×）
- 检索 title 加权（`boostExpr`）：unicode61 把整段 CJK 标题索引为单 token，FTS5 列过滤对中文失效——改 `lower(title) LIKE` 子串匹配；排序 = 命中数 → 标题命中 → bm25

## 0.12.x（2026-10-16）写迁移收官 + 真实数据试用
- **0.12.1**：obelisk 真实语料试用（154 记忆 + 2189 摘要 = 2333 notes）；修复 PG 镜像 tsv 复合 token 漏召回（`docker/mongo` 类斜杠串被 PG 解析为 url/host 复合 token——生成列先 `regexp_replace` 标点归一化再 tsvector）；tmp/ 规范立法
- **0.12.0**：tree/node 域写迁移（`src/treeWrites.ts` 九方法全事务化，BFS 闭包/Kahn 拓扑/环守卫逐字移植）；写迁移全域收官（26 服务方法）

## 0.11.0（2026-10-15）写迁移第二批
- produce/skill/project 域（artifactAdd 版本事务内自增、skillUpsert FTS 同事务、projectCreate 含 meta 翻转同事务）；produce 三命令补 JSON 纯净

## 0.10.0（2026-10-15）写迁移第一批 + async 裁决
- `src/writes.ts` 事务化写服务（research/kb/job 十方法）；裁决=事务化写服务+渐进迁移（否决全栈异步）；副作用三件套（幂等/FTS/events）同事务——修复 Store 时代基表+FTS 分离语句可留孤儿行的缺陷

## 0.9.0（2026-10-15）读面扩大 + 规范立法
- research 四 list 迁移 TypeORM（黄金对账全匹配）；docs/conventions.md——加表九触点清单、幂等决策树、FTS 纪律、迁移模板、TypeORM 边界、输出契约

## 0.8.0（2026-10-15）TypeORM 接入
- 用户裁定采用（typeorm@1.1.2 + better-sqlite3@13）；驱动闸门实测（Node 24 prebuild 3s 免编译）；`synchronize` 永久 false，实体= schema v5 快照；试点 `project show` 逐字段兼容

## 0.7.0（2026-10-15）PG 迁移 + L2 取消
- `db migrate pg`（一次性完整保真：24 表手写全约束 DDL + 单事务原子 + 列集漂移守卫 + 非空拒绝）；架构裁定：不做双后端同写（用户裁决 + sync/async 阻抗失配再评估）；修复 query_sources 漏出 export/sync/stats、skill refs 唯一索引缺失（v5）

## 0.6.0（2026-10-15）PG 镜像
- `db sync pg`（table_info 驱动镜像 + ngram 同分词器重算 + tsvector/GIN 中文等价召回）；docker postgres:16 实测 18 表计数严格对齐

## 0.5.x（2026-10-15）研究闭环 + JSON 对齐
- **0.5.1**：tree/node/skill/project 写命令 --json 对齐（README 承诺兑现）；project list 不再污染 name
- **0.5.0**：query↔source 关联（schema v4）、claim resolve 仲裁出口、kb import 批量 markdown、job tick 并发锁 + 悬空 run 回收；写命令 JSON 纯净纪律（duplicate:true）

## 0.4.0（2026-10-15）管线增强
- `source fetch`（零依赖抓取、失败零副作用）；`kb promote` L1 提炼；`agent brief` 健康度

## 0.3.0（2026-10-15）可移植 + 真实退出码
- `node import` 严格校验事务导入；validate 门控全集环检测；404 语义；**bin 退出码修复**（曾恒 0，Agent 全误判）；负数 flag 值；files 白名单

## 0.2.0（2026-10-15）数据不丢 + 幂等
- `db export` 补全七张树表 + `--lean`；schema v3（content_hash + 唯一索引 + v2 自动迁移）；六写命令幂等 + `--force`；`db dups`

## 0.1.0（2026-10-15）初始调查基线
- 两缺陷修复起步（node path 顺序、agent brief 描述缺失）；调研报告 + spec + plan 立项
