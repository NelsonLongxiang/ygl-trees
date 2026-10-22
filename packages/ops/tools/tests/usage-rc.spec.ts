import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 0.91.0 (cold-run friction log, ops line direct-f4357a11): the frozen
 * exit-code contract says usage errors are rc 2. Probing every top-level
 * group with a fake subaction found six offenders returning 0 —
 * research/tree/node/doctor/mcp/llms — plus the MCP server advertising a
 * hardcoded 0.69.0 version stamp. Both are pinned here.
 */

const REPO = resolve(__dirname, "../../../.."); // worktree/packages/ops/tools/tests → repo
const BIN = join(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = (() => { try { readFileSync(BIN); return true; } catch { return false; } })();

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "ygl-usage-rc-")); });
afterAll(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* EPERM on Windows */ } });

function run(args: string[], stdin?: string): { rc: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: REPO,
    encoding: "utf8",
    input: stdin ?? "",
    env: { ...process.env, YGL_HOME: home, YGL_SESSION: "usage-rc-spec" } as any,
    timeout: 60_000,
  });
  return { rc: r.status ?? -1, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
}

describe.skipIf(!HAS_BIN)("usage rc contract (0.91.0)", () => {
  it("every top-level group: unknown subaction → rc 2", () => {
    // workspace for groups whose dispatch touches env first; the R16
    // selection gates (no project / no tree → rc 1) fire before subaction
    // dispatch, so seed one project + one tree to reach the usage layer.
    expect(run(["db", "init"]).rc).toBe(0);
    expect(run(["project", "new", "alpha", "-q", "probe"]).rc).toBe(0);
    expect(run(["tree", "new", "probe-t"]).rc).toBe(0);
    const groups = [
      "agent", "research", "produce", "kb", "skill", "tree", "node",
      "task", "rel", "plugin", "webui", "db", "doctor", "config",
      "job", "project", "mcp", "llms",
    ];
    const offenders: string[] = [];
    for (const g of groups) {
      const { rc } = run([g, "__frob__"]);
      if (rc !== 2) offenders.push(`${g}=${rc}`);
    }
    expect(offenders, `groups not returning rc 2: ${offenders.join(", ")}`).toEqual([]);
  }, 120_000);

  it("bare group invocation stays usage display rc 0 (convention)", () => {
    for (const g of ["research", "tree", "node", "doctor", "kb"]) {
      expect(run([g]).rc, `bare ${g}`).toBe(0);
    }
  }, 60_000);

  it("MCP initialize advertises the real package version (not a stale stamp)", async () => {
    const pkgVersion = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
    const child = spawn(process.execPath, [BIN, "mcp"], {
      cwd: REPO,
      env: { ...process.env, YGL_HOME: home, YGL_SESSION: "usage-rc-spec" } as any,
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    const deadline = Date.now() + 15_000;
    while (!out.includes("serverInfo") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    child.kill();
    const line = out.split("\n").find((l) => l.includes("serverInfo"));
    expect(line).toBeTruthy();
    const serverInfo = JSON.parse(line as string).result.serverInfo;
    expect(serverInfo.name).toBe("ygl-trees");
    expect(serverInfo.version, "stale version stamp — read from package.json at runtime").toBe(pkgVersion);
  }, 30_000);

  it("#48 missing positional id → rc 2 usage + single JSON error (no driver leak)", () => {
    expect(run(["db", "init"]).rc).toBe(0);
    expect(run(["project", "new", "alpha", "-q", "probe"]).rc).toBe(0);
    for (const cmd of ["produce show", "produce export", "kb show", "research source show"]) {
      const r = run([...cmd.split(" "), "--json"]);
      expect(r.rc, cmd).toBe(2);
      const j = JSON.parse(r.stdout.trim());
      expect(j, cmd).toHaveProperty("error");
      expect(String(j.error), cmd).toMatch(/^usage: /);
      expect(r.stderr, cmd).not.toMatch(/Unsupported type for binding/);
    }
  });
});
