/**
 * #105（G13 后端面）：agent brief next_actions 的存名插值必须 shell 词化。
 * 实证：tree 名 "t1\ntouch /tmp/ygl105_pwn.txt #" 未词化时，整行丢 bash 粘贴会执行第二行
 * （canary 文件被创建）；尾 # 是构造要件（注释掉行尾残留引号）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
let HOME = "";
const run = (args, extraEnv = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 120_000, env: { ...process.env, YGL_HOME: HOME, ...extraEnv } });

describe.skipIf(!HAS_BIN)("#105 next_actions shell-quote（G13 后端面）", () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), "ygl-105-"));
    run(["db", "init"]);
  });
  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  /** POSIX 单词解析（测用）：返回 argv；未闭合引号视为注入失败信号 */
  const words = (cmd: string) => {
    const out: string[] = [];
    let cur = "", quoted = false, has = false;
    for (let i = 0; i < cmd.length; i++) {
      const c = cmd[i];
      if (quoted) { if (c === "'") { quoted = false; continue; } cur += c; has = true; continue; }
      if (c === "'") { quoted = true; has = true; continue; }
      if (c === "\\") { cur += cmd[++i] ?? ""; has = true; continue; }
      if (c === " ") { if (has) { out.push(cur); cur = ""; has = false; } continue; }
      cur += c; has = true;
    }
    if (quoted) throw new Error("unclosed quote — shell syntax leaked");
    if (has) out.push(cur);
    return out;
  };

  const cases = ["x;touch /tmp/pwn", "a$(id)", "it's", "my proj", "t1\ntouch /tmp/ygl105_pwn.txt #"];

  for (const name of cases) {
    it(`tree 名 ${JSON.stringify(name)}：建议命令词化为单一 argv，无裸换行终止`, () => {
      const mk = run(["tree", "new", name]);
      expect(mk.status, String(mk.stderr || "")).toBe(0);
      run(["node", "add", "n1", "-t", name]); // 造脏索引
      const brief = run(["agent", "brief", "--json"]);
      const actions: string[] = JSON.parse(String(brief.stdout || "{}")).next_actions || [];
      // 多棵脏树会各出一条建议——取**解析后 -t 值等于本树名**的那条（逐例独立断言）
      const escaped = /[\u0000-\u001f\u007f]/.test(name)
        ? name.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
        : name;
      const lines = actions.filter((a) => a.includes("node index"));
      const picked = lines.map((l) => ({ l, argv: words(l.split("   #")[0]) })).find((x) => {
        const at = x.argv.find((a) => a.startsWith("--tree="));
        return at !== undefined && at.slice("--tree=".length) === escaped;
      });
      expect(picked, `no node index action carrying ${JSON.stringify(name)}`).toBeTruthy();
      const argv = picked!.argv;
      expect(argv).toContain("index");
      // 附着式 --tree='<v>'（#106 REQUEST-fix②：前导 - 与 =ls 等号展开都被附着式+引号挡死）
      expect(argv.some((a) => a.startsWith("--tree="))).toBe(true);
      const ti = argv.findIndex((a) => a.startsWith("--tree="));
      expect(ti).toBeGreaterThan(-1);
      // 安全字符名逐字往返；含控制字符的名字按设计转义为字面 \n（不可往返 = 不会误操作错树）
      expect(argv[ti].slice("--tree=".length)).toBe(escaped); // 安全名逐字往返；控制字符名转义形（不往返=不会误操作）
      // 关键：命令本体里的换行必须被引号包住（words() 未抛未闭合引号即证单一 argv）
      expect(picked!.l.split("   #")[0]).toMatch(/node index --tree=/);
    });
  }

  it("每条 next_action 恒为单行：无任何裸控制字符（注释不是安全边界——验证席复验 NO-GO 本体）", () => {
    const crafted = "t1\ntouch /tmp/ygl105_pwn2.txt #";
    run(["tree", "new", crafted]);
    run(["node", "add", "n2", "-t", crafted]);
    const brief = run(["agent", "brief", "--json"]);
    const actions: string[] = JSON.parse(String(brief.stdout || "{}")).next_actions || [];
    for (const a of actions) {
      expect(a, "action must not contain raw control chars: " + JSON.stringify(a)).not.toMatch(/[\r\n\t\u0000-\u001f\u007f]/);
    }
  });

  // #108 终修（评审席单文件案）：固定 [sh, zsh, bash] 三壳；每壳独立 it——
  //  win32 或该壳不存在（ENOENT 探测）→ it.skipIf 注册+skip（**计数恒定**，全平台 1219）。
  const shellAvail = (bin: string): boolean => {
    const r = spawnSync(bin, ["-c", "true"], { encoding: "utf8", timeout: 5000 });
    return !(r.error && (r.error as any).code === "ENOENT");
  };
  const IS_WIN = process.platform === "win32";
  const canaryNames = ["t1\ntouch CANARY #", "a$(touch CANARY)", "=ls", "-rf"];
  for (const [shellName, shellBin, flags] of [
    ["sh", "sh", ["-c"]] as const,
    ["zsh", "zsh", ["-f", "-i", "-c"]] as const,
    ["bash", process.env.GIT_BASH || (IS_WIN ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash"), ["-i", "-c"]] as const,
  ]) {
    it.skipIf(IS_WIN || !shellAvail(shellBin))(`${shellName} 重放：${shellBin} 下敌意名 canary 不生成（#106①/#108）`, () => {
      for (const name of canaryNames) {
        const canary = join(tmpdir(), "ygl108_" + shellName + "_" + Math.random().toString(36).slice(2) + ".txt");
        const crafted = name.replace(/CANARY/g, canary);
        run(["tree", "new", crafted]);
        run(["node", "add", "nz", "--tree", crafted]);
        const brief = run(["agent", "brief", "--json"]);
        const actions: string[] = JSON.parse(String(brief.stdout || "{}")).next_actions || [];
        const line = actions.find((a) => a.includes("node index"))!;
        expect(line).toBeTruthy();
        const comment = line.split("   #")[1] || "";
        expect(comment).not.toMatch(/[$()`;&|<>]/);
        const rr = spawnSync(shellBin, [...flags, line], { encoding: "utf8", timeout: 30_000, env: { ...process.env, YGL_HOME: HOME } });
        expect(existsSync(canary), `${shellName} created canary for ${JSON.stringify(name)}`).toBe(false);
        try { rmSync(canary, { force: true }); } catch { /* absent */ }
      }
    });
  }
});
