/** research group — collect → screen → extract → claim.
 *  `source fetch` is async (Node 18+ global fetch) and returns a promise.
 *  List commands run on TypeORM (src/orm.ts); search stays raw SQL (FTS5). */
import * as fs from "node:fs";
import { MoreThanOrEqual } from "typeorm";
import { Env } from "../cli";
import { ok, bad, out, head, table, paint, C, writeResult } from "../fmt";
import { clip } from "../text";
import { getOrm } from "../orm";
import * as writes from "../writes";
import { Claim, Evidence, Query, Source } from "../entities/research";

/** Run a write through the TypeORM transactional write service and print
 *  with JSON discipline. Keeps every write command 6 lines. */
function runWrite(env: Env, fn: (ds: any) => Promise<writes.WriteResult>, human: (row: any) => string): Promise<number> {
  const { ctx } = env;
  return getOrm(env.db.path)
    .then(fn)
    .then((r) => {
      writeResult(ctx, r as any, human);
      return 0;
    })
    .catch((e: any) => {
      bad(ctx, e?.message || String(e));
      return 1;
    });
}

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
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
      const engine = String(args.flags.engine || "");
      return runWrite(env, (ds) => writes.queryAdd(ds, project.id, text, engine, force), (r) => `query registered: ${r.id}  ${clip(text, 60)}`);
    }
    if (subAction === "attach") {
      if (!rest[1] || !rest[2]) {
        bad(ctx, "usage: research query attach <queryId|text> <sourceId> [--note ..]");
        return 2;
      }
      const note = String(args.flags.note || "");
      return getOrm(env.db.path)
        .then((ds) => writes.queryAttach(ds, project.id, rest[1], rest[2], note))
        .then((r): number => {
          if (r.dup) out(ctx, paint(C.yellow, `  ! already attached: ${r.sourceId}`, ctx.color));
          else ok(ctx, `attached: ${clip(r.sourceTitle || r.sourceId, 40)} → "${clip(r.queryText, 40)}"`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }
    if (subAction === "list" || subAction === undefined) {
      return getOrm(env.db.path)
        .then(async (ds): Promise<number> => {
          const qs = await ds.getRepository(Query).find({
            where: { projectId: project.id },
            relations: { querySources: true },
            order: { created: "ASC" },
          });
          const rows = qs.map((q) => ({
            id: q.id,
            text: q.text,
            engine: q.engine,
            status: q.status,
            created: q.created,
            sources: q.querySources?.length ?? 0,
          }));
          table(ctx, rows, ["id", "query", "engine", "status", "sources", "created"], [
            "id",
            "text",
            "engine",
            "status",
            "sources",
            "created",
          ]);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, `orm query failed: ${e?.message || e}`);
          return 1;
        });
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
      const spec = {
        title,
        url,
        abstract: String(args.flags.abstract || ""),
        content: readBody() || String(args.flags.content || ""),
        engine: String(args.flags.engine || ""),
        relevance: Number(args.flags.relevance || 0),
        confidence: String(args.flags.confidence || "B"),
        tags: String(args.flags.tags || ""),
      };
      const qRef = String(args.flags.query || "");
      return getOrm(env.db.path)
        .then(async (ds): Promise<number> => {
          const r = await writes.sourceAdd(ds, project.id, spec);
          writeResult(ctx, r as any, (row) => `source added: ${row.id}  ${clip(row.title, 60)}`);
          if (qRef) {
            const at = await writes.queryAttach(ds, project.id, qRef, r.row.id);
            if (!ctx.json && !at.dup) out(ctx, paint(C.dim, `  attached to query: "${clip(at.queryText, 40)}"`, ctx.color));
          }
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }
    if (subAction === "fetch") {
      const url = rest[1];
      if (!url || !/^https?:\/\//i.test(url)) {
        bad(ctx, "usage: research source fetch <http(s)://url> [--tags ..] [--confidence A|B|C]");
        return 2;
      }
      // Node 18+ global fetch; nothing is stored unless the whole pipeline
      // succeeds, so a failed fetch leaves zero side effects. Returns a
      // promise so main() keeps the db open until the fetch settles.
      return fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
        headers: { "user-agent": "ygl-trees/0.4 (+local research cli)" },
      })
        .then(async (res): Promise<number> => {
          if (!res.ok) {
            bad(ctx, `fetch failed: HTTP ${res.status} ${url}`);
            return 1;
          }
          const ct = res.headers.get("content-type") || "";
          if (!/text\/html|application\/xhtml|text\/plain/i.test(ct)) {
            bad(ctx, `unsupported content-type '${ct || "(none)"}' — fetch handles html/plain only (no JS rendering)`);
            return 1;
          }
          const raw = await res.text();
          const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(raw)?.[1] || url).replace(/\s+/g, " ").trim().slice(0, 200);
          const metaDesc =
            (/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(raw)?.[1] ||
              /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(raw)?.[1] ||
              "").replace(/\s+/g, " ").trim();
          const text = raw
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<!--[\s\S]*?-->/g, " ")
            .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, "\n")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/[ \t]+/g, " ")
            .replace(/\n\s*\n+/g, "\n")
            .trim()
            .slice(0, 50_000);
          const thin = text.replace(/\s/g, "").length < 500;
          const ds = await getOrm(env.db.path);
          const r = await writes.sourceAdd(ds, project.id, {
            title,
            url,
            abstract: metaDesc.slice(0, 500),
            content: text,
            engine: "fetch",
            relevance: 0,
            confidence: String(args.flags.confidence || "B"),
            tags: String(args.flags.tags || (thin ? "needs_review" : "")),
          });
          writeResult(ctx, r as any, (row) => `fetched: ${row.id}  ${clip(title, 60)}`);
          if (!ctx.json)
            out(
              ctx,
              paint(
                C.dim,
                `  ${(text.length / 1000).toFixed(1)}k chars text · ${metaDesc ? "meta description" : "no meta"}${thin ? " · thin content → tagged needs_review" : ""}`,
                ctx.color
              )
            );
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, `fetch failed: ${e?.message || e} (15s timeout; JS-rendered sites unsupported)`);
          return 1;
        });
    }
    if (subAction === "list") {
      const min = Number(args.flags.min || -1);
      return getOrm(env.db.path)
        .then(async (ds): Promise<number> => {
          const srcs = await ds.getRepository(Source).find({
            where: { projectId: project.id, relevance: MoreThanOrEqual(Number.isFinite(min) ? min : -1) },
            order: { relevance: "DESC", retrievedAt: "DESC" },
          });
          const rows = srcs.map((s) => ({
            id: s.id,
            title: s.title,
            url: s.url,
            engine: s.engine,
            relevance: s.relevance,
            confidence: s.confidence,
            retrieved_at: s.retrievedAt,
          }));
          table(ctx, rows, ["id", "title", "engine", "rel", "conf", "retrieved"], [
            "id",
            "title",
            "engine",
            "relevance",
            "confidence",
            "retrieved_at",
          ]);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, `orm query failed: ${e?.message || e}`);
          return 1;
        });
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
      const note = String(args.flags.note || "");
      const locator = String(args.flags.locator || "");
      return runWrite(
        env,
        (ds) => writes.evidenceAdd(ds, project.id, sourceId, quote, note, locator, force),
        (r) => `evidence added: ${r.id}  ${clip(quote, 50)}`
      );
    }
    if (subAction === "list" || subAction === undefined) {
      return getOrm(env.db.path)
        .then(async (ds): Promise<number> => {
          const evs = await ds.getRepository(Evidence).find({
            where: { projectId: project.id },
            relations: { source: true, claimEvidence: true },
            order: { created: "ASC" },
          });
          const rows = evs.map((e) => ({
            id: e.id,
            source: e.source?.title ?? "",
            locator: e.locator,
            quote: clip(e.quote, 60),
            used_by: e.claimEvidence?.length ?? 0,
          }));
          table(ctx, rows, ["id", "source", "locator", "quote", "used_by"], ["id", "source", "locator", "quote", "used_by"]);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, `orm query failed: ${e?.message || e}`);
          return 1;
        });
    }
  }

  if (sub === "claim") {
    if (subAction === "add") {
      const text = rest.slice(1).join(" ") || String(args.flags.text || "");
      if (!text) {
        bad(ctx, 'missing claim text: research claim add "<text>"');
        return 2;
      }
      const confidence = String(args.flags.confidence || "B");
      return runWrite(
        env,
        (ds) => writes.claimAdd(ds, project.id, text, confidence, force),
        (r) => `claim added: ${r.id}  ${clip(text, 60)}`
      );
    }
    if (subAction === "link") {
      if (!rest[1] || !rest[2]) {
        bad(ctx, "usage: research claim link <claimId> <evidenceId> [--stance refutes]");
        return 2;
      }
      const stance = String(args.flags.stance || "supports") as "supports" | "refutes";
      return getOrm(env.db.path)
        .then((ds) => writes.claimLink(ds, rest[1], rest[2], stance))
        .then((r): number => {
          ok(ctx, `linked; claim status now: ${r.status}`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }
    if (subAction === "resolve") {
      const id = rest[1];
      const as = String(args.flags.as || "");
      const valid = ["supported", "refuted", "contested", "unverified"];
      if (!id || !valid.includes(as)) {
        bad(ctx, "usage: research claim resolve <claimId> --as supported|refuted|contested|unverified [--note \"..\"]");
        return 2;
      }
      const c0 = store.db.get("SELECT id, status FROM claims WHERE id=? AND project_id=?", [id, project.id]);
      if (!c0) {
        bad(ctx, `claim not found: ${id}`);
        return 1;
      }
      const note = String(args.flags.note || "");
      return getOrm(env.db.path)
        .then((ds) => writes.claimResolve(ds, id, as, note))
        .then((): number => {
          if (ctx.json) console.log(JSON.stringify({ id, status: as, note }, null, 2));
          else ok(ctx, `claim ${id}: ${c0.status} → ${as}  (manual arbitration; new evidence links re-derive)`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }
    if (subAction === "list" || subAction === undefined) {
      return getOrm(env.db.path)
        .then(async (ds): Promise<number> => {
          const cls = await ds.getRepository(Claim).find({
            where: { projectId: project.id },
            relations: { claimEvidence: true },
            order: { created: "ASC" },
          });
          const rows = cls.map((c) => ({
            id: c.id,
            text: clip(c.text, 60),
            status: c.status,
            confidence: c.confidence,
            sup: (c.claimEvidence ?? []).filter((ce) => ce.stance === "supports").length,
            ref: (c.claimEvidence ?? []).filter((ce) => ce.stance === "refutes").length,
          }));
          table(ctx, rows, ["id", "text", "status", "conf", "sup", "ref"], ["id", "text", "status", "confidence", "sup", "ref"]);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, `orm query failed: ${e?.message || e}`);
          return 1;
        });
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
