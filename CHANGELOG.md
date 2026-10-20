# Changelog

## 0.104.0

**批九可发现性 + r26 P1 安全收口**：无契约形状变更（`contract_version` / `corpus_version` 仍 1.1）。

- **跨树边提示（批九 P1①）**：`node link` 的两端查找失败原来只说 `parent not found: na`，用户看不出「这个 key 在别的树里」。`enrichNodeNotFound` 的正则从 `^node not found:` 扩到 `^(node|parent|child) not found:`，并复用 `trees.nodeInOtherTrees()` 点名——`key exists in other tree(s): 't-a' — edges cannot cross trees; add 'na' to 't-b' (or -t t-a to work over there)`。边不跨树是数据模型边界，提示必须给出「加节点」与「换树工作」两条出路。
- **未知组指引（批九 P1②）**：`ygl-trees claim list` 这类「把动作当组」的输入原来只说 `unknown group: claim`。现在对 `claim/source/evidence/query/predict` 五个动作补一行 `try: ygl-trees research claim …  (claim is an action of the research group)`；llms 尾注的 `- claim evaluate`、`- evidence assess` 一并订正为 `research …`。首启引导里的技能数 9 → 12（与 README / `skills/` 目录一致）。
- **`db sql` 列名速查（批九 P2）**：裸 `db sql` 原来静默 rc=0（形似「空结果」）——现在 rc=2 并给出真值形状：`edges.parent_id/child_id` 是 `nodes.id` 整数引用，要 join 后 alias `nodes.key`（附可直接跑的示例 SQL）。help 同步三行。
- **`node cond --force`（批九 P2）**：同键异内容原来只能 `node cond rm` 再 add（两次写、中间态缺条件）。`--force` 就地把 value/op 等改写为同一行（id 不变），落 `node.cond` 事件带 `"updated":true` 以便审计区分「新增」与「就地改写」；无 `--force` 的拒绝文案补「或 `--force` 就地改写」。
- **语料行尾规范化（发版席 0.103.0 复核 BLOCK 修复）**：`freeze.mjs` 按**磁盘字节**算 sha256，而 `core.autocrlf=true` 的检出会把 `corpus/cases/**` 写成 CRLF、脚本直写的 `canonical/vectors.json` 却是 LF——manifest 成了混合清单：Windows 主树自洽，CI/Linux/新 clone 上 `corpus-digest` 快照必红，且 tarball 内容随打包机漂移（产物正确性取决于哪台机器打包）。修法：仓库根新增 `.gitattributes`（`packages/verify/core/corpus/** text eol=lf`、`*.pdf -text`），在统一 LF 基上重冻 `manifest.json`（129 文件，digest `4cac21b4…` → `ee1a0a1d6dddcfcd8fcf58f70f5955ca4edab3d9fca5deb131c8c3eccc7212fc`）。语料语义零变化（仓库 blob 本来就是 LF），`corpus_version` 仍 1.1；`docs/verify-contract.md` §4.6 与 `packages/verify/core/CHANGELOG.md` 记明该 digest 取代关系。
- **r26 收口（评审 302cb119，1 个 P1 安全缺陷 + P4 文档项）**：报告是数据不是命令——`verify report import` 只校验 payload 自洽，伪造报告把 `" & echo PWNED & rem "` 塞进 `data_source.source` 后，`--schedule` 会把它内插进 `job_command`，`job tick` 经 shell 执行。修法：`jobCommand()` 对报告 source 与 `--db` 覆盖统一做路径白名单（字母数字/点/下划线/斜杠/反斜杠/冒号/连字符/空格/波浪号；波浪号放行以兼容 Windows 8.3 短路径），不安全 → `job_command_usable:false`、命令串打占位符、`--schedule` rc=1 且不回显原串（`job_command_rejected` 是消毒截断摘要）；`spec_id` 同白名单（不合格打 `<spec-id>`）。`verify report import` 对可疑 source 出声（`source_warning`，不拒绝——跨机绝对路径合法）。`--db` 覆盖语义钉死：只换常驻作业目标，不改资格判定/冻结记录/patrol。彻底修法（argv 存储、不经 shell）留 M13-4。
- **schema 探针问快照库要真实列（0.104.0，发版席上报 P2）**：`probeOf(ddl)` 解析的是 `sqlite_master.sql` 里的建表语句，`ALTER TABLE … ADD COLUMN` 加的列不在那条文本里——`kb_notes.tags/created` 这类「代码里在用、DDL 文本里没有」的列被 P2 结构性拒绝（`count column "tags" is not in kb_notes (columns: …)`）。修法：新增 `probeOfDb(dbPath)`（`PRAGMA table_info` 取真实表/列，带标识符转义），CLI `prepare` 与 HTTP `prepareViaHttp` 都改用它；DDL 文本只剩红队建空库与指纹用途。回归：CLI 新增「ALTER TABLE 加的列不被结构性打回」端到端用例（ready + 无 `is not in notes`）。
- **冷启动度量抗噪（0.104.0，门禁自伤修复）**：`ratchet` 的 `cold_start_ms` 原本「预热 1 次 + 5 次取中位数」，本机实测同一 commit 摆动 464–634ms——pre-push 钩子排在全量门禁末尾时，5 个样本一起被回收负载拖慢，中位数被顶穿 30% 容差，于是**同一个绿 commit 推不出去**（闸门测的是机器忙闲，不是产品快慢，正是该脚本开头想避免的错）。修法：预热 2 次 + 7 次取**最小值**（启动耗时存在可达下界，噪声是单侧的，真回归会把最小值一起抬上去），并在超容差时延迟 1.5s 复测一次取更优值（真回归两次都慢，噪声只命中一次）。基线不动，`docs/measurement-ratchet.md` 与脚本头注同步说明。
- 测试 unit **494**（+11：`node-qual` +3 跨树边提示、`guidance.spec.ts` 新增 3 例 unknown-group 指引、`cond-idem` +1 `--force` 就地改写、`graduate.spec.ts` +2 注入拒绝与普通路径放行、CLI +1 注入 source 拒绝拼进 shell、CLI +1 ALTER TABLE 列探针）/ Rust 31 / demo 128 / contract 100 / readme 54。`spec-validator.md` §9 新增「报告是数据，不是命令（r26 P1）」与「`--db` 覆盖的语义边界（r26 Q2）」两段。
- 附：r26 评审报告入库 `docs/reviews/REVIEW-spec-validator-m13-r26.md`（索引登记）。

## 0.103.0

**M13-3 毕业通道**：把「一次性验证」升级为「常驻检查」——`verify graduate`（`packages/ops/tools/src/graduate.ts`）。无契约形状变更（`contract_version` / `corpus_version` 仍 1.1）。

- **三段拆**：①**资格**＝同一 `spec_version`、最近 `--min-runs`（默认 3）份报告全部 `overall=PASS`、首末跨度 ≥ `--min-span-days`（默认 30 天）。**跨 spec_version 不算连续**——判据本身变了，"历史最好成绩"不成立。拒绝时逐条点名（缺几条、哪条不是 PASS、跨度差多少天），rc=1 且**不落盘**。
- **毕业记录冻结**：`$YGL_HOME/verify/graduations/<spec_id>.json` 写 `{spec_id, spec_version, run_ids, thresholds, span_days, data_source, created}`。同核心内容重跑回 `duplicate:true`（保留首次 `created`）；不同形状**拒绝覆盖**并给出 `delete <path> deliberately` 的显式指引——冻结记录不可被重跑改写（与 prepare「成功记录不被失败补跑冲掉」同一纪律）。
- **常驻执行**：默认只打印命令串（JSON 的 `job_command`），`--schedule --every <min>` 才真的登记作业（`job add`）；命令串固定带 `--no-archive`（趋势看 `reports/`，不看归档数量）。`<source>` 取毕业报告 `data_source.source`。
- **patrol 化边界**：`--patrol` 只在「被验库 == 工作区库」时放行，否则点名拒绝——`patrol run` 在工作区库上跑 SQL 而 VU 判的是被验快照，生成半对的检查比没有检查更危险。0.103.0 **只做资格闸门**，不自动生成 patrol check。
- **r25 收口（评审 302cb119，3 个 P2 必修 + P3 记账）**：①跨度闸门不再真空——`--min-span-days > 0` 时必须 ≥2 份报告，`--min-runs 1` + 单份 PASS 不再以 span=0 混过；②报告来源是 `blob:<sha12>`（HTTP 作业面内容寻址）时**不能当 `--db`**——`job_command` 打占位符、`--schedule` 拒绝登记，除非 `--db <file>` 显式覆盖，否则作业每分钟 ENOENT 失败；③文档把「`--patrol` 交 patrol add」订正为「0.103.0 只做资格闸门」。另收：`history` 摘要（同版本总数/非 PASS 数/最近一条非 PASS）、跨度窗口右移写进文档、响应一律回冻结阈值、`--schedule` 的用法校验提前到落盘之前（旧实现 rc=2 却已冻结记录）、被取代与记录错误分开提示。
- rc 语义与 verify 组一致：0=已毕业/duplicate，1=资格不够或运行错误，2=用法错误（缺 spec-id、`--min-runs` 非正整数、`--schedule` 缺 `--every`）。
- 测试 unit **483**（+20：`graduate.spec.ts` 15——资格/缺报告/FAIL/跨度/跨版本隔离/缺 spec/冻结幂等/拒绝覆盖/命令串/patrol 边界/history/冻结阈值/被取代文案/blob 不可执行与 `--db` 覆盖；CLI 5——缺参数 rc=2、未知 spec rc=1、资格不够→够格→duplicate 全链、`--schedule` 缺 `--every` rc=2 且不冻结、blob 来源拒绝登记而 `--db` 覆盖后放行，各自用独立 `YGL_HOME` 不污染共享夹具）/ Rust 31 / demo 128 / contract 100 / readme 54。
- 文档：`docs/spec-validator.md` §9 毕业通道补「已实现（0.103.0）」语义；`docs/verify-contract.md` §4.7 收 r24 三条口径——①`attempts[].file`=目录内文件名 / HTTP `record`=spec 目录相对 / CLI `record`=verify 根相对，**三个基准不同**；②小数秒 >3 位静默截断到毫秒；③有意保留的宽容边界（纯日期按 UTC、偏移 ±23:59）与「拒小写 t/z、闰秒、基本格式」显式写明。

## 0.102.4

**r23 收口**（评审 302cb119：0.102.3 PASS，留 1 P2 + P3×5）——无契约形状变更，全部是把「口径」收紧到可对质。

- **as_of 严格 ISO（P3⑤ / 三问①）**：`normalizeAsOf` 从「Date 能解析就收」改为显式语法校验——**接受**纯日期（UTC 00:00）与带显式时区的 datetime（`Z`/`+08:00`/`+0800`，±hh 与引擎 `ISO_DATETIME_TZ` 同口径）、1–9 位小数秒；**拒绝**无时区 datetime（同一串在本机 +08 与 CI UTC 会落成两个锚点）、空格分隔、非 ISO、非法日历（`2026-02-30` 曾被 Date 静默滚成 03-02 并以错误锚冻结——现在直接拒）。这是 0.102.3「可解析即归一」的漏洞：评审实测 CLI 曾以错误锚覆盖上一份 ready 记录。
- **as_of 校验提前（P3①）**：HTTP `prepare` 的 as_of 校验移到 `findMaterial`/`snapshotPath`/`schemaOf` 之前——「缺材料 + 非法 as_of」现在报 400（旗标错误）而非 404（资源错误），与 CLI 的「先校验后 I/O」同纪律。
- **attempts 原子占位（三问③）**：`prepareRecordPath` 的 `existsSync` 续号换成 `writeFileSync(..., {flag:"wx"})` + EEXIST 续号——原方案有 TOCTOU 窗口（评审：8 路并发没撞是毫秒错开的运气）。
- **P2：文档 reviews 示例形状**：`docs/verify-contract.md` 的 `--reviews` 示例原写旧嵌套 `[[{vu_id…}]]`，而 `fileReviewer` 按 `source_clause` 匹配对象数组——照文档抄永远 `needs-material`。示例改为 `[{source_clause, findings}]`（并注明 vu_id 由 prepare 生成），补 CLI 正向回归：文档形状 → ready rc=0 且三文件落盘；旧嵌套形状 → 非 ready（P2 的反例）。
- **措辞订正（P3②③）**：撤掉「`prepare.json` 不可变」的说法——真实口径是「成功以最后一次成功为准，失败的补跑不得冲掉上一轮成功记录」；文档写明 attempts 投影的 `file` 是 attempts 目录内 basename，而 CLI `record` 是相对 verify 根的 `specs/<id>/…`，两者基准不同。另注明 as_of 比引擎 `ISO_DATETIME_TZ` 更严（拒空格分隔）是有意的：数据值宽容，入参严格。
- 测试 unit **463**（+9：as-of 严格用例 6、CLI ready 形状正向 1、HTTP 严格 as_of 2（含「校验先于 I/O」））/ Rust 31 / demo 128 / contract 100 / readme 54。`contract_version` / `corpus_version` 仍 1.1。
- 附：r23 评审报告入库 `docs/reviews/REVIEW-spec-validator-m13-r23.md`（索引登记）。

## 0.102.3

**r22 P3 收口**（评审 302cb119：0.102.2 PASS，留 as_of 校验 / attempts 可审计 / 命名碰撞 / CLI record 四条）——无契约形状变更。

- **as_of 双侧同校验（评审要求②）**：新增 `normalizeAsOf`（`verify-cmds.ts`），HTTP `POST /api/verify/prepare` 的 `as_of` 与 CLI `--as-of` 共用——可解析 → `toISOString()`（`+08:00` 偏移归一 UTC，同一个瞬间只有一种存盘形态）；不可解析/非字符串 → HTTP 400、CLI rc=2，且**不落盘、不消耗 spec_version**。理由（R13）：不可解析的时间锚会让报告不可对质。CLI 的校验先于 material/db I/O，旗标错误不会被报成运行错误。
- **attempts 可审计（评审建议①）**：`GET /api/verify/spec?id=` 的载荷新增 `attempts: [{file, created, verdict}]` 投影（按文件名排序）。构造追溯视图可直接回答「为什么没 ready」，正文仍只在盘上。
- **命名碰撞（P3①）**：`prepareRecordPath` 同毫秒两次尝试不再撞名——首个 `attempts/<ts>.json`，续列 `-2`/`-3`，只追加不覆盖。
- **CLI `--json` 的 record（P3②）**：`verify prepare --json` 回 `record`（相对 verify 根的 `specs/<id>/prepare.json` 或 `attempts/<ts>.json`），脚本不必自己拼时间戳；`--draft` 回 `record: null` 保持形状稳定。
- 文档：`docs/verify-contract.md` §4.7 与 `docs/spec-validator.md` §7 同步（as_of 校验、attempts 投影、record 字段、命名规则）；`skills/ygl-trees-verify` 补 as_of 纪律。
- 测试 unit **454**（+9：`as-of.spec.ts` 6 例 normalizeAsOf/路径碰撞；HTTP 不可解析 400 且不落盘、`+08` 归一；CLI rc=2；specDetail attempts 投影）/ Rust 31 / demo 128 / contract 100 / readme 54。`contract_version` / `corpus_version` 仍 1.1。
- 附：r22 评审报告原文入库 `docs/reviews/REVIEW-spec-validator-m13-r22.md`（索引已登记）。

## 0.102.2

**评审 r21 三问收口（P2-2 / P3-2 / as_of 入口）** —— 0.102.0 作业面复核后的下一批口径统一，无契约形状变更。

- **构造记录只追加（P2-2）**：`ready` 才写不可变的 `prepare.json`；未 ready 的尝试写同 spec 目录下 `attempts/<ts>.json`。此前 CLI 无论 ready 与否都覆盖 `prepare.json`（一次失败补跑会冲掉上一轮已冻结的成功记录），HTTP 面什么都不写（失败无痕）——两个面各错一半，现在一个口径：成功记录不改、失败尝试留档。CLI 人类输出多一行 `attempt recorded: <path>`，HTTP body 多 `record` 字段（`prepare.json` 或 `attempts/<ts>.json`）。
- **`as_of` 有 HTTP 入口（P3）**：`POST /api/verify/prepare` 收可选 `as_of`（ISO 时刻）——P5 冻版时点由构造方钉（与 CLI `--as-of` 同语义），缺省按请求时刻，服务端不猜。
- **门的形态写清（P3-2）**：作业面只由 `--enable-verify-jobs` 把门、不随绑定地址收紧（地址不是信任边界，内网自托管是正当用法；上传门按回环默认是因为它没有专属 flag 且直接写盘）。command 型 VU 继承 serve 的 cwd/env、`stdout` 入 witness 是「执行外部命令」检查器的固有边界，白名单只收窄 `argv[0]`。
- **计数复核**：`CHANGELOG` 0.102.0 写 441、0.102.1 写 442 是按批次递增的真实值，不矛盾（r21 P3-5 的疑问据代码与 git 记录回复）。`specDir` 不分版本仍记 backlog。
- 测试 unit **445**（+3：HTTP 未 ready 只追加 attempts / `as_of` 落 spec / CLI 未 ready 不覆盖冻结记录）/ Rust 31 / demo 128 / contract 100 / readme 54。`contract_version` / `corpus_version` 仍 1.1。

## 0.102.1

**热修（发布后 P2）**：`YGL_VERIFY_ALLOW_CMD` 的空串语义是 **fail-open** 的——`String(process.env.YGL_VERIFY_ALLOW_CMD || "node")` 让「设空串 = 全禁 command」的操作员意图静默变成「放行 node」。改为 `??`：未设置才回落 `node`，空串是**显式空表**（所有 `argv[0]` 判 VU `ERROR`，fail-closed）。补回归一例（空串下跑 `command` 型 VU → `ERROR` 且 reason 含 `allowlist`）。

- 记 backlog（评审观察，非本批新增）：`specDir` 按 `spec_id` 不按版本分目录（`verify-cmds.ts`），CLI 与 HTTP 同语义都收强制 `spec_version`——同 id 低版本号会覆写 `spec.json`，`run` 永远读最新写入。两面同源、在"操作员可信"模型下可接受，将来可考虑版本冲突拒绝或分版本目录。
- 无契约变更；`contract_version` / `corpus_version` 仍 1.1。测试 unit **442**（+1）/ Rust 31 / demo 128 / contract 100 / readme 54。

## 0.102.0

**升级注意**：无契约变更——`contract_version 1.1` / `corpus_version 1.1` 不变，已发规范、封包与归档包继续可验。新增的是**默认关闭**的 HTTP 执行面，CLI 命令面零破坏。

- **M13-2 第三批：作业式验证面**（`packages/ops/tools/src/verify-jobs.ts`）。`POST /api/verify/prepare` 收 `{material_id, candidates, reviews, snapshot_sha256, draft?}`，跑 P0–P5 冻版（只有 `verdict=ready` 且非 `draft` 才落 `prepare.json`/`spec.json`/`trace.json`，形状与 CLI 完全一致）；`POST /api/verify/run` 收 `{spec_id, snapshot_sha256, no_archive?}`，在快照副本上出报告并默认归档。两者与 CLI 共用 `verify-cmds` 的同一组原语（`schemaOf` / `snapshotCopy` / `specDir` / `findMaterial` / `archiveRun` 等改为导出），不另写第二实现——重复实现才是漂移的源头。
- **默认关闭（`webui serve --enable-verify-jobs`）**：一个嵌入方不该因为调了 `serve` 就默默获得「能执行任意 spec」的能力；未开时两端点回 403 并点名开关。执行面要求 `application/json`（415）、只收 POST（405）、请求体上限同材料草稿（413）。
- **三条不变量**：①**请求体永不携带可执行面**——没有 argv/allowlist/路径，夹带 `submission_dir`（或 `submission`）直接 400，因为目录树没有安全的 HTTP 来源，file 型检查器仍走 CLI/封包；command 型白名单由 serve 启动时注入（`YGL_VERIFY_ALLOW_CMD`，默认只放 `node`），不在白名单的 `argv[0]` 判 VU `ERROR` 而不是执行。②**快照只能按内容寻址**——先 `PUT /api/verify/blob?name=snapshot.sqlite` 再传 `snapshot_sha256`（64 位小写 hex，非法 400、缺 blob 404 并点名上传端点），服务端到 blob 仓取字节。③**run 只碰副本**——blob 字节先复制成临时快照再跑（与 CLI 同一条 `snapshotCopy` 路径），报告 `data_source` 记 `{kind:"sqlite-snapshot", source:"blob:<sha12>", sha256, captured_at}` 后重算 `payload_sha256`。
- **HTTP 状态只表达过程**：400 用法 / 404 找不到 / 415 / 413 / 422（快照不可读或引擎硬拒，文案 `run rejected: …`）；判定结论在 body——prepare 的 `verdict`（`ready` / `needs-material` / `error`）、run 的 `overall`（PASS 与 FAIL 都是 200）。归档失败记 `archive_error`，不把已生成的报告变成 500。
- **构造面仍在 agent**：`candidates`（提取/翻译产物）与 `reviews`（盲审三问）由 agent 提交，服务端只做 P0–P5 机械判定与冻版，绝不发明候选；缺数组回 400。**gateway 边界如实记录**：`~/.vercel.ai-gateway.env` 的 key 可调 typesafe-ai/jev，但它只回布尔概率、不产出带锚点引文，喂不进 `ReviewRunner`（review 契约要求逐条 `anchor.quote` + `locator`）——所以 HTTP 面在 agent 型 VU 上仍会 NEEDS-MATERIAL/ERROR，这是能力边界而非配置缺失。
- 测试：unit **441**（+16：`verify-jobs.spec.ts` 覆盖门/方法/JSON/体上限、prepare 落三件套与 `spec_<sha12>` 幂等、`--draft` 不落盘、缺 blob 404、非法 sha 400、缺材料 404、缺 candidates 400、run 出报告+归档、`no_archive`、语料例归档失败记 `archive_error`、`submission_dir` 400、缺 spec 404、command 白名单外判 ERROR）/ Rust 31 / demo 128 / contract 100 / readme 54。

## 0.101.1

**热修（发布后 P3）**：`createBlobSink().finish()` 的 `renameSync` 缺并发护栏——两个并发 PUT 同内容时，胜者落位后败者在 Windows 上抛 `EEXIST/EPERM` → 500，而语义上应幂等 200。修法与 `putBlob` 同款：`try/catch` → 清临时文件 → `dest` 已存在即返 ref；补「同内容并发收尾」回归（8 例）。

- **r19 非阻塞项（302cb119）**：N1 端点计数订正（0.100.0 = 6 读 + 1 写；0.101.0 = 7 读 + 2 写）；N2 坏报告静默丢弃 **显式 WONTFIX**（单条损坏不应拖垮整块看板，`verify report <run>` 会点名解析错误，后续可在 UI 加脚注）；N3 `.gitignore` 补 `*.tgz`；N4 评审证据链移入 `docs/reviews/` 并加索引；N5 补 blob PUT 的 HTTP 413 直接用例。

**回执勘误**：0.101.0 回执写附件 mime 上限「>128 字符弃」，代码实际是 **200**（`blob-store.ts` 的 `clientMimeOf`）——代码无需动，口径以代码为准；勘误同步进 plan 记录。

无契约变更；`contract_version` / `corpus_version` 仍 1.1。

## 0.101.0

**升级注意**：`contract_version` / `corpus_version` 均不变（1.1），已发规范与归档包继续可验。新增 HTTP 写端点与 blob 仓，CLI 命令面零破坏。

- **M13-2 第二批：附件内容寻址仓**（`packages/ops/tools/src/blob-store.ts`）。附件原始字节落 `$YGL_HOME/verify/blobs/<sha 前 2 位>/<sha256>`，材料记录只记 `{path,sha256,mime,size,stored,blob:true}` 引用；`verify submit --attach` 与 WebUI 上传共用同一写入函数，同一份文件重复提交只占一份磁盘。归档 `--with materials` 从仓按 sha 取字节（缺 blob 点名拒产半包），旧工作区未标 `blob` 的条目继续读材料目录副本。
- **HTTP 写入面**：`PUT /api/verify/blob?name=&mime=` 收原始字节（服务端按实收字节算 sha256，不信 `Content-Length`；客户端声明的 mime 只记录，实际 mime 按扩展名定）；超 64 MiB 回 413 JSON（不再只断连）；`.incoming/*.part` 孤儿在启动与上传前按 mtime 清 6 小时以上残留；`POST /api/verify/material` 接 `attachments:[{sha256,name}]`，引用未入仓 blob → 400，非 JSON → 415。
- **服务面补齐（r18 P2）**：`GET /api/verify/archives`（侧车展开）与 `GET /api/verify/reports?spec=`（按规范过滤）；订正 0.100.0 记录里「7 个只读端点」的误写——当版实为 **6 读 + 1 写**（specs/spec/reports/report/materials/material；本条原写「5 读」漏计 materials 与 material 两个端点，0.101.1 的 N1 订正已含此括注）。
- **安全修复（r18 P1）**：`/api/verify/{spec,report,material}` 的 id 此前直接拼路径，`?run=../../leak` 可读到 verify 根外文件。改为 id 白名单 `^[A-Za-z0-9_-]{1,128}$` + 解析后包含性断言，越界与不存在一律 404（不区分，避免探测）；补五条穿越探针（含 `%2e%2e%2f`）回归。
- **上传门（r18 P3）**：`createDashboardServer` 默认 **拒绝** 上传；serve 仅在回环绑定显式开，`YGL_VERIFY_ALLOW_UPLOAD=1/0` 可强制开关；门的是端点本身（403 JSON），不是只藏 UI 按钮。
- **WebUI**：材料提交视图接附件上传（`Upload` 原始字节 PUT → 只提单引用），追溯/看板视图区分「加载失败」与「空态」——失败不再显示成「还没有规范」。
- **文档订正**：契约新增 §4.7 服务面（端点/id 白名单/附件两步/413/415/上传门/孤儿清理）与 §7.5 附件字节来源；`spec-validator.md` §7 端点表按实现更新并把「R16 选择门」口径改正——验证器工件是 home 级，与项目选择正交；`plan.md` 0.100.0 计数误写订正。
- 测试：unit 423（+13：blob 仓 7 / 服务面 +4 / CLI 附件归档 E2E 1 / 三视图文案 1）/ Rust 31 / demo 128 / contract 100 / readme 54。

## 0.100.0

**升级注意**：无契约变更（`contract_version 1.1` / `corpus_version 1.1` 不变，语料 digest 不动）。新增 WebUI 服务面端点与三视图，CLI 命令面零破坏。

- **WebUI 验证器三视图（M13-2 第一批）**：`apps/web/src/Verify.tsx` + 服务端 `packages/ops/tools/src/verify-web.ts`（挂 `/api/verify/*`）。
  - **材料提交**：标题 + 一段话（模糊输入是常态）。附件上传尚未接（multipart 排第二批）——WebUI 对 `attachments` 字段**显式 400** 并指向 `verify submit --attach`，不静默丢弃（静默丢弃会让「提交成功」掩盖材料缺失，而材料缺失正是 NEEDS-MATERIAL 的根因）。
  - **构造追溯**（只读审计面）：规范清单 → 材料原文 + 构造结论（verdict/轮次/被拒）+ 「判据 ↔ 检查器」表（类型/比较模式/判据原文/锚点）。**没有 ✓/✗ 按钮**——判定链上没有人工确认。
  - **报告看板**：运行记录按 `finished` 倒序；详情把 FAIL/NEEDS-MATERIAL 例外项**置顶为处置清单**（severity + 行数），四态统计退居摘要；附引擎模式/签名身份/快照 sha/归档数。
  - 服务面实现 7 个只读端点 + 1 个写入端点（材料草稿，同正文幂等）；`prepare`/`run` 端点仍欠——构造面需要判定网关，接入前 HTTP 层不假装能跑。
- **r17 复核 P3 四项（302cb119）**：①`archive --with binary` 的内容身份分支补 CLI 用例（同 key 另一封包替换工作区副本 → `refusing to archive`）；②`prepare.spec` 增 `corpus_version === CORPUS_VERSION` 回归断言（此前硬编码 "1.0" 的缺陷无守卫）；③`docs/verify-signing.md` §2 补 unsigned legacy 语义——**完整性可验、身份未证**，且剥掉签名字段会改变 `binary_sha256`（降级不保留身份），发布物应要求 signed 登记；④§5/§6 措辞订正——`archive verify` 做的是**哈希链与签名登记项一致性**，它没有密钥表输入、不重验签名，真伪性走 `verify signature`。
- 测试：unit **410**（+12：verify-web ×8 / Verify 渲染 ×3 / archive 身份 ×1）/ Rust 31 / demo 128 / contract 100 / readme 54。

## 0.99.1

**升级注意**：无契约变化（`contract_version 1.1`、`corpus_version 1.1` 不变）。本版是 0.99.0 签名批的收尾补丁：修一处版本透传缺陷，补首签实证与运维文档两条口径澄清。

- **修 `verify prepare` 的 `corpus_version` 漏传**：此前硬编码 `"1.0"` 写进 `spec.verifier`（与语料 `1.1` 不一致，报告/归档版本链会错位）。`packages/verify/core/src/contract.ts` 新增 `CORPUS_VERSION` 常量，`prepareSpec` 默认值与 `verify prepare` CLI 都改用它。
- **`seal --key` 容错**：种子文件允许尾随换行（64 hex 或 32 字节裸种子，末尾多一个换行都可）；此前报 `must be 32 raw bytes or 64 hex chars (got 65 bytes)`。补 Rust 用例 `seal_accepts_seed_file_with_trailing_newline`（Rust 测试 31）。
- **首签实证（2026-10-20）**：生产 key #1（`key_id = 80a978fa…e3632`，私钥在本机 `$YGL_HOME/verify/keys/production.seed`，不进仓库）签发 Cordis 漂移守卫封包（spec `spec_efb9a6a40450` v3）：`verify signature` rc=0 → `register` → 封包直跑 `run_first_signed`（overall PASS 5/5，报告带 `verifier.signature/signing_scheme/public_key_fingerprint`）→ `report import` `imported:true` → `archive --with binary`（`arc_8b717422ca3a`，6 项）→ `archive verify {ok:true}`。密钥表与首签记录落 `docs/verify-signing.md` §3。
- **r16 复核修复（302cb119）**：①**legacy 封包可读回**——规范形断言（raw == JCS）只对 `format_version` 存在的 footer 生效；真实 0.98.0 形态（serde 字段序 + 非规范 spec + 无 `format_version`/`engine_sha256`）按 unsigned 读回，magic/布局/三条哈希仍逐项校验（补用例 `遗留 0.98.0 形态…`，此前"legacy 按 unsigned 读取"的承诺不成立）；②**二进制内容身份**——`report import` 与 `archive --with binary` 在文件名之外再核 `sha256(工作区字节) === report.verifier.binary_sha256`，把 `binaries/<sha>.bin` 换成同 key 签名的另一封包会被点名 `binary identity mismatch`；③**密钥表自检**——载入时校验 `key_id === sha256(public_key)`，贴错行即报 `key table inconsistency`。
- **文档两条口径**：`docs/verify-signing.md` 新增 §4.1——①footer 字段名是 `sig_alg`/`key_id`/`sig`（不是 `alg`），报告侧对应 `signing_scheme`/`public_key_fingerprint`/`signature`；②**`run` 只验完整性不验签名**（离线可跑，真伪性走 `verify signature`/`register`/`import` 链）。
- 测试：unit **398**（+3：legacy 读回 / 二进制身份 / 密钥表自检）/ Rust **31**（+1）/ demo 128 / contract 100 / readme 54。

## 0.99.0（2026-10-20）封包签名（ed25519）+ 契约 1.1

- **封包签名（footer v1）**：`yglverify seal --key <seed>` 在 footer 里写 `format_version` / `engine_sha256` / `sig_alg:"ed25519"` / `key_id` / `sig`；签名输入 = `JCS(去掉 sig 的 footer)`，`sig_alg`/`key_id` 在签名输入内、`sig` 不在。同一 spec、同一引擎字节、同一种子 → TS `signFooter` 与 Rust `seal` 的签名**逐字节相同**（`packages/verify/core/tests/seal-parity.spec.ts`，RFC 8032 §7.1 公开测试种子）。
- **验签认表不认报文**：`key_id = sha256(32 字节公钥)`；`verify signature <sealed> [--keys <file>] [--expect-key <hex|file>]` 只认 `--keys`/`YGL_VERIFY_KEYS`/`$YGL_HOME/verify/keys/signing-keys.json` 里的未退役密钥——公钥不得只从报告/封包自带材料自证，签名构建没有可信表就不通过。轮换**只增不换**（旧 key 标 `retired_at` 保留）。
- **登记与导入接上签名**：`verify register` 对签名构建先验签再落 `registrations/`（登记里记 `signature:{signed,verified,scheme,key_id}`）；`verify report import` 对已登记的签名构建**重新**从工作区二进制验一遍，并核对报告 `verifier.public_key_fingerprint === footer.key_id`；验不过 → `imported:false`（实测篡改工作区二进制副本后 import 当场点名 `binary signature does not verify`）。
- **报告自描述（contract 1.1）**：`verifier` 增 `signature` / `signing_scheme` / `public_key_fingerprint` 三个可选字段；`contract_version` 与 `corpus_version` 同时升 1.1（33 份语料 spec 仅版本字段变化，digest `4cac21b4f5bc…`，差异表见 `packages/verify/core/CHANGELOG.md`）。
- **篡改矩阵**：spec 字节、engine 字节、footer 非规范（raw ≠ JCS(parse)）、签名字节、未知/退役 key、未知 `format_version`、legacy 无签名字段——七向各自点名拒绝；TS 侧逐向单测覆盖，Rust 侧 `sealed.rs` 覆盖 spec/engine/规范形/format_version/签名五向（Rust 无验签路径）；旧 0.98.0 封包按 unsigned 读取（不假称已验证）。
- **未签名构建显式告警**：`seal` 不带 `--key` 仍可打包（供测试/内部），但 stderr 打 `warning: sealing without --key produces an unsigned build`。
- 文档：新增 [docs/verify-signing.md](docs/verify-signing.md)（信任边界、密钥表、验签顺序、事故处置、非目标）；契约 §5 实现形态与 §6 状态补 v1.4 行。
- 测试：unit **395**（+9：signature ×5、seal-parity ×1、sealed-signature 篡改矩阵 ×3）、Rust **28**、demo 128、contract 100。
`）。

## 0.98.0（2026-10-20）构造面无损试跑 + file 排除集 + r14 三项收口

- **`verify prepare --draft`**：跑完 P0–P5 只给结论，**不写** `spec.json`/`prepare.json`/`trace.json`、不消耗 `spec_version`。构造面调参不再污染版本号（此前每次试跑都推进 spec 版本，回滚只能删目录）。
- **file 检查的 `ignore` 排除集**（TS + Rust 对称）：被排除文件不进扫描面（`witness` 与 `evidence.ignored` 只算可见文件），`require`/`sha256` 仍按字面路径校验；全部被排除 → NEEDS-MATERIAL 而不是 PASS；P2 拒绝绝对路径、`..` 段与通吃 glob。契约 §1.7。
- **r14 R1（归档链）**：`data_source.sha256` 统一 `sha256:<hex>`（TS 曾写裸 hex、Rust 写前缀 → 跨实现 `archive --with snapshot` 必失败）；archive/retain 归一化剥前缀。新增 `archive --snapshot <db>`：Rust 直跑等没有 retained 快照的报告，显式交同一份字节，入包前按报告 sha 校验，不符即点名拒绝。
- **r14 R2（门禁可信度）**：parity 门断言 `rustPayload === rustCore`，并补 `data_source` 形态断言（此前该字段被剥除，正好是盲区）；`YGL_REQUIRE_RUST=1` 时缺 release 产物直接红，不再静默 skip。
- **r14 R3（封包判别）**：`looks_sealed` 改结构性候选——magic 字节坏、footer JSON 语法坏也算「封包被改」，一律 rc=1；不再降级成开放模式（rc=2）。
- **verify 组未知旗标 rc=2**：每个动作有旗标白名单，`--attachment` 这类误拼不再被静默吞掉（曾导致 `files: []` 却 rc=0）。
- **`--db` 语义纠正（r15 P1-1，重要）**：`verify <cmd> --db <file>` 的 `--db` 是**业务库快照**，verify 组不再把它当工作区库打开——此前 `verify run/prepare --db <业务库>` 会就地跑 ygl schema 迁移（实测给业务库灌入 57 张表、`user_version` 0→12），且 `data_source.sha256` 取的是改写之后的字节，证据与报告当场对不上。工作区库固定为 `$YGL_HOME/ygl-trees.db`；回归断言「verify 后业务库 sha 不变、表集不变」。
- 文档：契约新增 §1.7（ignore）、§1.8（CLI 文件形态：candidates/reviews/db 示例 + `--draft` + 未知旗标纪律），§7.5 补 `--snapshot`；`docs/spec-validator.md` §5 澄清「执行面闭集 ≠ 构造面发射集」（prepare 只发 sql/sql-pair/count/exists 四型）。
- 测试：unit **386**（+4：file-ignore ×3、verify-cli 未知旗标 ×1、archive 跨实现快照 ×1；r15 回归 +4：业务库不被迁移、`--no-archive`、`--draft` 不落盘）、Rust **28**（+1 封包损坏判别）、demo 128、contract 100。

## 0.97.2（2026-10-20）同字节重发（npm 版本元数据传播延迟消歧）

**内容与 0.97.1 完全一致，仅版本号不同。** 0.97.1 发布后 npmjs 的版本元数据约 16 分钟后才可解析
（tarball shasum `63e12145…`，registry time 17:57Z），期间外部复核探针 404；补发又撞上 npm 11 的
staged-publish 冲突（`Cannot publish over previously staged version`）。为消除「到底发出去没有」的歧义，
以 0.97.2 重发同内容，0.97.1 已 `npm deprecate` 指向本版。

运维结论：**`npm publish` 打印 `+ pkg@version` 不等于 registry 已可解析**——版本元数据也传播，
验收要直查 `https://registry.npmjs.org/<pkg>/<version>`，别只看 `npm view`。

## 0.97.1（2026-10-20）归档诚实性修复（评审 r12 G1–G5）

- **G1 归档确定性**：`manifest.created` 缺省从 `report.finished` 派生，不再取 `now()`——同一 run 反复归档字节一致，`zip_sha256` 可复算；契约 §7.3 写明。此前同一 run 两次归档会得到不同 zip（`created` 每次都变），与「同输入同字节」自相矛盾。
- **G4 归档入口 fail-closed**：报告缺 `payload_sha256` 直接拒绝归档，不产出「一验就红」的包。
- **G5 engine_version 进校验链**：`verify archive verify` 比对 `manifest.engine_version` 与 `report.verifier.engine_version`，不再只写不比。
- **G3 空 archives 目录 → SKIP**：`verify self-check` 的 archives 项在目录为空时报 skip，不再报 ok（没有可验对象 ≠ 验过）。
- **G2 `--help` 补齐**：verify 组帮助加上 `archive` / `archive verify` / `self-check` 三行。
- 测试：unit 374（新增 archive ×3：确定性/无 payload 拒绝/engine_version 点名；selfcheck ×1：空目录 skip）。
- 评审席侧残留（非阻塞，已记录）：`R7` 快照清理只做 TTL、`R9` registrations 暂无写入方（M13-1b 封包侧补）。

## 0.97.0（2026-10-20）归档包 + 递归自校验：产物可带走、校验器可被校验

- **归档是默认动作（`verify archive`，契约 §7）**：`verify run` 结束即归档，`--no-archive` 才关。文件名有语法（`yglverify-<domain>-<slug>-v<n>-<utc>-r<run8>.yglverify.zip`，domain/slug 都可退化），包内目录唯一（`manifest/report/spec/prepare?/trace?/materials/<id>/files/<sha12>-<name>`，深度 ≤4、全 ASCII 化、原名进 `items[].original_name`）。**报告不可变**：归档身份写侧车 `$YGL_HOME/verify/archives/<run_id>.json`，不改 `report.json`（否则 payload_sha256 自毁）。
- **确定性 zip（`zip-store.ts`）**：store-only、条目按路径字节序、mtime 固定 1980-01-01、外部属性 0644、无目录条目/extra/comment —— 同输入同字节，`zip_sha256` 跨平台可复算；`archive_sha256 = sha256(canonical(manifest 去掉自身两个字段))`，`archive_id = arc_<前12>`。附独立 zip reader（零依赖，CRC 不符即拒）。
- **`verify archive verify <file>` 重算全链**：路径规范 → 每条 item sha256/size → `archive_sha256` 重算 → 未声明条目点名 → `report.payload_sha256` 重算 → summary/overall **按 VU 结果重算**比对 → contract/corpus/spec_version/run_id 一致 → `materials_sha256` 与 spec 一致。任一环失败 rc=1 点名文件；**判定结论不在归档校验里表达**。
- **`verify self-check`（递归验证单入口，契约 §7.6）**：environment → canonical 向量 → 语料冻结摘要 → 形状快照 → 语料实跑（33 例含红队）→ 归档重算，六项逐条报 ok/fail/skip。**SKIP 不等于 OK**：发布产物不含 `corpus/`，缺语料时显式 skip 并提示 `--corpus` / `YGL_VERIFY_CORPUS`，绝不静默显示通过。`--no-cases` 关实跑、`--limit N` 只跑前 N 例。
- **语料运行器随包发布**：实现从 `corpus/run.ts` 移到 `src/corpus-runner.ts`（`corpus/run.ts` 保留为 re-export + 默认参数适配），`verify self-check` 才能用发布产物跑语料；惰性 `node:sqlite` 绑定保持不变（未触达 verify 的命令仍零 stderr）。
- **形状快照口径修正**：值为 `undefined` 的键不再进形状（它本就在 JSON 里不存在，如 open 模式的 `verifier.binary_sha256`），快照重铸；`self-check` 的 shapes 项校验每行 `path:type` 形态。
- **真实试炼场：Cordis 应用评审自动化（`scripts/cordis-scan.mjs` + `scripts/cordis-drift.mjs`）**：m00310 的一次性 Cordis 评审固化成 verify spec（五条不变量：跨域直连白名单外为 0 / 事件面 ≥20 / 0.86 删除的服务不复活 / 服务必须声明 ctx 合并 / 事件表裸写 ≤13），每轮 = 一次 verify run。采集器把 `packages/**`、`apps/**` 扫成只读 sqlite 快照（四表 + `meta.source_digest`），`--root` 可指向任意树用于验收注入。实测：HEAD `overall PASS` 5/5；把 src 拷到临时树并注入一条 `knowledge/skills → techtree/model` 跨域 import → 同一冻结 spec `overall FAIL`，只有 V1 失败，witness `rows_scanned=151 / rows_matched=1`、`evidence{count:1,op:"==",expected:0}`；`archive verify` ok、`report import` imported。方法论与纪律见 `scripts/verify/cordis-drift/README.md`。
- **修 `ratchet --write` 空转（真实缺陷）**：回归分支 `continue` 早退导致认账值从未写进基线——文档承诺的「显式 `--write` 重设基线」实际无效。改为作者席 `--write` 时 adopt 新值并记 `accepted`（rc=0），否则仍 rc=1。本版因此把 bundle 基线从 507800 重设为 552030（verify 命令面 + 归档 + 自校验的真实增量）。
- 测试：unit 370 / demo 128 / contract 100 / readme 53。新增 `archive.spec.ts` ×13（命名/路径/确定性 zip/篡改/缺件/侧车）、`selfcheck.spec.ts` ×6（全绿/改语料/改向量/无语料 skip/归档注入/摘要同算法）、`verify-cli.spec.ts` +4（archive 未知 run、缺文件、非 zip、self-check）。

## 0.96.0（2026-10-20）M13-1 spec validator：verify 命令面 + 契约/语料钉 1.0 + 度量棘轮

- **verify 命令面（M13-1 落地，主推④ 的机器判定入口）**：`submit`（冻结材料：正文 + 附件 sha256/size/mime）→ `prepare`（候选 → P0–P5 流水线：逐字锚点 → 机械形态校验 → 盲审三问 → 红队 → 冻版）→ `run`（**只碰 sqlite 快照副本**，报告记 `data_source{kind,sha256,source,captured_at}`）→ `list`/`report`/`trace`/`export`/`report import`（校验 payload_sha256 + 构建登记 + 三版本一致）。rc 只表达过程：发现 FAIL 的报告仍 rc=0，判定看 `overall`；`prepare` 只有 `ready` 才 rc=0。
- **契约钉 1.0**：`CONTRACT_VERSION = "1.0"`（引擎入口版本守卫，不匹配直接拒绝）；新增 `Predicate.scan` 扫描域（`where` 只进 find、`scan` 进 find+scope，`witness.rows_scanned` = 域内检查行数）；报告增 `spec_id` 与 `data_source`。**语料钉 1.0**：129 文件 digest `388604230680f9606635caf1d55403703347097ef0337a1aba8337fdaaa076f0`，`packages/verify/core/CHANGELOG.md` 记冻结依据与 8 条不兼容变更（版本守卫 / sealed.review=false / 拒 agent 型 / as_of 必填 / window 偏移归一 / canonical 只收纯对象 / scan 域口径 / count-exists 谓词扫描面已知局限）。
- **度量棘轮（`pnpm ratchet`，docs/measurement-ratchet.md）**：`scripts/ratchet.mjs` + `ratchet-baseline.json` 钉三条确定性度量——bundle 字节（容差 2%）、前端 dist 字节（2%）、`--version` 冷启动中位数（30%）；**变好自动收紧基线，变坏超容差 rc=1**，`--write` 才认账重设。刻意不测单测/demo 总时长（并行负载下测的是机器忙闲）。已挂进 `pnpm test` 末段。
- **形状守卫**：`packages/verify/core/tests/shape.spec.ts` 对 `VerifySpec`/`VerifyReport` 的字段路径+类型做快照（快照首行钉 `contract_version`）——契约 1.0「不得静默改内文」有了机械门；升 1.1 必须重铸快照并进评审。
- **修一个真缺陷（JSON 纯净）**：verify 命令面曾顶层 `import node:sqlite`，让**每条命令**的 stderr 都带 ExperimentalWarning（demo 的 2>&1 捕获因此变红）。改为 `sqlite-bindings.ts` 惰性 require，未触达 verify 的命令零噪音。
- **r10/r11 评审修复**：`$` 守卫收窄 `$vu:`（`$50` 不再误伤）；window 时间偏移归一（`+08`→`+08:00`）；agent 型在 prepare P2 直接拒（M13-1 fact-only）；`as_of` 必填；canonical 拒非纯对象；`--help` 补 verify 组；快照临时库 7 天自清理；`report import` 补 engine/corpus 版本校验。
- 测试：unit 347 / demo 128 / contract 100 / readme 53；新 `verify-cli.spec.ts` ×6（rc 三态 + JSON 纯净 + import 形状）、`shape.spec.ts` ×2、predicate R4 ×2。

## 0.95.0（2026-10-19）毕业三件套 demo 落地 + source tags 读面修复

- **毕业三件套 demo 序列（0.94 P3 承诺兑现）**：demo.sh §9g——supported 断言（判据可机读）→ `source add --tags sop`（执行体词汇落账）→ `rel executes`（能力位↔SOP 源接缝边）三断言全绿；docs/graduation-protocol.md 自指验收条款闭合（demo 125→128）。
- **source 读面 tags 修复（demo 抓出的真缺口）**：`source list`/`source search` 投影漏掉 tags——毕业协议写明的消费方式「按 tags=sop 拉源」在 CLI 读面上不可能。修复三处：cmds.ts list 投影 + reads.ts sourceList SQL + sourceSearch cols；tags 一直有落库（FTS 也索引），只是读面看不见。
- 测试：demo 128 / contract 100 / readme 53；unit 258 不变（无新命令面，断言由 demo 承载）。

---

更早版本（0.1.0 – 0.94.0）的变更记录见 [docs/CHANGELOG-archive-2026-10-20.md](docs/CHANGELOG-archive-2026-10-20.md)（归档按拆分日期命名，指针只指向最新归档）。
