/** project group — one project = one research thread.
 *  `project show` is the TypeORM pilot (src/orm.ts): async command, output
 *  shape identical to the previous raw-SQL implementation. */
import { Env } from "../../../core/database/src/types";
import { ok, bad, out, head, table, show, paint, C, ack } from "../../../core/text/src/fmt";
import { getOrm } from "../../../core/database/src/orm";
import * as writes from "../../pipeline/src/writes";
import { Project } from "../../pipeline/src/entities";

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx, store } = env;
  const name = rest[0];

  switch (action) {
    case "new": {
      if (!name) {
        bad(ctx, "missing project name");
        return 2;
      }
      const question = String(args.flags.q || args.flags.question || "");
      return getOrm(env.db.path)
        .then((ds) => writes.projectCreate(ds, name, question))
        .then((p): number => {
          ack(ctx, p, `project created and selected: ${p.name}`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
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
      const resolved = store.projectResolve(args.flags.p ? String(args.flags.p) : undefined);
      return getOrm(env.db.path)
        .then(async (ds): Promise<number> => {
          const proj = await ds.getRepository(Project).findOne({
            where: { id: resolved.id },
            relations: { queries: { querySources: true }, claims: { claimEvidence: true } },
            order: { queries: { created: "ASC" }, claims: { created: "ASC" } },
          });
          if (!proj) {
            bad(ctx, `project not found: ${resolved.name}`);
            return 1;
          }
          // explicit mapping keeps the output shape byte-compatible with the
          // raw-SQL era (snake-free keys, derived counts) — agents parse this
          const queries = (proj.queries ?? []).map((q: any) => ({
            id: q.id,
            text: q.text,
            engine: q.engine,
            status: q.status,
            created: q.created,
            sources: q.querySources?.length ?? 0,
          }));
          const claims = (proj.claims ?? []).map((c: any) => ({
            id: c.id,
            text: c.text,
            status: c.status,
            confidence: c.confidence,
            sup: (c.claimEvidence ?? []).filter((ce: any) => ce.stance === "supports").length,
            ref: (c.claimEvidence ?? []).filter((ce: any) => ce.stance === "refutes").length,
          }));
          const project = {
            id: proj.id,
            name: proj.name,
            question: proj.question,
            inclusion: proj.inclusion,
            exclusion: proj.exclusion,
            status: proj.status,
            created: proj.created,
            updated: proj.updated,
          };
          if (ctx.json) {
            console.log(JSON.stringify({ project, queries, claims }, null, 2));
            return 0;
          }
          head(ctx, `Project ${project.name}`);
          show(ctx, {
            id: project.id,
            status: project.status,
            question: project.question || "(none)",
            inclusion: project.inclusion || "-",
            exclusion: project.exclusion || "-",
            queries: queries.length,
            claims: claims.length,
          });
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, `orm query failed: ${e?.message || e}`);
          return 1;
        });
    }
    case "":
      out(ctx, paint(C.dim, "  project: new <name> [-q question] | list | use <name> | show", ctx.color));
      return 0;
    default:
      bad(ctx, `unknown project action: ${action}`);
      return 2;
  }
}
