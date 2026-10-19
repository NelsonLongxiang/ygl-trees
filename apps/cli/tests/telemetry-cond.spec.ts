import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** apps/cli/tests → repo root is three levels up. */
const REPO = resolve(__dirname, "..", "..", "..");
const BIN = join(REPO, "dist", "bundle", "bin.cjs");
const HAS_BIN = (() => { try { return !!require("node:fs").statSync(BIN); } catch { return false; } })();

const describeIf = describe.skipIf(!HAS_BIN);

let home = "";

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    ...process.env,
    YGL_HOME: home,
    YGL_SESSION: "spec-t13",
    YGL_TEST: "1",
  };
  for (const k of Object.keys(env)) base[k] = env[k];
  const r = spawnSync(process.execPath, [BIN, ...args], { env: base as any, encoding: "utf8", timeout: 30_000 });
  return { rc: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

describeIf("0.93 T1/T3: telemetry cond + cmd.run actor attribution", () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "ygl-t13-"));
    const init = run(["db", "init"]);
    expect(init.rc).toBe(0);
    // a couple of natural cmd.run rows (db init already wrote one)
    expect(run(["doctor"]).rc).toBe(0);
    expect(run(["tree", "new", "t13-tree"]).rc).toBe(0);
    expect(run(["node", "add", "t13-root", "-t", "t13-tree", "--kind", "quest"]).rc).toBe(0);
  }, 60_000);

  afterAll(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* Windows EPERM best-effort */ }
  });

  it("T3: cmd.run carries actor=YGL_SESSION (+payload.session), bare shell falls back to cli", () => {
    const j = run(["agent", "log", "--limit", "50", "--json"]);
    expect(j.rc).toBe(0);
    const rows = JSON.parse(j.stdout);
    const cmdRuns = rows.filter((r: any) => r.kind === "cmd.run");
    expect(cmdRuns.length).toBeGreaterThan(0);
    for (const r of cmdRuns) {
      expect(r.actor).toBe("spec-t13");
      const p = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
      expect(p.session).toBe("spec-t13");
    }
    // bare shell (no YGL_SESSION / DSH_SESSION_ID) keeps the historical "cli"
    const bare = run(["doctor"], { YGL_SESSION: undefined, DSH_SESSION_ID: undefined });
    expect(bare.rc).toBe(0);
    const j2 = run(["agent", "log", "--limit", "50", "--json"]);
    const cliRows = JSON.parse(j2.stdout).filter((r: any) => r.kind === "cmd.run" && r.actor === "cli");
    expect(cliRows.length).toBeGreaterThan(0);
    const p2 = typeof cliRows[0].payload === "string" ? JSON.parse(cliRows[0].payload) : cliRows[0].payload;
    expect(p2.session).toBeUndefined();
  }, 60_000);

  it("T1: op=telemetry gate passes on real cmd.run counts", () => {
    const add = run(["node", "cond", "add", "t13-root", "-t", "t13-tree", "--name", "usage-floor", "--op", "telemetry", "--value", "cmd.run>=2"]);
    expect(add.rc).toBe(0);
    const can = run(["node", "can", "t13-root", "-t", "t13-tree", "--json"]);
    expect(can.rc).toBe(0);
    const j = JSON.parse(can.stdout);
    expect(j.ok).toBe(true);
    expect(j.missing_required ?? []).toEqual([]);
  }, 60_000);

  it("T1: windowed gate fails closed when the count cannot meet the threshold", () => {
    expect(run(["node", "cond", "add", "t13-root", "-t", "t13-tree", "--name", "usage-window", "--op", "telemetry", "--value", "cmd.run:1h>=99999"]).rc).toBe(0);
    const can = run(["node", "can", "t13-root", "-t", "t13-tree", "--json"]);
    const j = JSON.parse(can.stdout);
    expect(j.ok).toBe(false);
    expect(j.missing_required.join(" ")).toContain("usage-window");
  }, 60_000);

  it("T1: malformed telemetry value fails closed without crashing", () => {
    expect(run(["node", "cond", "add", "t13-root", "-t", "t13-tree", "--name", "usage-bad", "--op", "telemetry", "--value", "nonsense"]).rc).toBe(0);
    const can = run(["node", "can", "t13-root", "-t", "t13-tree", "--json"]);
    expect(can.rc).toBe(0);
    const j = JSON.parse(can.stdout);
    expect(j.ok).toBe(false);
    expect(j.missing_required.join(" ")).toContain("usage-bad");
  }, 60_000);
});
