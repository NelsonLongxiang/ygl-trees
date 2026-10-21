# M13 复核 r27：r26 P1 安全收口 + 语料行尾 / 门禁可复现（0.104.0 候选）

评审对象：0.104.0 候选工作树，HEAD `216f3fb`（含 `5d0eb49` 毕业通道、`1eb0225`/`6e04578` LF 重冻 + P1 安全、`936d0b4` schema 探针与 ratchet 估算器、`bb28945` fetch-retry、`216f3fb` 超时）。
评审方式：读码（graduate.ts / verify-cmds.ts / sealed-binary / ratchet.mjs / fetch-retry.ts / freeze.mjs）+ 隔离 home 动态探针（`tmp/r27home`）+ 干净树全量 `pnpm test` 实跑。
结论：**PASS（P1 收口成立）**。P1 注入链已按「报告是数据不是命令」fail-closed 关闭；语料行尾与门禁可复现两项协议变更属实。**发布前建议修 P2×3**（均为小改），P3×4 与 P4×2 可随版或记账。

## 1. 实测通过

### 1.1 r26 P1（命令注入）端到端关闭
伪造报告（`data_source.source = 'C:\snap.sqlite" & echo PWNED > C:\tmp\PWNED2.txt & rem "'`）经 `verify report import` 仍 `imported:true`（只校验 payload 自洽，符合设计），但：
- 同报告 `verify graduate --schedule --every 5` → **rc=1**：`cannot schedule: the verified source contains shell-unsafe characters (C:snap.sqlite" & echo PWNED > C:?mpPWNED…) — refusing to build a recurring command out of report data; pass --db <snapshot.sqlite> to choose the recurring database`；`jobs` 表无新行。
- 不加 `--schedule` 毕业 → `graduated:true` 但 `job_command_usable:false`、`job_command` 用占位符 `<snapshot.sqlite>`、`job_command_rejected` 为消毒摘要。
- `--db` 注入串 → rc=1（同一拒绝路径，验证「报告 source 与 --db 覆盖一视同仁」）。
- 合法路径（含空格与盘符）`--db 'C:\tmp\r27 db.sqlite' --schedule` → rc=0，作业命令正确、`job add` 幂等。
- `verify report import` 对可疑 source 只出声（`source_warning`）不拒绝——符合 Q1 口径。

### 1.2 语料行尾重冻（协议变更）
- `.gitattributes`：`* text=auto`、`packages/verify/core/corpus/** text eol=lf`、`*.pdf -text`。
- `git ls-files --eol` 抽查语料文件 `i/lf w/lf`；`node packages/verify/core/corpus/freeze.mjs --check` → `files=129 digest=ee1a0a1d6dddcfcd8fcf58f70f5955ca4edab3d9fca5deb131c8c3eccc7212fc` + `frozen corpus unchanged ✓`；manifest digest 与 package CHANGELOG 的 464→ee1a 超替行一致。
- `corpus_version` 仍 1.1（语义零变化 + 重冻记账）——接受；契约 §4.6 的 supersession 注释已写。

### 1.3 门禁实跑（干净树，HEAD 216f3fb）
- `pnpm build` rc=0（0.104.0，web dist 13 文件）。
- unit **494/494 passed，72 文件**（Rust parity 因 release 产物存在实际执行，非 skip）。
- demo 通过（`✗ cycle rejected` 是 CLI 自身 stderr，demo 随后 `(cycle correctly rejected)`，非失败）。
- contract-audit 首跑 **99/100**：`✗ idempotent: project new (same name)  rc=0/1  node:internal/modules/cjs/loader:1424`（第二次 `project new` 进程级模块加载失败，输出被 `cut -c1-70` 截断）；**单独复跑 100/100 rc=0** → 判为并发/加载型 flake，非本版回归（新样本，已记入 flake 家族）。
- `pnpm ratchet`：bundle 631758（基线 624179，+2% 容差 636662，held）、web dist 1369836（held）、cold start 589（基线 464，+30% 上限 603，held，余量仅 14ms——见 P3-4）。

### 1.4 测试与修复形态
- 定向 49/49（graduate 10 + verify-cli + corpus-freeze）；`graduate.spec:233` 注入用例断言命令串不含 `PWNED`；`verify-cli.spec:270/300/307` 覆盖 import warning、`--db` 覆盖、schedule 拒绝。
- `jobCommand()` 返回 `{command,db,usable,unsafe,rejected}`，`shellSafePath` 白名单、`spec_id` 白名单、blob 源短路占位、`--db` 覆盖不改资格/记录/patrol 的语义均按 r26 口径落地。

## 2. P2（建议 0.104.0 发布前修，均小改）

### P2-1 `--db` 对已存在作业的 retarget 是静默 no-op
实测：某 spec 已有毕业记录与作业 `7f7226ccaa`（命令 `--db "C:\tmp\r27 db.sqlite"`）；再次 `verify graduate ... --db '<tmp>\' --schedule` → rc=0，响应 `job_command` 已指向新路径、`job_id` 仍是 `7f7226ccaa`；但 `jobs` 表只有一行且命令仍是旧路径。根因：`jobAdd` 按 title 幂等（存在即返回旧 id，不更新命令），于是「--db retargets the job only」的承诺落空，而输出又让操作者以为已换目标。
修法：`--schedule` 时若作业已存在，走作业更新路径改命令（或明确拒绝并点名「作业已存在，先 job remove/update」），二者取一；补一条 retarget 回归。

### P2-2 尾随路径分隔符被判 usable，但命令必坏
实测：`--db '<tmp>\'` → `job_command_usable:true`、命令 `… --db "<tmp>\" --no-archive`。把该命令交给 node 实测：`node: bad option: --db`——闭合引号被末尾 `\` 转义，argv 崩坏（cmd.exe；POSIX sh 双引号内 `\"` 同理）。当前 `shellSafePath` 允许尾随分隔符。
修法：尾随 `/` 或 `\` 一律 `unsafe`（理由写进 `unsafe`/错误文案），补命令级回归（不只断言字符串）。

### P2-3 白名单过窄，合法路径被拒 → 无法排期
实测：`--db 'C:\tmp\快照.sqlite'` → `shell-unsafe characters (C:\tmp\??.sqlite)`，`--schedule` rc=1；`#`、`+` 同样被拒。Windows 中文目录名、以及 `#`/`+`/`@`/`=`/`,` 等惰性字符都是常见合法文件名。r26 要求「合法路径照常可排期」，当前只覆盖了 ASCII 子集。
修法：改用「shell 特殊字符 denylist」（cmd.exe 的 `" % ! ^ & | < > ( )` 等 + POSIX sh 的 `$ \` \ " ' & | ; < > ( ) * ? [ ] # ~` 交集/并集，按平台），或白名单扩到 Unicode 字母数字 `\p{L}\p{N}` + 惰性标点；保留双引号包裹。补中文/`#`/`+` 用例。

## 3. P3 / P4

- **P3-1 文档「原文不回显」不成立**：`job_command_rejected` 实测保留 40 个可打印字符（`C:snap.sqlite" & echo PWNED > C:?mpPWNED…`），且原样写进 `verify/graduations/<id>.json` 与 CLI 错误文案；开发回执称「保留长度与前 8 字符」，代码上限是 40（回执与实现不一致）。`docs/spec-validator.md:384`、`graduate.ts:204` 注释、`verify-cmds.ts:694` 都声称不回显原串。修法：逐字符掩码（越界字符 → `?`/类别码，不保留原字符），保留长度 + 首个越界字符的类别/位置；同步文档与测试（现测试断言 `rejected` 含 `PWNED`，等于把泄漏固化）。
- **P3-2 超时提升对 `pnpm test:unit` 无效**：`package.json:35` 的 `--test-timeout=20000` 覆盖 `vitest.config.ts` 的 `testTimeout: 60000`（CLI 优先），bundle 级用例仍是 20s 上限。修法：删该旗标或改 60000。
- **P3-3 Rust parity 门未进 `pnpm test`**：无 `.github/workflows`/`.husky`；`rust-parity.spec` 缺产物时 default skip，`YGL_REQUIRE_RUST=1` 只写在注释与 plan（r14 就提过「CI/发布门禁必须设置」）。发版交接必须显式 `pnpm test:rust`（Rust 31）。
- **P3-4 ratchet 基线/估算器错配**：`ratchet-baseline.json` 的 `cold_start_ms: 464` 测于 `2026-10-20T04:08:37Z`，当时 `scripts/ratchet.mjs` 是 median-of-5（`1eb0225`）；`936d0b4` 改成 warm×2 + min-of-7 + retryOnRegression 却未重烘基线。当前实测 589，容差上限 603，仅 14ms 余量，负载抖动下有误报风险；基线文件也无 method 字段可追溯。修法：用最终估算器重烘基线并写入 `method`（如 `warm2-min7`）；文档同步。
- **P4-1** `verify --help` 的 graduate 行缺 `[--patrol]`（`verify-cmds.ts:649` 的使用行与 `llms.txt:198` 都有）。
- **P4-2** `1eb0225` 与 `6e04578` 同一 commit subject（"fix(verify): 语料行尾 LF 规范化 + 重冻 manifest（0.104.0，发版席 BLOCK）＋批九 P1/P2 与 r26 P1 安全"），相邻两条重复，建议改一条 message 或 squash（不回写历史也可在 plan 记账）。

## 4. 对开发两问的答复

- **Q1（`source_warning` 只出声不拒绝，够不够）**：够。拒绝导入会误伤合法的跨机绝对路径；危险动作是「排期」，那条已经 fail-closed。两个附注：①`source_warning` 不进毕业记录/报告，只在 import 时输出——可接受（graduate 会重算），但若想事后审计，建议在 `verify report` 读面把 `source_warning` 也投影出来；②指向不存在的 DB 不查存在性是对的（runner 只读打开，作业会大声失败），但请把「缺失文件 → 运行期 rc=1」写进 §9，别让操作者以为 `graduated:true` 等于一切就绪。
- **Q2（`job_command_rejected` 要不要连字符类别一起隐去）**：要。保留长度和「第一个越界字符的类别/位置」足够定位脏字段；保留可打印片段等于把注入样本写进冻结记录、JSON 输出和错误文案，与文档承诺直接冲突。测试应从「rejected 含 PWNED」改成「rejected 不含任何 shell 元字符、形状为掩码串」。

## 5. 证据索引

- 代码：`packages/ops/tools/src/graduate.ts`（jobCommand/shellSafePath/printable）、`packages/ops/tools/src/verify-cmds.ts:649,680-740`（usage/patrol/--db/拒绝文案）、`packages/verify/core/corpus/freeze.mjs`、`scripts/ratchet.mjs:95-140`、`tests/support/fetch-retry.ts`、`package.json:35`、`vitest.config.ts:31`。
- 探针：`tmp/r27home`（隔离 home，复制真实 verify/{specs,reports,materials}，`db init`）；命令与输出见本报告 §1.1、§2。
- 门禁日志：`tmp/r27-gate.log`（unit 494/72、contract 99→100、demo 通过）；`tmp/r27-contract-retry.log`。
- 文档：`docs/spec-validator.md:384`、`docs/plan.md:230`、`llms.txt:198`、`docs/verify-contract.md` §4.6、`packages/verify/core/CHANGELOG.md`。
