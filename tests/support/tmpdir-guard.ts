import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #227：整轮单测共用一个新建的临时根（TMPDIR/TEMP/TMP 指过去，worker 与子进程都继承），
 * 跑完整个删掉——验证器一天重跑几十轮，漏收尾的测试目录不再堆进系统临时目录。
 * 删之前先清点：除 Node 编译缓存与引擎快照副本外还有残留 = 有测试漏收尾，整轮判红并点名。
 */
const EXPECTED = new Set(["node-compile-cache"]); // #228: ygl-verify-snapshots copies (incl. WAL sidecars) are removed per-run
const KEYS = ["TMPDIR", "TEMP", "TMP"] as const;
// #250: the whole unit suite runs with the evaluator pinned offline unless the
// live opt-in is given — specs that spawn claim link/evaluate must not reach the
// real gateway just because the host has credentials (three 2026-11-08 full-run
// reds traced to exactly that). A spec that needs another state sets it itself.
const LIVE = process.env.YGL_TEST_LIVE_EVAL === "1";

export default function setup() {
  const root = mkdtempSync(join(tmpdir(), "ygl-vitest-"));
  const saved = KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of KEYS) process.env[k] = root;
  const savedEval = process.env.YGL_EVAL_OFFLINE;
  if (!LIVE) process.env.YGL_EVAL_OFFLINE = "1";

  return () => {
    // #228 review: an EMPTY ygl-verify-snapshots directory is fine — a concurrent
    // snapshotCopy may sit between mkdir and copyFile, so the dir must outlive
    // runs (never rmdir'd). Files inside it are the leftover contract.
    const leftovers = readdirSync(root).filter((n) => {
      if (EXPECTED.has(n)) return false;
      if (n === "ygl-verify-snapshots") {
        const inside = readdirSync(join(root, n));
        return inside.length > 0; // empty dir passes, any file fails
      }
      return true;
    });
    // #228 debug: name the offending entry's shape (file vs dir + contents) so a
    // leftover can be attributed without re-running with a watcher.
    for (const n of leftovers) {
      const full = join(root, n);
      const stat = statSync(full);
      process.stderr.write(`tmpdir-guard leftover: ${n} ${stat.isDirectory() ? "dir[" + readdirSync(full).join(",") + "]" : "file"}\n`);
    }
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (savedEval === undefined) delete process.env.YGL_EVAL_OFFLINE;
    else process.env.YGL_EVAL_OFFLINE = savedEval;
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    if (leftovers.length) {
      throw new Error(`tests left ${leftovers.length} entr${leftovers.length === 1 ? "y" : "ies"} in the temp directory (#227): ${leftovers.sort().join(", ")}`);
    }
  };
}
