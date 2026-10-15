/** research group — collect → screen → extract → claim. */
import * as fs from "node:fs";
import { Env } from "../cli";
import { ok, bad, out, head, table, paint, C } from "../fmt";
import { clip } from "../text";

export function run(env: Env, action: string, rest: string[], args: any): number {
  const { ctx, store } = env;
  const sub = action;
  const subAction = rest[0];

  // -- project resolution (allow --p override) -----------------------------
  let project: any;
  try {
    project = store.projectResolve(args.flags.p ? String(args.flags.p) : undefined);
  } catch (e: any) {
    bad(ctx, e.message);
    return 1;
  }

  const readBody = (): string => {
    if (args.flags.body) return String(args.flags.body);
    if (args.flags.f) return fs.readFileSync(String(args.flags.f), "utf8");
    return "";
  };
  const force = args.flags.force === true || args.flags.force === "true";

  if (sub === "query") {
    if (subAction === "add") {
      const text = rest.slice(1).join(" ") || String(args.flags.text || "");
      if (!text) {
        bad(ctx, 'missing query text: research query add "<text>"');
        return 2;
      }
      const q = store.queryAdd(project.id, text, String(args.flags.engine || ""), force);
      if (q.dup) out(ctx, paint(C.yellow, `  ! duplicate, kept existing: ${q.row.id}`, ctx.color));
      else ok(ctx, `query registered: ${q.row.id}  ${clip(text, 60)}`);
      return 0;
    }
    if (subAction === "list" || subAction === undefined) {
      table(ctx, store.queryList(project.id), ["id", "query", "engine", "status", "created"], [
        "id",
        "text",
        "engine",
        "status",
        "created",
      ]);
      return 0;
    }
    if (subAction === "done") {
      if (!rest[1] || !store.db.get("SELECT 1 AS hit FROM queries WHERE id=?", [rest[1]])) {
        bad(ctx, `query not found: ${rest[1]}`);
        return 1;
      }
      store.queryDone(rest[1]);
      ok(ctx, `query marked done: ${rest[1]}`);
      return 0;
    }
  }

  if (sub === "source") {
    if (subAction === "add") {
      const title = String(args.flags.title || "");
      const url = String(args.flags.url || "");
      if (!title && !url) {
        bad(ctx, "need --title and/or --url");
        return 2;
      }
      const res = store.sourceAdd(project.id, {
        title,
        url,
        abstract: String(args.flags.abstract || ""),
        content: readBody() || String(args.flags.content || ""),
        engine: String(args.flags.engine || ""),
        relevance: Number(args.flags.relevance || 0),
        confidence: String(args.flags.confidence || "B"),
        tags: String(args.flags.tags || ""),
      });
      if (res.dup) out(ctx, paint(C.yellow, `  ! duplicate, kept existing: ${res.row.id}`, ctx.color));
      else ok(ctx, `source added: ${res.row.id}  ${clip(res.row.title, 60)}`);
      return 0;
    }
    if (subAction === "list") {
      table(ctx, store.sourceList(project.id, Number(args.flags.min || -1)), [
        "id",
        "title",
        "engine",
        "rel",
        "conf",
        "retrieved",
      ], ["id", "title", "engine", "relevance", "confidence", "retrieved_at"]);
      return 0;
    }
    if (subAction === "search") {
      const q = rest.slice(1).join(" ");
      if (!q) {
        bad(ctx, "missing search text");
        return 2;
      }
      const rows = store.sourceSearch(project.id, q).map((r: any) => ({
        id: r.id,
        title: clip(r.title, 50),
        rel: r.relevance,
        conf: r.confidence,
        score: typeof r.score === "number" ? r.score.toFixed(2) : "-",
      }));
      table(ctx, rows, ["id", "title", "rel", "conf", "score"], ["id", "title", "rel", "conf", "score"]);
      return 0;
    }
    if (subAction === "show") {
      const s = store.sourceGet(rest[1]);
      if (!s) {
        bad(ctx, "source not found");
        return 1;
      }
      if (ctx.json) {
        console.log(JSON.stringify(s, null, 2));
        return 0;
      }
      head(ctx, s.title);
      out(ctx, paint(C.dim, `  id ${s.id}  url ${s.url || "-"}  conf ${s.confidence}`, ctx.color));
      out(ctx, s.content || s.abstract || "");
      return 0;
    }
    if (subAction === "rm") {
      if (!rest[1] || !store.sourceGet(rest[1])) {
        bad(ctx, `source not found: ${rest[1]}`);
        return 1;
      }
      store.sourceDel(rest[1]);
      ok(ctx, `source removed: ${rest[1]}`);
      return 0;
    }
  }

  if (sub === "evidence") {
    if (subAction === "add") {
      const sourceId = rest[1];
      const quote = String(args.flags.quote || readBody());
      if (!sourceId || !quote) {
        bad(ctx, "usage: research evidence add <sourceId> --quote \"...\"");
        return 2;
      }
      if (!store.sourceGet(sourceId)) {
        bad(ctx, `source not found: ${sourceId}`);
        return 1;
      }
      const e = store.evidenceAdd(
        project.id,
        sourceId,
        quote,
        String(args.flags.note || ""),
        String(args.flags.locator || ""),
        force
      );
      if (e.dup) out(ctx, paint(C.yellow, `  ! duplicate, kept existing: ${e.row.id}`, ctx.color));
      else ok(ctx, `evidence added: ${e.row.id}  ${clip(quote, 50)}`);
      return 0;
    }
    if (subAction === "list" || subAction === undefined) {
      const rows = store.evidenceList(project.id).map((r: any) => ({ ...r, quote: clip(r.quote, 60) }));
      table(ctx, rows, ["id", "source", "locator", "quote", "used_by"], ["id", "source", "locator", "quote", "used_by"]);
      return 0;
    }
  }

  if (sub === "claim") {
    if (subAction === "add") {
      const text = rest.slice(1).join(" ") || String(args.flags.text || "");
      if (!text) {
        bad(ctx, 'missing claim text: research claim add "<text>"');
        return 2;
      }
      const c = store.claimAdd(project.id, text, String(args.flags.confidence || "B"), force);
      if (c.dup) out(ctx, paint(C.yellow, `  ! duplicate, kept existing: ${c.row.id}`, ctx.color));
      else ok(ctx, `claim added: ${c.row.id}  ${clip(text, 60)}`);
      return 0;
    }
    if (subAction === "link") {
      if (!rest[1] || !rest[2]) {
        bad(ctx, "usage: research claim link <claimId> <evidenceId> [--stance refutes]");
        return 2;
      }
      const stance = String(args.flags.stance || "supports") as "supports" | "refutes";
      store.claimLink(rest[1], rest[2], stance);
      const c = store.db.get("SELECT status FROM claims WHERE id=?", [rest[1]]);
      ok(ctx, `linked; claim status now: ${c?.status}`);
      return 0;
    }
    if (subAction === "list" || subAction === undefined) {
      const rows = store.claimList(project.id).map((r: any) => ({ ...r, text: clip(r.text, 60) }));
      table(ctx, rows, ["id", "text", "status", "conf", "sup", "ref"], ["id", "text", "status", "confidence", "sup", "ref"]);
      return 0;
    }
  }

  out(
    ctx,
    paint(
      C.dim,
      "  research: query add|list · source add|list|search|show|rm · evidence add|list · claim add|link|list",
      ctx.color
    )
  );
  return 0;
}
