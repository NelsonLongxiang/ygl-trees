/**
 * Plugin package management — launcher-owned, dispatched directly by bin.ts
 * before the domain routes (DSH apps/cli exemplar: `dsh plugin` is a bin
 * mode, not a domain package command). Profile operations live in
 * packages/ops/tools/src/plugins.ts (gated, vitest-covered, doctor-shared).
 */
import { initProfile, installPlugin, removePlugin, listPlugins, profileDir } from "../../../packages/ops/tools/src/plugins";
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
    case "list":
    case "": {
      const rows = listPlugins(home).map((r: any) => ({ ...r, ok: r.resolvable ? "✓" : "✗ 不可解析" }));
      if (ctx.json) {
        console.log(JSON.stringify(rows, null, 2));
        return 0;
      }
      head(ctx, `User plugins (${rows.length})  — profile: ${profileDir(home)}`);
      table(ctx, rows, ["name", "version", "spec", "ok"], ["name", "version", "spec", "ok"]);
      if (!rows.length) out(ctx, "  (empty — plugin init, then plugin install <spec>)");
      return 0;
    }
    default:
      bad(ctx, "usage: plugin [init|install <spec>|remove <name>|list]");
      return 2;
  }
}
