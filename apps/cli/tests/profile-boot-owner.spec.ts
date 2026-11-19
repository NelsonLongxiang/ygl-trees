import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { bootApp } from "../src/profile-boot";
import { Service } from "@deepseek-ai/cordis";
import { createWorkspaceOrm } from "../src/workspace-orm";
import { InvocationOwner } from "../../../packages/core/database/src/invocation";
import { apply as database } from "../../../packages/core/database/src/plugin";
import { apply as research, inject as researchInject } from "../../../packages/research/pipeline/src/plugin";

const load = vi.hoisted(() => ({ plugins: [] as any[], issues: [] as any[] }));
vi.mock("../../../packages/ops/tools/src/plugins", () => ({ loadUserPlugins: () => load }));
const roots: string[] = [], owners: InvocationOwner[] = [];
function setup() {
  fs.mkdirSync(path.join(process.cwd(), "tmp"), { recursive: true }); const home = fs.mkdtempSync(path.join(process.cwd(), "tmp/boot-owner-")); roots.push(home);
  const file = path.join(home, "workspace.db"), invocation = new InvocationOwner(), orm = createWorkspaceOrm({ dialect: "sqlite", file }); owners.push(invocation);
  invocation.own({ name: "orm", close: () => orm.close() });
  return { home, file, invocation, orm, options: { home, dbFile: file, version: "0.126.0", baseBundle: [{ id: "database", apply: database, config: (file: string) => ({ file }) }, { id: "research", apply: research, inject: researchInject }], invocation, orm, output: { json: true, quiet: false, color: false } } };
}
afterEach(async () => { for (const owner of owners.splice(0)) await owner.close().catch(() => {}); load.plugins.length = 0; load.issues.length = 0; for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
describe("Cordis workspace owner composition", () => {
  it("assembles before plugin use, independent of research command-plugin enable order", async () => {
    const s = setup(); let seen = 0;
    load.plugins.push({ name: "managed-probe", workspaceProtocol: "ygl-workspace/1", apply: async (ctx: any) => {
      const ds = await ctx.workspace.orm.getOrm(s.file); seen = ds.entityMetadatas.length;
      expect(ctx.workspace.orm.close).toBeUndefined();
    } });
    const app = await bootApp(s.options);
    expect(app.db.path).toBe(s.file); expect(seen).toBe(12); expect(app.ctx.research.store.db).toBe(app.db);
    await s.invocation.close(); expect(() => app.db.get("SELECT 1")).toThrow();
  });
  it("collects a failing managed plugin's own resources while leaving application ORM usable", async () => {
    const s = setup(), close = vi.fn(async () => {});
    load.plugins.push({ name: "fail-after-open", workspaceProtocol: "ygl-workspace/1", apply: async (ctx: any) => {
      await ctx.workspace.orm.getOrm(s.file); ctx.workspace.own({ name: "plugin-resource", close }); throw new Error("managed startup failed");
    } });
    await expect(bootApp(s.options)).rejects.toThrow(/plugin issue|startup/);
    expect(close).toHaveBeenCalledTimes(1);
    expect((await s.orm.getOrm(s.file)).isInitialized).toBe(true);
    await s.invocation.close(); expect(close).toHaveBeenCalledTimes(1);
  });
  it("registers native DB before a later startup error, so outer close cannot leak it", async () => {
    const s = setup(); load.issues.push({ name: "invalid-user", error: "missing entry" });
    await expect(bootApp(s.options)).rejects.toThrow(/plugin issue/);
    const close = vi.spyOn(require("better-sqlite3").prototype, "close");
    try { await s.invocation.close(); expect(close).toHaveBeenCalledTimes(1); }
    finally { close.mockRestore(); }
  });
  it("keeps application ORM available through actual Cordis effect cleanup", async () => {
    const s = setup(); let cleanupUse = 0;
    load.plugins.push({ name: "effect-cleanup", workspaceProtocol: "ygl-workspace/1", apply: (ctx: any) => {
      ctx.effect(() => async () => { const ds = await ctx.workspace.orm.getOrm(s.file); cleanupUse = Number((await ds.query("SELECT COUNT(*) n FROM projects"))[0].n) + 1; });
    } });
    await bootApp(s.options); await s.invocation.close(); expect(cleanupUse).toBe(1);
  });
  it("a single plugin unload waits for its last ORM use without closing the application instance", async () => {
    const s = setup(); let pluginContext: any, entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    load.plugins.push({ name: "unload-last-use", workspaceProtocol: "ygl-workspace/1", apply: (ctx: any) => {
      pluginContext = ctx; ctx.effect(() => async () => { entered(); await barrier; const ds = await ctx.workspace.orm.getOrm(s.file); await ds.query("SELECT COUNT(*) n FROM projects"); });
    } });
    await bootApp(s.options); let finished = false; const unload = Promise.resolve(pluginContext.fiber.dispose()).then(() => { finished = true; });
    await started;
    try { await Promise.resolve(); expect(finished).toBe(false); expect((await s.orm.getOrm(s.file)).isInitialized).toBe(true); }
    finally { release(); await unload; }
    expect(finished).toBe(true); expect((await s.orm.getOrm(s.file)).isInitialized).toBe(true); await s.invocation.close();
  });
  it("effect cleanup failure remains visible to the owner instead of letting fiber error logging release DB", async () => {
    const s = setup();
    load.plugins.push({ name: "failed-effect", workspaceProtocol: "ygl-workspace/1", apply: (ctx: any) => {
      ctx.effect(() => async () => { throw new Error("effect cleanup unconfirmed"); });
    } });
    const app = await bootApp(s.options);
    const failure = await s.invocation.close().then(() => undefined, error => error);
    try { expect(failure).toBeInstanceOf(Error); expect(failure.message).toMatch(/cleanup/); expect(app.db.get("SELECT 1 n")).toEqual({ n: 1 }); }
    finally { await s.orm.close(); app.db.close(); }
  });
  it.each([false, true])("joins an external plugin unload already in flight when application close overlaps (cleanup failure=%s)", async fail => {
    const s = setup(); let pluginContext: any, started!: () => void, release!: () => void, lastUse = false;
    const entered = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    load.plugins.push({ name: "overlap-cleanup", workspaceProtocol: "ygl-workspace/1", apply: (ctx: any) => {
      pluginContext = ctx; ctx.effect(() => async () => { started(); await gate; const ds = await ctx.workspace.orm.getOrm(s.file); await ds.query("SELECT COUNT(*) n FROM projects"); lastUse = true; if (fail) throw new Error("last cleanup failed"); });
    } });
    const app = await bootApp(s.options); const unload = Promise.resolve(pluginContext.fiber.dispose()); void unload.catch(() => {}); await entered;
    let closed = false; const closing = s.invocation.close().then(() => { closed = true; return undefined; }, error => error);
    try {
      await new Promise<void>(resolve => setImmediate(resolve)); expect(closed).toBe(false); expect(app.db.get("SELECT 1 n")).toEqual({ n: 1 });
      release(); await unload.catch(() => {}); const failure = await closing;
      expect(lastUse).toBe(true);
      if (fail) { expect(failure).toBeInstanceOf(Error); expect(app.db.get("SELECT 1 n")).toEqual({ n: 1 }); }
      else { expect(failure).toBeUndefined(); expect(closed).toBe(true); expect(() => app.db.get("SELECT 1")).toThrow(); }
    } finally { release(); await unload.catch(() => {}); await closing; await s.orm.close(); app.db.close(); }
  });
  it.each(["sync", "async"])("preserves native %s iterable effect return for a legacy plugin without exposing managed ORM", async kind => {
    const s = setup(), events: string[] = [];
    const apply = kind === "sync" ? function* (ctx: any) { expect(() => ctx.workspace).toThrow(/workspaceProtocol/); events.push("start"); yield () => { events.push("stop"); }; }
      : async function* (ctx: any) { expect(() => ctx.workspace).toThrow(/workspaceProtocol/); events.push("start"); yield async () => { await Promise.resolve(); events.push("stop"); }; };
    load.plugins.push({ name: "legacy-native-effect", apply });
    await bootApp(s.options); expect(events).toEqual(["start"]); await s.invocation.close(); expect(events).toEqual(["start", "stop"]);
  });
  it.each(["direct", "extend", "isolate", "deep"])("nested %s context registers effects on its own fiber and releases them on independent unload", async mode => {
    const s = setup(), events: string[] = []; let child: any;
    load.plugins.push({ name: "nested-receiver", workspaceProtocol: "ygl-workspace/1", apply: async (ctx: any) => {
      ctx.effect(() => () => { events.push("parent-close"); });
      const base = mode === "extend" ? ctx.extend({ local: true }) : mode === "isolate" ? ctx.isolate("local") : ctx;
      if (mode === "deep") {
        await base.plugin(async (middle: any) => { child = middle.plugin((leaf: any) => { leaf.effect(() => () => { events.push("child-close"); }); }); await child; });
      } else { child = base.plugin((leaf: any) => { leaf.effect(() => () => { events.push("child-close"); }); }); await child; }
    } });
    await bootApp(s.options); await child.dispose(); await child.await();
    expect(events).toEqual(["child-close"]); expect((await s.orm.getOrm(s.file)).isInitialized).toBe(true);
    await s.invocation.close(); expect(events).toEqual(["child-close", "parent-close"]);
  });
  it.each(["function", "sync", "async"])("tracks nested plugin returned %s cleanup failures as a strict receipt", async kind => {
    const s = setup(); let child: any;
    const cleanup = async () => { const ds = await s.orm.getOrm(s.file); await ds.query("SELECT 1"); throw new Error("nested cleanup unknown"); };
    const body = kind === "function" ? () => cleanup : kind === "sync" ? function* () { yield cleanup; } : async function* () { yield cleanup; };
    load.plugins.push({ name: "nested-return", workspaceProtocol: "ygl-workspace/1", apply: async (ctx: any) => { child = ctx.plugin(body); await child; } });
    const app = await bootApp(s.options);
    try { await child.dispose(); const failure = await s.invocation.close().then(() => undefined, error => error); expect(failure).toBeInstanceOf(Error); expect(app.db.get("SELECT 1 n")).toEqual({ n: 1 }); }
    finally { await s.orm.close(); app.db.close(); }
  });
  it.each([false, true])("joins externally started nested cleanup with last dependency use (failure=%s)", async fail => {
    const s = setup(); let child: any, started!: () => void, release!: () => void, used = false;
    const entered = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    load.plugins.push({ name: "nested-overlap", workspaceProtocol: "ygl-workspace/1", apply: async (ctx: any) => {
      child = ctx.plugin((inner: any) => async () => { started(); await gate; const ds = await inner.workspace.orm.getOrm(s.file); await ds.query("SELECT 1"); used = true; if (fail) throw new Error("nested release failed"); }); await child;
    } });
    const app = await bootApp(s.options), unloading = Promise.resolve(child.dispose()); void unloading.catch(() => {}); await entered;
    let done = false; const closing = s.invocation.close().then(() => { done = true; return undefined; }, error => error);
    try { await new Promise<void>(resolve => setImmediate(resolve)); expect(done).toBe(false); release(); await unloading.catch(() => {}); const failure = await closing; expect(used).toBe(true);
      if (fail) { expect(failure).toBeInstanceOf(Error); expect(app.db.get("SELECT 1 n")).toEqual({ n: 1 }); } else { expect(failure).toBeUndefined(); expect(() => app.db.get("SELECT 1")).toThrow(); }
    } finally { release(); await unloading.catch(() => {}); await closing; await s.orm.close(); app.db.close(); }
  });
  it("preserves registry lookup/delete identity for an original nested callback", async () => {
    const s = setup(), events: string[] = []; let scope: any, child: any;
    const nested = () => () => { events.push("closed"); };
    load.plugins.push({ name: "registry-identity", workspaceProtocol: "ygl-workspace/1", apply: async (ctx: any) => { scope = ctx; child = ctx.plugin(nested); await child; } });
    await bootApp(s.options);
    expect(scope.registry.has(nested)).toBe(true); expect(scope.registry.get(nested)).toBeDefined();
    expect([...scope.registry.keys()]).toContain(nested);
    scope.registry.delete(nested); await child.await(); expect(events).toEqual(["closed"]);
    expect(scope.registry.has(nested)).toBe(false); await s.invocation.close(); expect(events).toEqual(["closed"]);
  });
  it("preserves object plugin metadata, constructor lifecycle and private init state", async () => {
    const s = setup(), events: string[] = []; let child: any, serviceChild: any;
    class Nested extends Service {
      #value = "private-kept";
      constructor(ctx: any) { super(ctx, "nested"); }
      [Service.init]() { events.push(this.#value); return () => { events.push("class-close"); }; }
    }
    const object = { inject: ["database"], Config: { "~standard": { version: 1, vendor: "test", validate: (value: any) => ({ value: { checked: value.flag } }) } }, apply: (ctx: any, config: any) => {
      expect(ctx.database.db.path).toBe(s.file); expect(config).toEqual({ checked: true }); events.push("object-start"); return () => { events.push("object-close"); };
    } };
    load.plugins.push({ name: "nested-shapes", workspaceProtocol: "ygl-workspace/1", apply: async (ctx: any) => { child = ctx.plugin(object, { flag: true }); await child; serviceChild = ctx.plugin(Nested); await serviceChild; } });
    await bootApp(s.options); expect(events).toEqual(["object-start", "private-kept"]);
    await child.dispose(); await serviceChild.dispose(); expect(events).toEqual(["object-start", "private-kept", "object-close", "class-close"]); await s.invocation.close();
  });
  it.each([false, true])("a native restart opens a new generation only after confirmed cleanup (failure=%s)", async fail => {
    const s = setup(); let child: any, context: any, count = 0, closed = 0;
    load.plugins.push({ name: "restart-generation", workspaceProtocol: "ygl-workspace/1", apply: async (ctx: any) => {
      context = ctx; child = ctx.plugin(() => { count++; return () => { closed++; if (fail) throw new Error("generation cleanup unknown"); }; }); await child;
    } });
    const app = await bootApp(s.options);
    try {
      const failure = await child.restart().then(() => undefined, (error: unknown) => error);
      if (fail) {
        expect(count).toBe(1); expect(closed).toBe(1); expect(failure).toBeInstanceOf(Error);
        await expect(context.workspace.run(async () => 1)).rejects.toThrow(/not accepting|failed|poisoned/);
        await expect(context.workspace.orm.getOrm(s.file)).rejects.toThrow(/not accepting|failed|poisoned/);
        await expect(s.invocation.close()).rejects.toThrow(/cleanup/); expect(app.db.get("SELECT 1 n")).toEqual({ n: 1 });
      } else { expect(failure).toBeUndefined(); expect(count).toBe(2); expect(closed).toBe(1); await s.invocation.close(); expect(closed).toBe(2); }
    } finally { await s.invocation.close().catch(() => {}); await s.orm.close(); app.db.close(); }
  });
  it.each(["function", "generator"])("a nested async %s setup not awaited by its parent keeps its own completion lease", async shape => {
    const s = setup(); let child: any, context: any, entered!: () => void, release!: () => void, used = false, closed = 0;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const finish = async (inner: any) => { await gate; const ds = await inner.workspace.orm.getOrm(s.file); await ds.query("SELECT 1"); inner.workspace.own({ name: "late-setup", close: () => { closed++; } }); used = true; };
    load.plugins.push({ name: "unawaited-setup", workspaceProtocol: "ygl-workspace/1", apply: (ctx: any) => {
      context = ctx;
      const body = shape === "function" ? async (inner: any) => { entered(); await finish(inner); }
        : async function* (inner: any) { entered(); await finish(inner); yield () => {}; };
      child = ctx.plugin(body);
    } });
    const app = await bootApp(s.options); await started;
    let done = false; const closing = s.invocation.close().then(() => { done = true; return undefined; }, error => error);
    try {
      await new Promise<void>(resolve => setImmediate(resolve)); expect(done).toBe(false);
      await expect(context.workspace.run(async () => 1)).rejects.toThrow(/not accepting/);
      release(); const primary = await child.await().then(() => undefined, (error: unknown) => error); const failure = await closing;
      expect(primary).toBeUndefined(); expect(failure).toBeUndefined(); expect(used).toBe(true); expect(closed).toBe(1); expect(() => app.db.get("SELECT 1")).toThrow();
    } finally { release(); await child.await().catch(() => {}); await closing; await s.orm.close(); app.db.close(); }
  });
  it.each([0, 1, 2])("restores the exact native runner after %s clean restarts and final registry disposal", async restarts => {
    const s = setup(); let child: any, context: any, native: Function | undefined, count = 0;
    const callback = () => { count++; return () => {}; };
    load.plugins.push({ name: "restore-generation", workspaceProtocol: "ygl-workspace/1", apply: async (ctx: any) => {
      context = ctx; const stop = ctx.root.on("internal/plugin", (fiber: any) => { if (fiber.uid !== null && fiber.runtime?.callback === callback) native ??= fiber._runner.execute; }, { prepend: true });
      child = ctx.plugin(callback); await child; stop();
    } });
    await bootApp(s.options); expect(native).toBeTypeOf("function"); expect(child._runner.execute).not.toBe(native);
    for (let i = 0; i < restarts; i++) await child.restart();
    context.registry.delete(callback); await child.await(); expect(count).toBe(restarts + 1); expect(child._runner.execute).toBe(native);
    await s.invocation.close();
  });
  it("unawaited setup retains its primary failure and a separate cleanup failure receipt", async () => {
    const s = setup(); const primary = new Error("nested setup failed"), secondary = new Error("nested cleanup failed");
    let child: any, entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    load.plugins.push({ name: "unawaited-failure", workspaceProtocol: "ygl-workspace/1", apply: (ctx: any) => {
      child = ctx.plugin(async (inner: any) => { entered(); await gate; inner.effect(() => () => { throw secondary; }); throw primary; });
    } });
    const app = await bootApp(s.options); await started; const closing = s.invocation.close().then(() => undefined, error => error);
    try { release(); const actual = await child.await().then(() => undefined, (error: unknown) => error); const failure = await closing;
      expect(actual).toBe(primary); expect(failure).toBeInstanceOf(Error); expect(app.db.get("SELECT 1 n")).toEqual({ n: 1 });
    } finally { release(); await child.await().catch(() => {}); await closing; await s.orm.close(); app.db.close(); }
  });
  it("supports an explicit fallback without an unregistered second DB owner", async () => {
    const s = setup(); s.options.baseBundle = [] as any;
    const app = await bootApp(s.options); expect(app.db.path).toBe(s.file);
    await s.invocation.close(); expect(() => app.db.get("SELECT 1")).toThrow();
  });
});
