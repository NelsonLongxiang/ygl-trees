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
      // #44 F1: a flag-less (sid-less) process shares the "default" bucket. In a
      // multi-project workspace `project new` re-points every other sid-less
      // agent — state it in the JSON face too, not just in human output.
      const sid = sessionId();
      return getOrm(env.db.path)
        .then((ds) => writes.projectCreate(ds, name, question))
        .then((p): number => {
          logSelectionEvent("project.use", p.name);
          // count AFTER creation: the workspace is now multi-project if it was
          // not before, which is exactly when the shared bucket bites.
          const sharedWarning = sid === "default" && projectCount(store.db) > 1
            ? `selection written to the shared "default" bucket (prior: ${prior || "none"}); every session-less agent now resolves to '${p.name}' — pin with --project or YGL_SESSION`
            : undefined;
          if (sharedWarning && !ctx.json) {
            out(ctx, paint(C.yellow, `  ! ${sharedWarning}`, ctx.color));
          }
          ack(
            ctx,
            {
              ...p,
              selected: p.name,
              prior: prior || null,
              session: sid,
              ...(sharedWarning ? { selection_warning: sharedWarning } : {}),
            },
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
      // #82（验证席 d）：archived 永不标 current（软删项目不是工作目标）
      const marked = rows.map((r: any) => ({ ...r, current: r.name === cur && String(r.status || "active") !== "archived" }));
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
      const found = store.projectByName(name) as any;
      if (!found) {
        bad(ctx, `project not found: ${name}`);
        return 1;
      }
      // #82（验证席 direct-08d214ee b）：归档项目默认**拒选**——要显式 --archived 才选（只读巡查用）。
      if (String(found.status || "active") === "archived" && args.flags.archived !== true && args.flags.archived !== "true") {
        bad(ctx, `project ${name} is archived — pass --archived to select it for read-only inspection, or create a new project`);
        return 1;
      }
      // R16.2: default writes the session key (parallel sessions no longer
      // steal each other's selection); --global is the explicit opt-in that
      // writes the migration-fallback pointer.
      const scope = args.flags.global === true || args.flags.global === "true" ? "global" : "session";
      const sid = sessionId();
      const prior = store.db.metaGet(scope === "global" ? "current_project" : `current_project@${sid}`);
      store.db.metaSet(scope === "global" ? "current_project" : `current_project@${sid}`, name);
      logSelectionEvent("project.use", name);
      // #44 F1: the JSON face of `project use` must show what it replaced and
      // whether the selection landed in the shared "default" bucket.
      const sharedWarning = scope === "session" && sid === "default" && projectCount(store.db) > 1
        ? `selection written to the shared "default" bucket; every session-less agent now resolves to '${name}' — pin with --project or YGL_SESSION`
        : undefined;
      if (sharedWarning && !ctx.json) {
        out(ctx, paint(C.yellow, `  ! ${sharedWarning}`, ctx.color));
      }
      ack(
        ctx,
        { project: name, scope, session: sid, selected: name, prior: prior || null, ...(sharedWarning ? { selection_warning: sharedWarning } : {}) },
        `now using: ${name}  (${scope} selection${scope === "session" ? ` — session ${sid.slice(0, 8)}` : ""})`
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
    case "rm": {
      // #82（总工裁 direct-a7b1e30a；复核 direct-9ea58cd0 B）：软删默认、**拒绝并列资产计数、不级联**。
      // 有资产 → 点名计数（claims/evidence/sources/queries/artifacts/trees 各 N）→ rc1；
      // 用户自行迁移/清理后再删。--force 只对**空项目**做硬删（级联在 agent 批量脚本下是灾难放大器）。
      const name = rest[0] || String(args.flags.project || args.flags.p || "");
      if (!name) {
        bad(ctx, "usage: project rm <name> [--force]   (default: soft delete = status archived, assets untouched)");
        return 2;
      }
      const resolved = store.projectByName(name);
      if (!resolved) {
        bad(ctx, `project not found: ${name}`);
        return 1;
      }
      const counts: Record<string, number> = {};
      for (const t of ["queries", "sources", "evidence", "claims", "artifacts", "trees"]) {
        const r = store.db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id=?`, [resolved.id]) as any;
        counts[t] = Number(r?.n ?? 0);
      }
      const named = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${t} ${n}`)
        .join(" · ");
      if (!args.flags.force) {
        return getOrm(env.db.path)
          .then((ds) => writes.projectArchive(ds, resolved.name))
          .then((r): number => {
            // 归档即退出选择：清本会话桶（否则 list 把 archived 标成 current，验证席 d）
            const key = `current_project@${sessionId()}`;
            if (store.db.metaGet(key) === resolved.name) store.db.metaSet(key, "");
            if (ctx.json) {
              console.log(JSON.stringify({ ...r, soft: true, remaining: counts }, null, 2));
              return 0;
            }
            ok(ctx, `project archived: ${resolved.name}  (status=archived; assets untouched)`);
            if (named) out(ctx, paint(C.dim, `  remains: ${named} — archiving keeps the evidence chain intact`, ctx.color));
            return 0;
          });
      }
      if (named) {
        // 非空 + --force = 拒绝（无级联），按类型点名
        bad(ctx, `project not empty — refusing hard delete (no cascade): ${named}. Migrate or clean them first, or use the default soft delete (drop --force)`);
        return 1;
      }
      return getOrm(env.db.path)
        .then((ds) => writes.projectDeleteEmpty(ds, resolved.name))
        .then((r): number => {
          if ((r as any).refused) {
            bad(ctx, `project not empty — refusing hard delete (no cascade): ${Object.entries((r as any).counts || {}).filter(([, n]) => Number(n) > 0).map(([t, n]) => `${t} ${n}`).join(" · ")}`);
            return 1;
          }
          if (ctx.json) {
            console.log(JSON.stringify({ ...r, deleted: true }, null, 2));
            return 0;
          }
          ok(ctx, `project deleted: ${resolved.name}  (was empty)`);
          return 0;
        });
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
