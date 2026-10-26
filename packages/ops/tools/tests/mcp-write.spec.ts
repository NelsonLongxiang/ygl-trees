/**
 * MCP 4-tool surface (0.115.0 consolidation: 11→4, domain×action router).
 * Tests: tools/list=4 / read routing / write idempotency / rc fidelity / unknown domain.
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
    env: { ...process.env, YGL_HOME: home, YGL_SESSION: "mcp4-spec" } as any,
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

describe("MCP 4-tool surface (0.115.0 domain×action router)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "ygl-mcp4-"));
    const boot = (args: string[]) =>
      new Promise<void>((res, rej) => {
        const r = spawn(process.execPath, [BIN, ...args, "--json"], { env: { ...process.env, YGL_HOME: home, YGL_SESSION: "mcp4-spec" } as any });
        r.on("close", (c) => (c === 0 ? res() : rej(new Error(`boot ${args.join(" ")} rc=${c}`))));
      });
    await boot(["db", "init"]);
    await boot(["project", "new", "p1"]);
  });
  afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("tools/list exposes exactly 4 tools", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const r = await c.send("tools/list");
    const names = r.result.tools.map((t: any) => t.name);
    expect(names).toEqual(["read", "write", "verify", "doctor"]);
    c.kill();
  }, 60_000);

  it("ygl_read agent brief works", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const r = await c.send("tools/call", { name: "read", arguments: { domain: "agent", action: "brief" } });
    expect(r.result.isError).toBeFalsy();
    c.kill();
  }, 60_000);

  it("ygl_write research query-add is idempotent", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const a1 = await c.send("tools/call", { name: "write", arguments: { domain: "research", action: "query-add", text: "MCP4 幂等测试" } });
    const a2 = await c.send("tools/call", { name: "write", arguments: { domain: "research", action: "query-add", text: "MCP4 幂等测试" } });
    expect(a1.result.isError).toBeFalsy();
    const j1 = JSON.parse(a1.result.content[0].text);
    const j2 = JSON.parse(a2.result.content[0].text);
    expect(j2.id).toBe(j1.id);
    expect(j2.duplicate).toBe(true);
    c.kill();
  }, 60_000);

  it("ygl_write source-add keeps title (--title flag)", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const r = await c.send("tools/call", { name: "write", arguments: { domain: "research", action: "source-add", text: "标题保留测试", b: "https://example.com/s" } });
    expect(r.result.isError).toBeFalsy();
    const j = JSON.parse(r.result.content[0].text);
    expect(j.title).toBe("标题保留测试");
    c.kill();
  }, 60_000);

  it("#83 ygl_write source-add batch_file → --batch argv, all-or-nothing semantics", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const f = join(tmpdir(), `ygl-mcp-batch-${Date.now()}.jsonl`);
    require("node:fs").writeFileSync(f, [
      JSON.stringify({ title: "mcp batch one", url: "https://example.com/mb1" }),
      JSON.stringify({ title: "mcp batch dup", url: "https://example.com/mb1" }),
    ].join("\n"), "utf8");
    const r = await c.send("tools/call", { name: "write", arguments: { domain: "research", action: "source-add", batch_file: f, project: "p1" } });
    expect(r.result.isError).toBeFalsy();
    const j = JSON.parse(r.result.content[0].text);
    expect(j).toMatchObject({ batch: "source.add", added: 1, duplicates: 1 });
    require("node:fs").rmSync(f, { force: true });
    c.kill();
  }, 60_000);

  it("rc fidelity: ygl_write runtime error → isError + {rc, error}", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const r = await c.send("tools/call", { name: "write", arguments: { domain: "research", action: "claim-resolve", text: "nosuchclaim00" } });
    expect(r.result.isError).toBe(true);
    const j = JSON.parse(r.result.content[0].text);
    expect(j.rc).toBe(1);
    expect(String(j.error)).toMatch(/claim not found/);
    c.kill();
  }, 60_000);

  it("unknown domain → isError with clear message", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const r = await c.send("tools/call", { name: "write", arguments: { domain: "nope", action: "foo" } });
    expect(r.result.isError).toBe(true);
    const j = JSON.parse(r.result.content[0].text);
    expect(String(j.error)).toMatch(/unknown domain/);
    c.kill();
  }, 60_000);

  it("ygl_doctor works", async () => {
    const c = mcpCall();
    await c.send("initialize");
    const r = await c.send("tools/call", { name: "doctor", arguments: {} });
    expect(r.result.isError).toBeFalsy();
    c.kill();
  }, 60_000);
});
