# Changelog

## 0.114.25

编码 fail-closed + command 构造面边界（#62/#64）。

- **#62 材料编码**：`submit` 读字节后归一——UTF-8 BOM **剥除并记** `material.text_encoding`（首条子句不再丢）；
  UTF-16（BOM 或 NUL 字节模式）→ **rc=2 点名**「材料编码非 UTF-8（检出 UTF-16）——请转码为 UTF-8 后重交」；
  非法 UTF-8 字节同样 rc=2。冻乱码再报「判据捏造」的误导链被切断。`verify-encoding.spec` 3 例。
- **#64 command 边界**：`verify example` help 的陷阱文案改为「command 仅执行面：serve --enable-verify-jobs
  注入 YGL_VERIFY_ALLOW_CMD 或 authored 封包；prepare 不收 command（--allow-command 不是 CLI 旗标）」；
  `docs/spec-validator.md` 增「构造面边界」段（七型检查器闭集 ≠ 构造面子集）。
- unit 939 → **942**；contract 144；`verify meta .` 全绿。

## 0.114.24

Windows 空 `.ygllock` 残留修复（品味席报告 direct-1af18e77 / 监督席转达）。

- **现象**：快速连发 spawn + 被杀进程/删除延迟留下**空锁目录**（无 pid/cmd）时，旧实现单次
  `rmSync` 可能 EBUSY 被吞，随后把本进程 pid 写进残留目录 → 后续进程看到「持有者=自己」的活锁，
  `db unlock --force`/`doctor --fix` 同环解不开。
- **修复**：`clearLockDir()` 重试清除；新增 `takeoverLockDir()`——Windows 拒绝 rmdir 时用**原子 rename**
  把空/孤儿目录挪走（唯一名，无活持有者），再取新锁；两者都失败则 **fail-closed 报错**，绝不把 pid 写进
  残留目录造成自引用锁。`db unlock` 同路径。
- **回归**：`lock-empty.spec` 2 例（空目录写入可取锁、下一写继续成功；`db unlock` 清空目录）。
- **#reviews 形状校验（P2，发版席报告）**：`--reviews` 条目缺 `findings` 时不再在 `fileReviewer` 里
  TypeError；CLI 预校验（source_clause/findings/question/verdict/reason）→ rc=2 + schema 提示；runner 防御性兜底。
- **悬空 symlink（P2，发版席报告）**：`walk()` 改 lstat，断链 symlink 跳过并在 evidence 记
  `skipped_symlinks`，不再让整目录 file checker 变 ERROR。
- **#63 示例/引擎别名（P2，发版席报告）**：`p1()` 与翻译层同一别名 `c.expected_from ?? c.anchor`（存量候选不破）；
  `verify example` 每例增候选形状 `candidates[{id,source_clause,anchor,checker}]`（spec VU 仍保留 `expected_from`，
  文档区分两名）。
- **#65 lifecycle validator 1.2.0**：默认整 home 快照隔离读检（`fs.cpSync`→mkdtemp，所有 CLI 写只落副本；
  `--no-snapshot` 显式退回直检并披露 cmd.run 写入）；tooling role test→**gate**；显式 `--reregister`（#65 reason）。
- 测试：lock-empty 2 + reviews-shape 4 + 悬空 symlink 1 + example 候选形状；unit 932 → **939**；contract 144。
- 报告方侧 1919cfb 的清锁重试可作为上层缓解，本版在锁层根治；其 selfcheck 43 例可复跑。

## 0.114.23

发布门可靠性 + 元登记收尾（#61 / R3 / #47 残面）。

- **#61 发布门 flake（P2）**：contract-audit `badref()` 从 `head -1` 改为**全 stderr 搜期望串**
  （选择观测注记可先于 error 行）；驱动错误仍在全输出拒。快机连续两次 144/144。
- **R3 元登记**：`verify/meta.json` 登记 `scripts/tree-contract-matrix.mjs`（test）；`scripts/contract-audit.sh`
  按 #37 lineage 显式 `--reregister`（reason 记入 `reregistrations[]`）。clean tree `verify meta .` 五规则 PASS。
- **#47 残面**：`research query attach` 跨项目时点名 owner（最后一个通用提示动词）；selection-signals 5/5。
- **A1 v1.2 文档**：quorum 分母（PASS+FAIL；ERROR/NEUTRALIZED/STALE 不进，Q10-B 优先）+ V15 逐算子 11 行；
  v1.2 SHA `ff8b245f…`（fdc/验证席 delta 双签）。
- unit **932** 不变；contract **144/144**；`verify meta .`（clean tree）R1-R6 PASS。

## 未发布（裁定 provenance 披露）

- **更新（2026-10-23 14:01）**：属主经 fdc757f6 会话直令**落章**，裁定 Q1–Q13 + G8/G9；v1.2 定稿生效
  （`docs/reviews/verify-tree-run-contract-v1.2.md` + 裁定单 v2）。下列 relayed-order 披露保留为历史记录。

- **A1 `verify tree run` 契约（v1.1）provenance 补正（2026-10-23，fdc 处置 0.1）**：Q1–Q7 仅有主队席
  `dsh/e9a87677` 转发的属主口头「开始」（~01:05），**无属主直接签章/裁定制品**。0.114.17–0.114.22 的 tree
  实现按 **relayed-order** 如实披露；契约文件已降级为「待裁定草案」，冻结线（fdc 0.2）生效——停止实现
  subject/stale/digest 投影/ERROR 规则/tree spec pinning 等未裁定语义，仅保留 P1/P2 修复、测试、文档订正。
  待 Phase 1 裁定包交属主单次过手裁 Q1–Q7 后，按裁定序补齐/返工（含同主体/stale 两点误吸收）。

## 0.114.22

K3 选择观测三条（0.114.18 残余）：共享桶信号补齐到树侧与写时刻。

- **`tree use` 共享桶告警**：session 作用域 + `sessionId()="default"` + 多树工作区 → JSON
  `selection_warning` + 人类黄字提示（与 `project use` 同构；`--global` 不触发该条）。
- **写时刻告警**（`query add` / `node add` 首接）：共享桶 = `source=global` 或
  (`source=session` 且 `sessionId()="default"`)；同一维度最近 **90s** 内有 `project.use` / `tree.use`
  事件 → JSON 增 `selection_warning` + stderr note；**不做 actor 对比**（跨进程/无会话进程正是风险面）。
  90s 窗口外不告警；显式 `-p/-t`/env 选择不告警。核心判定唯一实现
  `selectionChangeWarning(db, dimension, source)`（`core/database/src/selection.ts`）。
- **doctor `selection_hygiene_trees`**：多树 + default 会话身份 → warn 点名树侧共享桶（与 project 侧
  `session_identity`/`selection_hygiene` 对称；保留既有 `tree_selection_hygiene` 全局指针检查）。
- 测试：`selection-signals.spec` 增 1 例（tree use / query add / node add / doctor / 90s 过期五面）；
  unit 931 → **932**；contract 144。

## 0.114.21

元验证层 R6：Cordis 应用框架符合性（K3 评审席施工令，属主「每一个验证器都必须符合 Cordis 应用框架规范」）。

- **META_VERSION 1.2→1.3**；meta 索引 **v3** 增 `kind: "engine" | "consumer"`（R2 校验，缺失/未知按名拒；
  严禁目录启发式）。v1/v2 索引判定与报告形状不变，R6 只在 v3 生效（R5a 版本门先例）。
- **R6 engine 档**：vendor 家族 `@deepseek-ai/*` 依赖全 `workspace:~`；`ygl.bundle.json` plugins 恰为
  database/ops/research/timer（timer 第 4）；Cordis 服务锚（database/ops plugin.ts）在场；vendor 版本 =
  `vendor/upstream.json` 基线 + fork 后缀（基线表随同步维护，不钉进规则）。
- **R6 consumer 档**：`ygl-trees` 引擎钉版 ≥ `ENGINE_FLOOR[CONTRACT_VERSION]`（1.2→0.107.0，PR#16 实证
  五仓钉 0.106.0 读不了 1.2）；orchestration 不得已驱动 `verify run|prepare|submit|archive`；仓内禁
  vendor/fork 引擎。地板表随契约升版维护，缺表点名。
- 本仓 `verify/meta.json` 升 v3 `kind: engine`，新增 `vendor/upstream.json`；`scripts/tree-fixture.mjs`
  按 R3 登记 tooling（sha 绑定）。
- 测试：`verify-meta.spec` 23 例（R6 engine 正例 + 5 负例、consumer 正例 + 钉版/编排/vendor 负例、
  v3 无 kind / v2 不执行 R6 回归）；unit 926 → **931**；contract 144。`verify meta .` 五规则全绿。
- 与 PR#16 P0.1 同批口径：舰队五仓升钉 0.110.0+ 与 R6 落地同批走（红→绿一次完成）；spec_bef7a3fe4644
  深度评估面保留、不退化。

## 0.114.20

A1 树层收口：组节点独立 report+archive + V 系夹具脚本。

- **组层真实 report+archive**：每个 group 生成标准形状 `VerifyReport`（子节点为 asserts）+ 合成 spec，
  走 `buildArchive`（`skipMaterials`，组无材料）并登记 registry；树 verdict 走 additive `tree` 信封，
  标准 `overall` 保持 fold 一致（PASS/FAIL/ERROR）；`tree run` 节点记录 `report_id`/`archive_sha256`/`archive_path`。
- **V6 语义**：pinned 叶归档验签失败 → 该叶子 `NEUTRALIZED`（不静默丢、不 PASS），聚合按矩阵阻断根 PASS；
  额外校验 registry 记录的 **zip_sha256**（追加尾字节等 in-zip manifest 看不到的篡改也会被识别——验证席探针
  实测的 V6 缺口，本版修复）。
- **夹具**：`scripts/tree-fixture.mjs` 一键生成隔离 HOME（两叶 spec+material+prepare、snapshot、树 spec、
  真实叶归档、pinned 树 spec），输出 `leaf_archive_path` 供验证席做篡改→NEUTRALIZED 验收。
- 测试：`verify-tree.spec` 组归档断言（root archive 存在 + `verify archive verify` 通过 + 双跑 digest 相等）；
  unit 926 不变（用例结构增强）；contract 144。
- 棘轮：bundle 799,943 B **held**（基线 795,880，容差内；组归档实现未触发认账）。

## 0.114.19

A1 运行时第一刀：`verify tree run / report / trace`（契约 v1.1 已裁定）。

- **`tree run <tree-spec-id>`**：后序遍历；叶节点真实 `runVerify` + 默认 `archiveRun`（`--no-archive` 可关）；
  pinned 叶子走 archive registry + 验签 + 回读冻结报告；组节点按四态矩阵聚合
  （NEUTRALIZED→FAIL→PASS→全 ERROR=INFRA_BLOCKED；`quorum(N)` 按通过数）；支持默认 `--db` 与
  `--db <node>=<path>` 多快照绑定。写 `verify/tree-reports/<tr_*>.json`，含 `verdict_digest`（只覆盖
  判定投影：节点 verdict/聚合/pinned；run id/时钟/归档字节不进 digest）与 events `verify.tree.run`（只增）。
- **`tree report` / `tree trace`**：读回树报告 / 按 tree spec 列 run。
- 本切组节点写进树报告节点记录（组独立 report+archive 下一小刀）；叶 archive 为真实归档。
- 测试：`verify-tree.spec` 18 例（新增聚合矩阵 7 例 + 双叶运行/确定性 digest/events 1 例）；unit 918 → **926**。
- 棘轮：bundle 基线 **772,395 → 795,880 B**（维护者认账；A1 tree prepare/run 的真实实现；web dist 与
  cold start 基线保持旧值）。

## 0.114.18

A1 审阅订正批（验证席 #59 契约四缺口 + #60 第一刀两洞）。

- **A1 契约 v1.1（审阅订正，不改 Q1–Q7 裁定）**：
  - V7/digest：`verdict_digest` 只覆盖判定投影（子节点用子 verdict_digest），archive sha/时钟/主机进 audit，
    解决「子 sha 含时间戳 → digest 不可满足」；
  - ERROR 聚合矩阵显式化：NEUTRALIZED 优先 → FAIL → PASS → 全 ERROR=INFRA_BLOCKED；ERROR 不否决 PASS；
  - 多快照：`tree run` 支持默认 `--db` + 重复 `--db <node>=<path>` 绑定舰队树，叶可冻结 `db`，缺绑定 rc=2；
  - 同主体查重：同 canonical tree 重复 prepare 幂等（同 id），pinned/db 变化即新 id（V20）；新增 V21 舰队多快照。
- **#60 第一刀两洞**：
  - `--pinned` 冻结现在**验签**：按 archive_sha256 在工作区 registry 找到归档并跑
    `verify archive verify` 同路径，未登记/验签失败 → prepare rc=2（此前只查 node 与 sha 形状）；
  - 聚合解析器收紧：`quorum2` / `quorum(2` / `quorum()` / `all_pass()` 等畸形一律 rc=2（V16）。
- 测试：`verify-tree.spec` 10 例（新增 V20 幂等 + 畸形枚举）；unit 916 → **918**；contract 144。

## 0.114.17

A1 契约 v1.0（已裁定）落地第一刀：`verify tree prepare`。契约正文 `docs/reviews/verify-tree-run-contract.md`，
属主 2026-10-23 裁定 Q1–Q7 通过（经主队席转发）；双席已签。

- **`verify tree prepare <material-id> [--pinned <node>=<sha256>]`**：读已冻结 material 的 JSON 树描述，
  做冻结期校验并写 `verify/trees/<ts_*.json>`：
  - 节点/根/schema、id 唯一、leaf 必须引用已冻结 spec（`specs/<id>/spec.json` 存在）；
  - 组节点非空（Q6 空组 rc=2）、聚合算子封闭集（`all_pass` / `count_fail` / `quorum(N)`，N 边界）；
  - 环/悬空引用/不可达节点 → rc=2；深度 >16（Q7）→ rc=2；
  - `pinned` 在 prepare 冻结（Q3/R-2 纪律），目标必须是叶子、sha256 64 hex；`--pinned` 可追加。
  - 成功 JSON：`{tree_spec_id, tree_spec_sha256, title, root, nodes, pinned, path}`；错误单对象 rc=2。
- 该切只含 prepare；`run/report/trace/archive`（每层真实 run+archive、V1–V19 运行时验收）随下一刀。
- 测试：`verify-tree.spec` 8 例（valid/环/未知算子/空组/深度/悬空+重复+不可达/缺 spec/pinned 形状）。
- unit 908 → **916**；contract 144；无 schema 变更。

## 0.114.16

GitHub #58（P3 · 文档漂移三处，docs-only）。

- **`rel --help`**：引用类型补 **`task:id`**（代码 `REL_TYPES` 九类，帮助只列八类）。
- **`docs/plugin-authoring.md`**：插件可用服务改为真实服务面——`ctx.database.db`（SQLite）、
  `ctx.research.store`、`ctx.ops`（evalClaim/assessEvidence/semanticRank）；删除不存在的
  `ctx.techtree` / `ctx.webApp`。
- **`docs/conventions.md` §一**：九触点路径改 monorepo 现行位置（`packages/core/database/src/db.ts`、
  `packages/research/pipeline/src/writes.ts`、`packages/ops/tools/src/{db-cmds,pgsync}.ts` 等）；
  第 4 触点从「Store 唯一写入面」改为「**写服务唯一写入面**（writes.ts / treeWrites.ts），Store 只剩读、
  配置面与历史例外」；第 2/3 触点同步 writes 路径。
- 无代码行为变化；测试数不变（unit 908 / contract 144）。

## 0.114.15

GitHub #55（P3 · `--attach` 边角）+ #57（P3 · doctor `sqlite_driver` 假阳）。

- **#55 `verify submit --attach`**：
  - 同名不同目录文件不再互相覆盖：`path` 保留目录限定（`x/c.txt` / `y/c.txt`）；绝对路径只取末两段，
    不把临时/home 前缀写进材料清单；
  - 同一文件重复传入只记一条（blob 本就按 sha 去重，清单不再双份）；
  - 目录参数改 **rc=2 用法错**（`usage: verify submit --attach <file> — directories are not accepted …`），
    此前是 rc=1 运行错。
  - `attach-paths.spec` 3 例。
- **#57 doctor `sqlite_driver` 假阳**：改为从 **typeorm 的解析路径**取版本，并比较两侧 `realpath`——
  同一物理副本才 pass；split 布局（两份 better-sqlite3）报 **warn** 并点名 `npm dedupe`；typeorm 完全
  解析不到才是 fail。`sqlite-driver.spec` 增细节断言。
- 测试：unit 905 → **908**；contract 144 不变。

## 0.114.14

#53 升级面跟进（验证席探针口径）。

- **WAL→legacy 回切不再静默失败**：`PRAGMA journal_mode=delete` 需要独占时刻；存在其它打开连接时 SQLite 会
  原样返回 `wal`。0.114.13 只在该请求「成功改变了模式」时提示，失败时无输出（探针看起来「没回切」）。
  0.114.14 先 `wal_checkpoint(TRUNCATE)` 再重试；**仍失败**则 stderr 打 `journal_mode … switch BLOCKED`
  并说明关闭其它连接后重试，不再假装成功。
- 口径说明：升级提示只在**发生转换的那一次打开**出现；旧库一旦已被任一命令转过 WAL，后续打开不再提示
  （无转换可报）。验证时请用「legacy 建库后的第一次普通打开」的 stderr。
- **#54（P2 · npm 升级依赖面）**：`better-sqlite3` 从 `^13` 收窄到 **`^12.11.1`**（typeorm 1.1.2 的
  optional peer 是 `^12`）——此前两个版本域不交，npm 升级可能把 12 收走/留下嵌套 13，typeorm 直接报
  「SQLite package has not been found」，`db init` 与全部 ORM 写入失败。现单版本同时满足两边；
  `doctor` 新增 **`sqlite_driver`** 检查（从 typeorm 视角 resolve 驱动，失败点名 `npm dedupe`/重装步骤），
  `getOrm` 对同一错误给出修复指引。`sqlite-driver.spec` 2 例（版本域 ^12 + 单一物理副本、doctor pass）。
- 测试：`journal-mode.spec` 增「另一连接空闲时回切仍成功」例（checkpoint 重试）；unit 902 → **905**
  （+1 journal +2 driver）。

### npm 升级注记（0.114.12–0.114.13 旧树）

若升级后出现「SQLite package has not been found」：在项目目录执行 `npm dedupe`（或删 `node_modules` 重装），
确认 `npm ls better-sqlite3` 只解析到一个 `12.x`。0.114.14 起依赖域已收窄，新装不会复现；`ygl-trees doctor`
的 `sqlite_driver` 检查可直接判定当前树是否已坏。

## 0.114.13

GitHub #53（P2 · 升级破坏面）+ #52（P3 · 测试污染）+ wasm 依赖清理。

### 升级注记（0.114.11 → 0.114.12+，必读）

0.114.12 把主库切到 **native better-sqlite3** 后，`PRAGMA journal_mode=WAL` 才首次真实生效：打开
**≤0.114.11 创建的旧工作区**时，会把 `DELETE` 日志模式**持久转换**为 `WAL`，而旧版 wasm 驱动无法再打开
WAL 库。0.114.13 起：

- 首次转换在 **stderr** 打一行提示（stdout 机器通道不受影响），并给出降级步骤；
- **`YGL_LEGACY_JOURNAL=1`** 保持旧 `DELETE` 模式（可反复切换，升级/降级安全）；`YGL_JOURNAL_MODE=<mode>`
  可显式指定 `wal|delete|truncate|persist|memory|off`；
- 已转 WAL 后要降级旧版：关闭所有 ygl 会话，执行
  `sqlite3 "<db>" "PRAGMA journal_mode=DELETE;"`（或 `YGL_LEGACY_JOURNAL=1 ygl-trees db stats` 一次），
  再用 ≤0.114.11 打开。

### 变更

- **#53**：`journal_mode` 迁移检测 + stderr 升级提示 + `YGL_LEGACY_JOURNAL` / `YGL_JOURNAL_MODE` 开关；
  `journal-mode.spec` 3 例（全新无提示、旧库转换提示、legacy 回切）。
- **#52**：`verify-example.spec` 与 `apps/cli/tests/help-checker.spec` 的 CLI spawn 补临时 `YGL_HOME`
  （此前写开发者真实 `~/.ygl-trees`，实测 313 条 `cmd.run` 污染）；两 spec 同时 seed 工作区，避免无库时
  首启欢迎页/选择门改变断言。
- **依赖清理**：移除 `node-sqlite3-wasm`（root + core/database），bundle externals 同步；运行时仅
  better-sqlite3 一个 SQLite 驱动。`docs/bun-compat.md` 顶部标注原 wasm VFS 结论已过时、Bun 面待重评。
- 测试：unit 899 → **902**（+3 journal-mode）；contract 144 不变。

## 0.114.12

GitHub #51（P1 · 并发正确性）+ #50（P3 · sweep 残余）。

- **#51 单驱动收敛**：主库从 `node-sqlite3-wasm` 切到 **better-sqlite3**（与 ORM 同一 native 驱动）——wasm
  VFS 的点锁/`mkdir` 协议与 native fcntl 在 POSIX 互不可见，两个驱动同时写会丢已提交事件行并抛假
  `SQLITE_IOERR`（macOS 并发 2/3 失败）。适配层保留 `all/get/run/finalize` 语句面；FTS5 由 better-sqlite3
  预编译提供。`db sql` 对非 SELECT 语句回退 `run()`（native 不允许 `all()` 非读语句）。并发回归断言
  加强：12 并发 `kb add` 后 `base == fts` 且**事件行不丢**（`kb.add` 事件 join 现存 note = base）。
- 测试资源：native 句柄在 Windows 会锁住 tmp 目录——`ops-service` / `verify-jobs` 收尾显式关闭 DB、
  `lock-retry` 等待 holder 子进程退出后再开，均按真实句柄生命周期修正。
- **#50 sweep 残余**：五 node 读动词（`show/parents/children/ancestors/descendants`）缺 key → rc=2；
  `missing-args.spec` 扩到 **81 动词**。六条 `--json` 成功路径收编为单对象：`kb link`（a/b/rel）、
  `kb promote`（name/description/origin）、`db export`（path/bytes/tables）、`webui export`（path/bytes）、
  `skill refs add`（skill/path）、`skill refs show`（skill/path/content）；人类提示行在 JSON 模式抑制。
- 测试：unit 891 → **899**（+5 sweep 读动词、+3 JSON 成功路径）；contract 144 不变。
- 注：`node-sqlite3-wasm` 依赖已不在运行时路径，清理列后续版本（不影响本版字节/安装）。

## 0.114.11

批十六用户观察（验证席转发）：kb 池高并发导入场景出现 `kb_notes` ↔ `kb_fts` 漂移（doctor `fts_sync_kb` 可见）。

- **根因（写入侧缝）**：`kb rm` 用两条 autocommit 语句分别删除 `kb_fts` 与 `kb_notes`（及事件），进程崩溃/忙错落在
  两条之间即留下影子行漂移。改为 `writes.kbRemove`——基表 + FTS 影子 + `kb_links`（双向）+ `kb.rm` 事件在
  **同一个事务**提交；失败整体回滚。
- **高并发路径**：并发 CLI 工作进程在打开/写入时可能拿到 `database is locked` 而整命令失败。加固：
  `busy_timeout` 2s→**10s**；`runTx` 对 `SQLITE_BUSY` 做 jittered 退避重试（事务回滚后重试安全，内容级
  hash 去重保持幂等）；`getOrm` 初始化对打开期锁做有界重试；CLI boot 对打开期 `database is locked` 重试。
- 测试：`kb-fts.spec` 2 例——`kb rm` 后 base/fts/事件一致且 doctor 绿；**12 并发 `kb add`** 全部 rc0 且
  `kb_notes == kb_fts`（并发双写同一事务）。
- unit 889 → **891**；contract 144 不变；ratchet held（cold start 471→459 tightened）。

## 0.114.10

GitHub #49（验证席 P3 · #48 残余）：带必选 id/name 的动词缺参时泄漏驱动错误/静默 rc=0。按验证席建议
做**一次全命令面缺参 sweep**，而非逐批补丁。

- **八动词修复**：`kb link`、`job run|enable|disable`、`tree use`、`skill rm|enable|disable`、
  `skill refs add|show` 缺参 → **rc=2 单 `{"error":"usage: …"}`**（不再泄 `Unsupported type for binding`
  /`not found: undefined`）。`skill refs` 的两个 `case` 合并（此前 `refs add` 被前面的列表分支截获，文档里的
  写法实际不可用）；`tree new/use` 在树解析前置校验。
- **同批收敛**：`db export` 按 help/README 声明要求 `<file.sql>`（此前无参静默生成默认文件名并 rc=0）；
  `patrol run` help 改为 `[--name <check>]`（实际接口，此前写成必选位置参数）。
- **机械 sweep**：`missing-args.spec` 维护全命令面必选参数表（76 个动词）——每行以「缺全部位置参数」调用，
  断言 rc=2 + 单个 JSON error、stderr 干净；新增带必选参数的动词要同步加行（与 llms/help 同纪律）。
  该测试一次收全类，后续无需第三轮逐动词派单。
- 测试：unit 813 → **889**（+76 sweep 例）；contract 144 不变。

## 0.114.9

GitHub #47（验证席 P3 · #44 残余）：selection 作用域残面按 #45 语义做**全 id 动词清单过堂**，统一
「项目内解析；跨项目时拒绝并点名 owner」（R16.3）。

- **produce / task**：`produce show` / `produce export` 增项目作用域（此前跨项目 rc=0）；`task done/doing/todo`
  按 artifact(kind=task) 的 project_id 校验，跨项目拒绝并点名。
- **research 补全**：`claim evaluate`、`evidence assess`、`evidence rm`、`source rm`、`query done`、
  `claim link --by-source` 的 source 缺失路径，统一 owner 点名；`query done` 同时补项目作用域（此前跨项目 rc=0）。
- 共享 `idNotFound` / `ownerProjectName`（core selection）作为唯一规则；本版只改 id 动词作用域与拒绝文案，
  不改变选择授权语义（#45 D1–D5 仍待属主）。
- 测试：`selection-signals.spec` 增 #47 用例（task / produce show+export / evidence assess+rm / source rm /
  query done 八个动词 owner 点名）；unit 811 → **812**；contract 144 不变。
- **#48 缺 id 位 → rc 2 用法错**：`produce show` / `produce export` / `kb show` / `research source show`
  缺参数时前置校验，输出单 `{"error":"usage: …"}`、rc=2（此前 `research source show` 会把驱动层
  `Unsupported type for binding undefined` 泄漏成 rc=1）；`usage-rc.spec` 增四例；unit 812 → **813**。
- 棘轮：bundle 基线 **757,018 → 772,395 B**（维护者认账；来源为 PR #42 walk-up + #44/#46/#47/#48 的
  真实逻辑；web dist 与 cold start 基线保持旧值不动，实测均在容忍带内）。

## 0.114.8

GitHub #46（验证席 P3 · JSON 契约违例）：`produce export` 成功路径在 `--json` 下打印人类 ack（`written: …`），
错误路径却是 JSON——违反冻结契约「`--json` 写 = 单 JSON 对象」。

- 成功路径改为 **`{"artifact_id","path","chars","bytes"}` 单对象**（与写命令契约一致）；
  人类模式 ack 不变；错误路径维持单 `{"error"}` 对象。
- 测试：`produce-export-json.spec` 3 例（成功单对象 + 文件字节一致、错误单对象、人类模式 ack）；
  unit 808 → **811**；contract 144 不变。

## 0.114.7

GitHub #44（验证席 P2/P3）选择桶信号与 owner 点名；选择语义全面梳理见 `docs/reviews/project-selection-review.md`（#45，D1–D5 待属主）。

- **F1/P2 `project new` 静默改写共享 default 桶**：`project new` / `project use --json` 结果增
  `selected` / `prior` / `session` 字段；写入共享 `default` 桶且工作区已多项目时，增
  `selection_warning`（JSON 字段 + 人类面 stderr 警示行）。选择本身仍按现行为（D2/D3 待属主），信号先补齐。
- **F2/P3 `claim link` 忽略选择**：跨项目链接且**未显式 `-p`**、所选项目不拥有任何一端时，回执增
  `selection_note` 说明「选择不拥有此链接两端」；链接行为不变（D1 待属主）。
- **F3/P3 id 寻址动词作用域分歧**：`claim resolve`/`unresolve`/`unlink`、`evidence add <source>`、
  `source show` 的拒绝统一**点名归属项目**（`it belongs to project 'p1' — use -p p1`）；
  `source show` 按 R16.3 改为**作用域内读取**（此前跨项目可读，与 R16.3「读写都 fail-closed」相悖）。
- 测试：`selection-signals.spec` 3 例（F1 字段/警告、F2 selection_note、F3 五个动词 owner 点名）；
  unit 795 → **808**；contract 144 不变。

## 未发布

GitHub #25 ③（0.113.1 后唯一未闭项）：**submit / prepare 的 meta 闸从子目录误拒**。`verify meta` 自 0.113.1 起从子目录上溯到
仓库根判定（PASS），但闸的硬分支仍判 `process.cwd()`——在合规仓库的 `sub/` 里 `verify submit` 得 rc=1
`meta gate: no AGENTS.md under …/sub (meta_unverified)`，两者判的不是同一个仓库。

- **同一解析**（`packages/ops/tools/src/meta-gate.ts`）：新增 `judgedRepoOf(start)` = `verify meta` 用的
  `metaRepoRootOf`（从起点的**真实路径**上溯到最近的标记目录 / git 根），回落起点真实路径。闸的三条路径
  （`--no-meta` 旁路的 provenance、阶梯 2/3 的标记判定、硬分支的 AGENTS.md + `runMeta`）都判这一个仓库。
- **阶梯不变**：显式 `--meta-repo` 优先于 cwd（且与 `verify meta <dir>` 一样从给定目录上溯）；cwd 不在任何
  git 仓库内 → 按 fdc 裁定静默跳过；git 仓库无标记 → 警告并跳过（警告点名判定的仓库）。差异只在「哪个目录」：
  标记在 git 根与 cwd 之间的嵌套目录时，闸与 `verify meta` 一样判那个目录（此前闸只看 git 根的标记）。
- **嵌套 AGENTS.md 不截断上溯**（审查席观察，0.113.1 起 `verify meta` 同病）：git 仓库内，上溯只停在带 meta 索引的目录
  （`verify/meta.json` 或 `verify/specs/`）或 git 根；单独的 `AGENTS.md` 不再算终点——monorepo 的 `packages/AGENTS.md`
  是指引不是验证器仓库，`packages/x` 应判为仓库根，而不是 `packages`（否则 NEEDS-MATERIAL、submit rc=1；本仓即如此）。
  git 外，最近的 `AGENTS.md` 仍标记独立验证器目录。`verify meta` 与闸共用 `metaRepoRootOf`，两面一起收紧。
  仅有 AGENTS.md 的目录本来就过不了 meta（无索引 = meta_unverified，#22），故不丢任何能 PASS 的情形。
- **realpath**（#26 同族）：起点先取真实路径，符号链接 / macOS `/var → /private/var` 下判到同一个真实仓库，
  bypass provenance 的 `repo` 记真实路径。
- 测试：`meta-gate-subdir.spec`（发布产物 10 例：合规仓 `sub/`、`sub/deep/` submit 通过且与 `verify meta` 同判；
  `sub/` prepare 过闸到构造判定；不合规仓（R3 散脚本）从子目录仍 `meta_failed`、与 `verify meta` 同判；仅有索引无
  AGENTS.md → `meta_unverified` 点名仓库根而非子目录；`--meta-repo` 覆盖 cwd（双向）；符号链接起点判真实仓库；
  git 外仍跳过；monorepo 嵌套 `packages/AGENTS.md` 不截断、`verify meta` 与 submit 都判仓库根；git 内带自有索引的
  嵌套验证器目录判为自身；git 外 AGENTS.md 独立目录判为自身）。在 0.114.6 的 `meta-gate.ts` 上 8/10 红。
- 契约 / 语料 / charter 不变；无 tooling 改动（无需重登记）。

## 0.114.6

- **#39 Rust 封包判定去启发式**：`looks_sealed()` 原先在「尾 4 字节回扫窗口含 `YGLVF1` 字面量」时也判封包，
  开构建的机器码里 `MAGIC` 字面量恰好落进窗口就误判「封包但篡改」（`test:rust` cli 4/8 路径依赖失败）。
  改为**footer 形态**判定：窗口须解析为带 magic/format_version/spec_offset/spec_sha256 的对象，或（JSON
  语法损坏时）花括号/方括号成对且含 JCS footer 首键 `"build_sha256"`；删除「含 MAGIC 字符串」兜底。
  回归测试：开构建尾窗仅含 MAGIC → 不判封包；括号成对 + build_sha256 窗 → 仍判封包（不静默降级）。
  本版不触契约/语料；unit 不受影响（rust 面 `cargo test` 全绿）。

- 门禁（本版实测）：unit **795/795（106 files）**、contract **144/144**、demo、ratchet held、readme 54/54、pack:check PASS；
  `cargo test`（rust 面）全绿，含 #39 新增回归。

## 0.114.5

GitHub #34 修正（0.114.1 / 0.114.2 的回归：舰队全部材料 lint `ok:false`、prepare 拒冻）：**子句按规则界定 +
不冲突的定位语法 + 舰队材料消费方夹具**，对齐审查席在 #34 的设计提案 a–d。原修复的意图保留——丢一条判据、
错一个锚点仍然被点名，prepare 不静默冻结；孤儿评审也被点名。

- **a. 子句 = 匹配子句模式的行**（`packages/verify/core/src/prepare.ts`）：默认舰队约定 `^([A-Z]+[0-9]+) `
  （捕获组 = 子句 id）；标题 / `##` 小节 / 空行 / 散文（`验收对象：…`）按规则不在范围内，不再靠豁免。
  材料可在冻结时声明自己的模式：`verify submit --clause-pattern <regex>` 写进 `material.json`
  `clause_pattern`（参与 `material_id` 哈希；未声明时 id 不变），prepare（CLI / WebUI 作业端点）只认冻结的模式；
  `lint-candidates --clause-pattern` 面向裸文本。缺捕获组或非法 → rc=2。同 id 重复声明 → 覆盖问题。
  **SKIP ≠ OK**：声明了模式却一行不中 → 覆盖问题（lint `ok:false` / prepare `error`）；默认模式一行不中 →
  具名跳过（lint `coverage_skipped:true`、`coverage.enforced:false`，`issues[]` 增一条 `level:"warning"` 的 COVERAGE
  条目——`ok` 只计拒绝，保持 prepare 投影；prepare ready 记录
  `[P1c] no clause lines matched pattern … — clause coverage not enforced (a skip, not a pass)`，`--json` 带 `coverage`），
  不再逐行造出子句。prepare 记录（`prepare.json` / `attempts/*.json`）增结构化 `clause_scope: {pattern, declared, enforced, clauses}`。
- **c. 定位语法**：`[文件]#<片段>` 先按子句 id 解析（`#S1`、`#L2` 是 id，不再被当成第 1/2 行）；物理行写
  `#line=<n>`。材料有子句时，无法解析的片段是 P1 拒绝，诊断只按子句计数（`declares 3 clause(s): S1, L2, S3`），
  行诊断只按行计数（`material has 12 line(s)` / `line 2, which is blank`）。旧的 `#L<n>`/`#S<n>` 行号写法删除，
  `clauseLineOf` 导出随之移除（0.114.1 引入，无消费方）。
- **覆盖认领收紧**：候选的 locator 解析到该子句（或其行），或 `source_clause` 含整行子句，才算认领；只引片段
  又无可解析 locator 的候选不认领（`S1` 不再顺带覆盖 `S10`）。`coverage` 输出增 `pattern` / `enforced`，
  `uncovered[]` 增 `id` / `line`。
- **b. 豁免只认子句 id 或原文 + 必填 reason**：`{id | locator | text, reason}` 恰好一个指明字段；裸字符串条目 rc=2
  （不再隐式补 reason）；`#line=<n>` 豁免被拒（编辑会静默改靶）；豁免已被覆盖的子句 → 问题。
- **评审配对**：prepare 把评审文件的 `source_clause` 交给构造面，**孤儿评审**（无候选携带）→ `error` +
  `[P3] orphan review`（CLI 与 WebUI 作业端点）；`lint-candidates --reviews <file>` 同源检查（孤儿评审 / 无评审候选 →
  `stage:"REVIEW"`）。
- **d. 消费方夹具进发布门禁**：`packages/verify/core/tests/fixtures/fleet/` 冻结 4 个舰队验证器仓（review 7 /
  webui 6 含 view / fleet 2 / design 9）共 24 份真实 spec 的 `material.md` + 已提交 `candidates.json` / `reviews.json`
  （来源 commit 见 `manifest.json`；全部带标题/散文/纪律节）。contract 15 对全部 24 份跑 `lint --text --reviews` 与
  `submit → prepare --draft`（快照 schema 由候选谓词合成，P4 空库红队照跑），任何非 ok / 非 ready 即发布阻断。
  单测：`fleet-fixtures.spec`（库面：全部 lint ok + prepare ready；S/L 开头 id 的三份材料上做丢子句 / 坏锚点 /
  孤儿评审负例；在 0.114.2 的 `prepare.ts` 上 57/58 红）+ `verify-fleet-fixtures.spec`（发布产物：全部 ok/ready +
  CLI 负例 + submit 冻结模式 + 裸字符串豁免 rc=2）。
- 契约面：spec 与报告形状不变（`contract_version` 1.2、`corpus_version` 1.2）；构造面加法字段（`material.json`
  `clause_pattern`、lint `coverage_skipped`、prepare `--json` `coverage`）；`docs/verify-contract.md` §1.6 改写。
  charter 不涉及。Rust 侧不镜像 prepare / lint，无改动。
- 门禁：contract 15 改写（id 子句 + 按 id 豁免 + 行号豁免拒绝 + 跳过可见 + 舰队夹具 lint/prepare 24/24），
  141 → **144**；`scripts/contract-audit.sh` 合并 0.114.3 后按 #37 机制显式重登记一次（`verify/meta.json`
  `reregistrations[]` 追加 591755c2 → 新 sha 一条，reason 写明合并前本分支三次旧机制重登记 7b367f41 / c241e42c / e6bf02b0）。
- 棘轮：bundle 基线 739,621 → **757,018 B**（本 PR 自行抬升，**需维护者显式认账**；master 的上限是 754,413）。同源对比：
  0.114.2 自身 748,195 B，本修正 head 757,602 B（+9,407：子句清单 / 定位解析 / 评审配对 / 豁免校验与其可操作诊断文案；
  已把新增顶层 JSDoc 改为 `//` 注释省下约 2.3 KB——tsdown 保留顶层 JSDoc、剥离行注释）。只认 bundle 一项，web dist 与冷启动保持原 win32 基线不动。

- 发布门禁（整合后实测）：unit **787/789**（2 skipped）、contract **144/144**（含舰队 fixtures lint+prepare **24/24**）、
  demo、ratchet held（bundle 基线认账 739,621 → **757,018 B**，仅 bundle；web dist 与冷启动基线不动）、readme 54/54。
- 已知非本版：#39 Rust `looks_sealed()` 路径依赖误判（开构建尾 4 字节回扫窗口含 `YGLVF1` 字面量）另批修；
  本版不触 `rust/`。
- 0.114.4 的 `llms.txt` job add 改序只改了生成物（源码模板仍旧），本版把模板同步进
  `apps/cli/src/bin.ts` 并重生成——生成物与源码不再漂移（`llms.txt` 首行 v0.114.5）。

## 0.114.4

fdc757f6 评审（属主令 2026-10-22 09:25）：`job add` 静默误注册/用法教唆/无绊线，一处 P1 两处 P2。

- **F1/P1 静默误注册**：尾拉回启发式要求 schedule 旗标在串尾，`--every 1440 --json` 这类后缀 token
  会击穿它，`args.flags.every` 未定义 → `Number(undefined||0)=0` **零告警**落成 manual job。修复：拉回后
  命令串仍匹配 `--every\b|--at\b` → **绊线警示**（不硬拒——任意命令可合法自带同名旗标）。
- **JSON 面**：`job add --json` 结果新增 `diagnostics[]`：「schedule 形 token 残留命令串内，本 job 已按
  manual(every=0) 注册；若意图是调度，请把 --every 移到 -- 之前」；**人类面**同文案走 stderr 警示行。
- **F2/P2 用法行教唆陷阱**：usage 改为 `job add <title> [--every <min>|--at "YYYY-MM-DD HH:MM"] -- <command>`
  ——旗标在 `--` 前；尾拉回保留为兼容面不主推。
- **P3 文档**：README 调度示例与 `llms.txt` job add 行同批改序（`--every` 在 `--` 前）。
- 测试：`job-schedule-token.spec` 5 例（后缀击穿 JSON diagnostics / 人类 stderr / 前置 flag 正常 / 尾拉回
  兼容 / usage 教序）；unit 707 → **712**。
## 0.114.3

验证席派单 #36/#37（双 P3，其中 #36 为红门）。

- **#36 墙钟硬编码（红门）**：`predict-cli.spec` 的 due fixture 用 `created=2026-10-10 / deadline=2026-10-17`
  字面量，过了 2026-10-21 后每个清洁检出的 unit 门恒红。改为**相对 today 滚动**（created = 今天−11d、
  deadline = 今天−4d、`days_left` 恒 −4），不再有日历日期会过期。
- **#37 重登记审计出域**：`meta.reregister` 原先只写操作员本地 DB，clone/评审者看不到理由，且 raw SQL
  绕过写服务纪律。改为把审计记录追加进 `verify/meta.json` 的 **`reregistrations[]`**
  （{path, old_sha256, new_sha256, reason, at}，append-only，**随仓库走**）；`meta-tooling --reregister`
  用一次原子写同时更新登记与审计（无本地 DB 依赖）。R2 校验该数组形状（path/old/new/reason/at）；
  contract 12c 追加**链一致性**断言：每条记录的 path 已登记、reason 非空、at 可解析，且每条路径的最后一条
  `new_sha256` 必须等于当前活 sha。本仓三笔历史重登记已迁入（contract-audit.sh ×2、meta-tooling.mjs ×1）。
- 门禁：unit 706 → **707**；contract 141（12c 加强，条数不变）。

## 0.114.2

r32 讨论催办（GLM Q3）：**tooling 登记漂移修复显式化 + 可审计**，并修掉本仓 `verify meta .` 的 R3 漂移。

- **漂移修复**：`scripts/meta-tooling.mjs` 重写为三模式——`--check`（只比对）、
  `--reregister <path> --reason "<why>"`（显式重登记）、`--add <path> --role`；**删除隐式 auto-rehash**
  （无参数 = usage rc2）。重登记**先写 `meta.reregister` 事件**（events：path/old_sha256/new_sha256/reason/actor，
  append-only、level=warn）再改 `verify/meta.json`——事件写失败则拒绝改索引（fail-closed）。
- **本仓漂移**：`scripts/contract-audit.sh`（0.114.1 contract 15 改动）与 `scripts/meta-tooling.mjs`（本版改动）
  两条登记已按上述流程重登记；`verify meta .` 恢复 PASS（R1/R2/R3/R5a）。
- **机械门**：contract-audit 增 12c——`meta-tooling --check` 必须 rc=0（与 `verify meta` R3 同源）；
  contract 140 → **141**。
- 测试：`meta-tooling.spec`（drift 红 → 无 reason 拒 → 显式重登记写事件+索引 → check 绿 → 无 drift 拒重登记 →
  bare run usage rc2）；unit 704 → **706**。
- charter §4.4 R3 补记⑤：登记漂移只能显式修复，禁 auto-rehash。

## 0.114.1

GitHub #34（验证席 P2 · 构造面覆盖缺口）：判据不得静默消失——prepare / lint 增加**冻结子句覆盖**检查。

- **子句模型**：材料每个非空行=一条冻结子句（`#L<n>`，`#S<n>` 同义别名；可带文件名前缀）。
  `anchor.locator` 为子句式时**必须命中存在的子句且该子句含 quote**（#S9 类悬空锚点拒）。
- **覆盖检查**：每条子句必须被**至少一个通过 P1 的候选**的 `source_clause` 覆盖；prepare 在 P1–P3 之后、
  P4 之前校验，未覆盖 → `verdict:error` + `diagnostics[stage=P1c]` 点名（**不冻 ready**，防「丢一条规则
  的 spec PASS 本应 FAIL 的数据」）；`verify lint-candidates --text` 同源检查，输出增
  `coverage:{clauses,covered,exempted,uncovered}`、`issues[].stage="COVERAGE"`。
- **具名豁免**：`--coverage-exempt <file>`（JSON 数组或 `{exempt:[{locator,reason}]}`），缺 reason /
  locator 不存在 / 格式非法 → 拒（不可审计的豁免不生效）。
- 契约面：报告形状不变（构造面检查，`contract_version` 1.2）；`docs/verify-contract.md` 补记 P1 与 §1.7 前口径。
- 门禁：contract-audit +2（contract 15 覆盖/豁免）→ **140**；unit 700 → **704**。

## 0.114.0

- **charter v1.2（docs-only，0.113.2 之后）**：#29 修正谱系——R5 权威拆分（R5a 静态合规 / R5b 审计方
  内嵌能力表、默认不执行）、§4.7 增 `capability_version` 列与 `unshipped` 无界、verbatim 提取规则入表注；
  依据 fdc757f6 对 #29 的裁定。无代码面变更。
- **#27 方案 T1（#28 残留）：归档内 `submission-scan.json` 改为白名单投影**。0.113.2 只去掉了侧车顶层的
  `dir`，逐 scan 的 `dir`（本机绝对路径）仍进了包。现在归档项只含
  `{run_id, spec_id?, scans[]: {vu_id, files, ignored, matched[]: {path, sha256, size}}}`；`matched[].path`
  非相对（绝对 / `..`）→ 拒绝归档并点名。同一份扫描在任何机器上产出同一 zip 字节；归档内 grep 不到
  `/Users/`、`/private/`、`/tmp/`；字节篡改仍 fail-closed。契约 §7.2 补记 0.113.1/0.113.2 新增的三类条目与
  本形状。报告形状未动（契约 1.3 批另议，见 `docs/verify-contract-v1.3.md` 草案）。
- **#27 方案 T7a（charter v1.1 §4.4 / v1.2 R5a）：`verify meta` 读 `meta_index_version: 2` 登记制**。
  - v2 索引新增 `orchestration[]`（`{path, sha256, role ∈ collect|invoke|aggregate-input, replaced_by, sunset}`）
    与 `tooling[]`（`{path, sha256, role ∈ build|test|release|gate}`）；**R2** 校验登记形状（键集、角色闭集、
    64 位小写 hex、路径仓内相对且不重复）。
  - **R3 豁免改登记制（v2）**：扫描面 = git 看到的文件（已跟踪 + 未忽略的未跟踪；`dist/` 等 gitignored 构建产物不在面上；
    非 git 目录则全树），只豁免 `tmp/` 与依赖根（`node_modules/`、`vendor/`）；**目录名白名单在 v2 下退场**（评审 P2：
    0.112.0 的按名放行让未登记的 `scripts/run.mjs` 驱动 `verify run` 而 R3 PASS，#22 绕过仍在）。其余可执行件（v2 起含 `.py`）
    只在登记于 `orchestration[]`（有效性归 R5a）或 `tooling[]`（sha256 必须一致）时放行；列有 spec 的仓库里 `tooling[]`
    文件不得调用 `verify run|prepare|submit|archive`——机械匹配同时覆盖 shell 形式与舰队惯用的 argv 数组形式
    `ygl(["verify", "run", …])`（评审 P3）。v1 索引仍按 0.112.0 规则（目录白名单 + `freeze.mjs` 硬编码）只读兼容。
  - **本仓登记**：`verify/meta.json` 升 v2，25 个已跟踪脚本（`scripts/`、`benchmarks/`、`examples/`、`freeze.mjs`）登记为
    `tooling[]`；新增 `scripts/meta-tooling.mjs`（`--check` / 刷新 sha / `--add`）维护登记，contract-audit 12 的
    `verify meta .` 让登记漂移变红。`.ts` 不在 charter 的扩展名闭集里（Node ≥22 可直接运行 .ts；本仓 254 个 .ts 源文件）——
    留给 charter 裁定，引擎按闭集扫描。
  - **ratchet 认账**：bundle 722,820 → 739,621 B（+16.8 KB，超 2% 容差；meta v2 登记制 + R5a + git 扫描面 + 归档投影），
    只重设 `bundle_bytes` 基线；冷启动与 web 基线不动（基线由属主的 win32 机器测得，本机不得覆盖）。
  - **新增 R5a**（仅 v2 报告）：`orchestration[]` 每条 `path` 在 `verify/orchestration/` 下、sha256 一致、
    `replaced_by` ∈ §4.7 命令 token 闭集（`verify collect` / `verify snapshot build` / `verify tree run` /
    `verify self-check` / `verify package` / `verify notify` / `verify import-report`）、`sunset` 为完整
    `MAJOR.MINOR.PATCH`；**不做时钟比较**（R5b 审计面显式开启，本版未提供 `--capabilities`，#29 口径）。
  - **版本映射**：`META_INDEX_VERSIONS = [1, 2]`，`META_VERSION` 1.0 → **1.1**；v1 索引按 v1 规则只读兼容、
    不读登记（报告仍是 R1–R3 三条）；`meta_index_version ∉ {1,2}` 按名拒绝，闸的 `meta_index_unknown` 语义
    随之收窄为「未知」。报告增 `meta_index_version` 字段（无索引为 null）。
  - 测试：verify-meta +4（v2 空登记 / tooling 登记与 sha 漂移与形状 / tooling 驱动验证 / R5a 四缺陷 + v1 不读登记）、
    meta-gate +1（v2 登记过闸）；顺手修 #25c walk-up 用例在 macOS 上的 realpath 比较（`/var` ↔ `/private/var`，
    #26 口径）；archive/submission-scan 单测扩成「任何层级无 `dir`、无本机路径、两次构建同字节、非相对路径拒绝」。
- **#27 方案 T6：渲染面透出语义边界（缺省按 structural）**。契约 ≤1.2 的报告没有 `semantic_scope` 字段，
  此前任何渲染面都看不出「这份 PASS 在哪一层成立」——父验证器对子归档的 PASS 容易被读成「子结论为真」（#27 Q3，K3 双钉）。
  - **WebUI 报告看板**：运行记录每行、报告头各带一个「边界」标签（structural「仅结构」/ factual「事实」/ semantic「语义」）；
    无字段 → 显示「仅结构·缺省」并在报告头给**一行**说明「父 PASS 不代表子结论为真」；VU 表只在报告真带 `semantic_scope`
    （契约 1.3 起）时才加「边界」列，缺省不逐行重复。说明走 Tooltip + 可聚焦 span + 标签内视觉隐藏文本
    （键盘 / 触屏 / 读屏可达；不给无 role 的 span 挂 `aria-label`——ARIA 1.2 禁止命名 generic 元素）；
    缺省提示只说「按最保守读」、不描述检查器实际做了什么。`ReportDetail` / `ScopeTag` / `scopeLabel` / `scopeHint` 可测导出——
    种子库没有报告，运行时视图验证器画不到新 UI，其证据是夹具静态渲染单测（监督席评审 ①②③）。
  - **服务端列表投影**（`verify-web.ts listReports`）：`semantic_scope` 原样透传，无字段为 `null`——服务端不替报告发明值，
    兜底在 UI。
  - **CLI**：`verify run` / `verify report <run>` 的人类输出首屏增一行 `semantic_scope <值>`；无字段时写
    `structural (缺省：报告无 semantic_scope 字段，按最保守读——父 PASS 不代表子结论为真)`。**JSON 面原样**（报告不可变、形状冻结；
    字段本体属契约 1.3 批 T4）。
  - **闭集之外不失败开放**（评审 P3）：`semantic_scope` 不在 `structural | factual | semantic` 内的值（拼错、大小写、未来新值），
    WebUI 标签显示「仅结构·未知值」、报告头给一行说明，CLI 行写 `structural (未知值 "<原值>" 不在闭集内，按最保守读…)`；
    任何面都不原样透出未知值。
  - 测试：`verify-report-scope.spec`（CLI 两面 + JSON 不变 + 投影 null）、`verify.spec.tsx` +2（缺省/闭集映射）。

- **#29 T8 补裁落地（charter §4.4 R3 范围 + `META_VERSION` 1.1→1.2）**：R3 扫描面=git 可见文件；
  **gitignored 路径不属 R3 面**（其内验证驱动脚本由 P2 证据规则管辖，路径无关；`tmp/` 唯一探索白名单；
  全局 gitignore 接受为不可机械检面）；可执行扩展名闭集 v2 起含 `.py` 与 **`.ts/.mts/.cts`**；产品源码根经
  **`source_roots[]`** 显式声明（具名子目录，禁 `.`/`..`/绝对/反斜杠/尾斜杠，非法→R2 形状拒绝；
  **未声明即全扫**；根级闭集文件不被 source_roots 覆盖，按登记处置）。本仓声明 `["packages","apps","tests"]`
  并登记 `vitest.config.ts`（tooling role=test）。审计面对「source_roots 过宽」的 warning 记 §4.7 待办（不实现）。
  测试：verify-meta +3（source_roots 豁免/非法值/严格全扫）。

## 0.113.2

GitHub #28（验证席 P2 · charter P5）：`verify run --submission` 的 file 检查器扫描面留痕。

- **扫描 trace**：file VU 执行时（PASS/FAIL/NEEDS-MATERIAL 均记）经引擎内部 `onFileScan` 回调产出
  `{vu_id, dir, files, ignored, matched:[{path,sha256,size}]}`；CLI 写工作区侧车
  `verify/submission-scans/<run_id>.json`，`verify run --json` 增 `submission_scan` 摘要（path/files/dir）。
- **archive 一等 item**：构建归档时把 trace 以 `submission-scan.json`（去绝对路径）入包，matched 文件字节
  按内容寻址入 `submission/<sha256>`（role=`submission-file`，`original_name` 保留原相对路径）；
  `manifest.items` 绑 sha、**manifest 顶层形状不变**；归档时重算哈希，字节已变即 fail-closed
  （`submission file changed since the scan`）。
- **契约面**：report `evidence` 形状与 `data_source` **未改**——路径清单/逐文件哈希入 report 属报告形状
  变更（契约 1.3），与 #16 P1 raw-material provenance、#27 Q3 `semantic_scope` 同批升版；本版先用
  sidecar + archive 把 P5 的可追溯性补齐（PASS 可回指被检字节、字节可复原）。
- 测试：`submission-scan.spec`（CLI 端到端：trace 侧车 + report evidence 键集冻结 + archive items）、
  archive 单测（入链 + 字节篡改 fail-closed）；unit 680 → **682**。

## 0.113.1

GitHub #25 / #26（验证席 P2/P3）：bypass 进证据链、meta 根 walk-up、跨平台 realpath；charter 补齐闸的覆盖面。

- **#25a `--no-meta` 逃逸进证据链**：submit/prepare 在 material/spec 目录落 `meta-bypass.json`
  （canonical JCS，`{command,cwd,repo,bypassed_at,payload_sha256}`）；archive 把它作为**一等 item**
  （role=`meta-bypass`，manifest.items 绑定字节 sha），**不改 manifest 顶层形状**（冻结形状守卫不变）；
  `verifyArchiveBytes` 全链可验。events 的 `meta.bypass` 携带同一份 provenance。
- **#25b 闸的覆盖面（fdc 裁定）**：meta 是准入闸，骑在 `submit`/`prepare`；`run`/`archive` 不二次 gate，
  以 provenance 追溯承接 P5。charter §4.2 明写，防「漏实现」误读。
- **#25c meta 根解析 walk-up**：`verify meta <repo>/subdir` 与自动检测从给定路径向上找验证器标记/git 根；
  自动检测阶梯**限定在 git 仓内**（普通业务目录静默），且 marker 不再把工作区 `verify/` 数据目录误判为验证器仓库
  （改为 AGENTS.md / `verify/meta.json` / `verify/specs`）。
- **#26 realpath 归一**：cwd/repo 双侧 `fs.realpathSync`，macOS `/var`→`/private/var` 软链不再产生审计差异。
- 测试：meta-gate（含 bypass sidecar、subdir 回显、realpath 断言）、verify-meta（子目录 walk-up）、
  archive（provenance item 可验 + manifest 形状不变）；unit 677 → **680**。

## 0.113.0

charter §4.2 翻转点：**meta 准入闸默认硬拒收**（阶梯检测）+ **版本键控机械门**。

- **检测阶梯**（fdc757f6 裁定 A 加固版）：
  1. `--meta-repo <path>` 显式 → 硬拒；
  2. cwd 在 git 仓且带验证器标记（AGENTS.md / verify/ / verify/meta.json 任一）→ **默认硬拒**；
  3. cwd 在 git 仓但无标记 → **warn+点名 R1 提示后跳过**（缺 AGENTS.md 的验证器仓库得到 R1 压力，
     门不静默消失）；
  4. cwd 非 git 仓（业务随机目录）→ 静默跳过（产品面无感）。
- **`--no-meta` 逃逸**：允许应急注册，但必须**持久化审计**——每次 bypass 同步写入
  `events(kind="meta.bypass", payload={command,cwd,repo})`；写入失败则拒绝 bypass。JSON 回执带
  `meta_bypassed:true`。
- `--require-meta` 保留为幂等显式开关（不再改变默认），help 用 deprecation-style 标注；CHANGELOG/help
  双声明翻转。
- **机械门（本版随版本落地）**：contract-audit 新增 contract 14——`version >= 0.113.0` 时断言
  `META_DEFAULT_POLICY = "hard-for-verifier-repos"`、阶梯检测（gitRootOf）与 bypass 落账同时存在；
  版本键控在人读声明之外提供机器拦截。
- 门禁：unit 675 → **677**（ladder 3/4 + bypass events 三例）；contract 135 → **136**。

## 0.112.0

charter §4.3 落地：**`verify probe --matrix`** —— 评审席两代临时探针（sealprobe/sigprobe）升为 CLI 命令，
复核证据必须来自命令（P2 自我约束的正式化）。

- **16 向并集**（开发席八 + 评审席篡改八）：
  `envelope` / `signature` / `digest` / `timestamp` / `escalation` / `injection` / `cross-machine` / `replay`
  + `tamper-spec` / `tamper-engine` / `tamper-footer` / `noncanon` / `sig-byte` / `unknown-key` /
  `retired-key` / `resign-fv`。
- **确定性/离线**：fixture 用 RFC8032 确定性测试种子（`sha256(probe-label)`）自签，禁网、禁生产钥；
  `timestamp` 探针以「同输入两次封包字节逐字节相同」验证无时间/随机泄漏。
- 输出 `{probe_version, target, seeds, probes:[{probe,verdict,detail,evidence_sha256}], verdict, checked_at}`；
  `--matrix` 全量、`--only <name>` 单探针、`--target <sealed-file>` 以真实封包为基；失败不中断、
  rc 镜像 verdict（0 PASS / 1 FAIL / 2 用法）。`retired-key` / `resign-fv` 保留（fdc 0.99 复核实证语义）。
- charter §4.3 状态更新为已落地；contract-audit 新增 contract 13（16 向全 PASS + 未知探针 rc=2）→ **135**。
- **#22 meta soundness（评审席 P 级）**：R2 无索引域从「PASS skipped」改为 **NEEDS-MATERIAL**（zero-scan
  不是通过；闸映射 `meta_unverified`），R3 改为**全树扫描**（工具目录白名单，`lib/probe.mjs` 这类散件会被拒），
  charter §4.4 口径同步；`verify meta`/meta 闸测试补零扫描与全树散件两例。
- 门禁：unit 667 → **675**（probe 5 + #22 三测）；**ratchet 认账**：bundle 703,423 → 722,820
  （+19,397 B，probe 矩阵 + meta 全树扫描），显式 `node scripts/ratchet.mjs --write` 重设基线。

## 0.111.0

**验证器生态根规范（charter）入档 + `verify meta` v1**（属主令 2026-10-21 13:18：「验证器的开发与
运维以及使用的规范，一切必须以 ygl-trees CLI 为主，禁止临时编码执行」）。契约/语料零变更。

- **`docs/validator-charter.md` 入档**：五根原则 P1-P5（单一执行面 / 禁止临时编码执行且对评审席自身生效 /
  元验证先于一切 / 判据语言封闭七型 / 审计链完整）+ §1 开发、§2 运维、§3 使用、§4 执行机制（v1/v2 闸/
  探针 CLI 化/元规则 R1-R4）、§5 文件关系。生效依据＝属主令本身。
- **`verify meta [<repo>]` v1**（charter §4.1）：验证器仓库准入规则 R1 AGENTS.md 根存在、R2
  `verify/meta.json`（`meta_index_version: 1` 单一来源）↔ `verify/specs/*.json` 双向一致（含 sha256；未知版本按名拒绝）、R3 无散落可执行验证件（仓库根无
  游离脚本、`docs/**` 无 `*.mjs/*.js/*.sh`、`tmp/` 必须 gitignored）；`--json` 单对象，
  **rc 镜像 verdict**（0 PASS / 1 FAIL / 2 用法）。**0.105.x 未落 meta（落的是 self-check 递归门）**，
  v1 为 greenfield，charter §4.6 已如实对账。
- **过渡排期**：0.111.x 在 submit/prepare 接受面默认 warn + `--require-meta` 拒收；**0.113.0 翻硬拒收**
  并同时落地版本键控机械门（contract-audit/pack:check 断言），help 用 deprecation-style 前瞻标注。
- **探针 CLI 化（0.112.0）**：`verify probe --matrix` 16 向并集（开发席八向 + 评审席篡改八向含
  retired-key/resign-fv），RFC8032 确定性种子、离线、`--target sealed|workspace`。
- 门禁：unit 656 → **660**；contract-audit 130 → **133**（contract 12：meta PASS/FAIL/缺仓用法）；
  **ratchet 认账**：bundle 685,095 → 703,423（+18,328 B，meta 模块/命令/契约 12 与 charter 文档），
  显式 `node scripts/ratchet.mjs --write` 重设基线；cold/web 保持。
