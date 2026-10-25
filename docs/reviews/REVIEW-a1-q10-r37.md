---
name: review-a1-q10-r37
description: A1 r36 修复复核（r37）——G8/Q9/矩阵已修，但 tree spec 冻结 target 在 run 期被 String(obj) 打成 usage rc2，Q8 target 实际不可运行；0.115.0 仍暂缓
kind: 评审
---

# A1 r36 修复 · 复核（r37）

> 对象：`86093fb`（G8 rc2 + 矩阵重绑 + 测试）+ `51f64cf`（矩阵最终 HEAD），HEAD `51f64cf`。
> 方法：代码路径 + 重建 bundle 后空 scratch 探针 + 矩阵重生成。
> 结论：**G8/Q9/五值/V15/Q12 已修；但 Q8 的 tree spec 冻结 target 在 run 期不可用（usage rc2）** → 0.115.0 暂缓，补一个 parse 修复 + run 级测试即可。

## 0. 已确认修复

- **G8**：声明 `engine_version:"0.999.0"`（实际 0.114.31）→ `tree prepare` **rc2**，点名 `G8: … engine/pin mismatch`；corpus/contract 同查。
- **Q9**：活叶冻结 `spec_version:2` vs 实际 v1 → run `STALE`、`stale_reason: spec_version drift`、`report_verdict:FAIL` 保留；pinned 版本漂移测试存在。
- **五值**：空库 ERROR 叶 → `nodes[].verdict` 五值内；`report_verdict` 原四值。
- **V15**：cap-on-PASS 改码 + 17+4 行测试；FAIL+ERROR/FAIL+INFRA=FAIL。
- **Q12**：pinned 必须来自已完成 run + 同轮自引用 rc2，测试存在。
- **矩阵**：manifest 已重绑新测试（Q8 target frozen / Q9 drift / G8 mismatch / Q12 completed run），HEAD 重建 `green 21 / partial 1 / planned 2 / missing 0 / red 0`；测试 45 例通过。

## 1. 阻塞 bug：tree spec 冻结的 target 在 run 期是 `[object Object]`

**复现**（`YGL_HOME=/d/workspace/a1-countersign/.home`）：

```json
// tree JSON（prepare 用）
{"tree_spec_version":1,"root":"root",
 "target":{"kind":"sqlite-snapshot","id":"other-node"},
 "nodes":[{"id":"root","kind":"group","aggregate":"all_pass","children":["a"]},
          {"id":"a","kind":"leaf","spec_id":"spec_b0de240263b4"}]}
```

- `verify tree prepare` **rc0**（target 进 spec/canonical，Q8 测试覆盖到这一步）。
- `verify tree run ts_… --db snapshot.sqlite` → **rc2**：
  `{"error":"usage: --target <kind>:<id>[#sha256]"}`
- 根因：`treeRun` 里 `const targetRaw = args.flags.target !== undefined ? String(args.flags.target) : String((spec as any).target ?? "")`（`verify-cmds.ts:337`）——spec.target 是对象，`String(obj)` 得到 `"[object Object]"`，无 `:` → usage rc2。
- 后果：**Q8 的「tree spec 声明 target」路径在 run 期不可达**；pinned/live 的 target 比较只有在传 `--target` flag 时才生效，冻结 target 等于死数据。矩阵 Q8 green 只覆盖「prepare 写入 canonical」，未覆盖 run。

**修复**：`treeRun` 读取 target 时区分 flag 字符串与 spec.target 对象（对象直接用 `{kind,id,sha256}`；flag 才 parse `<kind>:<id>[#sha256]`）；补两条 run 级测试：
1. spec.target 与活叶 data_source 失配 → STALE；
2. spec.target + pinned 叶失配 → STALE（Q8 pinned 覆盖，r36 也提过）。

## 2. 次要不阻塞（可随修复一起）

- G8 目前在 **prepare** 期拒绝版本不一致；契约 §0 写「run 时与引擎实况不一致 → 拒跑」。tree spec 冻结后不可变，prepare 拒绝已提供安全性，但建议 run 期再加一道（或契约注明以 prepare 为准），避免 spec 文件被手改后绕过。
- Q8 subject（repo+commit）只做了 canonical 绑定，未校验实况；作为声明面可接受，建议文档写清「subject 是声称，不校验」。
- `aggregate` 注释已修正；V15 assertion 已改五值。

## 3. 签注条件

修复 §1（target 对象解析）+ 上述两条 run 级测试 + 矩阵重生成（Q8 绑定 run 测试），302 席即签；fdc 同批复核后 0.115.0 放行。其余已修项不重开。
