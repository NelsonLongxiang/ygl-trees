/**
 * MCP HTTP transport (0.114.31): StreamableHTTP stateless — taste-mcp 市场先例契约.
 * - POST /mcp → JSON-RPC 2.0 (initialize / tools/list / tools/call / ping)
 * - GET /mcp → 405 (stateless, no SSE)
 * - --token → Bearer auth OR X-Market-Client passthrough
 * - X-YGL-Session header → per-request session override
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const BIN = join(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let home = "";
let server: ReturnType<typeof spawn> | null = null;
let port = 0;

function post(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((res) => {
    const data = JSON.stringify(body);
    const http = require("node:http") as typeof import("node:http");
    const r = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } },
      (resp: any) => {
        let out = "";
        resp.on("data", (d: Buffer) => (out += d));
        resp.on("end", () => {
          try { res({ status: resp.statusCode, body: JSON.parse(out) }); }
          catch { res({ status: resp.statusCode, body: out }); }
        });
      },
    );
    r.write(data);
    r.end();
  });
}

function get(): Promise<{ status: number; body: any }> {
  return new Promise((res) => {
    const http = require("node:http") as typeof import("node:http");
    http.get({ host: "127.0.0.1", port, path: "/mcp" }, (resp: any) => {
      let out = "";
      resp.on("data", (d: Buffer) => (out += d));
      resp.on("end", () => res({ status: resp.statusCode, body: out }));
    });
  });
}

describe.skipIf(!HAS_BIN)("MCP HTTP transport (StreamableHTTP stateless, taste-mcp contract)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "ygl-mcp-http-"));
    const boot = (args: string[]) =>
      new Promise<void>((res, rej) => {
        const r = spawn(process.execPath, [BIN, ...args, "--json"], { env: { ...process.env, YGL_HOME: home, YGL_SESSION: "mcp-http-spec" } as any });
        r.on("close", (c) => (c === 0 ? res() : rej(new Error(`boot ${args.join(" ")} rc=${c}`))));
      });
    await boot(["db", "init"]);
    await boot(["project", "new", "p1"]);

    // find free port
    const net = require("node:net") as typeof import("node:net");
    await new Promise<void>((res) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        port = (s.address() as any).port;
        s.close(() => res());
      });
    });

    server = spawn(process.execPath, [BIN, "mcp", "--http", "--port", String(port)], {
      env: { ...process.env, YGL_HOME: home, YGL_SESSION: "mcp-http-spec" } as any,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((res, rej) => {
      const on = (d: Buffer) => { if (d.toString().includes("HTTP server ready")) res(); };
      (server as any).stdout.on("data", on);
      (server as any).stderr.on("data", on);
      setTimeout(() => rej(new Error("server start timeout")), 10_000);
    });
  }, 30_000);

  afterAll(async () => {
    server?.kill();
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 5; i++) {
      try { rmSync(home, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  });

  it("POST initialize → serverInfo with version", async () => {
    const r = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(r.status).toBe(200);
    expect(r.body.result.serverInfo.name).toBe("ygl-trees");
    expect(r.body.result.serverInfo.version).toBeTruthy();
  }, 15_000);

  it("POST tools/list → 4 tools (0.115.0 domain×action consolidation)", async () => {
    const r = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(r.status).toBe(200);
    const names = r.body.result.tools.map((t: any) => t.name);
    expect(names).toEqual(["read", "write", "verify", "doctor"]);
  }, 15_000);

  it("GET /mcp → 405 (stateless contract, taste-mcp precedent)", async () => {
    const r = await get();
    expect(r.status).toBe(405);
  }, 15_000);

  it("POST tools/call → ygl_read agent brief works end-to-end", async () => {
    const r = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read", arguments: { domain: "agent", action: "brief" } } });
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBeFalsy();
  }, 30_000);

  it("X-YGL-Session header → per-request session override", async () => {
    const r = await post(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read", arguments: { domain: "agent", action: "brief" } } },
      { "x-ygl-session": "http-session-test" },
    );
    expect(r.status).toBe(200);
  }, 30_000);
});
