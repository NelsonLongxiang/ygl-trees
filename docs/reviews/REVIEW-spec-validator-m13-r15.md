# M13-1b 复核 r15：eabdcf4（R1–R3 + --draft/ignore/未知旗标）

评审时间：2026-10-20 03:2x。对象：`eabdcf4`（HEAD）。方式：源码 diff + 实跑门禁 + CLI/封包/归档端到端探针（隔离 home `tmp/r15home`，探针产物 `tmp/r15/`）。

## 0. 结论

**CHANGES（暂不放行签名批）。** 开发线报的 R1/R2/R3 + S1 四项**全部实测通过**；但复核中发现**两处新 P1 阻塞**，其中证据库被就地改写成 ygl 工作区是破坏性缺陷（对 `verify run --db` 的任何业务 SQLite 都成立），修好前不能进签名批，也不能对外说「R1 跨实现归档已闭环」。

## 1. 已实证修复（本轮报项）

- **R1 归链统一**：`snapshotCopy` 现在返回 `sha256:<hex>`（verify-cmds.ts:156）；`retainSnapshot`/`buildArchive` 剥前缀再拼 `snapshots/<bare>.sqlite`（archive.ts:210-232、428-433）。实测：TS 报告 `data_source.sha256 = sha256:4d3492…`、retained 文件 `4d349231…sqlite`（裸 hex）；`verify archive <run> --with snapshot` rc=0；`verify archive verify` → `{ok:true, items:3, problems:[]}`。
- **R1 跨实现 `--snapshot`**：Rust release 封包跑 sql-find-violation → 报告 `ds=sha256:1941fb67…` → 登记/导入 → `verify archive <run> --with snapshot --snapshot x.sqlite` **rc=0**（入包前 sha 校验通过）；换成别的 db → rc=1 点名 `report bd8cd5ea…, file 78ffa727…`。错误分支不产半包。
- **R2 parity 门加硬**：rust-parity.spec.ts 断言 `rustPayload !== rustCore` 也算 diff（:102），并断言 `data_source.sha256` 形态 `/^sha256:[0-9a-f]{64}$/`（:107）；`YGL_REQUIRE_RUST=1` 时缺 release 产物直接 throw（:24）。实测 `YGL_REQUIRE_RUST=1 vitest run rust-parity` 1 passed。
- **R3 封包判别结构化**：sealed.rs:135-145 改结构性候选；单测 `corrupted_footer_still_counts_as_sealed_candidate` 覆盖 magic 坏/JSON 坏两态。CLI 实测（新 seal 产物 `tmp/r15/sealed.exe`，4.78MB）：
  - 正常封包 + `--spec` → **rc=2**「sealed binary does not accept --spec」；
  - magic 字节改 X → **rc=1**「sealed footer magic mismatch: XGLVF1」；
  - footer JSON `{`→`[` → **rc=1**「sealed footer is malformed」；
  - spec 区改 1 字节 → **rc=1**「sealed spec_sha256 mismatch」。
- **S1 未知旗标**：`verify run --attachment x` → rc=2「unknown flag for verify run: --attachment」。`verify report import` 未登记二进制 → **rc=1** + `imported:false`。
- **文档**：verify-contract.md 新增 §1.7（ignore 排除集，:119）、§1.8（CLI 文件形态，:132）、§7.5 `--snapshot` 跨实现说明（:399）；spec-validator.md:148 增「执行面闭集 ≠ 构造面发射集」。
- **file ignore**：engine.ts:455-480 排除面只减扫描域（`ignored` 计数进 evidence、全排除→NEEDS-MATERIAL）；prepare.ts:254-263 构造期拒空/绝对/`..`；TS `file-ignore.spec.ts` 与 Rust `file_ignore.rs` 对称测试。
- 测试实跑：verify-core **94/94**（12 文件）；cargo **28 passed**（见 §3-④）。

## 2. 新 P1（阻塞，必须先修）

### P1-1 `--db` 撞全局工作区库：TS 验证会就地改写证据库
- 根因：`apps/cli/src/bin.ts:394` 无条件 `const file = str(args, "db", "") || dbPath(home)`——`--db` 是**全局工作区库路径**。`verify run`/`verify prepare` 用它传证据快照，于是 CLI 把证据库当工作区库打开，启动即跑 schema 迁移并写 `events`。
- 实证 A（普通业务库，最严重）：手工建 `plain.sqlite`（仅 `bills` 两行，`user_version=0`）→ `verify run --db plain.sqlite` → 文件哈希 `ace6cfd9… → 8eb643c3…`，再打开：**57 张 ygl 表全部被建进去，user_version 0→12**。业务方的证据快照被改造成 ygl 工作区。
- 实证 B（已是 ygl 库）：`verify run --db case.sqlite` → 哈希变、`events` 行数 5→7（写入了 verify 遥测）；但报告 `data_source.sha256` 取的是**改写前**的字节哈希 → 报告与磁盘证据从此对不上。
- 连带：R1 的 `--snapshot` 跨实现工作流在 TS 跑过之后失效——同一 db 第二次归档 sha 必不匹配（本轮 sealed 报告 `bd8cd5ea…` 对应的文件此刻已是 `1941fb67…`，正是被 TS 的迁移/写入改掉）。
- 对比：Rust 封包路径只读（`tmp/r15/imm2.sqlite` 跑完哈希不变），说明这不是「SQLite 特性」，是 bin.ts 的旗标重载。
- 修法（一处）：`bin.ts` 对 `group === "verify"` 不使用 `--db` 作为工作区库（`const file = (group === "verify" ? "" : str(args, "db", "")) || dbPath(home)`）；或把证据参数改名（`--data`/`--snapshot-db`）并在 help/契约里写明。修复后应加回归测试：跑完 `verify run` 后证据文件字节不变（sha 相等）。
- 影响面：`verify run`、`verify prepare`（同样读 `--db` 做 schema 探针，实测路径同一根因）、以及任何 `--db` 指向非工作区库的命令。**Rust 交付形态不受影响**，但 TS 是构造/门禁主路径，故仍按 P1 阻塞。

### P1-2 `--no-archive` 被未知旗标守卫误杀（eabdcf4 引入的回归）
- verify-cmds.ts:435 仍有 `args.flags["no-archive"]`，但 `ACTION_FLAGS.run`（:213）没有 `no-archive` → `verify run --db … --no-archive` **rc=2 unknown flag**。文档/demo 若用该旗标会立刻挂。
- 修法：`ACTION_FLAGS.run` 加 `"no-archive"`，并补一条 CLI 用例（与 S1 同一守卫一起测）。

## 3. 随批小项（非阻塞）

① `--draft` 代码路径正确（verify-cmds.ts:322-345 在任何写入前返回；不写 spec/prepare/trace、不消耗版本），但 `grep -rn draft tests/` **零命中**——核心承诺（nothing written）没有测试，建议补「draft 后 specs/ 目录不新增、重复 prepare 仍是 v1」两断言。
② 封包自检实跑：sealed 二进制 run 正常（rc=0，overall FAIL 是有效结论），报告 `verifier.mode=sealed`、`binary_sha256=sha256:e90df8a0…`、`data_source.sha256=sha256:bd8cd5ea…` 均在。
③ 错误文案：`--snapshot` 指向不存在文件时是 ENOENT 泛化错误（先于 sha 校验），可接受；建议消息里点名「file 不存在」以区分「不存在」与「哈希不符」。
④ 计数口径：cargo 实跑 **28 passed**（cli 7 / parity 8 / predicate 3 / vectors 1 / corpus 2 / file_ignore 2 / sealed 单测 5），开发线报 29——差 1，请核对（可能是把 doc-test 或某个 0-test 目标算进去了）。unit 383 报数（376 绿+4 skip+3 flake）本轮未全量复跑，以你后台 gate 为准。
⑤ R3 的 `looks_sealed` 现在把「尾部窗口像 JSON/含 YGLVF1」都判候选：普通开放二进制尾部恰好带 `{…}` 会被误判封包（rc=1 而非开放模式）。概率低（要求最后 4 字节恰为合法长度且窗口结构吻合），但建议在文档写明这是「严格优先」的取舍。

## 4. 签名批就绪度

R1–R3 的**实现**已达成契约；签名批能否开工取决于 P1-1/P1-2：
- **必须先做 P1-1**：否则签名覆盖的是「报告里记录的二进制/字节」，而实际证据库已被改写，链再严也证不了输入完整性；且 `--snapshot` 校验会随第一次 TS 运行失效。
- 签名覆盖面（沿用 r14 六条，不再变）：`JCS(footer_without_sig)` + 域分隔 `"YGLVERIFY-SEAL-v1\0"` + `u32le(footer_len)`；footer 增 `format_version`/`engine_sha256`（engine||spec 现有拼接无法区分边界）；sealed 内 spec 存 JCS 字节、验证先 `raw == JCS(parse(raw))`；验签失败 rc=1 不回落；`key_id` → 工作区密钥表或 `--expect-key`（不自证嵌入公钥）；不签 report/data_source/materials（它们由 payload_sha256 与 archive 链覆盖）。
- 建议 P1-1/P1-2 修完直接进签名批（两者都是 bin.ts/旗标表的小改），我下轮按「证据库字节不变 + 归档链 + 签名向量」三组一起验。

## 5. 探针清单（可复跑）

- `tmp/r15/sealed.exe`（eabdcf4 Rust release seal 产物）、`tmp/r15/sealed-report.json`；
- 篡改件 `t1.exe`（magic）/`t2.exe`（footer JSON）/`t3.exe`（spec）；
- `tmp/r15/plain.sqlite`（被迁移成 ygl 库的证据）、`tmp/r15/imm.sqlite`（TS 跑后哈希变化）、`tmp/r15/imm2.sqlite`（Rust 跑后不变）；
- 归档：`tmp/r15home/verify/archives/*.yglverify.zip`（native 与 `--snapshot` 两条路径各一，archive verify 均 ok:true）。
