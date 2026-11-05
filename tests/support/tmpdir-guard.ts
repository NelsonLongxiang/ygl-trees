import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #227：整轮单测共用一个新建的临时根（TMPDIR/TEMP/TMP 指过去，worker 与子进程都继承），
 * 跑完整个删掉——验证器一天重跑几十轮，漏收尾的测试目录不再堆进系统临时目录。
 * 删之前先清点：除 Node 编译缓存与引擎快照副本外还有残留 = 有测试漏收尾，整轮判红并点名。
 */
const EXPECTED = new Set(["node-compile-cache", "ygl-verify-snapshots"]);
const KEYS = ["TMPDIR", "TEMP", "TMP"] as const;
const STALE_MS = 24 * 60 * 60 * 1000;

export default function setup() {
  const base = tmpdir();
  // 被杀掉的一轮跑不到收尾，整个根会留下；开头删掉一天以前的同类根（并发的其他轮都比这新）。
  for (const name of readdirSync(base)) {
    if (!name.startsWith("ygl-vitest-")) continue;
    const p = join(base, name);
    try {
      if (Date.now() - statSync(p).mtimeMs > STALE_MS) rmSync(p, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* 并发删除不影响本轮 */
    }
  }
  const root = mkdtempSync(join(base, "ygl-vitest-"));
  const saved = KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of KEYS) process.env[k] = root;
  return () => {
    const leftovers = readdirSync(root).filter((n) => !EXPECTED.has(n));
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    if (leftovers.length) {
      throw new Error(`tests left ${leftovers.length} entr${leftovers.length === 1 ? "y" : "ies"} in the temp directory (#227): ${leftovers.sort().join(", ")}`);
    }
  };
}
