# ygl-trees 架构图 — 所有部件如何协作

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户 / Agent                              │
│                                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │   CLI    │  │   MCP    │  │  WebUI   │  │   IDE Agent      │ │
│  │ (60+cmds)│  │ (11 tools)│  │ (antd+   │  │ (Claude/Cursor/  │ │
│  │          │  │          │  │  graph)  │  │  VSCode)         │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘ │
│       │              │              │                  │         │
└───────┼──────────────┼──────────────┼──────────────────┼─────────┘
        │              │              │                  │
        ▼              ▼              ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    bin.ts（薄入口 + rc 契约）                      │
│  解析参数 → bootApp() → 分发到域模块 → 返回 0/1/2                  │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              Cordis 框架（DSH fork，plugin 组合）                  │
│                                                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────┐ │
│  │  database   │  │  web-app    │  │   timer     │  │ 用户层  │ │
│  │  Service    │  │  Service    │  │  (ctx.timer)│  │ plugin │ │
│  │(ctx.database)│ │(ctx.webApp) │  │             │  │        │ │
│  └──────┬──────┘  └─────────────┘  └─────────────┘  └────────┘ │
│         │                                                         │
└─────────┼─────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SQLite（唯一事实源）                            │
│                    ~/.ygl-trees/ygl-trees.db                     │
│                    WAL 模式 · schema v12 · 28 表                  │
│                    ─────────────────────────                     │
│                    可选 PG（B7 起直连面）：                        │
│                    YGL_DB_URL=postgres://…                        │
│                    · db stats/path/doctor 直连                    │
│                    · db sync/migrate 单向导出                     │
│                    · 永不双写（SQLite 恒为 SoT）                   │
└────┬────────┬────────┬────────┬────────┬────────┬───────────────┘
     │        │        │        │        │        │
     ▼        ▼        ▼        ▼        ▼        ▼
┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐┌────────────┐
│ 研究    ││ 科技树  ││ 知识    ││ 关联    ││ 工程    ││ 运维        │
│ 管线    ││ 模型    ││ 系统    ││ 织物    ││ 产出    ││            │
│        ││        ││        ││        ││        ││            │
│queries ││trees   ││kb_notes││relations││artifacts││config     │
│sources ││nodes   ││kb_fts  ││(8 类   ││(report/ ││jobs       │
│evidence││edges   ││skills  ││ 实体   ││spec/    ││events     │
│claims  ││conds   ││skill_  ││ 双向)  ││design/  ││           │
│        ││closure ││refs    ││        ││task)    ││           │
│        ││state   ││        ││        ││         ││           │
└────────┘└────────┘└────────┘└────────┘└────────┘└────────────┘
     │           │          │          │          │
     └───────────┴──────────┴──────────┴──────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    决策模型（可选，离线安全）                       │
│                                                                   │
│  kb search --eval  ──→  语义重排（P(relevant) 逐条评分）           │
│  claim evaluate    ──→  置信度评估（0-5 → A/B/C/D）               │
│  evidence assess   ──→  证据质量（0-5 → 高/中/低）                 │
│  node can --eval   ──→  语义解锁判定（P≥0.7 通过 / ≤0.4 未通过）   │
│                                                                   │
│  无 AI_GATEWAY_API_KEY 时自动降级 pending                          │
└─────────────────────────────────────────────────────────────────┘
```

## 数据流

```
                    ┌──────────┐
                    │  Agent   │
                    └────┬─────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
    agent brief    agent match     research query
          │              │              │
          │         skill 命中          │
          │              │         source fetch
          │              │              │
          │              │         evidence add
          │              │              │
          │              │         claim add ──→ claim evaluate
          │              │              │         (决策模型校准)
          │              │         claim resolve
          │              │              │
          │              │         produce report
          │              │              │
          │              │         kb ingest ───→ 知识库
          │              │              │
          │              │         kb promote ──→ 技能
          │              │              │
          └──────────────┴────── agent match 下次命中
                                          │
                                          ▼
                                    知识闭环完成
```

## 契约层（冻结，机械断言）

```
┌─────────────────────────────────────────────────┐
│  ① 退出码: 0/1/2          → contract 4         │
│  ② 写入幂等: duplicate    → contract 1+2       │
│  ③ 坏引用: 点名不裸异常   → contract 3          │
│  ④ --json: 成功+失败可parse → contract 5       │
│  ⑤ flag 校验: 裸值/枚举拒绝 → contract 6       │
│                                                   │
│  145 项机械断言 · pnpm contract:audit 全绿        │
└─────────────────────────────────────────────────┘
```

## 分发层

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ npmjs.org│    │  Gitea   │    │  bundle  │
│ ygl-trees│    │ @nelson..│    │ bin.cjs  │
│ (公网)   │    │ (私仓)   │    │ (~831KB)  │
└──────────┘    └──────────┘    └──────────┘
       │              │              │
       └──────────────┴──────────────┘
                      │
              npm install -g ygl-trees
                      │
              ygl-trees db init
                      │
              3 步 20ms · Agent 就绪
```


## 门禁层（G1–G13 · 可执行判据）

```
┌────────────────────────────────────────────────────────────────────┐
│ 发布前（Now 出口）                    G1 离线门 offline-gate.sh      │
│                                     （env -i 干净 clone + 全链测试）  │
│  评审过程门                           G2 全 diff 读 / G3 真调用      │
│                                     （docs/release.md checklist）   │
│  构造面                               G4 commit-claims.mjs（消息声明   │
│                                     ↔ diff 一致）/ G5 mutation-pins  │
│  体量与归因                           G6 ratchet.mjs --reason 归属化  │
│                                     G11 volume-gate.mjs 双阈值       │
│  环境面                               G12 interp-anchor.mjs +         │
│                                     run-sh.mjs（解释器锚定）         │
│  数据面                               G7 pg-gate.sh（真 PG 矩阵）     │
│ 合并面                               G9 merge-check.mjs + pre-push   │
│                                     （祖先守卫，首捕实弹 e8653f6）      │
│ 发布后                               G8 post-release-check.mjs        │
│                                     （tag clone 复跑，禁 shallow）    │
│ 规则层                               G2b 未清 REQUEST-fix=合并禁制    │
│                                     G13 复制类命令必须 shell-quote    │
└────────────────────────────────────────────────────────────────────┘
                │
                ▼
    scripts/（G1/G4/G6/G7/G8/G9/G11/G12 脚本）+ docs/release.md（G2/G3 checklist）
    + verify/meta.json tooling[]（登记与 R3 一致性）+ .githooks/pre-push（pre-push 面）
```

**判据锚**：每门红→绿对照 + 负例钉（G11 双阈值实测 / G12 漂移负例 / G13 敌意名四例）。
**计数门**：`readme-verify.sh` unit 计数＝README 单值与 vitest total 严格相等（无开关；跨平台口径并列注明，差集追查中）。

---

*v0.116.0 · 52 版本账 · SQLite(+可选 PG 直连面) + Cordis + TypeScript · MIT*
