---
name: ygl-trees-design-capture
description: >-
  ygl-trees design 捕获方法论（spec R12/R13.2）：三类 design 工件的捕获法——ui-ux 用 DESIGN.md
  格式（google-labs-code：YAML tokens + rationale 节序 + lint 工具链）；arch/decision 用 ADR
  三段（上下文/决策/后果）。produce design 命令 + design_type 信封 + rel 挂节点 + DESIGN.md
  单一事实源纪律。触发词：design 捕获、设计决策、ADR、DESIGN.md、ui-ux、架构决策、
  design_type、produce design、设计沉淀。
version: 0.115.1
tags: ygl-trees,methodology,design,adr,design-md
---

# Design 捕获方法论：三类工件三种写法

## 1. 分型（用户裁定 2026-10-17）

| design_type | 格式 | 工具链 |
|---|---|---|
| `ui-ux` | **DESIGN.md 格式**（[google-labs-code/design.md](https://github.com/google-labs-code/design.md)） | `npx -p @google/design.md designmd lint`（Windows 别名） |
| `arch` | ADR 三段：上下文/决策/后果 | 无（Markdown 纪律） |
| `decision` | ADR 三段（单点决策，比 arch 更小） | 无 |

## 2. ui-ux：DESIGN.md 格式要点

- **YAML front matter**（机器可读 tokens）：colors / typography / rounded / spacing / components（`{colors.primary}` 引用）
- **节序固定**：Overview → Colors → Typography → Layout → Elevation → Shapes → Components → Do's and Don'ts
- **lint 十一规则**：broken-ref(error) / contrast-ratio(WCAG AA) / orphaned-tokens / section-order…
- 组件属性面有限（backgroundColor/textColor/typography/rounded/padding/size/height/width）——border 色等页级 token 会 orphan 警告，属格式 alpha 限制
- **仓库纪律**：repo 根 `DESIGN.md` 是 WebUI token 单一事实源；`apps/web/src/tokens.css` 镜像它——改设计先改 DESIGN.md 再同步

## 3. arch / decision：ADR 三段

```markdown
# <决策标题>
## 上下文   （ Forces：约束、备选、为什么现在决定 ）
## 决策     （ Chosen：一句话可执行的裁定 + 触发条件 ）
## 后果     （ Consequences：正/负/中立，含推迟项 ）
```

判例参考本仓：WAL+NORMAL 双连接（docs/conventions.md §五）、Bun Windows 受阻（docs/bun-compat.md）。

## 4. 捕获命令与挂接

```bash
ygl-trees produce design "<标题>" --design-type ui-ux|arch|decision --body|-f <file>
ygl-trees rel add node:<tree>/<key> artifact:<id> --rel decided-by   # 挂到树
```

design_type 存 artifacts.meta JSON 信封（schema v8）；`produce list` 可按 kind 检索。

## 5. 纪律

- 设计先有 token 再有像素：ui-ux 捕获若引入新色/新字号，先改 DESIGN.md 并 lint 0 error
- ADR 的"后果"必须含推迟项（没有推迟项的 ADR 多半没想清代价）
- 每条 design 都应 `decided-by` 挂到 evolution 树的对应节点——设计孤岛 = 没捕获
