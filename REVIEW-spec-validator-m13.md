# M13 spec-validator 设计评审（评审线 · 2026-10-19）

评审对象：`docs/spec-validator.md`（317 行）+ `docs/spec-validator.html`（592 行），HEAD `2ee5876`。
评审方式：全文精读 + 仓库事实核验（patrol SQL 门 / getPgOrm / telemetry count / sourceAdd / artifacts schema）+ 文档内示例交叉验算。
立场：只审「实现是否自洽」，不重开 m11558（零人工确认）、m11659/m11703（封包二进制、spec 内嵌不可变更）、m11490（七型闭集）等用户裁定。

## 0. 结论

**CHANGES。** 设计骨架成立（分层/闭集/管线/版本/交付形态边界清晰，fail-closed 与两层真承诺是正确取舍），但 **6 项阻塞（B1–B6）必须先落文档再开工**；另有 **7 项（C1–C7）随 M13-1 首批闭环**。按现状直接实现，会在「判定聚合、空转通过、封包审计锚、冻结边界、比较语义、自审验收」六处产出可被审计链掩盖的错误结论。

## 1. 已通过项（不重开裁定）

- 零人工确认的三重防线结构（可审计构造 + 独立上下文自审 + 抗弛守卫 + fail-closed）方向正确；NEEDS-MATERIAL 与 FAIL 严格分开、不算通过。
- 封包二进制形态（spec 内嵌、拒绝 --spec、启动自检、报告记 binary_sha256）自洽；版本链「构建→交付→回收入库」闭合。
- 七型闭集 + 两层真承诺（fact 逐字重放 / review 可复核）表述诚实；闭集变更走 schema 版本的纪律正确。
- VU 纯函数 + 管线拓扑/环检测/级联语义，复用树引擎（拓扑序、环拒绝）合理。
- artifacts 起步（kind=verify-spec/verify-report，meta 存 VU JSON）：`packages/core/database/src/db.ts:153-164` 的 kind 为自由 TEXT、meta 为 JSON、version 为 INTEGER，无需 schema v13 即可开工——推荐采纳（§12.4）。
- `rc=0 只表达过程`（FAIL 是有效结论）与报告不可变、NEEDS-MATERIAL 自动开补充材料 task 的处置闭环正确。
- 与 patrol 分工（一次性/里程碑验证 vs 持续巡检）、毕业通道接缝（verify→patrol）清晰。
- SSE 复用既有 ctx.on("ygl") 通道、R16 选择门与 P1-1 归属校验同规，均与现有实现对齐。

## 2. 阻塞必改（B1–B6，按阻塞度）

### B1 判定聚合规则缺失（含 severity 权属）
- 问题：文档只定义**每项** verdict（md:166），全篇没有「整体判定」的折叠规则；`verify run --json` 只给 `summary:{pass,fail,needs_material,error}` 计数（md:244），agent/业务方无法从单对象得到「这次到底过没过」。severity（S1/S2/S3）由谁赋、如何影响整体，也未定义。
- 文档自证：§5.5 示例 V3 写「`$V2.violations == 0` → verdict FAIL」（md:151），语义疑似反转；HTML 演示 3.3 中 V3 的 checker 是「`$V1.rows>0 OR $V2.rows>0` → FAIL」（html:475），而报告统计把 V3 列进 PASS（html:497-543）——同一文档内自相矛盾。
- 修法：定义 overall ∈ {PASS, FAIL, NEEDS-MATERIAL, ERROR} 折叠规则（FAIL > NEEDS-MATERIAL > ERROR > PASS，全 PASS 才 PASS；或按 severity 分级并在文首明确），severity 映射表（判据语气/用户显式优先级），报告头与 `--json` 单对象都带 `overall` + `reason`；demo/契约补混合态断言。

### B2 空洞通过（vacuous PASS）未防
- 问题：抗弛守卫只在构造期拦截（md:114「无 WHERE 或只在视图上聚合 → 拒绝」），run 期「违规行=FAIL、0 行=PASS」（md:124）。查询选错表、谓词全 NULL、源表为空、join 错列但语法合法 → 0 违规行 → 静默 PASS，且审计链完整。
- 修法：每个 fact checker 输出 **scope witness**（`rows_scanned` / `rows_matched` / 源表行数 / schema 指纹）；`rows_scanned=0` 或（期望非空却）`rows_matched=0` → NEEDS-MATERIAL 而非 PASS；prepare 冻结 schema 指纹（表/列/类型），run 不一致 → ERROR；证据行 canonical 排序（见 C2）。

### B3 封包「不可变更」缺外部锚链（自校验是循环论证）
- 问题：md:252-257 的机制是「内嵌哈希 + 启动自检 + 报告记 binary_sha256」。攻击者重建引擎+spec 并同步改写指纹后，二进制自洽、报告自洽——自检只能防意外损坏；「审计可对质」缺一个二进制之外的期望值。
- 修法：①build 时把 `{spec_id, version, platform, binary_sha256, engine_version, build_at}` 登记为 workspace artifact（可选 ed25519 签名，公钥登记）；②`verify report import` 校验 report.binary_sha256 命中登记且 spec_version 匹配，未知二进制 → 拒绝/隔离并点名；③footer 定义 magic/offset/length 与各哈希计算域（`build_sha256 = H(engine||spec)`，不得覆盖 footer 自身，否则循环）；④report 自带 payload 哈希（文件在 import 前可被编辑）。

### B4 冻结边界与附件实现不自洽
- 问题一（文档矛盾）：md:259 说运行时输入含「提交物附件（业务数据）」，而 md:55/195 说附件在提交时注册为 source；md:140 又要求 review 层拿「冻结提交物」——三处对「提交物在 prepare 冻结还是 run 传入」说法不一。
- 问题二（冻结提交物的载体未定义）：review 层要读提交物原文；若把材料内嵌进封包二进制 → 泄密/体积问题；若运行时传入 → 未冻结（可换文件）。正确形态应是：spec 冻结提交物的 **sha256**，run 时要求同一批字节并校验哈希，哈希通过后才交给 review 层。
- 问题三（现有 source 支撑不了附件形态，实测）：`packages/research/pipeline/src/writes.ts:139` 的幂等键是 `url_hash = sha1(url)`，重复路径早返回（`:141-142`），同路径换内容不会更新；`content_hash = sha1(text)`（`:152`）；`source add` 取正文只经 `--body` / `-f`（`packages/research/pipeline/src/cmds.ts:79-83`，按 utf8 读文本）——**二进制附件（xlsx/PDF/png/zip）没有按字节入库的路径**，md:186「source 本就 append-only（file:// + 哈希 id）」目前不成立。
- 修法：两阶段写清——基准材料 submit 时冻结（值+锚点+引文进 spec）；提交物在 run 时为「同一批字节」，spec 冻结其 sha256，run 校验后交给 review；附件走 content-addressed blob（sha256 字节哈希 + size + mime，同路径换内容=新版本行），或给 sources 增列/新表并纳入九触点。

### B5 比较契约未定义（数值/单位/币种/容差/基数/NULL）
- 问题：md:93 的 `tolerance: 0.01` 是绝对值、无币种与小数位；`sql-pair` 未定义重复键（1:N 发票-订单必然 fan-out）与 NULL≠0；`count` 的语义是 ygl 事件账本（`kind[:win]`，`packages/techtree/model/src/reads.ts:859-867` 显示其计数由 canUnlock 注入 state），封包模式下的业务库没有这个账本；`exists`「记录/证据存在性」同样是 ygl 语义；§5.5 的 `== 0 → FAIL` 与演示中的 `>0 → FAIL` 两种写法语义相反。
- 修法：定义 CompareSpec（`mode: exact|tolerance_abs|tolerance_rel|subset|superset|range|regex|window`、`currency?`、`scale?`），货币用最小单位整数比较；sql-pair 显式基数语义（1:1 或显式聚合，重复键默认 ERROR）；NULL≠0；count/exists 改为「业务数据源查询/结果行数」语义（可带 as_of 时间窗），去掉 ygl 事件账本依赖，或明确标注仅 workspace 模式可用。

### B6 自审可靠性缺可验收契约（「替代人确认」的边界）
- 问题：三问自审（md:110-111）由第二个模型回答，但「独立上下文」不等于独立判断（同模型、同材料、同先验）。文档没有验收指标；HTML 演示 V4 恰好暴露漏洞：首轮判「期望值锚点与提交物同源」→ 改锚到报价基准.xlsx·Sheet1·R5C3（html:480-489），但**改锚后未要求复读原文**——锚点可被话术满足，审计链变成自证。
- 修法：①锚点复读：reviewer 必须逐字引用冻结材料在锚点处的原文（文本/xlsx 可字符串比对；图片要求裁剪区 + OCR 文本且数值出现在其中）；②盲审：不带上一轮结论/修订史，每轮新上下文，「≤3 轮」每轮独立；③红队语料：≥8 例故意松弛/错误规格（恒真谓词、错列、同源期望、错误提取值如把小计当单价）必须 100% 被拒才可验收；④优先不同模型族/不同温度。

## 3. 随 M13-1 首批闭环（C1–C7）

- **C1 判据清单完整性**：md:115 的覆盖率以 VU 为锚，但判据清单本身是模型切分——漏切的分句会「静默消失」。落盘 clause inventory（每个分句 → VU 或显式豁免），reviewer 对照材料全文段校验。
- **C2 时间/快照/排序可重放**：md:185「db 快照标识」未定义——SQLite 用文件哈希、PG 用只读事务快照 id；count 窗口与任何 now() 必须锚定 as_of（入报告 meta）；证据行 canonical 排序，否则「逐字重放」不成立。
- **C3 PG 只读强制**：md:242「sql 只读前缀门」不是安全边界（PG 的 SELECT 可调 volatile 函数产生副作用；WITH 前缀被门拒绝只是巧合）。封包/直连一律 `default_transaction_read_only=on` + `statement_timeout` + 单语句 + 只读账号；禁 volatile 副作用函数。
- **C4 agent 型封包模式凭证/网络**：封包二进制在业务方机器跑 review 层需要 gateway URL/凭证（md:204 只说「同 claim evaluate 通道」）。定义 env 注入、离线时该 VU 显式 ERROR/NM 并点名（不静默），`self-check --offline` 列出网络依赖；NEEDS-MATERIAL 的开 task 副作用只在 import 侧发生。
- **C5 平台矩阵与封包构建**：win/linux 各一引擎字节 + 每平台哈希（html:567 已列）；「封包不需要 Rust 工具链」（md:254）要说清前提是使用预构建引擎字节；M13-1b Rust 必须实现全部七型（含 agent HTTP 与 command），不是只做 SQL。
- **C6 文档一致性**：md 缺「七域」定义（md:144 用了，html:295-303 才给出七个比较域）与代码落点/测试金字塔（html:384-399 有）；html:381「run 阶段零模型调用」与 md:140「review 层 run 时调模型」矛盾；html:211「Rust(后置)」陈旧；`docs/plan.md:319` 仍写 NEEDS-HUMAN/「表单编辑器/VU 确认视图」/「六端点」（现行设计是 NEEDS-MATERIAL、材料提交/构造追溯、五端点）；html:497-543 的 V3 状态矛盾；html:538「交给业务专家裁决」与「要材料不签字」矛盾。
- **C7 HTML 双源治理**：592 行 HTML 为手工维护且已与 md 漂移（七域、代码落点只存在于 HTML）。要么由 md 生成，要么页首页脚标注「演示稿，规范以 md 为准」，并把 HTML 独有的规范内容回迁 md。

## 4. 三个最可能翻车点（概率×伤害）

1. **自审替代人确认的可靠性边界**：错提取（把单价读成小计、把含税价读成未税）可以一路通过三问自审，产出「审计链完美、结论错误」的 PASS。B6 的锚点复读 + 红队语料是唯一可验收的止血点；没有它，「零人工确认」= 把风险从签字人转移给不可验收的模型。
2. **封包不可变更的循环论证**：没有二进制外部期望值，篡改者重建自洽封包即可；报告里的 binary_sha256 只有与登记值对质才有意义。B3 的登记 + import 校验缺一不可，否则 m11703 的「不可变更」在工程上是不可证的。
3. **七型闭集在真实材料与 PG/Odoo 的缺口**：run 期零提取意味着**新提交的 xlsx/PDF/图片内容只能走 review 层**（事实层只做文件级）；count/exists 是 ygl 语义、封包模式不可用；xlsx 公式缓存值/合并单元格/文本型数字、PDF 扫描件 OCR、zip 炸弹与路径穿越、PG 重复键 fan-out 与 NULL/币种/单位，都是会静默产生错误布尔的具体缺口。B2+B5+C1 是配套防线。

## 5. 修完 B1–B6 后的 M13-1 开工顺序与闸门

顺序（每步先落契约/用例，再写实现）：
1. **契约先行**：spec / VU / report 三 JSON schema（含 overall、severity、CompareSpec、anchor、footer 元数据、as_of/snapshot），contract:audit 用例。
2. **fact 引擎**：七型中的 sql/sql-pair/count/exists/file/command + scope witness + canonical 证据排序；先写「应判 NEEDS-MATERIAL 的空洞样例」测试。
3. **prepare**：提取→翻译→判据清单→抗弛守卫→自审（盲审 + 锚点复读）→红队语料（错误规格必须被拒）。
4. **管线拓扑**：`$Vx.out` 引用、DAG 拓扑、环拒绝、级联语义。
5. **.157 运费对账端到端**（PG 只读账号 + 真实样本）作为 M13-1 验收靶。
6. **封包器前置**：footer/自检/拒绝 --spec/哈希登记与 import 校验先于 M13-1b 冻结，否则 Rust 双实现会漂。

闸门：
- G1 契约：三 schema round-trip、rc 0/1/2、JSON 单对象、报告不可变。
- G2 矩阵：七型 × 七域边界（空表/空集/全 NULL/重复键/容差边界/负值/大数/Unicode/时区窗口）。
- G3 红队：≥8 例松弛/错误规格 100% 拒绝；≥3 例错误提取值被锚点复读抓出。
- G4 语料：TS 单实现逐字重放（同输入同判）；M13-1b 双实现逐字一致（除时间戳/ID/行序/浮点格式，比较前 canonical 化；agent 型用 mock gateway 录制回放）。
- G5 封包：改 1 字节 → self-check ERROR；换 spec 重建 → import 哈希不匹配；拒绝 --spec；win/linux 各一产物。
- G6 demo：真实附件 → submit → prepare（含自审记录）→ run → 报告断言（含 overall 折叠）。
- G7 真实靶：.157 FBA 对账跑通，报告可与人工对质。

## 6. 证据索引（行号）

- md:110-118 三重防线；md:124/126/128-130 七型；md:144 七域（未定义）；md:148-151 管线示例 V3；md:166-171 交付契约；md:184-187 版本表；md:224-246 §8.5；md:248-263 §8.5.1（封包/自检/运行时输入）；md:302 批次；md:304-317 §12。
- html:211 chip「Rust(后置)」；html:295-303 七比较域；html:306 七型×七域；html:326 五端点；html:381「run 阶段零模型调用」；html:480-489 V4 改锚；html:497-543 报告演示（V3 状态矛盾）；html:538「业务专家裁决」；html:567 win/linux。
- 代码：`packages/ops/tools/src/patrol-cmds.ts:26,30`（SELECT 前缀门/单语句）；`packages/core/database/src/orm.ts:45`（getPgOrm）；`packages/techtree/model/src/reads.ts:859-867`（telemetry count 由 canUnlock 注入）；`packages/research/pipeline/src/writes.ts:139,141-142,152`（url_hash 去重早返回、content_hash）；`packages/research/pipeline/src/cmds.ts:79-83`（readBody 仅 --body/-f 文本）；`packages/core/database/src/db.ts:12`（SCHEMA_VERSION=12）、`:153-164`（artifacts kind/meta/version）；`docs/plan.md:319`（M13 段落陈旧）。
