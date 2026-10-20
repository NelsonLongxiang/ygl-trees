/**
 * GitHub issue #6 ②: `job tick` / `job run` used to hold the process-level
 * write lock while execSync-ing each due job (up to 600s), queueing every other
 * CLI invocation behind them. They now boot lock-free like `webui serve`; the
 * fs tick.lock keeps concurrent ticks apart and SQLite WAL serializes writes.
 *
 * Regression shape: start a slow job run, then run a normal CLI command while
 * it is still executing; the command must answer promptly instead of waiting on
 * the runner's lock.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
let HOME = "";

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, YGL_HOME: HOME, YGL_EVAL_OFFLINE: "1" },
  });
  return { rc: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

beforeAll(() => {
  HOME = mkdtempSync(resolve(tmpdir(), "ygl-joblock-"));
  run(["db", "init"]);
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("job run/tick 不再长持写锁（GitHub issue #6 ②）", () => {
  it("a slow job run does not block ordinary CLI commands", async () => {
    const added = run(["job", "add", "slow", "--", process.execPath, "-e", "setTimeout(()=>{},2500)"]);
    expect(added.rc).toBe(0);
    const list = JSON.parse(run(["job", "list", "--json"]).stdout) as Array<{ id: string; title: string }>;
    const slow = list.find((j) => j.title === "slow");
    expect(slow).toBeTruthy();

    const child = spawn(process.execPath, [BIN, "job", "run", slow!.id], {
      env: { ...process.env, YGL_HOME: HOME, YGL_EVAL_OFFLINE: "1" },
      stdio: "ignore",
    });
    try {
      // give the runner time to boot and enter execSync
      await new Promise((r) => setTimeout(r, 400));
      const t0 = Date.now();
      const stats = run(["db", "stats"]);
      const elapsed = Date.now() - t0;
      // Before the fix the child waited out YGL_LOCK_RETRY_MS (8s) and then
      // failed with "database is locked" (rc=1), so rc=0 is the discriminator;
      // the elapsed bound only guards against silent long stalls.
      expect(stats.rc).toBe(0);
      expect(elapsed).toBeLessThan(8000);
    } finally {
      child.kill();
    }
  }, 60_000);
});
