import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runWorkspaceInvocation } from "../src/workspace-invocation";
import { emitJson, bad } from "../../../packages/core/text/src/fmt";

const ctx = { json: true, quiet: false, color: false };
function channels() {
  const stdout: string[] = [], stderr: string[] = [], signals = new EventEmitter(), exits: number[] = [];
  return { stdout, stderr, signals, exits, options: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line), signals, forceExit: (code: number) => exits.push(code) } };
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
describe("workspace invocation result and cleanup boundary", () => {
  it("publishes normal output only after accepted work and strict release complete", async () => {
    const ch = channels(), events: string[] = [];
    const rc = await runWorkspaceInvocation(ctx, { dialect: "sqlite", file: "unused.db" }, async scope => {
      scope.invocation.own({ name: "db", phase: "database", close: () => { events.push("closed"); expect(ch.stdout).toEqual([]); } });
      emitJson(scope.ctx, { id: "one", duplicate: true }, 2); events.push("business"); return 0;
    }, ch.options);
    expect(rc).toBe(0); expect(events).toEqual(["business", "closed"]); expect(ch.stdout).toEqual([JSON.stringify({ id: "one", duplicate: true }, null, 2)]);
    expect(ch.signals.listenerCount("SIGINT")).toBe(0); expect(ch.signals.listenerCount("SIGTERM")).toBe(0);
  });
  it("PG preflight success followed by usage return still releases registered resources and keeps rc2", async () => {
    const ch = channels(), close = vi.fn(async () => {});
    const rc = await runWorkspaceInvocation(ctx, { dialect: "postgres", url: "postgres://unused" }, async scope => {
      scope.invocation.own({ name: "preflight", close }); bad(scope.ctx, "usage refused"); return 2;
    }, ch.options);
    expect(rc).toBe(2); expect(close).toHaveBeenCalledTimes(1); expect(ch.stdout.map(JSON.parse)).toEqual([{ error: "usage refused" }]);
  });
  it("replaces staged success on cleanup failure without a second object or raw credential diagnostics", async () => {
    const ch = channels();
    const rc = await runWorkspaceInvocation(ctx, { dialect: "sqlite", file: "unused.db" }, async scope => {
      scope.invocation.own({ name: "client", close: () => { throw new Error("postgres://user:password@private/database"); } });
      emitJson(scope.ctx, { id: "business-may-already-be-committed" }); return 0;
    }, ch.options);
    expect(rc).toBe(1); expect(ch.stdout.map(JSON.parse)).toEqual([{ error: "workspace cleanup failed" }]);
    expect(ch.stderr.join("\n")).toMatch(/may already be committed/); expect(ch.stderr.join("\n")).not.toMatch(/password|postgres:\/\//);
  });
  it("preserves primary error payload and nonzero code when cleanup also fails", async () => {
    const ch = channels();
    const rc = await runWorkspaceInvocation(ctx, { dialect: "sqlite", file: "unused.db" }, async scope => {
      scope.invocation.own({ name: "client", close: () => { throw new Error("secondary"); } }); bad(scope.ctx, "primary usage"); return 2;
    }, ch.options);
    expect(rc).toBe(2); expect(ch.stdout.map(JSON.parse)).toEqual([{ error: "primary usage" }]); expect(ch.stderr).toHaveLength(1);
  });
  it("sanitizes an uncaught PG failure while cleaning resources registered before startup completed", async () => {
    const ch = channels(), close = vi.fn(async () => {});
    const rc = await runWorkspaceInvocation(ctx, { dialect: "postgres", url: "postgres://u:secret@private/db" }, async scope => {
      scope.invocation.own({ name: "startup-client", close }); throw new Error("postgres://u:secret@private/db");
    }, ch.options);
    expect(rc).toBe(1); expect(close).toHaveBeenCalledTimes(1); expect(ch.stdout).toHaveLength(1); expect(ch.stdout[0]).not.toContain("secret");
  });
  it("a signal quiesces a detached serve control path without waiting on itself", async () => {
    const ch = channels(), ready = gate(), stopped = gate(), events: string[] = [];
    const running = runWorkspaceInvocation(ctx, { dialect: "sqlite", file: "unused.db" }, async scope => {
      scope.invocation.own({ name: "server", quiesce: () => { events.push("stop"); stopped.resolve(); }, close: () => { events.push("release"); } });
      scope.detachControl(); ready.resolve(); await stopped.promise; events.push("serve-ended"); return 0;
    }, ch.options);
    await ready.promise; ch.signals.emit("SIGTERM"); expect(await running).toBe(0);
    expect(events.indexOf("stop")).toBeLessThan(events.indexOf("serve-ended")); expect(events.indexOf("serve-ended")).toBeLessThan(events.indexOf("release"));
    expect(ch.exits).toEqual([0]);
  });
  it("a main command accepted before signal can register and finish its acquired resource while quiescing", async () => {
    const ch = channels(), entered = gate(), quiesced = gate(), release = gate(), events: string[] = [];
    const running = runWorkspaceInvocation(ctx, { dialect: "sqlite", file: "unused.db" }, async scope => {
      scope.invocation.own({ name: "stop-barrier", quiesce: () => { quiesced.resolve(); } });
      entered.resolve(); await release.promise;
      scope.invocation.own({ name: "accepted-late", close: () => { events.push("released"); } });
      emitJson(scope.ctx, { id: "accepted" }); return 0;
    }, ch.options);
    await entered.promise; ch.signals.emit("SIGTERM"); await quiesced.promise; release.resolve();
    expect(await running).toBe(0); expect(events).toEqual(["released"]); expect(ch.stdout.map(JSON.parse)).toEqual([{ id: "accepted" }]);
  });
  it("keeps two concurrent main invocations' result sinks and resource owners independent", async () => {
    const a = channels(), b = channels(), entered = gate(), release = gate();
    const one = runWorkspaceInvocation(ctx, { dialect: "sqlite", file: "a.db" }, async scope => { emitJson(scope.ctx, { owner: "a" }); entered.resolve(); await release.promise; return 0; }, a.options);
    await entered.promise;
    expect(await runWorkspaceInvocation(ctx, { dialect: "sqlite", file: "b.db" }, async scope => { emitJson(scope.ctx, { owner: "b" }); return 0; }, b.options)).toBe(0);
    expect(a.stdout).toEqual([]); release.resolve(); expect(await one).toBe(0);
    expect(a.stdout.map(JSON.parse)).toEqual([{ owner: "a" }]); expect(b.stdout.map(JSON.parse)).toEqual([{ owner: "b" }]);
  });
});
