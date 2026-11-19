/** Base and user Cordis composition with explicit application and plugin resource ownership. */
import { Context, type Effect } from "@deepseek-ai/cordis";
import { DB } from "../../../packages/core/database/src/db";
import { InvocationOwner, type InvocationAccess } from "../../../packages/core/database/src/invocation";
import type { OrmAccess } from "../../../packages/core/database/src/scoped-orm";
import type { Ctx } from "../../../packages/core/text/src/fmt";
import { Store } from "../../../packages/research/pipeline/src/reads";
import { loadUserPlugins, type LoadedUserPlugin, type PluginIssue } from "../../../packages/ops/tools/src/plugins";
import { StartupError, type StartupIssue } from "./startup-diagnostics";

export interface WorkspaceCapability extends InvocationAccess {
  readonly orm: OrmAccess;
  readonly ctx: Ctx;
}
declare module "@deepseek-ai/cordis" { interface Context { workspace: WorkspaceCapability } }
export interface BootEntry {
  id: string;
  apply: (ctx: any, config?: any) => any;
  inject?: readonly string[];
  config?: (file: string) => any;
}
export interface BootOptions {
  home: string;
  dbFile: string;
  baseBundle: BootEntry[];
  version: string;
  invocation: InvocationOwner;
  orm: OrmAccess;
  output: Ctx;
}
export interface BootedApp {
  ctx: Context;
  db: DB;
  store: Store;
  pluginCommands: Record<string, { run: (env: any, action: string, rest: string[], args: any) => number | Promise<number> }>;
  loadedPlugins: string[];
  pluginIssues: PluginIssue[];
  startupIssues: StartupIssue[];
}
function capability(owner: InvocationOwner, orm: OrmAccess, output: Ctx): WorkspaceCapability {
  return Object.freeze({
    orm: Object.freeze({ getOrm: (file: string) => owner.use(() => orm.getOrm(file)), getPgOrm: (url: string) => owner.use(() => orm.getPgOrm(url)) }),
    ctx: Object.freeze({ ...output }),
    own: (resource: Parameters<InvocationOwner["own"]>[0]) => owner.own(resource),
    run: <T>(work: () => T | Promise<T>) => owner.run(work),
  });
}
/** Preserve Cordis Effect shapes while making each yielded disposer an owner-tracked completion. */
function ownedEffect(owner: InvocationOwner, name: string, value: any): any {
  if (typeof value === "function") return owner.cleanup(name, value);
  if (value == null || typeof value !== "object") return value;
  if (typeof value.then === "function") return value.then((result: any) => ownedEffect(owner, name, result));
  if (value[Symbol.asyncIterator]) return (async function* () {
    const iterator = value[Symbol.asyncIterator]();
    for (;;) { const step = await iterator.next(); if (step.done) return ownedEffect(owner, name, step.value); yield ownedEffect(owner, name, step.value); }
  })();
  if (value[Symbol.iterator]) return (function* () {
    const iterator = value[Symbol.iterator]();
    for (;;) { const step = iterator.next(); if (step.done) return ownedEffect(owner, name, step.value); yield ownedEffect(owner, name, step.value); }
  })();
  return value;
}

/** Track only descendant fibers; keep callback identity, class construction and registry behavior native. */
function ownedContext(context: Context, owner: InvocationOwner, name: string): Context {
  const marker = Symbol("workspace-owner");
  const scope = context.extend({
    [marker]: owner,
    effect(this: Context, execute: () => Effect | void, label?: string) {
      return this.fiber.effect(function (this: any) { return ownedEffect(owner, name, execute.call(this)) as Effect; }, label);
    },
  });
  const bridges = new Map<object, { execute: Function; wrapped: Function }>();
  const restore = (runner: any) => {
    const bridge = bridges.get(runner);
    if (bridge && runner.execute === bridge.wrapped) runner.execute = bridge.execute;
    bridges.delete(runner);
  };
  // The observer outlives each generation; a restart must not consume final restoration.
  const remove = context.root.on("internal/plugin", (fiber: any) => {
    if (fiber.ctx[marker] !== owner) return;
    const runner = fiber._runner;
    if (fiber.uid === null) { restore(runner); return; }
    if (bridges.has(runner)) return;
    if (typeof runner?.execute !== "function") throw new Error("unsupported Cordis effect runner; managed cleanup cannot be guaranteed");
    const execute = runner.execute;
    const wrapped = function (this: unknown) {
      const receiver = this;
      // The native effect consumes the full setup, including promise and iterable awaits, inside this lease.
      return owner.run(async () => { await fiber.effect(() => ownedEffect(owner, name, execute.call(receiver)) as Effect); });
    };
    bridges.set(runner, { execute, wrapped });
    runner.execute = wrapped;
  });
  const release = () => { remove(); for (const runner of bridges.keys()) restore(runner); };
  owner.own({ name: "cordis-effect-bridge", close: release });
  context.root.effect(() => release);
  return scope;
}

function compatWarn(name: string, compat: string | undefined, version: string): string | null {
  if (!compat) return null;
  const declaredMajor = (compat.match(/\d+/) || [""])[0];
  return declaredMajor && declaredMajor !== version.split(".")[0] ? name + " declares yglTrees " + compat + " (running " + version + ")" : null;
}

export async function bootApp(opts: BootOptions): Promise<BootedApp> {
  if (!opts.invocation || !opts.orm || !opts.output) throw new Error("bootApp requires explicit invocation, ORM and output capabilities");
  const app = new Context().extend({ workspace: capability(opts.invocation, opts.orm, opts.output) });
  const startupIssues: StartupIssue[] = [];
  const pluginCommands: BootedApp["pluginCommands"] = {};
  const fibers: Array<{ dispose(): any; await(): PromiseLike<any> }> = [];
  const pluginOwners: InvocationOwner[] = [];
  let stopPlugins: Promise<void> | undefined;
  const disposePlugins = () => {
    if (!stopPlugins) stopPlugins = Promise.resolve().then(async () => {
      // Keep database services and ORM alive until plugin completion has settled.
      const scopes = await Promise.allSettled(pluginOwners.map(owner => owner.close()));
      const errors = scopes.filter((r): r is PromiseRejectedResult => r.status === "rejected").map(r => r.reason);
      for (const fiber of [...fibers].reverse()) {
        try { await fiber.dispose(); } catch (error) { errors.push(error); }
      }
      try { await app.fiber.dispose(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "plugin cleanup is unconfirmed");
    });
    void stopPlugins.catch(() => {});
    return stopPlugins;
  };
  opts.invocation.own({ name: "cordis-consumers", phase: "consumer", quiesce: () => { for (const owner of pluginOwners) void owner.close().catch(() => {}); }, close: disposePlugins });
  const mount = (plugin: any, config: any) => { const fiber = app.plugin(plugin, config); fibers.push(fiber); return fiber; };
  try {
    for (const entry of opts.baseBundle) {
      const config = entry.config ? entry.config(opts.dbFile) : undefined;
      mount(entry.inject ? { apply: entry.apply, inject: [...entry.inject] } : entry.apply, entry.id === "database" ? { ...config, owner: opts.invocation } : config);
    }
    // Preserve the existing availability wait; entity completeness never depends on these ticks.
    let db: DB | undefined = app.get("database")?.db;
    for (let i = 0; i < 50 && !db; i++) { await new Promise<void>(resolve => setImmediate(resolve)); db = app.get("database")?.db; }
    for (const fiber of fibers) await fiber.await();
    if (!db) {
      db = new DB(opts.dbFile, { lock: process.env.YGL_TEST !== "1" && process.env.YGL_SERVE !== "1", managed: true });
      const fallback = db;
      opts.invocation.own({ name: "fallback-sqlite", phase: "database", close: () => fallback.closeStrict() });
    }
    const store: Store = app.get("research")?.store ?? new Store(db);
    const { plugins, issues } = loadUserPlugins(opts.home);
    for (const issue of issues) startupIssues.push({ where: "user plugin " + issue.name, error: issue.error });
    for (const plugin of plugins) {
      const owner = new InvocationOwner(); pluginOwners.push(owner);
      const managed = plugin.workspaceProtocol === "ygl-workspace/1";
      const workspace = capability(owner, opts.orm, opts.output);
      let pluginContext!: Context;
      let startupPrimary: unknown;
      const apply = async (ctx: Context, config: any) => {
        // Transfer the actual child disposer into one effect; sibling teardown must not close its owner first.
        await ctx.effect(async function* () {
          const childContext = managed ? ctx.extend({ workspace }) : ctx.extend({ get workspace(): never { throw new Error("managed ORM requires workspaceProtocol ygl-workspace/1; migrate resource and result ownership"); } });
          const body = async (inner: Context, value: any) => {
            pluginContext = ownedContext(inner, owner, plugin.name);
            try {
              await owner.run(async () => {
                // Cordis owns all native Effect shapes, including sync and async iterables.
                await pluginContext.effect(() => plugin.apply?.(pluginContext, value) as Effect);
              });
            } catch (primary) { startupPrimary = primary; throw primary; }
          };
          const shape: any = { apply: body };
          for (const key of ["inject", "Config", "provide", "intercept"] as const) {
            if ((plugin.apply as any)?.[key] !== undefined) shape[key] = (plugin.apply as any)[key];
          }
          const child = childContext.plugin(shape, config);
          owner.own({ name: "cordis-effects", phase: "consumer", close: async () => {
            await child.dispose();
            try { await child.await(); } catch (error) { if (error !== startupPrimary) throw error; }
          } });
          yield child.dispose;
          yield () => owner.close();
          await child.await();
        });
      };
      const fiber = mount(apply, plugin.config ?? {});
      try { await fiber.await(); }
      catch (error: any) { startupIssues.push({ where: "user plugin " + plugin.name, error: error?.message || String(error) }); }
      const warning = compatWarn(plugin.name, plugin.compat, opts.version);
      if (warning) { process.stderr.write("ygl-trees: plugin compat warning: " + warning + "\n"); startupIssues.push({ where: "compat", error: warning }); }
      for (const [group, command] of Object.entries(plugin.commands ?? {})) {
        if (typeof command.run !== "function") continue;
        pluginCommands[group] = { run: (env, action, rest, args) => owner.run(() => command.run({ ...env,
          cordis: pluginContext, orm: managed ? workspace.orm : undefined, invocation: managed ? workspace : undefined,
          ctx: managed ? workspace.ctx : { json: env.ctx.json, color: env.ctx.color, quiet: env.ctx.quiet },
        }, action, rest, args)) };
      }
    }
    if (startupIssues.length) throw new StartupError(startupIssues.length + " plugin issue(s) during startup", startupIssues);
    return { ctx: app, db, store, pluginCommands, loadedPlugins: [...opts.baseBundle.map(entry => entry.id), ...plugins.map((plugin: LoadedUserPlugin) => plugin.name)], pluginIssues: issues, startupIssues };
  } catch (primary) {
    try { await disposePlugins(); }
    catch { throw new Error("startup failed and plugin cleanup is unconfirmed", { cause: primary }); }
    throw primary;
  }
}
