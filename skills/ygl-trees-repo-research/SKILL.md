---
name: ygl-trees-repo-research
description: 用 ygl-trees 研究一个开源项目（主推场景②）：从仓库/发布史/社区证据建「作者意图树」——作者要解决什么问题、走到哪一步、下一步大概率是什么。给到一个开源项目要做系统性研究、写项目分析报告、或建项目科技树时使用。触发词：开源项目研究、作者意图、项目分析、repo research、项目科技树、竞品研究。
version: 0.118.0
---

# 开源项目研究树（repo-research 标准形）

把一个外部开源项目建模成研究项目 + 一棵「作者意图树」。产出不是读后感，是可回测的判断。

## 五步标准形

1. **立项登记**：`project new <repo-owner-name>`；检索式登记 `research query add "作者想解决什么问题"`（问题域）+ `"架构为什么这样选"`（决策域）+ `"下一个版本会做什么"`（预测域）。
2. **证据采集**（三路源）：
   - 仓库本体：README/AGENTS.md/CHANGELOG/目录结构（`research source add --url file://… --title "…"` 或 http(s) URL）；
   - 发布史：releases/tags 逐条（每条一个 source，引 CHANGELOG 段落为 evidence）；
   - 社区信号：issues/discussions/外部讨论（记录时间点与密度）。
   每条 evidence 必须带 `--quote` 原文摘录——转述不算证据。
3. **断言三层**（每层至少一条，`research claim add` + `research claim link <cid> <eid> --stance supports` 挂证据）：
   - **意图层**：作者要解决的问题是什么（判据=作者自己的话，不是你的推断）；
   - **现状层**：解决到哪一步（判据=发布史/代码事实）；
   - **机制层**：为什么这条路走得通/走不通（判据=架构决策链）。
4. **建树**：`tree new <repo>-intent`。标准节点骨架：t1 问题定义 → t2 路线选择（各候选路线一节点，走通的 unlock、否决的挂 excludes）→ t3 已交付能力 → t4 当前边界 → t5 下一步（**未来节点用真实条件锁定**：`node cond add <key> --name <cond> --op eval --value "<判定问题>"` 挂「作者会做 X 吗」，或 `--op telemetry` 挂发布节奏）。挂树用 rel：`rel add node:<tree>/<key> claim:<id> --rel decided-by`。
5. **预测落账**：对 t5 出 `[预测·N天]` 断言（`research claim add` 带文本格式、数值 `--confidence 0.8` 与 `--channel`）+ 标记节点（time-capsule 树）。到期 `research predict audit` 取证，resolve 仍是人工仲裁。`research predict list --all --json` 的 `brier_calc` 由引擎计算，结算者不再手算；原 `brier` 备注值只作对账。研究质量用 `research predict score --all --json` 按 channel 读取 `hit_rate` / `brier_mean`，可加 `--channel <c>` 精确过滤：ND、未结算和缺概率行不进评分分母，空分母是 null 不是 0。

## 反模式

- 只读 README 不读发布史——意图在演进，快照会骗人。
- 断言无证据链接（`research claim add` 后不 `research claim link`）——那是观点不是断言。
- 预测不落预测断言格式——无法回测的研究是一次性消费。
- 树只有三个节点——用真实条件锁定的未来节点撑开边界（t5 至少 2 个 locked）。

## 实战样本

mp-skills 深读（tmp/ 工作痕迹，2026-10-18）：6 源 + 9 技能逐文件证据 + 意图层断言「技能=给 agent 的操作系统调用约定」。
