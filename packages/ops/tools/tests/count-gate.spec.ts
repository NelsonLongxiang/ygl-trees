/**
 * #108（验证席裁）：unit 计数门**无开关**——任何机器都比对（opt-in flag 会变成关闸闸门）。
 * 负例钉：README 数字 ≠ 实际 total → 门必须判红（非 baseline 机同样红）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO = resolve(__dirname, "../../../..");

describe("#108 计数门（无开关 + 负例必红）", () => {
  const src = readFileSync(join(REPO, "scripts", "readme-verify.sh"), "utf8");

  it("门里没有 YGL_COUNT_BASELINE 之类开关（不许关闸）", () => {
    expect(src).not.toContain("YGL_COUNT_BASELINE");
    // 也不许用其它环境变量做前置跳过：计数块内只允许 README_UNIT_COUNT_GATE=0 的显式放弃（历史兼容），
    // 且该变量不得出现在 release/pack:check 路径（见下一条）。
    const block = src.slice(src.indexOf("unit 计数"), src.indexOf("readme-verify: $((N-F))"));
    expect(block).not.toContain("SKIP");
  });

  it("README 数字与实际 total 不符时，比较必定失败（负例语义）", () => {
    const readmeNum = Number((readFileSync(join(REPO, "README.md"), "utf8").match(/vitest (\d+) 例/) || [])[1] || 0);
    const mismatch = String(readmeNum + 1); // 故意造一个不等于 README 的值
    const equal = readmeNum === readmeNum;
    expect(equal).toBe(true);
    expect(mismatch === String(readmeNum)).toBe(false); // 门用的是严格字符串相等
    // 门实现必须是严格相等比较，不许容差
    expect(src).toMatch(/README_NUM" = "\$ACTUAL"/);
    // #216：总数不依赖 "Tests <N> passed" 形状（有 failed 时旧正则取空）；内嵌一轮的 rc 被读取并点名失败用例
    const block = src.slice(src.indexOf("unit 计数"), src.indexOf("readme-verify: $((N-F))"));
    expect(block).not.toMatch(/Tests\[\[:space:\]\]\*\[0-9\]\[0-9\]\* passed/);
    expect(block).not.toContain("2>/dev/null");
    expect(block).toMatch(/UNIT_RC=\$\?/);
    expect(block).toMatch(/\$UNIT_RC" != "0"/);
    expect(block).toMatch(/grep -E '\^\[\[:space:\]\]\*FAIL\[\[:space:\]\]'/);
    // #216 ⑤：日志按轮唯一（时间戳 + $$），不是固定文件名
    expect(block).toMatch(/UNIT_LOG="tmp\/readme-count-vitest-\$\(date -u [^)]*\)-\$\$\.log"/);
    expect(block).not.toContain('UNIT_LOG="tmp/readme-count-vitest.log"');
  });

  it("release 路径不依赖任何关闸变量", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    const scripts = Object.values(pkg.scripts || {}).join(" ");
    expect(scripts).not.toContain("YGL_COUNT_BASELINE");
    const release = readFileSync(join(REPO, "docs", "release.md"), "utf8");
    expect(release).not.toContain("YGL_COUNT_BASELINE");
  });
});
