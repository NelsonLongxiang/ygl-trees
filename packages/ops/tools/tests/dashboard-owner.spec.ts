import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as net from "node:net";
import { DB } from "../../../core/database/src/db";
import { InvocationOwner } from "../../../core/database/src/invocation";
import { createDashboardServer } from "../src/webui";
import { createWorkspaceOrm } from "../../../../apps/cli/src/workspace-orm";
import { AsyncResearchStore } from "../../../research/pipeline/src/async-store";
import { Store } from "../../../research/pipeline/src/reads";

const cleanups: Array<() => Promise<void> | void> = [];
const trace = (phase: string) => { console.error("dashboard-owner-phase", phase); };
async function phase<T>(name: string, work: Promise<T>): Promise<T> {
  const started = performance.now(), budget = 20000;
  trace(name); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("dashboard fixture phase did not settle: " + name)), budget); })]);
    trace(name + " done " + Math.round(performance.now() - started) + "ms");
    return value;
  } catch (error) {
    trace(name + " failed " + Math.round(performance.now() - started) + "ms");
    throw error;
  } finally { if (timer) clearTimeout(timer); }
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
afterEach(async () => { try { for (const close of cleanups.splice(0).reverse()) await close(); } finally { vi.unstubAllEnvs(); vi.restoreAllMocks(); } });
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
const legacyVersions = ["18.0-api-absent", "18.2-parser-idle", "18.20-response-aware"] as const;
async function legacyFixture(version: typeof legacyVersions[number]) {
  const entered = gate(), realClose = http.Server.prototype.close;
  const nativeClose = vi.spyOn(http.Server.prototype, "close").mockImplementation(function (this: http.Server, callback?: (error?: Error) => void) {
    const result = net.Server.prototype.close.call(this, callback); entered.resolve(); return result;
  });
  const f = await fixture(), idleDescriptor = Object.getOwnPropertyDescriptor(f.server, "closeIdleConnections");
  const sockets = new Map<net.Socket, { request?: http.IncomingMessage; response?: http.ServerResponse }>();
  f.server.on("connection", (socket: net.Socket) => { sockets.set(socket, {}); socket.once("close", () => sockets.delete(socket)); });
  f.server.on("request", (request: http.IncomingMessage, response: http.ServerResponse) => { sockets.set(request.socket, { request, response }); });
  // Model the versioned idle classifiers independently of the current Node implementation.
  Object.defineProperty(f.server, "closeIdleConnections", { configurable: true, value: version === "18.0-api-absent" ? undefined : () => {
    for (const [socket, state] of sockets) if ((!state.request || state.request.complete) && (version === "18.2-parser-idle" || !state.response || state.response.writableFinished)) socket.destroy();
  } });
  f.server.keepAliveTimeout = 60_000;
  return { ...f, entered, sockets, restore: async () => {
    try {
      if (idleDescriptor) Object.defineProperty(f.server, "closeIdleConnections", idleDescriptor);
      else delete (f.server as any).closeIdleConnections;
      await new Promise<void>(resolve => realClose.call(f.server, () => resolve()));
    } finally { nativeClose.mockRestore(); }
  } };
}
describe("dashboard fixture phase budgets", () => {
  it.each(["list-ready", "response-settled"])("allows %s delayed past three seconds within its phase budget", async name => {
    const traceLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const work = new Promise<void>(resolve => { setTimeout(resolve, 3500); });
      let settled = false;
      const result = phase(name, work).then(
        () => { settled = true; return "done"; },
        error => { settled = true; return error; },
      );
      await vi.advanceTimersByTimeAsync(3001);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(499);
      expect(await result).toBe("done");
      expect(traceLog).toHaveBeenCalledWith("dashboard-owner-phase", name + " done 3500ms");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); traceLog.mockRestore(); }
  });

  it.each(["list-ready", "response-settled"])("bounds never-settling %s at twenty seconds with its phase name", async name => {
    const traceLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const work = new Promise<void>(() => {});
      let settled = false;
      const result = phase(name, work).then(
        () => { settled = true; return null; },
        error => { settled = true; return error; },
      );
      await vi.advanceTimersByTimeAsync(19999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("dashboard fixture phase did not settle: " + name);
      expect(traceLog).toHaveBeenCalledWith("dashboard-owner-phase", name + " failed 20000ms");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); traceLog.mockRestore(); }
  });
});

describe("dashboard quiescent ownership", () => {
  it.each(legacyVersions)("closes a pre-existing idle keep-alive socket without a timer (%s)", async version => {
    const f = await legacyFixture(version), agent = new http.Agent({ keepAlive: true });
    let closing: Promise<void> | undefined;
    try {
      const socket = new Promise<net.Socket>(resolve => f.server.once("connection", resolve));
      const idle = new Promise<void>(resolve => agent.once("free", () => resolve()));
      await phase("keepalive-response", new Promise<void>((resolve, reject) => {
        const request = http.get(f.url + "/api/data", { agent }, response => { response.resume(); response.once("end", resolve); response.once("error", reject); }); request.once("error", reject);
      }));
      await idle; const acceptedSocket = await socket; expect(acceptedSocket.destroyed).toBe(false);
      closing = f.owner.close(); await f.entered.promise; await new Promise<void>(resolve => setImmediate(resolve));
      expect(acceptedSocket.writableEnded || acceptedSocket.destroyed).toBe(true);
      await phase("idle-close", closing); expect(f.server.listening).toBe(false); expect(() => f.db.get("SELECT 1")).toThrow();
    } finally { agent.destroy(); try { await (closing ?? f.owner.close()); } finally { await f.restore(); } }
  });
  it.each(legacyVersions)("finishes an accepted response across shutdown, then closes its newly idle socket (%s)", async version => {
    const f = await legacyFixture(version), agent = new http.Agent({ keepAlive: true }), started = gate(), release = gate();
    const original = f.env.asyncStore.projectByName.bind(f.env.asyncStore); let first = true;
    f.env.asyncStore.projectByName = async (name: string) => { if (first) { first = false; started.resolve(); await release.promise; } return original(name); };
    let closing: Promise<void> | undefined;
    const received = new Promise<{ status: number; complete: boolean; body: any }>((resolve, reject) => {
      const request = http.get(f.url + "/api/data", { agent }, response => {
        let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; }); response.once("error", reject);
        response.once("end", () => { try { resolve({ status: response.statusCode!, complete: response.complete, body: JSON.parse(body) }); } catch (error) { reject(error); } });
      }); request.once("error", reject);
    }); void received.catch(() => {});
    try {
      await phase("accepted-response-barrier", Promise.race([started.promise, received.then(() => { throw new Error("request missed the read barrier"); })]));
      const [[socket, state]] = [...f.sockets]; expect(state.request?.complete).toBe(true); expect(state.response?.writableFinished).toBe(false);
      closing = f.owner.close(); void closing.catch(() => {}); await f.entered.promise; await new Promise<void>(resolve => setImmediate(resolve));
      expect(socket.destroyed).toBe(false); expect(socket.writableEnded).toBe(false); expect(f.db.get("SELECT 1 n")).toEqual({ n: 1 });
      release.resolve(); const response = await phase("complete-accepted-response", received);
      expect(response.status).toBe(200); expect(response.complete).toBe(true); expect(response.body).toHaveProperty("brief");
      await phase("response-to-idle-close", closing); expect(f.server.listening).toBe(false); expect(() => f.db.get("SELECT 1")).toThrow();
    } finally { release.resolve(); agent.destroy(); await received.catch(() => {}); try { await (closing ?? f.owner.close()); } finally { await f.restore(); } }
  });
  it("flushes both accepted pipelined responses before ending their shared connection", async () => {
    const f = await legacyFixture("18.0-api-absent"), entered = gate(), firstGate = gate(), secondGate = gate();
    const original = f.env.asyncStore.projectByName.bind(f.env.asyncStore); let reads = 0;
    f.env.asyncStore.projectByName = async (name: string) => {
      const call = ++reads; if (call === 2) entered.resolve();
      if (call === 1) await firstGate.promise;
      else if (call === 2) await secondGate.promise;
      return original(name);
    };
    const client = net.connect((f.server.address() as net.AddressInfo).port, "127.0.0.1");
    let output = "", closing: Promise<void> | undefined;
    client.setEncoding("utf8"); client.on("data", chunk => { output += chunk; });
    const closed = new Promise<void>(resolve => client.once("close", () => resolve()));
    const ended = new Promise<void>((resolve, reject) => {
      client.once("end", resolve); client.once("error", reject);
      client.once("close", () => { if (!client.readableEnded) reject(new Error("pipeline closed before complete EOF")); });
    }); void ended.catch(() => {});
    try {
      await new Promise<void>((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
      const request = "GET /api/data HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n";
      client.write(request + request); await phase("both-pipelined-reads", entered.promise);
      const socket = [...f.sockets.keys()][0]; expect(reads).toBe(2);
      closing = f.owner.close(); await f.entered.promise;
      firstGate.resolve();
      await phase("first-pipelined-response", new Promise<void>(resolve => {
        const inspect = () => { if (output.includes("HTTP/1.1 200") && output.includes('"brief"')) { client.removeListener("data", inspect); resolve(); } };
        client.on("data", inspect); inspect();
      }));
      expect(socket.writableEnded).toBe(false); expect(socket.destroyed).toBe(false); expect(f.db.get("SELECT 1 n")).toEqual({ n: 1 });
      secondGate.resolve(); await phase("both-pipelined-response-bodies", ended); await phase("pipelined-close", closing);
      const frames = output.split("HTTP/1.1 200 OK\r\n").slice(1); expect(frames).toHaveLength(2);
      for (const frame of frames) {
        const split = frame.indexOf("\r\n\r\n"), headers = frame.slice(0, split), body = frame.slice(split + 4);
        const length = /content-length: (\d+)/i.exec(headers);
        let payload: Buffer;
        if (length) { payload = Buffer.from(body); expect(payload.length).toBe(Number(length[1])); }
        else {
          expect(headers).toMatch(/transfer-encoding: chunked/i);
          const wire = Buffer.from(body), chunks: Buffer[] = []; let offset = 0;
          for (;;) {
            const end = wire.indexOf("\r\n", offset); expect(end).toBeGreaterThanOrEqual(offset);
            const size = Number.parseInt(wire.subarray(offset, end).toString("ascii"), 16); expect(Number.isSafeInteger(size)).toBe(true);
            offset = end + 2;
            if (size === 0) { expect(wire.subarray(offset).toString()).toBe("\r\n"); break; }
            expect(offset + size + 2).toBeLessThanOrEqual(wire.length);
            chunks.push(wire.subarray(offset, offset + size)); offset += size;
            expect(wire.subarray(offset, offset + 2).toString()).toBe("\r\n"); offset += 2;
          }
          payload = Buffer.concat(chunks);
        }
        expect(JSON.parse(payload.toString("utf8"))).toHaveProperty("brief");
      }
    } finally {
      firstGate.resolve(); secondGate.resolve(); client.destroy(); await closed; await ended.catch(() => {});
      try { await (closing ?? f.owner.close()); } finally { await f.restore(); }
    }
  });
  it.each([false, true])("releases a connection whose peer keeps its write side open (partial request=%s)", async partial => {
    const f = await legacyFixture("18.0-api-absent");
    const connected = new Promise<net.Socket>(resolve => f.server.once("connection", resolve));
    const client = net.connect({ port: (f.server.address() as net.AddressInfo).port, host: "127.0.0.1", allowHalfOpen: true });
    const closed = new Promise<void>(resolve => client.once("close", () => resolve()));
    client.on("error", () => {}); client.resume();
    let closing: Promise<void> | undefined;
    try {
      const socket = await phase("half-open-peer-connected", connected);
      if (partial) {
        const received = new Promise<void>(resolve => socket.once("data", () => resolve()));
        client.write("GET /api/data HTTP/1.1\r\nHost: localhost\r\nX-Partial:");
        await phase("partial-request-bytes", received);
      }
      expect(f.sockets.get(socket)?.request).toBeUndefined();
      closing = f.owner.close(); void closing.catch(() => {});
      await phase("half-open-peer-server-close", closing);
      expect(socket.destroyed).toBe(true); expect(client.writableEnded).toBe(false);
      expect(() => f.db.get("SELECT 1")).toThrow();
    } finally { client.destroy(); await closed; try { await (closing ?? f.owner.close()); } finally { await f.restore(); } }
  });
  it("keeps an aborted accepted request's last database use tracked until it settles", async () => {
    const f = await legacyFixture("18.0-api-absent"), entered = gate(), release = gate();
    const original = f.env.asyncStore.projectByName.bind(f.env.asyncStore); let first = true, used = false;
    f.env.asyncStore.projectByName = async (name: string) => {
      if (first) { first = false; entered.resolve(); await release.promise; }
      const result = await original(name); used = true; return result;
    };
    const accepted = new Promise<net.Socket>(resolve => f.server.once("connection", resolve));
    const client = net.connect((f.server.address() as net.AddressInfo).port, "127.0.0.1");
    const clientClosed = new Promise<void>(resolve => client.once("close", () => resolve())); client.on("error", () => {}); client.resume();
    let closing: Promise<void> | undefined;
    try {
      const socket = await accepted, serverClosed = new Promise<void>(resolve => socket.once("close", () => resolve()));
      client.write("GET /api/data HTTP/1.1\r\nHost: localhost\r\n\r\n"); await phase("aborted-request-read-barrier", entered.promise);
      client.destroy(); await clientClosed; await phase("aborted-server-socket-close", serverClosed);
      let done = false; closing = f.owner.close().then(() => { done = true; });
      await f.entered.promise; await new Promise<void>(resolve => setImmediate(resolve));
      expect(done).toBe(false); expect(used).toBe(false); expect(f.db.get("SELECT 1 n")).toEqual({ n: 1 });
      release.resolve(); await phase("aborted-request-last-use", closing); expect(used).toBe(true); expect(() => f.db.get("SELECT 1")).toThrow();
    } finally { release.resolve(); client.destroy(); await clientClosed; try { await (closing ?? f.owner.close()); } finally { await f.restore(); } }
  });
  it("waits for response completion even after its request handler has settled", async () => {
    const f = await legacyFixture("18.2-parser-idle"), deferred = gate(), agent = new http.Agent({ keepAlive: true });
    let finishResponse: (() => void) | undefined, closing: Promise<void> | undefined;
    f.server.once("request", (_request: http.IncomingMessage, response: http.ServerResponse) => {
      const nativeEnd = response.end.bind(response); let sent = false;
      vi.spyOn(response, "end").mockImplementation((...args: any[]) => {
        finishResponse = () => { if (!sent) { sent = true; Reflect.apply(nativeEnd, response, args); } };
        deferred.resolve(); return response;
      });
    });
    const accepted = new Promise<net.Socket>(resolve => f.server.once("connection", resolve));
    const received = new Promise<{ complete: boolean; body: any }>((resolve, reject) => {
      const request = http.get(f.url + "/api/data", { agent }, response => {
        let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; }); response.once("error", reject);
        response.once("end", () => { try { resolve({ complete: response.complete, body: JSON.parse(text) }); } catch (error) { reject(error); } });
      }); request.once("error", reject);
    }); void received.catch(() => {});
    try {
      await phase("response-end-deferred", deferred.promise); const socket = await accepted;
      let done = false; closing = f.owner.close().then(() => { done = true; });
      await f.entered.promise; await new Promise<void>(resolve => setImmediate(resolve));
      expect(done).toBe(false); expect(socket.destroyed).toBe(false); expect(socket.writableEnded).toBe(false);
      expect(f.db.get("SELECT 1 n")).toEqual({ n: 1 });
      finishResponse!(); const result = await phase("deferred-response-complete", received);
      expect(result.complete).toBe(true); expect(result.body).toHaveProperty("brief");
      await phase("deferred-response-network-close", closing); expect(() => f.db.get("SELECT 1")).toThrow();
    } finally { finishResponse?.(); agent.destroy(); await received.catch(() => {}); try { await (closing ?? f.owner.close()); } finally { await f.restore(); } }
  });
  it("reads an accepted POST body that completes after shutdown begins", async () => {
    const f = await legacyFixture("18.0-api-absent"), agent = new http.Agent({ keepAlive: true });
    const accepted = new Promise<http.IncomingMessage>(resolve => f.server.once("request", resolve));
    let request!: http.ClientRequest, closing: Promise<void> | undefined;
    const received = new Promise<{ complete: boolean; status: number; body: string }>((resolve, reject) => {
      request = http.request(f.url + "/api/task", { method: "POST", agent, headers: { "content-length": 2 } }, response => {
        let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; }); response.once("error", reject);
        response.once("end", () => resolve({ complete: response.complete, status: response.statusCode!, body }));
      }); request.once("error", reject);
    }); void received.catch(() => {});
    try {
      request.write("{"); const incoming = await phase("accepted-partial-post", accepted);
      expect(incoming.complete).toBe(false);
      closing = f.owner.close(); void closing.catch(() => {}); await f.entered.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(incoming.socket.destroyed).toBe(false); expect(incoming.socket.writableEnded).toBe(false);
      expect(f.db.get("SELECT 1 n")).toEqual({ n: 1 });
      request.end("}"); const response = await phase("accepted-post-completed", received);
      expect(response.complete).toBe(true); expect(response.status).toBe(400); expect(response.body).toContain("usage: POST /api/task");
      await phase("accepted-post-close", closing); expect(() => f.db.get("SELECT 1")).toThrow();
    } finally { request.destroy(); agent.destroy(); await received.catch(() => {}); try { await (closing ?? f.owner.close()); } finally { await f.restore(); } }
  });
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
