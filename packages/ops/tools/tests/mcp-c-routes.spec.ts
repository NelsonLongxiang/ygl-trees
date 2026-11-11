import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import * as http from "node:http";
import { serveMcpHttp } from "../src/mcp.js";

// #257: MCP C 类路由缺口。每个新动作必须：①tools/list enum 列出；②与 CLI 同形（rc/JSON）；
// ③写面重复执行 duplicate:true rc=0。source fetch 默认拒绝，开关放行。

const ROOT = process.cwd();
let home = "";
let server: http.Server | null = null;
let port = 0;
let oldEnv: NodeJS.ProcessEnv | undefined;
let oldArgv = "";
const environment: Record<string, string> = {};

function boot(args: string[], session: string) {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const r = spawnSync(process.execPath, [join(ROOT, "dist/apps/cli/src/bin.js"), ...args], {
    env: { ...environment, YGL_SESSION: session }, encoding: "utf8",
  });
  return { rc: r.status, out: String(r.stdout ?? "") };
}

function request(body: unknown, session?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", ...(session ? { "x-ygl-session": session } : {}) } },
      (res) => { let out = ""; res.on("data", (d) => (out += d)); res.on("end", () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } }); },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    req.end(JSON.stringify(body));
  });
}

async function callTool(name: string, args: Record<string, unknown>, session = "s-257") {
  const r = await request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, session);
  expect(r.error, JSON.stringify(r)).toBeUndefined();
  return { isError: !!r.result.isError, body: JSON.parse(r.result.content[0].text) };
}

async function toolSchema(name: string) {
  const r = await request({ jsonrpc: "2.0", id: 9, method: "tools/list" });
  return r.result.tools.find((t: any) => t.name === name);
}

describe("#257 MCP C-class routes", () => {
  beforeAll(async () => {
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    home = mkdtempSync(join(ROOT, "tmp/mcp-257-"));
    oldEnv = process.env; oldArgv = process.argv[1]; process.argv[1] = join(ROOT, "dist/apps/cli/src/bin.js");
    environment.YGL_HOME = home; environment.YGL_DB_URL = ""; environment.YGL_NO_UPDATE_CHECK = "1";
    process.env = environment as any;
    boot(["db", "init"], "s-setup");
    boot(["project", "new", "main"], "s-setup");
    boot(["tree", "new", "tech", "-p", "main"], "s-setup");
    boot(["node", "add", "root", "-t", "tech", "-p", "main"], "s-setup");
    boot(["node", "add", "child", "-t", "tech", "--name", "子节点", "-p", "main"], "s-setup");
    boot(["node", "link", "root", "child", "-t", "tech", "-p", "main"], "s-setup");
    boot(["node", "index", "-t", "tech", "-p", "main"], "s-setup");
    server = serveMcpHttp("0.122.0", 0);
    await once(server, "listening");
    port = (server.address() as any).port;
  }, 120000);
  afterAll(async () => {
    if (server) { await new Promise<void>((r) => { server!.close(() => r()); (server as any).closeAllConnections(); }); }
    if (oldEnv) process.env = oldEnv;
    if (oldArgv) process.argv[1] = oldArgv;
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("tools/list enums list every new action", async () => {
    const read = await toolSchema("read");
    const write = await toolSchema("write");
    const verify = await toolSchema("verify");
    for (const a of ["path", "ancestors", "descendants", "validate"]) expect(read.inputSchema.properties.action.enum, a).toContain(a);
    for (const a of ["outline", "section", "spec", "design", "export", "promote", "ingest", "node-lock", "source-fetch"]) expect(write.inputSchema.properties.action.enum, a).toContain(a);
    for (const a of ["trace", "lint-candidates", "example", "tree-prepare", "tree-run", "tree-report", "tree-trace"]) expect(verify.inputSchema.properties.action.enum, a).toContain(a);
  });

  it("node path/ancestors/descendants/validate return the same shape as the CLI", async () => {
    const viaMcp = await callTool("read", { domain: "node", action: "path", key: "child", tree: "tech" });
    expect(viaMcp.isError).toBe(false);
    const viaCli = boot(["node", "path", "child", "-t", "tech", "--json"], "s-257");
    expect(viaCli.rc).toBe(0);
    expect(JSON.stringify(viaMcp.body)).toBe(JSON.stringify(JSON.parse(viaCli.out)));
    for (const action of ["ancestors", "descendants", "validate"]) {
      const r = await callTool("read", { domain: "node", action, key: action === "validate" ? undefined : "child", tree: "tech" });
      expect(r.isError).toBe(false);
    }
  });

  it("produce section/spec/design repeat creates a new version (rc0); kb promote is duplicate-idempotent", async () => {
    // section/spec/design：CLI 语义＝同名重复执行产生新版本（#240 报告取最高版），rc0 即幂等安全
    for (const action of ["section", "spec", "design"]) {
      const first = await callTool("write", { domain: "produce", action, title: "MCP-" + action, body: "正文 " + action });
      expect(first.isError).toBe(false);
      const again = await callTool("write", { domain: "produce", action, title: "MCP-" + action, body: "正文 " + action });
      expect(again.isError).toBe(false);
      expect((again.body as any).version).toBe(2);
    }
    // kb add 同内容重跑 duplicate:true rc0（写幂等契约的直接面）
    const n1 = await callTool("write", { domain: "kb", action: "add", name: "mcp-257-note", body: "笔记正文" });
    expect(n1.isError).toBe(false);
    const n2 = await callTool("write", { domain: "kb", action: "add", name: "mcp-257-note", body: "笔记正文" });
    expect(n2.isError).toBe(false);
    expect((n2.body as any).duplicate).toBeTruthy();
    // promote 走真实质量门：裸笔记被拒（rc1 点名 cue/lesson/evidence），不被占位符绕过
    const p1 = await callTool("write", { domain: "kb", action: "promote", id: (n1.body as any).id });
    expect(p1.isError).toBe(true);
    expect((p1.body as any).rc).toBe(1);
    expect(JSON.stringify(p1.body)).toContain("cue");
  });

  it("node-lock flips state and repeats as duplicate-style rc0", async () => {
    const u = await callTool("write", { domain: "tree", action: "node-unlock", key: "child", tree: "tech" });
    expect(u.isError).toBe(false);
    const l1 = await callTool("write", { domain: "tree", action: "node-lock", key: "child", tree: "tech" });
    expect(l1.isError).toBe(false);
    const l2 = await callTool("write", { domain: "tree", action: "node-lock", key: "child", tree: "tech" });
    expect(l2.isError).toBe(false);
    expect((l2.body as any).status).toBe("locked");
  });

  it("verify lint-candidates runs DB-free with the same rc as the CLI", async () => {
    const f = join(home, "cand.json");
    writeFileSync(f, JSON.stringify({ candidates: [{ type: "sql", use: "count", text: "select count(*) from sources" }] }));
    const viaMcp = await callTool("verify", { action: "lint-candidates", a: f, text: "材料文本" });
    const viaCli = boot(["verify", "lint-candidates", f, "--text", "材料文本", "--json"], "s-257");
    expect(viaCli.rc).toBe(viaMcp.isError ? 1 : 0);
  });

  it("source fetch is refused by default and admitted behind the switch", async () => {
    const r = await callTool("write", { domain: "research", action: "source-fetch", url: "http://127.0.0.1:1/x" });
    expect(r.isError).toBe(true);
    expect((r.body as any).rc).toBe(2);
    expect(String((r.body as any).error)).toContain("YGL_MCP_SOURCE_FETCH");
    // 开关放行（网络目标不可达也走 CLI 的 rc1，不是 MCP 拒绝）
    process.env.YGL_MCP_SOURCE_FETCH = "1";
    try {
      const r2 = await callTool("write", { domain: "research", action: "source-fetch", url: "http://127.0.0.1:1/x" });
      expect((r2.body as any).rc ?? 0).not.toBe(2);
    } finally { delete process.env.YGL_MCP_SOURCE_FETCH; }
  });

  it("outline and verify example work end-to-end", async () => {
    const o = await callTool("write", { domain: "produce", action: "outline" });
    expect(o.isError).toBe(false);
    const ex = await callTool("verify", { action: "example", checker: "sql" });
    expect(ex.isError).toBe(false);
  });
});
