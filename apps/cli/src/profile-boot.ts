/**
 * App boot — DSH profile-boot.ts exemplar (scaled to ygl-trees).
 *
 * Resolves the composition stack: base bundle (ygl.bundle.json) then the
 * workspace's user layer ($YGL_HOME/plugins + ygl.user.bundle.json), mounts
 * plugins on the Cordis Context, settles the service layer with the
 * established CLI fallbacks (0.19 lesson), and reports per-plugin issues
 * through StartupError instead of failing wholesale or silently skipping.
 */
import { Context } from "@deepseek-ai/cordis";
import { DB } from "../../../packages/core/database/src/db";
import { Store } from "../../../packages/research/pipeline/src/reads";
import { loadUserPlugins, LoadedUserPlugin, PluginIssue } from "../../../packages/ops/tools/src/plugins";
import { StartupError, StartupIssue } from "./startup-diagnostics";

export interface BootEntry {
  id: string;
  apply: (ctx: any, config?: any) => void;
  config?: (file: string) => any;
}

export interface BootOptions {
  home: string;
  dbFile: string;
  baseBundle: BootEntry[];
  version: string;
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

/** yglTrees "^0.36" compat: warn when the declared MAJOR differs from running. */
function compatWarn(name: string, compat: string | undefined, version: string): string | null {
  if (!compat) return null;
  const declaredMajor = (compat.match(/\d+/) || [""])[0];
  const runningMajor = version.split(".")[0];
  if (declaredMajor && declaredMajor !== runningMajor) {
    return `${name} declares yglTrees ${compat} (running ${version})`;
  }
  return null;
}

export async function bootApp(opts: BootOptions): Promise<BootedApp> {
  const app = new Context();
  const startupIssues: StartupIssue[] = [];
  const pluginCommands: BootedApp["pluginCommands"] = {};

  // base bundle (fail-loud: a malformed base composition is a code problem)
  for (const entry of opts.baseBundle) {
    app.plugin(entry.apply, entry.config ? entry.config(opts.dbFile) : undefined);
  }

  // user layer: per-plugin isolation — one bad plugin must not brick the bench
  const { plugins, issues } = loadUserPlugins(opts.home);
  for (const i of issues) startupIssues.push({ where: `user plugin ${i.name}`, error: i.error });

  for (const up of plugins) {
    // Entry-option parity adopted without the loader: config rides the bundle
    // entry, disabled entries never reach here (filtered in loadUserPlugins).
    app.plugin(up.apply || (() => {}), up.config ?? {});
    const w = compatWarn(up.name, up.compat, opts.version);
    if (w) {
      process.stderr.write(`ygl-trees: plugin compat warning: ${w}\n`);
      startupIssues.push({ where: "compat", error: w });
    }
    for (const [g, c] of Object.entries(up.commands || {})) {
      if (typeof (c as any).run === "function") pluginCommands[g] = c as any;
    }
  }

  // settle the service layer (one yield; direct construction stays the CLI fallback)
  await new Promise((r) => setImmediate(r));
  const db: DB = app.database?.db || new DB(opts.dbFile, { lock: true });
  const store: Store = app.research?.store || new Store(db);

  if (startupIssues.length) {
    throw new StartupError(`${startupIssues.length} plugin issue(s) during startup`, startupIssues);
  }
  return {
    ctx: app,
    db,
    store,
    pluginCommands,
    loadedPlugins: [...opts.baseBundle.map((e) => e.id), ...plugins.map((p: LoadedUserPlugin) => p.name)],
    pluginIssues: issues,
    startupIssues,
  };
}
