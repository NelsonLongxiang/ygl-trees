/** project group — one project = one research thread.
 *  `project show` is the TypeORM pilot (src/orm.ts): async command, output
 *  shape identical to the previous raw-SQL implementation. */
import { Env } from "../../../core/database/src/types";
import { ok, bad, out, head, table, show, paint, C, ack } from "../../../core/text/src/fmt";
import { getOrm } from "../../../core/database/src/orm";
import { resolveProject, ambiguousProject, projectSample, projectCount, sessionId } from "../../../core/database/src/selection";
import * as writes from "../../pipeline/src/writes";
import { Project } from "../../pipeline/src/entities";

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx, store } = env;
  const name = rest[0];

  /** Report ③-3: selection changes are events (session-tagged) — see the
   *  twin helper in techtree/model/src/cmds.ts for the rationale. */
  function logSelectionEvent(kind: "project.use", projName: string): void {
    try {
      store.db.run(
        "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,?)",
        [
          `ev${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          new Date().toISOString(),
          process.env.YGL_SESSION || "cli",
          kind,
          "project",
          projName,
          JSON.stringify({ name: projName, session: process.env.YGL_SESSION || "cli" }),
          "info",
        ]
      );
    } catch { /* telemetry only */ }
  }

  switch (action) {
    case "new": {
      if (!name) {
        bad(ctx, "missing project name");
        return 2;
      }
      const question = String(args.flags.q || args.flags.question || "");
      // Feedback confirmation ②: auto-selecting the new project silently
      // re-points every flag-less command away from prior work — say so.
      // R16.2: selection is session-scoped now; compare against this
      // session's prior choice.
      const prior = store.db.metaGet(`current_project@${sessionId()}`);
      const priorHint = prior && prior !== name
        ? `  (prior project '${prior}' is no longer selected — project use ${prior} to switch back)`
        : "";
      return getOrm(env.db.path)
        .then((ds) => writes.projectCreate(ds, name, question))
        .then((p): number => {
          logSelectionEvent("project.use", p.name);
          ack(
            ctx,
            p,
            p?.duplicate === true
              ? `project exists, selected: ${p.name}  (duplicate, not re-created)${priorHint}`
              : `project created and selected: ${p.name}${priorHint}`
          );
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }
    case "list": {
      const rows = store.projectList();
      // R16: mark by the resolved selection — but only sources that would
      // AUTHORIZE a project-scoped command (flag/env/session/only). A global
      // pointer or no selection does not authorize `research *`, so marking a
      // project current there would contradict the strict gate (review P2).
      const sel = resolveProject(store.db, undefined);
      const authorizes =
        sel.source === "flag" || sel.source === "env" || sel.source === "session" || sel.source === "only";
      const cur = authorizes ? sel.name : null;
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
      // R16.2: default writes the session key (parallel sessions no longer
      // steal each other's selection); --global is the explicit opt-in that
      // writes the migration-fallback pointer.
      const scope = args.flags.global === true || args.flags.global === "true" ? "global" : "session";
      store.db.metaSet(scope === "global" ? "current_project" : `current_project@${sessionId()}`, name);
      logSelectionEvent("project.use", name);
      ack(
        ctx,
        { project: name, scope, session: sessionId() },
        `now using: ${name}  (${scope} selection${scope === "session" ? ` — session ${sessionId().slice(0, 8)}` : ""})`
      );
      // 0.87 (user ruling m07308): bare shells share the "default" session
      // key — parallel terminals on different projects would stomp each
      // other. Explicit pinning is first-class; env identity is the fallback.
      if (!ctx.json && scope === "session" && sessionId() === "default" && projectCount(store.db) > 1) {
        out(ctx, paint(C.dim, `hint: shells without a session id share one "default" selection — parallel sessions on different projects interfere.`, ctx.color));
        out(ctx, paint(C.dim, `      pin explicitly (recommended): ygl-trees <cmd> --project ${name} · or isolate this shell: export YGL_SESSION=<name>`, ctx.color));
      }
      return 0;
    }
    case "show": {
      // R16.3: project show is project-scoped — same strict gate as research.
      const sel = resolveProject(
        store.db,
        args.flags.p ?? args.flags.project ? String(args.flags.p ?? args.flags.project) : undefined
      );
      if (ambiguousProject(store.db, sel)) {
        bad(
          ctx,
          `ambiguous project: ${projectCount(store.db)} projects in workspace; pass --project <name> or run ygl-trees project use <name>; projects: ${projectSample(store.db).join(", ")}`
        );
        return 2;
      }
      if (!sel.name) {
        bad(ctx, "no project selected; run: ygl-trees project new <name>");
        return 1;
      }
      const resolved = store.projectByName(sel.name);
      if (!resolved) {
        bad(ctx, `project not found: ${sel.name}`);
        return 1;
      }
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
            console.log(JSON.stringify({ project, queries, claims, selection_source: sel.source }, null, 2));
            return 0;
          }
          head(ctx, `Project ${project.name}  (selection: ${sel.source})`);
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
