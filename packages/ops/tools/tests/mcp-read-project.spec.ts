import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import * as http from "node:http";
import { serveMcpHttp } from "../src/mcp.js";

// #260: read 路由的显式 project 透传。会话已选项目不得劫持显式指定；未知项目 rc1；
// 无副作用；READ_ROUTES 全表扫——新加的项目域读路由若漏透传，本文件变红。

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
    env: { ...environment, YGL_SESSION: session },
    encoding: "utf8",
  });
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

async function callRead(args: Record<string, unknown>, session?: string) {
  const r = await request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: args } }, session);
  expect(r.error, JSON.stringify(r)).toBeUndefined();
  return { isError: !!r.result.isError, body: JSON.parse(r.result.content[0].text) };
}

/** READ_ROUTES 全表（域/动作枚举直接取 tools/list，避免私有导出） */
async function readRouteTable(): Promise<{ domain: string; actions: string[] }[]> {
  const r = await request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const read = r.result.tools.find((t: any) => t.name === "read");
  const domains: string[] = read.inputSchema.properties.domain.enum;
  const actions: string[] = read.inputSchema.properties.action.enum;
  return domains.map((domain) => ({ domain, actions: actions.filter((a) => a !== "list" && a !== "show" && a !== "stats" && a !== "timeline" && a !== "search" && a !== "match" && a !== "log" && a !== "state" && a !== "can" && a !== "ready") }));
}

describe("#260 read routes pass explicit project through", () => {
  beforeAll(async () => {
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    home = mkdtempSync(join(ROOT, "tmp/mcp-260-"));
    oldEnv = process.env; oldArgv = process.argv[1]; process.argv[1] = join(ROOT, "dist/apps/cli/src/bin.js");
    environment.YGL_HOME = home; environment.YGL_DB_URL = ""; environment.YGL_NO_UPDATE_CHECK = "1";
    process.env = environment as any;
    boot(["db", "init"], "s-setup");
    boot(["project", "new", "alpha"], "s-setup");
    boot(["project", "new", "beta"], "s-setup");
    boot(["project", "use", "beta"], "s-B"); // s-B 的会话选择 = beta
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

  it("explicit project beats the session selection (brief shows alpha, not beta)", async () => {
    const r = await callRead({ domain: "agent", action: "brief", project: "alpha" }, "s-B");
    expect(r.isError).toBe(false);
    expect((r.body as any).current_project).toBe("alpha");
    expect((r.body as any).selection_source).toBe("flag");
    expect((r.body as any).project?.name).toBe("alpha");
  });

  it("project/show honours project and name from a session whose selection is beta", async () => {
    const byProject = await callRead({ domain: "project", action: "show", project: "alpha" }, "s-B");
    expect(byProject.isError).toBe(false);
    expect(String((byProject.body as any).project?.name)).toBe("alpha");
    const byName = await callRead({ domain: "project", action: "show", name: "alpha" }, "s-B");
    expect(byName.isError).toBe(false);
    expect(String((byName.body as any).project?.name)).toBe("alpha");
  });

  it("project and name both given and differing is rc2 before any I/O", async () => {
    const r = await callRead({ domain: "project", action: "show", project: "alpha", name: "beta" }, "s-B");
    expect(r.isError).toBe(true);
    expect((r.body as any).rc).toBe(2);
    expect(String((r.body as any).error)).toContain("differ");
  });

  it("unknown project is rc1 project not found, with and without a selection", async () => {
    for (const session of ["s-B", "s-fresh"]) {
      const r = await callRead({ domain: "agent", action: "brief", project: "nope" }, session);
      expect(r.isError).toBe(true);
      expect((r.body as any).rc).toBe(1);
      expect(String((r.body as any).error)).toContain("project not found");
    }
  });

  it("no side effect: explicit-project reads never change the session selection", async () => {
    await callRead({ domain: "agent", action: "brief", project: "alpha" }, "s-B");
    const after = await callRead({ domain: "project", action: "show" }, "s-B");
    expect(after.isError).toBe(false);
    expect(String((after.body as any).project?.name)).toBe("beta");
    expect(String((after.body as any).selection_source)).toBe("session");
  });

  it("sweep: every read route with project given never returns ambiguous project", async () => {
    // 域→动作的完整枚举：与 READ_ROUTES 同步取自 tools/list 的 enum，并按域补齐
    // （tools/list 的 action enum 是全表并集，这里按域逐一定义与路由表一致的映射）
    const ROUTES: Record<string, string[]> = {
      agent: ["brief", "match", "log"],
      kb: ["search", "show"],
      research: ["query-list", "source-list", "source-search", "source-show", "evidence-list", "evidence-show", "claim-list", "claim-show", "claim-evaluate", "claim-calibration", "predict-list"],
      tree: ["state", "list", "show"],
      node: ["can", "ready", "path", "ancestors", "descendants", "validate"],
      task: ["list"],
      rel: ["list"],
      produce: ["report-show", "report-list"],
      project: ["list", "show"],
      db: ["stats", "timeline"],
      skill: ["list", "match", "show"],
    };
    // tools/list 的域枚举必须与本表完全一致——新加域/动作忘了这里也会红
    const listed = await request({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const readTool = listed.result.tools.find((t: any) => t.name === "read");
    expect(readTool.inputSchema.properties.domain.enum.sort()).toEqual(Object.keys(ROUTES).sort());
    const extra = readTool.inputSchema.properties.action.enum.filter((a: string) => !Object.values(ROUTES).some((v) => v.includes(a)));
    expect(extra, "actions in tools/list missing from sweep table: " + extra.join(",")).toEqual([]);

    const filler: Record<string, Record<string, unknown>> = {
      match: { query: "q" }, search: { query: "q" }, "source-search": { query: "q" },
      show: { id: "x1", name: "zz-none" }, "kb-show": { id: "x1" },
    };
    for (const [domain, actions] of Object.entries(ROUTES)) {
      for (const action of actions) {
        const args: Record<string, unknown> = { domain, action, project: "alpha", ...(filler[action] || (action.endsWith("-show") ? { id: "x1" } : {})) };
        const r = await callRead(args, "s-fresh"); // s-fresh 从未选过项目
        const text = JSON.stringify(r.body);
        expect(text, `${domain}/${action} leaked ambiguity: ${text}`).not.toContain("ambiguous project");
      }
    }
  }, 120000);
});
