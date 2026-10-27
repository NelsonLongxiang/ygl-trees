---
name: unit-count-baseline
description: unit 计数门的基准环境、跨平台清单与 29 例差集追查（验证席裁 direct-0c74f406 A+C）
kind: 参考
---

# unit 计数门基准（C：先查清差集）

## 基准环境（A①）

README 的 `vitest N 例` 以**含 bundle（docker 无）与 rust 工具链的离线机**为基准（发布机同款）：
- `dist/bundle/bin.cjs` 在场 → `describe.skipIf(!HAS_BIN)` 的成组用例才会执行；
- `cargo` 在场 → rust-parity / seal-parity 两处会执行。

**前置不满足时** `readme-verify.sh` 的计数门**显式 SKIP 并打印原因**（A②：不静默绿、不假红），
满足前置才比对数字（A③）。

## 本机清单（Windows，master `fa2769c` 线，bundle 在场、cargo 1.90 在场）

- 测试文件 **143**，用例总数 **1170**（多次跑在 1161–1170 之间抖动：**同一 commit 两次跑差 7 例**——见下「抖动」节，验证席裁 ①：自跳=禁止）。
- 基准机（macOS，bundle+cargo）实测 **1204**（监督席 direct-d41b913e 转述：1201+3）。
- 显式 skip 5 条：shell.spec ×3（真实 CLI 往返，`HAS_BIN` 语义不同）、claimlink-quiet ×1（离线 quiet 路径）、meta-gate-subdir ×1（`it.skipIf(process.platform === "win32")`——symlink realpath）。

## 抖动（验证席 direct-9c98bb08 裁①：自跳=禁止）

同一 commit、同一机器、两次 `vitest run` 总例数 1161 vs 1168（skip 恒 5）——说明有 **spawn 型用例在负载下自跳**（静默丢覆盖）。追查法：两次 `--reporter=json` 差集得 7 例名单，逐个改足 timeout 或 `describe.sequential`，禁止静默 skip。测量口径候选：`--no-file-parallelism`（串行）复测；抖动消失即定为 README 计数口径（gate 用同 flag）。

## 与 macOS 的差集（34 例，待交叉）

评审席在 macOS 报 1197–1201。逐文件清单比对步骤：

```bash
npx vitest run --reporter=json --outputFile=/tmp/inv.json
node -e "const j=require('/tmp/inv.json');console.log(j.testResults.map(f=>f.name.replace(/.*ygl-trees[\\/]/,'')+'	'+f.assertionResults.length).join('\n'))"
```

两侧按 `文件<TAB>用例数` 排序 diff 即得差集。预期来源（按 `skipIf` 静态清单）：
`HAS_BIN` 组（bundle 在场才跑）、`hasRust` 组（cargo 在场才跑）、`it.skipIf(process.platform)` 单例。
本机（bundle 有、cargo 无）若差集集中在 rust 组，则**前置收敛后两平台应立即一致**；否则说明还有环境敏感测试未收敛，回 C 继续查。
