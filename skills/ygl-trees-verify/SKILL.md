---
name: ygl-trees-verify
description: >-
  ygl-trees spec-validator 验证器（M13，0.96→0.101）：把「业务规范」变成可执行、可复核、零人工确认的验证器——
  业务方交一段话+附件（submit 冻结材料）→ agent 构造判据（prepare P0–P5：提取/盲审/红队/守卫，出 spec）
  → 引擎在数据库快照副本上跑七型检查器（sql/sql-pair/count/exists/file/command/agent）出报告（run）
  → 归档成可带走的确定性 zip（archive，默认必做）+ 封包签名（ed25519，认表不认报文）+ 递归自校验（self-check）。
  触发词：验证器、spec-validator、yglverify、submit、prepare、run、report、trace、archive、
  self-check、sealed、封包、签名、ed25519、黄金语料、corpus、contract_version、NEEDS-MATERIAL、
  P0-P5、红队、盲审、判据、检查器、witness、报告看板、WebUI 三视图、verify:run。
version: 0.101.1
tags: ygl-trees,verify,spec-validator,sealed,archive,corpus,signature
---

# ygl-trees spec-validator（验证器）

## 1. 何时用

- 要把一条**业务规范**（"报销单必须……"、"上线前必须……"）变成**可机器执行、可复核**的验证器；
- 要复核别人给的验证结论：报告是"谁在哪台机器跑出来的"必须可证（跑 → 归档 → 验包 → 认签名）；
- 要在自己的工作区里验证"这个工作台/这份数据"是否满足一批判据。

**不适用**：需要人工拍板的决策（判定链上**没有**确认按钮，这是设计）、纯文本检查（用 `kb`/`claim`）。

## 2. 一条链（每步都可单独重跑）

```bash
ygl-trees verify submit --title "报销规范 v1" --text ./规范.md
# → material_id（正文+附件各带 sha256 冻结；同内容重跑幂等返回同一 id）
ygl-trees verify submit --title t --text - --attach ./样本.csv      # 附件走 blob 仓 {sha256} 引用

ygl-trees verify prepare <material-id>          # rc=0 仅当 ready；P1/P2 阻断、灰带进 open
ygl-trees verify prepare <material-id> --draft  # 无损试跑：照构造但**不冻结** spec 版本
ygl-trees verify trace <spec-id>                # 构造追溯：清单/判据↔检查器表/盲审与红队结论（只读）

ygl-trees verify run <spec-id> --db snapshot.sqlite   # FAIL 也是 rc=0，看 overall/summary
ygl-trees verify report <run-id>                # 人类可读；--json 机器读
ygl-trees verify list                           # 工作区全部 spec/run 概览
```

- **退出码**：`run` 只用 rc 表达**过程错误**；`overall=FAIL` 仍 rc=0（判定不是程序失败）。
  `prepare` 用 rc 表达"能不能跑"：`ready=false` → rc=1，用法错 → 2。
- **零人工确认**：`trace` 是审计面不是审批面。想改判据 = 改材料重新 submit → 新 spec → 新 run。
- **快照纪律**：`run --db` 指向**副本**；引擎只读打开（`PRAGMA query_only`），不碰源库。

```bash
ygl-trees verify:run   # 组合入口：submit → prepare → run 串接（rc 只表达过程错误）
```

## 3. 检查器七型与 witnesses

| 类型 | 判据 | witness 看点 |
|---|---|---|
| `sql` | 结果集断言（`compare` 八型：eq/ne/gt/gte/lt/lte/in/empty…） | `rows_scanned`/`rows_matched` + 比较值 |
| `sql-pair` | 互斥/一致性（keys 与 violations 两查） | `keys` 数与 `violations` 数 |
| `count` | 聚合计数（别名 `agg_alias`） | 计数值与期望 |
| `exists` | 行存在性 | 命中行数 |
| `file` | 文件集断言（`root` 白名单 + `ignore` glob 排除集） | 命中文件清单 |
| `command` | 白名单命令（`commandAllowlist`，超集拒绝） | stdout/rc |
| `agent` | 需网关的语义判定（无凭证 → `ERROR`，不当 PASS） | 判定原文 |

SQL 三种写法统一：单语句 SELECT/WITH 走 `SqliteRunner.query`；`sql-pair` 拆两查；`agent` 只经网关。

## 4. 归档与封包（可复核性的载体）

```bash
ygl-trees verify archive <run-id|spec-id>            # 默认必做；--no-archive 才关
ygl-trees verify archive <run-id> --snapshot db.sqlite   # 跨实现复跑需要快照
ygl-trees verify archive <run-id> --with materials       # 带上材料字节（附件从 blob 仓按 sha 取）
ygl-trees verify archive verify <file.zip>           # 全链重算：footer→文件树→报告哈希
ygl-trees verify list --unarchived                   # 找漏归档的 run
```

- 归档 = **确定性 zip**（store-only、无时间戳/无权限位）+ 报告 + spec + 清单；同一 run 两次归档**逐字节相同**。
- 报告**不可变**：归档身份写侧车 `$YGL_HOME/verify/archives/<run_id>.json`，不改报告本体。
- 边车键：`$YGL_HOME/verify/registrations/<sha256>.json`（register 时写入）。

## 5. 封包 + 签名（认表不认报文）

```bash
ygl-trees verify signature init            # 生成工作区密钥表（seed 在 keys/ 下，文件权限自检）
ygl-trees verify signature <sealed-binary> [--expect-key <hex|file>]
ygl-trees verify register <sealed-binary>  # footer 链 → registrations/ + binaries/
```

- 封包二进制 = 正常入口 + **ed25519 footer**（`sig_alg`/`key_id`/`sig` + 载荷哈希）。签名覆盖
  **二进制本体 + 载荷**；验签只认**工作区密钥表**（不信任报文里自报的 key）。
- **发布物应要求 `signed` 登记**：`legacy`（无签名）= 可跑但不构成"可信发布"；报告里 `signature.sealed`
  如实写 `signed|legacy`。0.98 及以前的 legacy 产物按 legacy 语义放行（`--expect-key` 不参与）。
- 换密钥 = 新 key_id + 双签过渡期；旧 run 的签名仍可验（密钥表保留历史公钥）。

## 6. 递归自校验（发布门禁）

```bash
ygl-trees verify self-check                  # 六环：environment → canonical 向量 → 语料摘要 → 形状
                                            #      → 语料实跑（33 例）→ 归档重算
ygl-trees verify self-check --corpus <dir>   # 发布产物无语料时显式 skip 并提示
ygl-trees verify self-check --no-cases       # 只跑前四环（无内核环境时）
```

**SKIP ≠ OK**：跳过的环在输出里写 `skip` 并给原因，绝不冒充通过。语料摘要（`corpus_version`）与
`contract_version` 是跨实现一致性的钉：改判据形状/封包形状就要 bump 版本，TS 与 Rust 同时改。

## 7. WebUI 三视图（0.100+）

`ygl-trees webui serve` 后开 `/verify`：

- **材料提交**：标题 + 一段话 + 附件上传（`PUT /api/verify/blob` 内容寻址；上传门**默认关**，
  serve 回环显式开；`0.0.0.0` 暴露需 `YGL_VERIFY_ALLOW_UPLOAD=1`）。
- **构造追溯**：只读审计（清单/材料原文/构造结论/判据↔检查器表）。
- **报告看板**：FAIL 与 NEEDS-MATERIAL 置顶为处置清单；坏报告**静默跳过是显式决定**（单条诊断走
  `verify report <run>`）——将来加"N 条损坏"脚注走旁路计数。

`prepare`/`run` 的 HTTP 端点**未开**：构造面需要网关凭证，runner 只能由 serve 启动时注入，
请求体永不携带 argv/allowlist/凭证。HTTP 层不假装能跑。

## 8. 常见坑

| 现象 | 原因/处理 |
|---|---|
| `prepare` rc=1 但没说错在哪 | 看 `--json` 的 `open[]`/`blocking[]`；P1/P2 阻断会点名字段 |
| `run` 报 `no such table` | 快照库不对/没建表——`--db` 要给**真快照**不是主库 |
| 报告 `overall=ERROR` 且 agent 检查器全错 | 网关凭证没配：`AI_GATEWAY_API_KEY` / `config decision_model_llm_token` / `~/.vercel.ai-gateway.env` |
| 归档两次不同字节 | 报告里有非确定性字段（时间/路径）——先跑 `self-check` 的归档环 |
| `verify archive verify` 失败 | 先看是 footer 链、文件树哈希还是报告哈希断；`--json` 给逐环 |
| WebUI 上传 403 | 上传门没开（非回环地址），显式设 `YGL_VERIFY_ALLOW_UPLOAD=1` 或走 CLI `--attach` |
| 附件 400 点名 sha | blob 仓里没有该 sha——先 PUT blob 再带 `{sha256,name}` 引用 |

## 9. 契约速查

- `contract_version 1.1`：spec/report 形状；`corpus_version 1.1`：黄金语料摘要。
- 报告字段 snake_case；witness 必带 `rows_scanned`/`rows_matched`（或 `compared`）——**没有 witness 的 PASS 不算证据**。
- 一切写路径事务化；读端点只读；`--json` 失败也是单对象 `{"error": "..."}` + rc 承载类别。
