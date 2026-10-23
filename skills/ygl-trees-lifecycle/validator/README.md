# validator — ygl-trees lifecycle 机检面

[ygl-trees-lifecycle](../SKILL.md) 技能回答"什么时候动"；本目录的验证器把它的
触发表（§1/§2）、节奏纪律（§3）和漂移反模式（§5）编码成可执行检查，是技能的
机器执行面。给 A2A 成员做工作区漂移巡检用。

## 用法

```bash
node validate-lifecycle.mjs                          # 巡检默认工作区（$YGL_HOME 或 ~/.ygl-trees）
node validate-lifecycle.mjs --home <dir>             # 指定工作区
node validate-lifecycle.mjs --json                   # 机器读：单个 JSON 对象（findings + summary）
node validate-lifecycle.mjs --rule L1,L6             # 只跑部分规则
node validate-lifecycle.mjs --strict                 # info 级发现也算失败
node validate-lifecycle.mjs --cli <cmd> --help       # 换 CLI 入口 / 看全部用法
```

零依赖，Node >= 18，Windows/Linux 通用。只读：数据全部经官方 CLI `--json` 读通道
获取，不直接打开 SQLite，不写任何状态。

## 退出码

| rc | 含义 |
|---|---|
| 0 | 干净（`--strict` 下仍允许 info 级） |
| 1 | 存在 error/warn 级发现（`--strict` 下含 info） |
| 2 | 无法执行检查（CLI 缺失、工作区不存在或未初始化） |

## 规则表（每条发现都反查技能章节）

| 规则 | 级别 | 检什么 | 反模式 |
|---|---|---|---|
| L1 | error | 节点 unlocked 但没有任何 evidence/claim/kb 挂接 | §5-1 心内解锁 |
| L2 | warn | 节点 0 条 rel（结构位不豁免挂证据） | §5-2 裸节点 |
| L3 | warn | evidence/claim/kb 未被任何节点挂接（含"被 claim 引用但没挂树"变体） | §5-6 两条流水线 |
| L4 | warn | 断言 sup=ref=0（0 证据链） | §5-2 姊妹形态 |
| L5 | warn | payload/断言正文含完成性表述，机器状态却是 locked/unverified | §5-5 状态在正文里 |
| L6 | error | 闭包索引脏（`tree list .dirty` / `node export .index.dirty`） | §5-3 改结构不重建 |
| L7 | error | `node validate` 的环/悬空边 issues 透传 | §5-3 |
| L8 | info | task 停在 todo/doing（收口纪律） | §3 |
| L9 | info | claim 已有证据链但 unverified（待人工仲裁） | §2 |
| L10 | warn/error | `doctor` 的 warn/fail 项透传 | §3 收口必 doctor |

## 采集顺序契约（为什么 tree list 必须第一条）

CLI 的 node 族读命令会自愈脏索引：本工具自己跑完一轮，`tree list .dirty` 就归零。
所以 L6 的唯一可靠观测点是**进程内第一条命令**读 `tree list`；连续两轮巡检，第二轮
L6 大概率静音，这是自愈语义，不是漏报。修法照旧：改完结构同轮 `node index && node validate`。

## 保证与边界

- 只读 + 会话隔离：子进程固定 `YGL_SESSION=lcv-validator`，选树走 `YGL_TREE` 环境变量，
  绝不 `tree use` / `project use`，不污染任何会话的选择状态。
- rel 端点是节点内部 id：快路径用两条 SELECT-only 的 `db sql`（nodes/trees 表）一次拿全
  id 到 tree/key 的映射；该路径失灵时回退逐节点 `node show`（慢，仅兜底）。
- claim/evidence/task 是项目作用域（未选项目时 fail-closed）：工具按 `project list` 遍历
  并用 `YGL_PROJECT` 环境变量导向逐项目采集，跨项目按 id 去重，不改任何会话的选择状态；
  kb 与 rel 是工作区全局，各读一次。
- L7 是防御性通道：CLI 正常写入造不出环/悬空，`node validate` issues 非空才触发。
- 断言正文的完成性表述用否定前置排除（未/没/不/待/否），仍有误报可能，发现条目
  带原文，人工复核后处置。

## A2A 服务方式

本验证器由 ygl-trees-lifecycle 技能专家席维护（team `dsh/680db8f3`，roster
`ygl-trees`）。其他成员把"帮我查工作区漂移"路由过来，附工作区路径即可；专家席
跑本工具并回 `--json` 报告（findings 每条带反模式出处与修法命令）。
