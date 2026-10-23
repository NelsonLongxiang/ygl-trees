/**
 * MCP 写面扩展（0.114.26 方案 D，属主裁定「MCP 也是要的」）：
 *  - tools/list 恰 11 个（8 读面 + research_write/tree_write/verify）
 *  - research_write 幂等（同内容重跑同 id duplicate）
 *  - rc 保真：CLI rc≠0 → MCP isError:true + 机器可读 {rc, error} 载荷
 *  - 未知 action → isError（schema 外兜底）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");

let home = "";

interface Resp { id: number; result?: any; error?: any }

function mcpCall(): { send: (method: string, params?: unknown) => Promise<Resp>; kill: () => void } {
  const child = spawn(process.execPath, [BIN, "mcp"], {
    cwd: REPO,
    env: { ...process.env, YGL_HOME: home, YGL_SESSION: "mcp-write-spec" } as any,
  });
  const pending = new Map<number, (r: Resp) => void>();
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (l) => {
    try {
      const m = JSON.parse(l);
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
    } catch { /* noise */ }
  });
  let nextId = 1;
  return {
    send: (method, params = {}) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, res);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout: ${method}`)); } }, 30_000);
      }),
    kill: () => child.kill(),
  };
}

describe("MCP write faces + rc fidelity (0.114.26)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "ygl-mcp-write-"));
    const boot = (args: string[]) =>
      new Promise<void>((res, rej) => {
        const r = spawn(process.execPath, [BIN, ...args, "--json"], { env: { ...process.env, YGL_HOME: home, YGL_SESSION: "mcp-write-spec" } as any });
        r.on("close", (c) => (c === 0 ? res() : rej(new Error(`boot ${args.join(" ")} rc=${c}`))));
      });
    await boot(["db", "init"]);
    await boot(["project", "new", "p1"]); // 研究写面严格闸：无 selection 时拒写
  });
  afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("tools/list exposes exactly 11 tools incl. the three write faces", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const r = await c.send("tools/list");
    const names = r.result.tools.map((t: any) => t.name);
    expect(names).toHaveLength(11);
    for (const w of ["research_write", "tree_write", "verify"]) expect(names).toContain(w);
    c.kill();
  }, 60_000);

  it("research_write is idempotent (same content → same id, duplicate:true)", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const a1 = await c.send("tools/call", { name: "research_write", arguments: { action: "query-add", text: "MCP 写面幂等测试" } });
    const a2 = await c.send("tools/call", { name: "research_write", arguments: { action: "query-add", text: "MCP 写面幂等测试" } });
    expect(a1.result.isError).toBeFalsy();
    const j1 = JSON.parse(a1.result.content[0].text);
    const j2 = JSON.parse(a2.result.content[0].text);
    expect(j2.id).toBe(j1.id);
    expect(j2.duplicate).toBe(true);
    c.kill();
  }, 60_000);

  it("rc fidelity: runtime error (rc=1) → isError:true + machine-readable {rc, error}", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const r = await c.send("tools/call", {
      name: "research_write",
      arguments: { action: "claim-resolve", text: "nosuchclaim00" },
    });
    expect(r.result.isError).toBe(true);
    const j = JSON.parse(r.result.content[0].text);
    expect(j.rc).toBe(1);
    expect(String(j.error)).toMatch(/claim not found/);
    c.kill();
  }, 60_000);

  it("unknown action (schema bypass) → isError with usage-style message", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const r = await c.send("tools/call", {
      name: "tree_write",
      arguments: { action: "node-flatten" },
    });
    expect(r.result.isError).toBe(true);
    const j = JSON.parse(r.result.content[0].text);
    expect(String(j.error)).toMatch(/unknown action/);
    c.kill();
  }, 60_000);
});
