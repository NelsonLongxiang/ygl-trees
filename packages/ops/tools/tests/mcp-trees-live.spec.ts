import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import * as http from "node:http";
import { serveMcpHttp } from "../src/mcp";

const ROOT = process.cwd(), BIN = join(ROOT, "dist/bundle/bin.cjs");
let home = "", server: http.Server | undefined, port = 0;
let savedEnv: NodeJS.ProcessEnv, savedBin: string;
function request(method: string, params: unknown = {}, session?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", agent: false,
      headers: { "content-type": "application/json", ...(session ? { "x-ygl-session": session } : {}) } }, res => {
      let body = ""; res.on("data", b => body += b); res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.setTimeout(15000, () => req.destroy(Error("trees request timeout")));
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  });
}
async function call(name: string, args: unknown, session?: string) {
  const r = await request("tools/call", { name, arguments: args }, session);
  expect(r.error, JSON.stringify(r)).toBeUndefined();
  return { error: !!r.result.isError, body: JSON.parse(r.result.content[0].text) };
}
async function good(args: unknown, session?: string) {
  const r = await call("trees", args, session); expect(r.error, JSON.stringify(r.body)).toBe(false); return r.body;
}

describe("trees published CLI over HTTP with legacy parity", () => {
  beforeAll(async () => {
    mkdirSync(join(ROOT, "tmp"), { recursive: true }); home = mkdtempSync(join(ROOT, "tmp/trees-live-"));
    savedEnv = process.env; savedBin = process.argv[1];
    process.env = { ...savedEnv, YGL_HOME: home, YGL_DB_URL: "", YGL_SESSION: "trees-startup", YGL_EVAL_OFFLINE: "1", YGL_NO_UPDATE_CHECK: "1" };
    process.argv[1] = BIN;
    for (const args of [["db", "init"], ["project", "new", "alpha"]]) {
      const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { env: process.env, encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    }
    server = serveMcpHttp("test", 0); await once(server, "listening"); port = (server.address() as any).port;
  });
  afterAll(async () => {
    if (server) await new Promise<void>(r => { server!.close(() => r()); server!.closeAllConnections(); });
    process.env = savedEnv; process.argv[1] = savedBin;
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  it("serves help and schema discovery over the actual transport", async () => {
    const list = await request("tools/list"); expect(list.result.tools[0]._meta["ygl-trees/dispatch"].contract).toBe("ygl-trees/1");
    expect((await good({ action: "help" })).domains).toContain("project");
    const detail = await good({ domain: "verify", action: "help", params: { action: "run" } });
    expect(detail.access).toBe("write"); expect(detail.params_schema.required).toEqual(["a"]);
  });
  it("roundtrips writes, duplicate acknowledgements and reads without wrapping CLI JSON", async () => {
    const args = { domain: "kb", action: "add", params: { name: "trees-live-note", body: "hello", scope: "" } };
    const note = await good(args); expect(note).toMatchObject({ title: "trees-live-note", body: "hello", verified: true });
    expect(await good(args)).toMatchObject({ duplicate: true, id: note.id });
    const modern = await call("trees", { domain: "kb", action: "show", params: { id: note.id } });
    const legacy = await call("read", { domain: "kb", action: "show", id: note.id }); expect(modern).toEqual(legacy);
  });
  it("retains caller-session isolation through the common executor", async () => {
    await good({ domain: "project", action: "new", params: { name: "beta" } }, "trees-beta");
    await good({ domain: "project", action: "use", params: { name: "alpha" } }, "trees-alpha");
    const [a, b, fallback] = await Promise.all([
      good({ domain: "project", action: "show" }, "trees-alpha"), good({ domain: "project", action: "show" }, "trees-beta"),
      good({ domain: "project", action: "show" }),
    ]);
    expect(a.project.name).toBe("alpha"); expect(b.project.name).toBe("beta"); expect(fallback.project.name).toBe("alpha");
  });
  it("preserves verify and doctor results and CLI rc failures", async () => {
    expect(await call("trees", { domain: "verify", action: "example" })).toEqual(await call("verify", { action: "example" }));
    expect(await call("trees", { domain: "doctor", action: "check" })).toEqual(await call("doctor", { fix: false }));
    const modern = await call("trees", { domain: "project", action: "show", params: { project: "missing-project" } });
    const legacy = await call("read", { domain: "project", action: "show", project: "missing-project" });
    expect(modern).toEqual(legacy); expect(modern).toMatchObject({ error: true, body: { rc: 1 } });
  });
  it("fails unknown/admin routing and check-to-fix parameter escalation before CLI", async () => {
    for (const args of [{ domain: "db", action: "sql", params: { query: "select 1" } }, { domain: "doctor", action: "check", params: { fix: true } }]) {
      expect(await call("trees", args)).toMatchObject({ error: true, body: { rc: 2 } });
    }
  });
});
