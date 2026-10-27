/**
 * #105（G13 后端面）：agent brief next_actions 的存名插值必须 shell 词化。
 * 实证：tree 名 "t1\ntouch /tmp/ygl105_pwn.txt #" 未词化时，整行丢 bash 粘贴会执行第二行
 * （canary 文件被创建）；尾 # 是构造要件（注释掉行尾残留引号）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
      const lines = actions.filter((a) => a.includes("node index"));
      const picked = lines.map((l) => ({ l, argv: words(l.split("   #")[0]) })).find((x) => x.argv[x.argv.indexOf("-t") + 1] === name);
      expect(picked, `no node index action carrying ${JSON.stringify(name)}`).toBeTruthy();
      const argv = picked!.argv;
      expect(argv).toContain("index");
      // 显式 -t <tree>（#105③：裸 node index 会索引错树）
      const ti = argv.indexOf("-t");
      expect(ti).toBeGreaterThan(-1);
      expect(argv[ti + 1]).toBe(name); // 词化后解析回原名
      // 关键：命令本体里的换行必须被引号包住（words() 未抛未闭合引号即证单一 argv）
      expect(picked!.l.split("   #")[0]).toContain("node index -t ");
    });
  }
});
