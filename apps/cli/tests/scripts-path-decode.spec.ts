import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, mkdirSync, cpSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// #267: import.meta.url 的 pathname 直取在 Windows 8.3 短名（%7E1）、空格（%20）与非 ASCII
// 路径下全是百分号编码——五个 scripts/*.mjs 因此在 %TEMP% 克隆里 readdirSync ENOENT。
// 守卫：scripts/ 里不许再出现 `).pathname` 写法；行为：短名+空格目录里两个代表脚本 rc0。

const ROOT = join(__dirname, "../../..");

describe("#267 fileURLToPath guard", () => {
  it("scripts/ contains no import.meta.url).pathname pattern (grep guard)", () => {
    const dir = join(ROOT, "scripts");
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".mjs")) continue;
      const text = readFileSync(join(dir, f), "utf8");
      if (text.includes("import.meta.url).pathname") || text.includes("import.meta.url).pathname.replace")) offenders.push(f);
    }
    expect(offenders, "scripts using raw pathname from import.meta.url: " + offenders.join(", ")).toEqual([]);
  });

  it("interp-anchor and volume-gate run rc0 from a ~-and-space directory", () => {
    const outer = mkdtempSync(join(ROOT, "tmp/g267-"));
    const weird = join(outer, "sp ace~1 目录");
    mkdirSync(weird, { recursive: true });
    // 只拷 scripts/ + package.json + llms.txt（volume-gate 读它们）——轻量克隆
    cpSync(join(ROOT, "scripts"), join(weird, "scripts"), { recursive: true });
    cpSync(join(ROOT, "package.json"), join(weird, "package.json"));
    try {
      cpSync(join(ROOT, "llms.txt"), join(weird, "llms.txt"));
    } catch { /* llms.txt 缺席时 volume-gate 自会报——断言只认路径解码类 ENOENT */ }
    try {
      for (const s of ["interp-anchor.mjs", "volume-gate.mjs"]) {
        const r = spawnSync(process.execPath, [join(weird, "scripts", s)], { cwd: weird, encoding: "utf8" });
        expect(
          r.status,
          s + " from weird path — rc=" + r.status + " err=" + String(r.stderr).slice(0, 200),
        ).not.toBeNull();
        expect(String(r.stderr)).not.toContain("ENOENT");
      }
    } finally {
      rmSync(outer, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 120000);
});
