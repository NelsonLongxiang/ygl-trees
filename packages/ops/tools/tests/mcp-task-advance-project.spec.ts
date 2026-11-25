import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import * as http from "node:http";
import { serveMcpHttp } from "../src/mcp.js";

// #306: MCP task advance passes the explicit project through as -p, like add/cancel/reopen. Two projects in one
// workspace: naming the task's own project advances it, naming the other project is refused (isolation), and
// leaving it out still answers "ambiguous project" when nothing is selected. Old write tool and trees entry alike.

const ROOT = process.cwd();
let home = "";
let server: http.Server | null = null;
let port = 0;
let oldEnv: NodeJS.ProcessEnv | undefined;
let oldArgv = "";
const environment: Record<string, string> = {};

function boot(args: string[], session: string) {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const r = spawnSync(process.execPath, [join(ROOT, "dist/apps/cli/src/bin.js"), ...args], { env: { ...environment, YGL_SESSION: session }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`boot failed (${args.join(" ")}): ${r.stdout} ${r.stderr}`);
  return r.stdout;
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

async function call(name: string, args: Record<string, unknown>, session: string) {
  const r = await request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, session);
  expect(r.error, JSON.stringify(r)).toBeUndefined();
  return { isError: !!r.result.isError, body: JSON.parse(r.result.content[0].text) };
}

async function addTask(project: string, text: string): Promise<string> {
  const r = await call("write", { domain: "task", action: "add", text, project }, "s-fresh");
  expect(r.isError, JSON.stringify(r.body)).toBe(false);
  return String((r.body as any).id);
}

async function statusOf(project: string, id: string, session: string): Promise<string> {
  const r = await call("read", { domain: "task", action: "list", project }, session);
  expect(r.isError, JSON.stringify(r.body)).toBe(false);
  return String((r.body as any[]).find((t) => t.id === id)?.status);
}

describe("#306 MCP task advance passes project through", () => {
  beforeAll(async () => {
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    home = mkdtempSync(join(ROOT, "tmp/mcp-306-"));
    oldEnv = process.env; oldArgv = process.argv[1]; process.argv[1] = join(ROOT, "dist/apps/cli/src/bin.js");
    environment.YGL_HOME = home; environment.YGL_DB_URL = ""; environment.YGL_NO_UPDATE_CHECK = "1";
    process.env = environment as any;
    boot(["db", "init"], "s-setup");
    boot(["project", "new", "alpha"], "s-setup");
    boot(["project", "new", "beta"], "s-setup");
    boot(["project", "use", "beta"], "s-B");
    server = serveMcpHttp("0.128.0", 0);
    await once(server, "listening");
    port = (server.address() as any).port;
  }, 120000);
  afterAll(async () => {
    if (server) { await new Promise<void>((r) => { server!.close(() => r()); (server as any).closeAllConnections(); }); }
    if (oldEnv) process.env = oldEnv;
    if (oldArgv) process.argv[1] = oldArgv;
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("advances with the task's own project from a session with no selection", async () => {
    const id = await addTask("alpha", "306 own project");
    const r = await call("write", { domain: "task", action: "advance", id, to: "doing", project: "alpha" }, "s-fresh");
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(r.body).toMatchObject({ id, from: "todo", to: "doing" });
    expect(await statusOf("alpha", id, "s-fresh")).toBe("doing");
  });

  it("without project and without a selection it is still ambiguous (rc2), and nothing changes", async () => {
    const id = await addTask("alpha", "306 no project");
    const r = await call("write", { domain: "task", action: "advance", id, to: "doing" }, "s-fresh");
    expect(r.isError).toBe(true);
    expect((r.body as any).rc).toBe(2);
    expect(String((r.body as any).error)).toContain("ambiguous project");
    expect(await statusOf("alpha", id, "s-fresh")).toBe("todo");
  });

  it("isolation: naming the other project refuses the task (rc1) and leaves it unchanged", async () => {
    const id = await addTask("alpha", "306 isolation");
    for (const session of ["s-fresh", "s-B"]) {
      const r = await call("write", { domain: "task", action: "advance", id, to: "doing", project: "beta" }, session);
      expect(r.isError, session).toBe(true);
      expect((r.body as any).rc, session).toBe(1);
      expect(String((r.body as any).error), session).toContain("not found");
    }
    expect(await statusOf("alpha", id, "s-fresh")).toBe("todo");
  });

  it("explicit project beats the session selection, and the selection is left as it was", async () => {
    const id = await addTask("alpha", "306 over selection");
    const r = await call("write", { domain: "task", action: "advance", id, to: "doing", project: "alpha" }, "s-B");
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(r.body).toMatchObject({ id, to: "doing" });
    const sel = await call("read", { domain: "project", action: "show" }, "s-B");
    expect(String((sel.body as any).project?.name)).toBe("beta");
  });

  it("the trees entry passes project through the same way", async () => {
    const id = await addTask("alpha", "306 trees");
    const r = await call("trees", { domain: "task", action: "advance", params: { id, to: "doing", project: "alpha" } }, "s-fresh");
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(r.body).toMatchObject({ id, to: "doing" });
    const wrong = await call("trees", { domain: "task", action: "advance", params: { id, to: "done", project: "beta" } }, "s-fresh");
    expect(wrong.isError).toBe(true);
    expect((wrong.body as any).rc).toBe(1);
    expect(await statusOf("alpha", id, "s-fresh")).toBe("doing");
  });
});
