# REVIEW-spec-validator-m13-r22（0.102.2 三问收口）

评审对象：`3c8973d` / tag `v0.102.2`（HEAD 另有 `4e58264` docs 提交：收录 r21 报告与 harness2 双线方案）。
评审席：302cb119（评审线）。评审方式：git/发布物核验 + 全量与定向门禁 + 隔离 home 动态探针（`tmp/r22-run.sh`、`tmp/r22-probe.cjs`）+ 源码逐行核对。

**结论：PASS。** 三问收口全部落位且实测通过，无阻塞项；留 3 条 P3 观察（as_of 校验、attempts 可审计性、命名碰撞）。

## 1. 实测

**发布态**：`npm view ygl-trees version` = 0.102.2（dist fileCount 149）；Gitee release 1220519，`target_commitish=3c8973d`；tag `v0.102.2` → `3c8973d^{}`；工作树干净（我的两份 docs 已在 4e58264 入库）。

**门禁**（canonical 口径）：

- unit **445/445**（69 文件，`--hook-timeout=60000 --test-timeout=20000 --maxWorkers=2`，158s）；
- contract **100/100**、demo **rc=0**、readme **rc=0**；
- Rust 未改（3c8973d 变更清单无 `rust/`），0.102.1 的 31 例沿用。

**单测加法**：`verify-jobs.spec` +2（attempts 只追加 / as_of 落盘）、`verify-cli.spec` +1（CLI 不覆盖冻结记录），与 CHANGELOG「+3」一致。

**动态探针**（隔离 home、`webui serve --enable-verify-jobs`、18692）：

- 未 ready #1：200 `needs-material`，`record=attempts/2026-10-20T01-22-41-518Z.json`，`prepare.json` 不存在，attempts=1；#2 → attempts=2。
- ready：200 `ready`，`record=prepare.json`，`spec.json`/`trace.json` 落盘，`written=true`。
- 再未 ready：`prepare.json` 字节哈希与冻结时相同（`prepHashesEqual=true`），attempts=3。
- `draft`：`record=null`、`written=false`、attempts 不增。
- CLI 未 ready：rc=1，`prepare.json` 哈希不变，attempts+1，人类输出含 `attempt recorded: <path>`（`--json` 按设计不含 record）。
- `run`：200 PASS，默认归档生成（`with:["materials"]`，6 files）。
- `as_of`：`"2026-10-19T12:00:00+08:00"` 原样存 `spec.as_of.value`；**`"not-a-time"` 也被接受并落盘**（HTTP 与 CLI 同缺校验）。
- 归档/读面：`verify archive --with` 允许 `materials|snapshot|binary|all`（`spec` 不是合法 kind，报错点名）；归档不含 `attempts/`；`specDetail` 只回 spec/prepare/trace。

## 2. 三问结论

**① P2-2 选型（成功记录不改、失败尝试追加）——接受。** 实证如上：ready 记录逐字节不变、失败尝试只追加、draft 无痕；两面共用 `prepareRecordPath()`，CLI 与 HTTP 行为一致。这正是「镜像 CLI」与「HTTP 不写」之外的第三个正确口径。

- 审计建议（非阻塞）：`attempts/` 目前只落盘——HTTP 只读面（`specDetail`）与归档包都看不到「这次为什么没 ready」的原文。最小改法：`specDetail` 增 `attempts: [{file,created,verdict}]`（一行 readdir + 投影），失败尝试即可在构造追溯视图查看；归档侧不改 `--with` 词表可接受（原文在 spec 目录，CLI 可读）。

**② as_of——接受入口，建议补双侧校验。** 现在 `POST /api/verify/prepare` 与 CLI `--as-of` 都原样存字符串；实测 `"not-a-time"` 进 spec 并进报告 `as_of`。引擎不读 as_of（时间函数正则在 SQL 层守门），所以不是安全洞，但 R13 要求 as_of「锚定冻结值」，不可解析的时点会让报告携带不可对质的时间锚。建议 HTTP 与 CLI 共用一个校验：ISO-8601 可解析 → 归一 `.toISOString()` 存盘；不可解析 → HTTP 400 / CLI rc=2。若选择保留原样，至少拒绝不可解析值并在 `docs/spec-validator.md` §7 写明。

**③ 门形态——接受。** 作业面只由 `--enable-verify-jobs`（flag 表运维明确意图），不随绑定地址收紧（地址不是信任边界，内网自托管正当）；上传门因无专属 flag 且直接写盘而按回环默认，两条门形态不同有理由且已文档化。0.102.1 的 `??` 修复（空串=显式空表、fail-closed）正确。

**④ 计数疑问——撤回。** 0.102.0=441、0.102.1=442、0.102.2=445 是各批次真值，我把跨版本对比误读为同版矛盾；CHANGELOG 的说明清楚，无漂移。

**⑤ 发布态——澄清接受。** 镜像/CDN 滞后解释成立；现 npm latest 0.102.2、Gitee 1220519、tag 一致。后续以 registry 直连 + release API 双证。

## 3. 遗留（P3，非阻塞）

1. **as_of 无校验**（见 ②）：`"not-a-time"` 可进 spec/report；建议双侧共用 ISO 校验并归一。
2. **attempts 可审计性**：HTTP 读面/归档均不可见失败尝试原文（见 ① 建议）。
3. **attempts 命名碰撞**：文件名取 `created` 到毫秒（`now.replace(/[:.]/g,"-")`），同一毫秒两次尝试会写同一文件；概率极低，可选加短序号/随机后缀。
4. **CLI `--json` 无 `record` 字段**（人类行有 `attempt recorded`）：脚本要拿路径时只能读人类输出；若需要可补字段（与 HTTP body 对齐）。

## 4. 结论

PASS，可开下一批。建议把 ①`specDetail` attempts 投影 与 ②as_of 双侧校验并入 M13-3/backlog（各约半日），不阻塞当前发布。
