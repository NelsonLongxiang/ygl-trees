import { describe, expect, it } from "vitest";
import { InvocationOwner, InvocationCleanupError } from "../src/invocation";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
describe("invocation-owned quiesce, drain and release", () => {
  it.each(["control", "run", "use"] as const)("preserves the accepting %s callback receiver and detach argument", async method => {
    const owner = new InvocationOwner();
    try {
      const observed = await owner[method](function (this: unknown) { return { receiver: this, args: [...arguments] }; });
      expect(observed.receiver).toBeUndefined(); expect(observed.args).toHaveLength(1); expect(observed.args[0]).toBeTypeOf("function");
    } finally { await owner.close(); }
  });
  it("preserves the null receiver and zero arguments of an accepted dependency-use callback during shutdown", async () => {
    const owner = new InvocationOwner(), started = barrier(), gate = barrier();
    const work = owner.run(async () => {
      started.resolve(); await gate.promise;
      return owner.use(function (this: unknown) { return { receiver: this, args: [...arguments] }; });
    });
    await started.promise;
    const closing = owner.close(); gate.resolve();
    try {
      const observed = await work;
      expect(observed.receiver).toBeNull(); expect(observed.args).toEqual([]);
    } finally { await closing; }
  });
  it("preserves a strict native cleanup callback receiver before releasing its dependencies", async () => {
    const owner = new InvocationOwner(), entered = barrier(), gate = barrier(), events: string[] = [];
    let observed: { receiver: unknown; count: number } | undefined;
    const cleanup = owner.cleanup("native", function (this: unknown) {
      observed = { receiver: this, count: arguments.length }; entered.resolve();
      if (this !== null || arguments.length !== 0) throw new Error("native cleanup callback contract changed");
      return gate.promise.then(() => { events.push("native-closed"); });
    });
    owner.own({ name: "native", phase: "consumer", close: cleanup });
    owner.own({ name: "dependency", close: () => { events.push("dependency-closed"); } });
    const unloading = cleanup(), closing = owner.close();
    const pending = Promise.allSettled([unloading, closing]);
    try {
      await entered.promise;
      expect(events).not.toContain("dependency-closed");
      expect(observed).toEqual({ receiver: null, count: 0 });
      expect(cleanup()).toBe(unloading);
      gate.resolve();
      expect((await pending).every(item => item.status === "fulfilled")).toBe(true);
      expect(events).toEqual(["native-closed", "dependency-closed"]);
    } finally { gate.resolve(); await pending; }
  });
  it("stops admission immediately and drains accepted work before any connection or database release", async () => {
    const owner = new InvocationOwner(), gate = barrier(), entered = barrier(), events: string[] = [];
    owner.own({ name: "server", quiesce: () => { events.push("quiesce"); }, close: () => { events.push("server-closed"); } });
    owner.own({ name: "orm", close: () => { events.push("orm-closed"); } });
    owner.own({ name: "db", phase: "database", close: () => { events.push("db-closed"); } });
    const work = owner.run(async () => { events.push("work-start"); entered.resolve(); await gate.promise; events.push("work-end"); return 7; });
    await entered.promise;
    const close = owner.close(); expect(owner.close()).toBe(close);
    await expect(owner.run(async () => 9)).rejects.toThrow(/not accepting/);
    await Promise.resolve(); await Promise.resolve();
    expect(events).toContain("quiesce"); expect(events).not.toContain("orm-closed"); expect(events).not.toContain("db-closed");
    gate.resolve(); expect(await work).toBe(7); await close;
    expect(events.indexOf("work-end")).toBeLessThan(events.indexOf("orm-closed"));
    expect(events.indexOf("orm-closed")).toBeLessThan(events.indexOf("db-closed"));
  });
  it("starts all stop callbacks before joining their asynchronous shutdown", async () => {
    const owner = new InvocationOwner(), gate = barrier(), started = barrier(), events: string[] = [];
    owner.own({ name: "serve", quiesce: async () => { events.push("server-stop"); started.resolve(); await gate.promise; }, close: () => { events.push("server-close"); } });
    owner.own({ name: "sse", quiesce: () => { events.push("sse-stop"); gate.resolve(); } });
    const close = owner.close(); await started.promise; await close;
    expect(events).toEqual(["server-stop", "sse-stop", "server-close"]);
  });
  it("lets accepted work finish its own registration while draining and quiesces the late resource", async () => {
    const owner = new InvocationOwner(), gate = barrier(), started = barrier(), events: string[] = [];
    const work = owner.run(async () => { started.resolve(); await gate.promise; owner.own({ name: "late", quiesce: () => { events.push("late-stop"); }, close: () => { events.push("late-close"); } }); });
    await started.promise; const close = owner.close(); gate.resolve(); await work; await close;
    expect(events).toEqual(["late-stop", "late-close"]);
    expect(() => owner.own({ name: "too-late" })).toThrow(/closed|releasing/);
  });
  it("allows only already accepted completion to use resources while quiescing", async () => {
    const owner = new InvocationOwner(), entered = barrier(), gate = barrier(), events: string[] = [];
    owner.own({ name: "connection", close: () => { events.push("closed"); } });
    const work = owner.run(async () => { entered.resolve(); await gate.promise; return owner.use(async () => { events.push("last-use"); return 3; }); });
    await entered.promise; const closing = owner.close();
    await expect(owner.use(async () => 9)).rejects.toThrow(/not accepting/);
    gate.resolve(); expect(await work).toBe(3); await closing; expect(events).toEqual(["last-use", "closed"]);
  });
  it("keeps dependencies available through an owned cleanup callback, but not unrelated new work", async () => {
    const owner = new InvocationOwner(), entered = barrier(), gate = barrier(), events: string[] = [];
    owner.own({ name: "consumer", phase: "consumer", close: async () => { entered.resolve(); await gate.promise; await owner.use(async () => { events.push("cleanup-use"); }); } });
    owner.own({ name: "connection", close: () => { events.push("connection-close"); } });
    const closing = owner.close(); await entered.promise;
    await expect(owner.use(async () => {})).rejects.toThrow(/not accepting/);
    gate.resolve(); await closing; expect(events).toEqual(["cleanup-use", "connection-close"]);
  });
  it("preserves a work rejection as the caller's primary without turning it into cleanup failure", async () => {
    const owner = new InvocationOwner(), primary = new Error("business failed"), work = owner.run(async () => { throw primary; });
    await expect(work).rejects.toBe(primary); await expect(owner.close()).resolves.toBeUndefined();
  });
  it("attempts independent connection releases but keeps dependent DB and lock when cleanup is unknown", async () => {
    const owner = new InvocationOwner(), events: string[] = [], failure = new Error("native end failed");
    owner.own({ name: "native-pg", close: () => { events.push("native-close"); throw failure; } });
    owner.own({ name: "orm", close: () => { events.push("orm-close"); } });
    owner.own({ name: "db-lock", phase: "database", close: () => { events.push("unsafe-lock-release"); } });
    const first = owner.close(), error = await first.then(() => undefined, error => error);
    expect(error).toBeInstanceOf(InvocationCleanupError);
    expect(error.failures).toEqual([{ phase: "release", name: "native-pg", cause: failure }]);
    expect(events).toEqual(["native-close", "orm-close"]);
    expect(owner.close()).toBe(first); await expect(owner.close()).rejects.toBe(error);
    await expect(owner.run(async () => 1)).rejects.toThrow(/not accepting/);
  });
  it("continues independent stop requests after one fails but does not release their dependencies", async () => {
    const owner = new InvocationOwner(), events: string[] = [];
    owner.own({ name: "bad-server", quiesce: () => { throw new Error("stop unknown"); }, close: () => { events.push("unsafe-release"); } });
    owner.own({ name: "worker", quiesce: () => { events.push("worker-stop"); } });
    owner.own({ name: "db", phase: "database", close: () => { events.push("unsafe-db-close"); } });
    await expect(owner.close()).rejects.toBeInstanceOf(InvocationCleanupError);
    expect(events).toEqual(["worker-stop"]);
  });
  it("closes later consumers before withdrawing their previously registered completion dependencies", async () => {
    const owner = new InvocationOwner(), started = barrier(), gate = barrier(), events: string[] = [];
    let serviceAlive = true;
    owner.own({ name: "cordis", phase: "consumer", close: () => { serviceAlive = false; events.push("withdraw"); } });
    owner.own({ name: "dashboard", phase: "consumer", close: async () => { started.resolve(); await gate.promise; expect(serviceAlive).toBe(true); events.push("last-service-use"); } });
    owner.own({ name: "db", phase: "database", close: () => { events.push("db-close"); } });
    const close = owner.close(); await started.promise; expect(serviceAlive).toBe(true); gate.resolve(); await close;
    expect(events).toEqual(["last-service-use", "withdraw", "db-close"]);
  });
  it("rejects unrelated late registration while a different accepted operation is draining", async () => {
    const owner = new InvocationOwner(), entered = barrier(), gate = barrier();
    const work = owner.run(async () => { entered.resolve(); await gate.promise; owner.own({ name: "accepted-late" }); });
    await entered.promise; const close = owner.close();
    try { expect(() => owner.own({ name: "unrelated-late" })).toThrow(/accepted|closed|releasing/); }
    finally { gate.resolve(); await work; await close; }
  });
  it("drains work spawned by asynchronous quiesce before the first release", async () => {
    const owner = new InvocationOwner(), stopGate = barrier(), useGate = barrier(), entered = barrier(), events: string[] = [];
    let using: Promise<void> | undefined;
    owner.own({ name: "consumer", quiesce: async () => { await stopGate.promise; using = owner.use(async () => { entered.resolve(); await useGate.promise; events.push("last-use"); }); } });
    owner.own({ name: "connection", close: () => { events.push("connection-close"); } });
    const closing = owner.close(); stopGate.resolve(); await entered.promise;
    try { await new Promise<void>(resolve => setImmediate(resolve)); expect(events).not.toContain("connection-close"); }
    finally { useGate.resolve(); await using; await closing; }
    expect(events).toEqual(["last-use", "connection-close"]);
  });
  it("cleanup uncertainty immediately blocks new work only for its owning scope", async () => {
    const failed = new InvocationOwner(), healthy = new InvocationOwner(), primary = new Error("release unknown");
    const close = failed.cleanup("native", () => { throw primary; });
    await expect(close()).rejects.toBe(primary);
    await expect(failed.run(async () => 1)).rejects.toThrow(/not accepting/);
    await expect(failed.use(async () => 1)).rejects.toThrow(/not accepting/);
    expect(() => failed.own({ name: "new-resource" })).toThrow(/closed|releasing/);
    expect(await healthy.run(async () => 2)).toBe(2); await healthy.close();
    await expect(failed.close()).rejects.toThrow(/cleanup/);
  });
  it("isolates same-process owners and rejects duplicate registrations by object identity", async () => {
    const a = new InvocationOwner(), b = new InvocationOwner(), resource = { name: "one" }, events: string[] = [];
    a.own(resource); expect(() => a.own(resource)).toThrow(/already owned/);
    b.own({ name: "b", close: () => { events.push("b"); } });
    await a.close(); expect(events).toEqual([]); await b.close(); expect(events).toEqual(["b"]);
  });
});
