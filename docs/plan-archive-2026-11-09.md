# plan 执行记录归档 · 2026-11-09（#158–#171 的「在途」记录）

> 从 [plan.md](plan.md) 拆出，原文未改。这些小节写于 0.119.0 / 0.120.0 发版前，标题里的「未发版」是当时的状态；对应 issue（#158、#159、#160、#166、#168、#170、#171）现已全部关闭。

## 在途 · #171 第2项 引擎版本来源（未发版）

独立分支基于c553f8d，不改五个已评审头、不进0.119.0。应用prepare/run显式注入env.version，与tree G8相同来源；覆盖CLI、HTTP与树叶新报告，并移除组报告过时fallback。底层独立verify-core包自身version为0.1.0，保留其确定语料/直接库调用默认值，不冒称根CLI版本；修复的是应用入口漏传/写死版本。旧spec/报告保持原字节，新执行报告记录当前引擎；无schema/as_of/import/provenance/独立性范围扩展。原码版本断言4红/84绿，修后88/88通过，CLI归档哈希仍可验，补旧0.1.0 spec复跑不回写断言。README测试数量未增加（增强现有用例），完整链与pack待本轮实测。Refs #171，只完成第2项不提前关整单。

## 在途 · #168 构建配置隔离（未发版）

PR173从c553f8d独立起支，首轮--no-config虽隔离父配置但与已评审#161的仓内压缩配置冲突，故按评审direct-fc81720c普通merge冻结fc2f65d到本支（不改四评审头，不进0.119.0）。现build:bundle:only显式--config ./tsdown.config.mjs，沿用#161 minify/keepNames及原82ms/676368B基线，不重写。G1在env -i内校验realpath属本仓并打印配置绝对路径。保留真实clone父decoy字节同/未执行反例，新增仓内minify切换有效正控，以及G1本仓/缺失/仓外symlink三场景，8/8定向通过。README1501+新增1+G1新增2=1504，完整链待实测。offline-gate同提交重登记；package此前未登记，误加Z锚已显式撤销，监督席确认后单独enrollment另议，不改既有账本。仅在0.119发布和四层依序合并后才可落本PR；Refs#168不提前关单。
## 在途 · #166（未发版）

agent brief使用入口已解析项目构造载荷，短/长旗标优先于env/session，不改选择指针，未知项目rc1、多项目未选rc2；node list接受CLI已消费的全局home/db且保留未知旗标rc2，隔离真实bundle覆盖前后放置。Refs #148保留原七项验收不扩写。旧master与本修复ABBA冷启动均超过原408ms上限，因此复用已有#158运行时优化，接在PR #165后组合重验并加入官方stack，不放宽棘轮基线或容差。仅本单代码/测试/文档为新delta，无schema/PG支持面/生产作业变更，不自合、不发版、不关单。

## 在途 · #160（未发版）

新增 evidence 对照非空存储原文，仅折叠空白/trim后精确匹配，不做NFKC/模糊/抓取。拒绝单错误、事务零写入；--unverified 显式绕过，force 不绕过，新增事件记核验与绕过。回执 quote_verified 是加法字段，重复只取创建事件的历史标记，旧未知=false，不追溯重验或改存量。批量共用写入核心、物理行号、全批回滚，PG 同形；黄金夹具只认可这个明确新增字段，其余原字节比对。本轮普通merge父PR163，P3使用QuoteMismatchError并保留批量类型/物理行号。事件选择保留带payload_version:1的JSON审计（核验/绕过必须持久区别），旧字符串不迁移且未知=false；agent log/SQL export混合旧新载荷回归及专用错误类共18/18通过。既有A偏好在进一步审计后改为B，已以decision上下文记反向判断，不当成独立或认定规则。README预计1470+原引文17+新增3=1490，最终全链计数核准。依赖 PR #163，独立 Refs #160，完整链与真实PG结果以后续固定提交验收为准，不自合、不发版、不关单。

## 在途实现 · #158（未发版）

预测 P/Brier 与频道评分保持只读，ND/open/no_p不进入均值分母。PR161按普通merge并入固定master c553f8d，保留#170夹具和基线历史，不进入0.119.0发布。运行时按需加载与压缩保留类名；完整dist/bundle随包交付。按监督席direct-6154a043在Windows签名重锁：旧938774B为入口口径，新676368B为全目录口径，不声称同尺；cold407→82ms由惰性加载改善，web1401456B持平，容差2%/30%不变。归因已写ratchet-baseline.json的_attribution和方法戳；不得在macOS重写。保留无sourcemap的诊断限制。merge后README暂按原1451+新增#170三例=1454，另串行perf10，最终须全链独立计数实测核准。旧cdb-only验收与本PR的新全目录基线不混用；本PR仍Draft，完整验证待本轮回执。

## 在途 · #159（未发版）

知识提升准入放在事务化写服务：完整非空 cue/lesson/evidence，或真实 evidence/claim 双向 rel，二选一；否则 rc1 单错误、零技能写入。强制绕过与技能/FTS/提升时 support_refs 快照同事务留痕。评审P2修复：普通skillUpsertIn不删promoted-with，删除仅放kbPromote事务内重新插入前；同名add/import保留历史支持快照。P3收敛为仅按id选笔记。负控旧码对add/import保留与重名标题拒绝三例均红，修后16/16通过，含重新提升失败恢复既有skill/FTS/support快照。README预计1454+16=1470，另perf10，最终全链计数核对。复用 relations 表，无 schema 变更；kb add/import 仍宽松，只有准入 frontmatter 在 import 中保留。#157/#161 与本单 README 计数行均需以后合后的实际测试配置重测。本单显式依赖 PR #161 的已验证运行时预算修复，独立 PR 以 fix/158-predict-score 为基线，仅展示 #159 差异，组合后完整链重测；不复用父单验收冒充本单通过。使用 Refs #159，不自动关闭，发版后另按工单复验。

## 在途 · #170 MCP 测试生命周期（未发版）

候选 10b68dc 的 G1 第二轮出现请求超时和清理 EPERM，三轮 rc 为 0/1/0，不能放行。Windows 原码在真实默认套件负载下定向 30/30 通过，另 10 次完整默认套件全部 rc0、MCP 均通过；没有复现原始 15 秒停顿。异步诊断观察到请求处理最大 12.745ms、spawn 返回最大 12.534ms、heartbeat 超出 1000ms 周期最大 16.598ms，未记录请求上下文内同步 fs/spawnSync。原失败没有逐请求 trace，故主机停顿只是当前工作判断，不是已证明根因。

本次仅修测试：accepted IPC 屏障证明交错已进入服务端；销毁测试请求后停止服务接收并终止其拥有的 CLI，等待所有 CLI close，再等待父服务 close 后清目录。保留业务请求 15000ms、不改运行时和基线。新增三条清理回归，其中旧的先杀父再清理顺序已实测红；真实持有文件子进程的回归通过。修复后 Windows 30/30 负载重复通过，背景完整默认套件 1326 passed / 109 skipped = 1435（164文件通过/9跳过）；README计数取1435。Windows pnpm test全链rc0：主段1435、串行perf10、demo128、contract152/152、README60/60（独立串行计数1435）、skills289/0，ratchet入口938774B/web1401456B held、cold397ms tightened（基线未写）。meta45/0drift及against-git审计rc0。macOS完整链仍待评审席独立回执。
