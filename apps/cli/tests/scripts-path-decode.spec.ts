import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, mkdirSync, rmSync, mkdtempSync, existsSync, copyFileSync } from "node:fs";
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
    // 夹具＝两脚本实际读的全部根文件（#267 复核：缺 volume-baseline.json 在 macOS ENOENT 变红）。
    // node 的 cpSync(目录) 在含 ~1 的路径上静默不拷（本机实测 cp dir OK:false 无异常）——逐文件手工递归。
    const copyTree = (from: string, to: string) => {
      mkdirSync(to, { recursive: true });
      for (const e of readdirSync(from, { withFileTypes: true })) {
        if (e.isDirectory()) copyTree(join(from, e.name), join(to, e.name));
        else copyFileSync(join(from, e.name), join(to, e.name));
      }
    };
    copyTree(join(ROOT, "scripts"), join(weird, "scripts"));
    copyFileSync(join(ROOT, "package.json"), join(weird, "package.json"));
    copyFileSync(join(ROOT, "volume-baseline.json"), join(weird, "volume-baseline.json"));
    copyTree(join(ROOT, "docs"), join(weird, "docs"));
    try { copyFileSync(join(ROOT, "llms.txt"), join(weird, "llms.txt")); } catch { /* 可选 */ }
    try {
      for (const s of ["interp-anchor.mjs", "volume-gate.mjs"]) {
        // vitest worker 的 Windows spawn 对含空格 argv 引号不稳——经 shell:true 让平台 shell 负责引号；
        // 根因回归面仍在：脚本用 import.meta.url 定位 ROOT，若退回 pathname 写法将以 %XX 路径 ENOENT。
        if (!existsSync(join(weird, "scripts", s))) throw new Error("fixture missing: " + join(weird, "scripts", s) + " | weird exists: " + existsSync(weird) + " | weird entries: " + (existsSync(weird) ? readdirSync(weird).join(",") : "-") + " | scripts exists: " + existsSync(join(weird, "scripts")));
        const q = (p: string) => '"' + p + '"';
        const r = spawnSync(q(process.execPath) + " " + q(join(weird, "scripts", s)), { shell: true, cwd: weird, encoding: "utf8" });
        expect(
          r.status,
          s + " from weird path — rc=" + r.status + " out=" + String(r.stdout).slice(0, 120) + " err=" + String(r.stderr).slice(0, 200),
        ).toBe(0);
        expect(String(r.stderr)).not.toMatch(/%7E|%20|%E7/);
      }
    } finally {
      rmSync(outer, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 120000);
});
