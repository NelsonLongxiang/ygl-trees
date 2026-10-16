/**
 * Plugin package management — launcher-owned, dispatched directly by bin.ts
 * before the domain routes (DSH apps/cli exemplar: `dsh plugin` is a bin
 * mode, not a domain package command). Profile operations live in
 * packages/ops/tools/src/plugins.ts (gated, vitest-covered, doctor-shared).
 */
import { initProfile, installPlugin, removePlugin, listPlugins, profileDir, setPluginEnabled, setPluginConfig } from "../../../packages/ops/tools/src/plugins";
import { ok, bad, out, head, table } from "../../../packages/core/text/src/fmt";

export function runPluginCommand(env: any, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx } = env;
  const home = env.home;

  switch (action) {
    case "init": {
      initProfile(home);
      ok(ctx, `plugin profile ready: ${profileDir(home)}`);
      return 0;
    }
    case "install": {
      const spec = rest[0];
      if (!spec) {
        bad(ctx, "usage: plugin install <npm-package|git-url|local-dir>");
        return 2;
      }
      return installPlugin(home, spec).then(
        (r: any): number => {
          if (ctx.json) console.log(JSON.stringify(r, null, 2));
          else ok(ctx, `installed: ${r.name}  (${r.spec}) — restart any running process to load`);
          return 0;
        },
        (e: any): number => {
          bad(ctx, `install failed: ${e?.message || e}`);
          return 1;
        }
      );
    }
    case "remove":
    case "rm": {
      const name = rest[0];
      if (!name) {
        bad(ctx, "usage: plugin remove <name>");
        return 2;
      }
      return removePlugin(home, name).then(
        (): number => {
          ok(ctx, `removed: ${name}`);
          return 0;
        },
        (e: any): number => {
          bad(ctx, `remove failed: ${e?.message || e}`);
          return 1;
        }
      );
    }
    case "enable":
    case "disable": {
      const name = rest[0];
      if (!name) {
        bad(ctx, `usage: plugin ${action} <name>`);
        return 2;
      }
      try {
        setPluginEnabled(home, name, action === "enable");
        ok(ctx, `${action}d: ${name}${action === "disable" ? " (stays installed; not mounted at startup)" : ""}`);
        return 0;
      } catch (e: any) {
        bad(ctx, `plugin ${action} failed: ${e?.message || e}`);
        return 1;
      }
    }
    case "config": {
      // plugin config <name> '<json>'   |   plugin config <name> --clear
      const name = rest[0];
      if (!name) {
        bad(ctx, `usage: plugin config <name> '<json>'   (or --clear)`);
        return 2;
      }
      try {
        if (args.flags.clear) {
          setPluginConfig(home, name, {});
          ok(ctx, `config cleared: ${name}`);
          return 0;
        }
        const raw = rest.slice(1).join(" ").trim();
        if (!raw) {
          const cur = listPlugins(home).find((p: any) => p.name === name);
          if (!cur) {
            bad(ctx, `'${name}' is not in the user bundle`);
            return 1;
          }
          const bundle = require("../../../packages/ops/tools/src/plugins").readUserBundle(home).find((p: any) => p.name === name);
          out(ctx, JSON.stringify(bundle?.config ?? {}, null, 2));
          return 0;
        }
        const parsed = JSON.parse(raw);
        setPluginConfig(home, name, parsed);
        ok(ctx, `config set: ${name}`);
        return 0;
      } catch (e: any) {
        bad(ctx, `plugin config failed: ${e?.message || e}`);
        return 1;
      }
    }
    case "list":
    case "": {
      const rows = listPlugins(home).map((r: any) => ({
        ...r,
        ok: r.resolvable ? "✓" : "✗ 不可解析",
        state: r.enabled ? "启用" : "停用",
        cfg: r.has_config ? "有" : "—",
      }));
      if (ctx.json) {
        console.log(JSON.stringify(rows, null, 2));
        return 0;
      }
      head(ctx, `User plugins (${rows.length})  — profile: ${profileDir(home)}`);
      table(ctx, rows, ["name", "version", "state", "cfg", "spec", "ok"], ["name", "version", "state", "cfg", "spec", "ok"]);
      if (!rows.length) out(ctx, "  (empty — plugin init, then plugin install <spec>)");
      return 0;
    }
    default:
      bad(ctx, "usage: plugin [init|install <spec>|remove <name>|list]");
      return 2;
  }
}
