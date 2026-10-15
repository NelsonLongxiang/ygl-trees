/** project group — one project = one research thread. */
import { Env } from "../cli";
import { ok, bad, out, head, table, show, paint, C, ack } from "../fmt";

export function run(env: Env, action: string, rest: string[], args: any): number {
  const { ctx, store } = env;
  const name = rest[0];

  switch (action) {
    case "new": {
      if (!name) {
        bad(ctx, "missing project name");
        return 2;
      }
      const p = store.projectCreate(name, String(args.flags.q || args.flags.question || ""));
      ack(ctx, p, `project created and selected: ${p.name}`);
      return 0;
    }
    case "list": {
      const rows = store.projectList();
      const cur = store.db.metaGet("current_project");
      // keep `name` clean for --json consumers; mark the current project separately
      const marked = rows.map((r: any) => ({ ...r, current: r.name === cur }));
      table(ctx, marked, ["project", "status", "src", "claims", "artifacts", "updated"], [
        "name",
        "status",
        "sources",
        "claims",
        "artifacts",
        "updated",
      ]);
      return 0;
    }
    case "use": {
      if (!name) {
        bad(ctx, "missing project name");
        return 2;
      }
      if (!store.projectByName(name)) {
        bad(ctx, `project not found: ${name}`);
        return 1;
      }
      store.db.metaSet("current_project", name);
      ack(ctx, { project: name }, `now using: ${name}`);
      return 0;
    }
    case "show": {
      const p = store.projectResolve(args.flags.p ? String(args.flags.p) : undefined);
      const q = store.queryList(p.id);
      const cl = store.claimList(p.id);
      if (ctx.json) {
        console.log(JSON.stringify({ project: p, queries: q, claims: cl }, null, 2));
        return 0;
      }
      head(ctx, `Project ${p.name}`);
      show(ctx, {
        id: p.id,
        status: p.status,
        question: p.question || "(none)",
        inclusion: p.inclusion || "-",
        exclusion: p.exclusion || "-",
        queries: q.length,
        claims: cl.length,
      });
      return 0;
    }
    case "":
      out(ctx, paint(C.dim, "  project: new <name> [-q question] | list | use <name> | show", ctx.color));
      return 0;
    default:
      bad(ctx, `unknown project action: ${action}`);
      return 2;
  }
}
