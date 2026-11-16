import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { DB } from "../../../core/database/src/db";
import { InvocationOwner } from "../../../core/database/src/invocation";
import { createDashboardServer } from "../src/webui";
import { createWorkspaceOrm } from "../../../../apps/cli/src/workspace-orm";
import { AsyncResearchStore } from "../../../research/pipeline/src/async-store";
import { Store } from "../../../research/pipeline/src/reads";

const cleanups: Array<() => Promise<void> | void> = [];
const trace = (phase: string) => { console.error("dashboard-owner-phase", phase); };
async function phase<T>(name: string, work: Promise<T>): Promise<T> {
  trace(name); let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("dashboard fixture phase did not settle: " + name)), 3000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
afterEach(async () => { try { for (const close of cleanups.splice(0).reverse()) await close(); } finally { vi.unstubAllEnvs(); } });
async function fixture() {
  fs.mkdirSync(path.join(process.cwd(), "tmp"), { recursive: true }); const root = fs.mkdtempSync(path.join(process.cwd(), "tmp/dashboard-owner-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  vi.stubEnv("YGL_PROJECT", "owner-project");
  const file = path.join(root, "workspace.db"), db = new DB(file, { managed: true }), owner = new InvocationOwner(), orm = createWorkspaceOrm({ dialect: "sqlite", file });
  owner.own({ name: "orm", close: () => orm.close() }); owner.own({ name: "db", phase: "database", close: () => db.closeStrict() });
  cleanups.push(() => owner.close());
  const env: any = { home: root, ctx: { json: true, quiet: true, color: false }, db, store: new Store(db), asyncStore: new AsyncResearchStore(db), orm, invocation: owner };
  db.run("INSERT INTO projects(id,name,created,updated) VALUES(?,?,?,?)", ["owner-project", "owner-project", "2026-01-01", "2026-01-01"]);
  trace("creating-server");
  const server = createDashboardServer(env);
  server.on("request", () => trace("request-received"));
  cleanups.push(() => new Promise<void>(resolve => { (server as any).closeLive?.(); server.close(() => resolve()); }));
  await phase("list-ready", (server as any).verifyListReady);
  await phase("listening", new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }));
  const address = server.address() as any; return { owner, orm, db, env, server, url: "http://127.0.0.1:" + address.port };
}
describe("dashboard quiescent ownership", () => {
  it("waits for a real accepted HTTP read's last DB use before closing ORM and DB", async () => {
    const f = await fixture(), started = gate(), release = gate();
    const original = f.env.asyncStore.projectByName.bind(f.env.asyncStore);
    let first = true;
    f.env.asyncStore.projectByName = async (name: string) => { if (first) { first = false; started.resolve(); await release.promise; } return original(name); };
    const abort = new AbortController();
    const request = fetch(f.url + "/api/data", { signal: abort.signal }).then(async response => ({ status: response.status, body: await response.json() }));
    void request.catch(() => {});
    try {
      await phase("selected-project-read", Promise.race([started.promise, request.then(() => { throw new Error("HTTP request never reached its selected-project read barrier"); })])); let closed = false; const close = f.owner.close().then(() => { closed = true; });
      await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false); expect(f.db.get("SELECT 1 n")).toEqual({ n: 1 });
      release.resolve(); const result = await phase("response-settled", request); expect(result.status).toBe(200); expect(result.body).toHaveProperty("brief");
      await close; expect(closed).toBe(true); expect(() => f.db.get("SELECT 1")).toThrow(); expect(f.server.listening).toBe(false);
    } finally { release.resolve(); abort.abort(); await request.catch(() => {}); }
  });
  it("drops SSE sockets and finishes its initialization before releasing the DB", async () => {
    const f = await fixture();
    let response!: http.IncomingMessage;
    const ready = new Promise<void>((resolve, reject) => {
      const req = http.get(f.url + "/api/events", res => { response = res; res.once("data", () => resolve()); }); req.once("error", reject);
    });
    await phase("sse-first-frame", ready); const ended = new Promise<void>(resolve => { response.on("end", resolve); response.on("close", resolve); response.resume(); });
    await f.owner.close(); await phase("sse-ended", ended); expect(f.server.listening).toBe(false); expect(() => f.db.get("SELECT 1")).toThrow();
  });
});
