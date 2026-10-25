/** research group — collect → screen → extract → claim.
 *  `source fetch` is async (Node 18+ global fetch) and returns a promise.
 *  List commands run on TypeORM (src/orm.ts); search stays raw SQL (FTS5). */
import * as fs from "node:fs";
import { MoreThanOrEqual } from "typeorm";
import { Env } from "../../../core/database/src/types";
import { ok, bad, out, head, table, paint, C, writeResult, show } from "../../../core/text/src/fmt";
import { rejectBare, validateEnum } from "../../../core/text/src/flagcheck";
import { clip } from "../../../core/text/src/text";
import { getOrm } from "../../../core/database/src/orm";
import { resolveProject, ambiguousProject, projectSample, projectCount, currentSelectionVia, selectionChangeWarning, idNotFound, ownerProjectName } from "../../../core/database/src/selection";
import * as writes from "./writes";
import { configGet, configGetNumber } from "../../../ops/tools/src/config";
// 0.91a: bare claim.eval INSERTs gain bus emission — static import per
// direct-032bf3b4 (require-in-catch silently dies under ESM hosts).
import { emitEvent } from "../../../core/text/src/eventbus";
import { Claim, Evidence, Query, Source } from "./entities";

/** Run a write through the TypeORM transactional write service and print
 *  with JSON discipline. Keeps every write command 6 lines. */
/** 0.80: compact timestamp for session:// adjudication urls (yyyymmddhhmm). */
function nowCompact(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
}

function runWrite(env: Env, fn: (ds: any) => Promise<writes.WriteResult>, human: (row: any) => string): Promise<number> {
  const { ctx } = env;
  // F1 (0.110.x): write receipts name the target project + the selection layer;
  // a bare write riding session/global selection in a multi-project workspace
  // gets a one-line stderr hint (JSON stdout stays a single object).
  const projectName = process.env.YGL_SELECTION_PROJECT || "";
  const via = currentSelectionVia();
  // 0.114.22 (K3 #K3-2): shared-bucket + recent same-dimension selection change
  // => the target may move under this write; warn (not refuse). No actor compare.
  const selectionWarning = selectionChangeWarning(env.db, "project", (via || "none") as any);
  if (!ctx.json && selectionWarning) process.stderr.write(`  note: ${selectionWarning}\n`);
  if (!ctx.json && projectName && via && via !== "flag" && via !== "env") {
    const n = Number((env.db.get("SELECT COUNT(*) AS n FROM projects") as any)?.n ?? 0);
    if (n > 1) {
      console.error(`  note: writing to project '${projectName}' via ${via} selection (cwd=${process.cwd()}) — pass -p <name> to bind the target explicitly`);
    }
  }
  return getOrm(env.db.path)
    .then(fn)
    .then((r) => {
      writeResult(ctx, r as any, human, {
        ...(projectName ? { project: projectName, project_source: via || undefined } : {}),
        ...(selectionWarning ? { selection_warning: selectionWarning } : {}),
      });
      return 0;
    })
    .catch((e: any) => {
      bad(ctx, e?.message || String(e));
      return 1;
    });
}

export async function run(env: Env, action: string, rest: string[], args: any): Promise<number> {
  const { ctx, store } = env;
  const sub = action;
  const subAction = rest[0];

  // -- project resolution (R16: flag > env > session > global; strict gate) --
  // R16.3 exemption: `claim calibration --all` and `predict list --all` are
  // workspace-scoped (project may be null) — the strict gate must not block
  // the research subcommands that legitimately span projects.
  // predict audit --all stays project-scoped (0.85 review ruling).
  const workspaceWide =
    args.flags.all === true &&
    (subAction === "calibration" || (sub === "predict" && subAction === "list"));
  let project: any;
  const sel = resolveProject(
    store.db,
    args.flags.p ?? args.flags.project ? String(args.flags.p ?? args.flags.project) : undefined
  );
  if (!workspaceWide && ambiguousProject(store.db, sel)) {
    // R16.3 fail-closed: a global pointer (or nothing) must not authorize
    // project-scoped commands in a multi-project workspace.
    bad(
      ctx,
      `ambiguous project: ${projectCount(store.db)} projects in workspace; pass --project <name> or run ygl-trees project use <name>; projects: ${projectSample(store.db).join(", ")}`
    );
    return 2;
  }
  if (!workspaceWide && !sel.name) {
    bad(ctx, "no project selected; run: ygl-trees project new <name>");
    return 1;
  }
  if (!workspaceWide) {
    project = await env.asyncStore.projectByName(sel.name);
    if (!project) {
      bad(ctx, `project not found: ${sel.name}`);
      return 1;
    }
  }
  process.env.YGL_SELECTION_PROJECT = project?.name || "";

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
          // #47 residual: query attach answers with the owning project, not a
          // generic "query not found" (scoped+owner naming is the current rule).
          const msg = e?.message || String(e);
          const qOwner = ownerProjectName(env.db, "queries", rest[1]);
          const sOwner = ownerProjectName(env.db, "sources", rest[2]);
          if (msg.startsWith("query not found") && qOwner) {
            bad(ctx, `query not found: ${rest[1]}  (it belongs to project '${qOwner}' — use -p ${qOwner})`);
            return 1;
          }
          if (msg.includes("source not found") && sOwner) {
            bad(ctx, `source not found: ${rest[2]}  (it belongs to project '${sOwner}' — use -p ${sOwner})`);
            return 1;
          }
          bad(ctx, msg);
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
      if (!rest[1]) {
        bad(ctx, "usage: research query done <queryId>");
        return 2;
      }
      {
        const q = store.db.get("SELECT project_id FROM queries WHERE id=?", [rest[1]]) as any;
        if (!q || q.project_id !== project.id) {
          bad(ctx, idNotFound(env.db, "queries", rest[1], "query"));
          return 1;
        }
      }
      await env.asyncStore.queryDone(rest[1]);
      ok(ctx, `query marked done: ${rest[1]}`);
      return 0;
    }
  }

  if (sub === "source") {
    if (subAction === "add") {
      // P1-1 fix: a flag given without a value arrives as boolean true — reject
      // it instead of silently storing "true" as the title/url (cold-user report).
      if (rejectBare(ctx, args.flags, ["abstract", "content", "relevance", "confidence", "tags", "query", "engine"])) return 2;
      // R284 fix: relevance is INTEGER 0-5 (screening score band); a REAL like
      // 0.95 passes SQLite's weak typing but explodes in PG migration
      // ("invalid input syntax for type integer") — reject at the CLI gate.
      if (args.flags.relevance !== undefined && args.flags.relevance !== "") {
        const rel = Number(args.flags.relevance);
        if (!Number.isInteger(rel) || rel < 0 || rel > 5) {
          bad(ctx, `--relevance must be an integer 0-5 (got: ${args.flags.relevance})`);
          return 2;
        }
      }
      if (validateEnum(ctx, args.flags, "confidence", ["A", "B", "C"])) return 2;
      const titleRaw = args.flags.title;
      const urlRaw = args.flags.url;
      if (titleRaw === true || urlRaw === true) {
        bad(ctx, 'flag needs a value: --title "..." / --url "..."  (bare flag was treated as boolean)');
        return 2;
      }
      let title = String(titleRaw || "");
      let url = String(urlRaw || "");
      // 0.80: in-session adjudication carrier — the most common human
      // arbitration form had no native --url shape (http(s)/file only),
      // forcing temp-file workarounds. `--adjudication "<裁决摘要>"`
      // fills url with a session:// pseudo-scheme and doubles as the
      // title when --title is absent.
      const adjRaw = args.flags.adjudication;
      if (adjRaw === true) {
        bad(ctx, 'flag needs a value: --adjudication "<裁决摘要>"');
        return 2;
      }
      if (adjRaw !== undefined && adjRaw !== "") {
        const adj = String(adjRaw);
        if (!url) url = `session://adjudication/${nowCompact()}`;
        if (!title) title = adj.slice(0, 60);
      }
      if (!title && !url) {
        bad(ctx, "need --title and/or --url");
        return 2;
      }
      if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
        // 0.81: any RFC-3986 scheme is a valid carrier — cross-agent refs
        // (a2a://peer/task), session://, file://, http(s):// … url_hash
        // dedupe protects the rest (user report: a2a:// rejected).
        bad(ctx, `--url must be <scheme>:// — https://, file://, session://, a2a:// … (got: "${clip(url, 30)}")`);
        return 2;
      }
      const spec = {
        title,
        url,
        abstract: String(args.flags.abstract || ""),
        content: readBody() || String(args.flags.content || ""),
        engine: String(args.flags.engine || ""),
        relevance: Number(args.flags.relevance || 0),
        confidence: String(args.flags.confidence || configGet(env.db, "default_confidence")),
        tags: String(args.flags.tags || ""),
      };
      const qRef = String(args.flags.query || "");
      // 0.83 (user report ①): half-write guard — `source add --query X` used
      // to commit the source FIRST and attach separately; a bad query ref
      // left the source landed with a pure error receipt (assets fragment
      // silently). Pre-validate the query ref before ANY write; if the
      // attach still fails post-write, name the landed source + the retry.
      if (qRef) {
        const q = store.db.get(
          "SELECT id FROM queries WHERE (id=? OR text=?) AND project_id=?",
          [qRef, qRef, project.id]
        );
        if (!q) {
          bad(ctx, `query not found: ${clip(qRef, 40)} — refusing to write (source add would land without its query link; fix the ref or drop --query)`);
          return 1;
        }
      }
      return getOrm(env.db.path)
        .then(async (ds): Promise<number> => {
          const r = await writes.sourceAdd(ds, project.id, spec);
          writeResult(ctx, r as any, (row) => `source added: ${row.id}  ${clip(row.title, 60)}  · project ${project.name}`);
          if (qRef) {
            try {
              const at = await writes.queryAttach(ds, project.id, qRef, r.row.id);
              if (!ctx.json && !at.dup) out(ctx, paint(C.dim, `  attached to query: "${clip(at.queryText, 40)}"`, ctx.color));
            } catch (e: any) {
              bad(ctx, `source landed as ${r.row.id} but attach failed: ${e?.message} — research query attach ${clip(qRef, 20)} ${r.row.id} to retry`);
              return 1;
            }
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
        signal: AbortSignal.timeout(configGetNumber(env.db, "fetch.timeout_ms")),
        headers: { "user-agent": configGet(env.db, "fetch.user_agent") },
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
            confidence: String(args.flags.confidence || configGet(env.db, "default_confidence")),
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
            tags: s.tags || "",
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
      const rows = (await env.asyncStore.sourceSearch(project.id, q)).map((r: any) => ({
        id: r.id,
        title: clip(r.title, 50),
        rel: r.relevance,
        conf: r.confidence,
        tags: r.tags || "",
        score: typeof r.score === "number" ? r.score.toFixed(2) : "-",
      }));
      table(ctx, rows, ["id", "title", "rel", "conf", "score"], ["id", "title", "rel", "conf", "score"]);
      return 0;
    }
    if (subAction === "show") {
      if (!rest[1]) {
        bad(ctx, "usage: research source show <sourceId> [--json]");
        return 2;
      }
      const s = await env.asyncStore.sourceGet(rest[1]);
      if (!s) {
        bad(ctx, idNotFound(env.db, "sources", rest[1], "source"));
        return 1;
      }
      // F3 (#44): R16.3 says reads fail closed; source show was the one
      // id-addressed read that returned another project's row. The owning
      // project is knowable, so the refusal names it.
      if (s.project_id !== project.id) {
        const owner = ownerProjectName(env.db, "sources", rest[1]) ?? "another project";
        bad(ctx, `source not found in project '${project.name}': ${rest[1]} (it belongs to project '${owner}' — use -p ${owner})`);
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
      const id = rest[1];
      if (!id) {
        bad(ctx, "usage: research source rm <sourceId> [--force cascade its evidence]");
        return 2;
      }
      // Project scoping matters here: sourceGet(id) alone would let a session
      // pointed at project A delete project B's source.
      const s0 = store.db.get("SELECT id FROM sources WHERE id=? AND project_id=?", [id, project.id]);
      if (!s0) {
        bad(ctx, idNotFound(env.db, "sources", id, "source"));
        return 1;
      }
      const force = args.flags.force === true;
      return getOrm(env.db.path)
        .then((ds) => writes.sourceRemove(ds, id, force))
        .then((r: any): number => {
          if (ctx.json) {
            console.log(JSON.stringify(r, null, 2));
          } else {
            ok(ctx, r.evidence_removed
              ? `source removed: ${r.id}  (cascade: ${r.evidence_removed} evidence row(s) dropped; ${r.claims_recomputed} claim(s) recomputed)`
              : `source removed: ${r.id}`);
          }
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }
  }

  if (sub === "evidence") {
    // Batch-nine P2-1: delete an evidence row. claim_evidence cascades on
    // delete, so a bare DELETE would silently drop links and leave claim
    // statuses stale — refuse while links exist unless --force (then recompute
    // every affected claim inside the same transaction).
    if (action === "evidence" && subAction === "rm") {
      const id = rest[1];
      if (!id) {
        bad(ctx, "usage: research evidence rm <evidenceId> [--force cascade claim links]");
        return 2;
      }
      const e0 = store.db.get("SELECT id, quote FROM evidence WHERE id=? AND project_id=?", [id, project.id]);
      if (!e0) {
        bad(ctx, idNotFound(env.db, "evidence", id, "evidence"));
        return 1;
      }
      const force = args.flags.force === true;
      return getOrm(env.db.path)
        .then((ds) => writes.evidenceRemove(ds, id, force))
        .then((r): number => {
          if (ctx.json) {
            console.log(JSON.stringify({ id: r.id, unlinked: r.unlinked, forced: r.forced, cascaded: r.cascaded, statuses: r.statuses }, null, 2));
          } else {
            ok(ctx, r.unlinked.length
              ? `evidence removed: ${r.id}  (cascade: ${r.unlinked.length} link(s) dropped; claims recomputed: ${r.unlinked.map((c) => `${c}→${r.statuses[c]}`).join(", ")})`
              : `evidence removed: ${r.id}`);
          }
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }

    if (subAction === "add") {
      const sourceId = rest[1];
      // Report ⑤: --file reads the quote from disk — long multi-line excerpts
      // stop fighting the shell for --quote escaping.
      const file = String(args.flags.file || "");
      let quote = String(args.flags.quote || "");
      if (file) {
        if (quote) {
          bad(ctx, "--file and --quote are mutually exclusive");
          return 2;
        }
        try {
          quote = require("fs").readFileSync(file, "utf8").trim();
        } catch (e: any) {
          bad(ctx, `cannot read --file: ${e?.message || e}`);
          return 1;
        }
        if (!quote) {
          bad(ctx, `--file is empty: ${file}`);
          return 2;
        }
      }
      if (!quote) quote = readBody();
      if (!sourceId || !quote) {
        bad(ctx, "usage: research evidence add <sourceId> --quote \"...\" | --file <path> [--note ..] [--locator ..]");
        return 2;
      }
      {
        const srcOwner = store.db.get("SELECT project_id FROM sources WHERE id=?", [sourceId]) as any;
        if (srcOwner && srcOwner.project_id !== project.id) {
          bad(ctx, idNotFound(env.db, "sources", sourceId, "source"));
          return 1;
        }
      }
      const note = String(args.flags.note || "");
      const locator = String(args.flags.locator || "");
      return runWrite(
        env,
        (ds) => writes.evidenceAdd(ds, project.id, sourceId, quote, note, locator, force),
        (r) => `evidence added: ${r.id}  ${clip(quote, 50)}  · project ${project.name}`
      );
    }
    // R15.3: evidence assess — decision model evaluates evidence quality
    if (action === "evidence" && subAction === "assess") {
      const id = rest[1];
      if (!id) {
        bad(ctx, "usage: research evidence assess <evidenceId>");
        return 2;
      }
      const ev = store.db.get(
        `SELECT e.quote, e.locator, s.title AS source_title, s.url AS source_url
           FROM evidence e LEFT JOIN sources s ON s.id = e.source_id
          WHERE e.id = ? AND e.project_id = ?`,
        [id, project.id]
      ) as any;
      if (!ev) {
        bad(ctx, idNotFound(env.db, "evidence", id, "evidence"));
        return 1;
      }
      // 0.86 M7-1: model-eval via ctx.ops (Cordis service) — no cross-package
      // require. Fallback = offline-shaped result when the service isn't up
      // (crash-safety boot path constructs env without full services).
      const opsEval = (env as any).cordis?.ops;
      const assess = opsEval
        ? opsEval.assessEvidence({
            quote: ev.quote,
            locator: ev.locator,
            source_title: ev.source_title || "(无来源)",
            source_url: ev.source_url,
          })
        : Promise.resolve({ quality_score: null, reliability: "unavailable", reasoning: "eval service unavailable (ops plugin not loaded)" });
      return assess.then((result: any) => {
      if (ctx.json) {
        console.log(JSON.stringify({
          evidence_id: id,
          quote: ev.quote.slice(0, 120),
          source: ev.source_title,
          quality_score: result.quality_score,
          reliability: result.reliability,
          reasoning: result.reasoning,
        }, null, 2));
      } else {
        head(ctx, `evidence assess: ${id}`);
        show(ctx, {
          引文: clip(ev.quote, 60),
          来源: ev.source_title || "-",
          模型评分: result.quality_score !== null ? `${result.quality_score}/5` : "离线",
          可靠性: result.reliability,
        });
        out(ctx, paint(C.dim, `  ${result.reasoning}`, ctx.color));
      }
      return 0;
      });
    }

    
if (subAction === "show") {
      // F2 (0.110.3): single-evidence full view + both link directions.
      const id = rest[1];
      if (!id) {
        bad(ctx, "usage: research evidence show <evidenceId> [--json]");
        return 2;
      }
      const e = store.db.get(
        `SELECT e.id, e.project_id, e.source_id, e.quote, e.note, e.locator, e.created,
                s.title AS source_title, s.url AS source_url, s.relevance AS source_relevance,
                s.confidence AS source_confidence
           FROM evidence e LEFT JOIN sources s ON s.id=e.source_id
          WHERE e.id=? AND e.project_id=?`,
        [id, project.id]
      ) as any;
      if (!e) {
        const other = store.db.get("SELECT project_id FROM evidence WHERE id=?", [id]) as any;
        if (other) {
          const pname = (store.db.get("SELECT name FROM projects WHERE id=?", [other.project_id]) as any)?.name || other.project_id;
          bad(ctx, `evidence not found in project '${project.name}': ${id} (it belongs to project '${pname}' — use -p ${pname})`);
        } else {
          bad(ctx, `evidence not found: ${id}`);
        }
        return 1;
      }
      const links = store.db.all(
        `SELECT ce.claim_id, ce.stance, c.text AS claim_text, c.status AS claim_status
           FROM claim_evidence ce JOIN claims c ON c.id=ce.claim_id
          WHERE ce.evidence_id=? ORDER BY c.created`,
        [id]
      ) as any[];
      const payload = {
        id: e.id,
        project: project.name,
        quote: e.quote,
        note: e.note || "",
        locator: e.locator || "",
        created: e.created,
        source: {
          id: e.source_id,
          title: e.source_title || "",
          url: e.source_url || "",
          relevance: e.source_relevance ?? null,
          confidence: e.source_confidence || null,
        },
        claims: links.map((l) => ({
          claim_id: l.claim_id,
          stance: l.stance,
          status: l.claim_status,
          text: l.claim_text,
        })),
      };
      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return 0;
      }
      head(ctx, `evidence ${e.id} — ${project.name}`);
      out(ctx, `  source: ${e.source_title || "(unknown)"} ${e.source_url ? `· ${e.source_url}` : ""}`);
      out(ctx, `  quote: ${e.quote}`);
      if (e.note) out(ctx, `  note: ${e.note}`);
      out(ctx, paint(C.dim, `  locator ${e.locator || "(none)"} · created ${e.created}`, ctx.color));
      if (!links.length) {
        out(ctx, paint(C.dim, "  claims: (none linked)", ctx.color));
      } else {
        table(ctx, links, ["claim", "stance", "status", "text"], ["claim_id", "stance", "claim_status", "claim_text"]);
      }
      return 0;
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
      if (rejectBare(ctx, args.flags, ["confidence", "text"])) return 2;
      // 0.81: confidence accepts the letter grades (A|B|C) OR a numeric
      // level — 0-1 decimal (0.92) or 0-100 percentage (92, 85%). Column
      // stays TEXT; raw input is stored as given.
      {
        const raw = String(args.flags.confidence ?? "");
        if (raw !== "" && !/^[ABC]$/.test(raw)) {
          const n = Number(raw.replace(/%$/, ""));
          if (!Number.isFinite(n) || n < 0 || n > 100) {
            bad(ctx, `--confidence must be A|B|C or a number 0-1 / 0-100(%) (got: "${clip(raw, 20)}")`);
            return 2;
          }
        }
      }
      const text = rest.slice(1).join(" ") || String(args.flags.text || "");
      if (!text) {
        bad(ctx, 'missing claim text: research claim add "<text>"');
        return 2;
      }
      const confidence = String(args.flags.confidence || configGet(env.db, "default_confidence"));
      // 0.90 (direct-ce9eaf7a): predictions register the ledger channel they
      // settle against — free string, suggested vocabulary
      // github-issues|review-rounds|npm-registry|downloads-api|manual.
      const channel = String(args.flags.channel || "");
      return runWrite(
        env,
        (ds) => writes.claimAdd(ds, project.id, text, confidence, force, channel),
        (r) => `claim added: ${r.id}  ${clip(text, 60)}${channel ? `  · channel ${channel}` : ""}  · project ${project.name}`
      );
    }
    if (subAction === "link") {
      if (!rest[1] || !rest[2]) {
        bad(ctx, "usage: research claim link <claimId> <evidenceId> [--stance refutes] [--by-source]");
        return 2;
      }
      const stanceRaw = String(args.flags.stance || "supports");
      // P1-2 fix: --stance must be exactly supports|refutes; a bad value must
      // NOT silently rewrite claim status (cold-user report: nonsense → unverified).
      if (stanceRaw !== "supports" && stanceRaw !== "refutes") {
        bad(ctx, `--stance must be supports|refutes (got: "${stanceRaw}")`);
        return 2;
      }
      const stance = stanceRaw as "supports" | "refutes";
      // Report ④-3: --by-source sugar — hand a SOURCE id and every evidence
      // under it links in one shot (the three-id taxonomy forced a per-evidence
      // lookup round trip before this).
      // 0.84.0 评审 F2/F4（REVIEW-0.84.0 + tmp/review-0.84.0.md）：
      // link 后置评估抽成公共步骤——by-source 批量路径与单条路径同一语义；
      // duplicate 路径不再付全价网关评估（幂等重跑 3-5s/次的隐性税）。
      const evalAndLog = async (claimId: string, claimStatus: string): Promise<{ label?: string; score?: number }> => {
        try {
          // 0.86 M7-1 (Cordis P0-1): the model-eval gateway call goes through
          // ctx.ops.evalClaim — the service owns the ops domain; research no
          // longer reaches into ops source by relative require.
          const opsEval = (env as any).cordis?.ops;
          if (!opsEval) return {};
          const evRows = store.db.all(
            `SELECT e.quote, ce.stance, s.title AS source_title
               FROM claim_evidence ce
               JOIN evidence e ON e.id = ce.evidence_id
               LEFT JOIN sources s ON s.id = e.source_id
              WHERE ce.claim_id = ?`, [claimId]) as any[];
          const evalResult = await opsEval.evalClaim({
            claim_text: (store.db.get("SELECT text FROM claims WHERE id=?", [claimId]) as any)?.text || "",
            claim_status: claimStatus,
            evidence: evRows,
          });
          if (evalResult.ok) {
            // 0.91a: bare INSERT gains bus emission (autocommit INSERT
            // returning == durable, so emit-after is post-commit) with the
            // exact payload snapshot the audit row carries.
            const evTs = new Date().toISOString();
            const evPayload = JSON.stringify({ model_confidence: evalResult.confidence_score, label: evalResult.confidence_label, mode: "auto-on-link", human_status: claimStatus });
            store.db.run(
              "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,?)",
              [`${Date.now().toString(36)}${Math.random().toString(36).slice(2,4)}`, evTs,
               process.env.YGL_SESSION || "cli", "claim.eval", "claim", claimId, evPayload, "info"]
            );
            // 0.91a review (direct-55b4ca85): emission is best-effort — a
            // throwing subscriber must never fail the (already durable) write.
            try { emitEvent({ kind: "claim.eval", entity: "claim", entityId: claimId, payload: evPayload, ts: evTs }); } catch { /* audit row is the source of truth */ }
            if (!ctx.json) {
              out(ctx, paint(C.dim, `  [模型] 置信度 ${evalResult.confidence_label} (${evalResult.confidence_score}/5) — ${evalResult.reasoning.slice(0, 60)}`, ctx.color));
            }
            return { label: evalResult.confidence_label, score: evalResult.confidence_score ?? undefined };
          }
        } catch { /* eval is best-effort, never blocks the link */ }
        return {};
      };
      if (args.flags["by-source"]) {
        const evs = store.db.all(
          "SELECT id FROM evidence WHERE source_id=? AND project_id=? ORDER BY created",
          [rest[2], project.id]
        ) as any[];
        if (!evs.length) {
          const srcExists = store.db.get("SELECT id FROM sources WHERE id=? AND project_id=?", [rest[2], project.id]);
          bad(ctx, srcExists
            ? `source ${rest[2]} has no evidence yet — research evidence add ${rest[2]} --quote ".." first`
            : idNotFound(env.db, "sources", rest[2], "source"));
          return 1;
        }
        return getOrm(env.db.path)
          .then(async (ds): Promise<number> => {
            const existing = new Set(
              (store.db.all("SELECT evidence_id FROM claim_evidence WHERE claim_id=?", [rest[1]]) as any[])
                .map((x: any) => x.evidence_id)
            );
            let linked = 0, dups = 0, status = "";
            for (const ev of evs) {
              const r = await writes.claimLink(ds, rest[1], ev.id, stance);
              existing.has(ev.id) ? dups++ : linked++;
              status = r.status;
            }
            // F2：批量路径同样落 claim.eval（此前校准数据源盲区）；全 dup 时跳过（F4）
            let model: { label?: string; score?: number } = {};
            if (linked > 0) model = await evalAndLog(rest[1], status);
            if (ctx.json) console.log(JSON.stringify({ claim: rest[1], source: rest[2], linked, duplicates: dups, status, ...(model.label ? { model_label: model.label, model_confidence: model.score } : {}) }, null, 2));
            else ok(ctx, `linked ${linked} evidence from source ${rest[2]} (${dups} already) — claim status: ${status}`);
            return 0;
          })
          .catch((e: any): number => {
            bad(ctx, e?.message || String(e));
            return 1;
          });
      }
      // F4 (0.110.x): cross-project link hint — the stored project_id is the
      // criterion (a link-time snapshot, not dynamic visibility); either end
      // with no project → no hint.
      const crossProject = (() => {
        const cp = store.db.get("SELECT p.name AS name FROM claims c JOIN projects p ON p.id=c.project_id WHERE c.id=?", [rest[1]]) as any;
        const ep = store.db.get("SELECT p.name AS name FROM evidence e JOIN projects p ON p.id=e.project_id WHERE e.id=?", [rest[2]]) as any;
        if (!cp?.name || !ep?.name || cp.name === ep.name) return null;
        return { claim: cp.name, evidence: ep.name };
      })();
      // F4：duplicate 检出在 link 前完成（幂等重跑跳过评估 + 回执如实标 duplicate）
      const wasDup = !!store.db.get("SELECT 1 FROM claim_evidence WHERE claim_id=? AND evidence_id=?", [rest[1], rest[2]]);
      return getOrm(env.db.path)
        .then((ds) => writes.claimLink(ds, rest[1], rest[2], stance))
        .then(async (r): Promise<number> => {
          // R15 深度集成：链接后自动触发置信度评估。0.84.0 修复两处——
          // ① await 落地：fire-and-forget 会被 CLI 短进程退出截断（事件从未落账）；
          // ② JSON 纯度：评估先结算再打回执，模型档位并入 JSON 对象（契约② stdout 单对象）。
          const model = wasDup ? {} : await evalAndLog(rest[1], r.status);
          const modelLabel = model.label;
          const modelScore = model.score;
          // 0.82.1: prediction claims never auto-promote on link — the receipt
          // says so explicitly instead of showing a silently-unchanged status.
          const explicitSelection = args.flags.p !== undefined || args.flags.project !== undefined;
          const selectionNote = crossProject && !explicitSelection && project.name !== crossProject.claim && project.name !== crossProject.evidence
            ? `selection '${project.name}' owns neither end of this link; the link is cross-project because ids resolve workspace-wide — pin ownership explicitly with -p when both ends should be scoped`
            : undefined;
          if (ctx.json) {
            console.log(JSON.stringify({ claim: rest[1], evidence: rest[2], stance, status: r.status, auto_promote: r.auto_promote, ...(wasDup ? { duplicate: true } : {}), ...(crossProject ? { cross_project: crossProject } : {}), ...(selectionNote ? { selection_note: selectionNote } : {}), ...(modelLabel ? { model_label: modelLabel, model_confidence: modelScore } : {}) }, null, 2));
          } else if (r.auto_promote === false) {
            ok(ctx, `linked; prediction claim stays ${r.status} — auto-promote skipped (arbitration: claim resolve / deadline audit)`);
          } else {
            ok(ctx, `linked; claim status now: ${r.status}`);
          }
          if (crossProject && !ctx.json) {
            out(ctx, paint(C.yellow, `  跨项目：claim 属 '${crossProject.claim}'，evidence 属 '${crossProject.evidence}'（用 -p 分别解析）`, ctx.color));
          }
          return 0;
        })
        .catch((e: any): number => {
          // Report ④-2: the three-id taxonomy (source/evidence/claim) makes
          // "evidence not found: X" ambiguous when X is actually a SOURCE id.
          // Detect that case and hand back the real evidence ids to use.
          const m = /^evidence not found: (.+)$/.exec(e?.message || "");
          if (m) {
            const evs = store.db.all(
              "SELECT id FROM evidence WHERE source_id=? AND project_id=? ORDER BY created LIMIT 8",
              [m[1], project.id]
            ) as any[];
            if (evs.length) {
              bad(ctx, `${e.message} — that id is a SOURCE; its evidence: ${evs.map((x) => x.id).join(" ")} (or rerun with --by-source to link them all)`);
              return 1;
            }
            const srcExists = store.db.get("SELECT id FROM sources WHERE id=? AND project_id=?", [m[1], project.id]);
            if (srcExists) {
              bad(ctx, `${e.message} — that id is a SOURCE with no evidence yet: research evidence add ${m[1]} --quote ".." first`);
              return 1;
            }
          }
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
        bad(ctx, idNotFound(env.db, "claims", id, "claim"));
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
    // 0.82.1 (user report ③): the repair channel for link side effects —
    // resets a claim to unverified. Covers predictions auto-promoted before
    // 0.82.1 AND any claim arbitrated too early (explicit un-arbitration).
    if (subAction === "unresolve") {
      const id = rest[1];
      if (!id) {
        bad(ctx, "usage: research claim unresolve <claimId>");
        return 2;
      }
      const c0 = store.db.get("SELECT id, status FROM claims WHERE id=? AND project_id=?", [id, project.id]);
      if (!c0) {
        bad(ctx, idNotFound(env.db, "claims", id, "claim"));
        return 1;
      }
      return getOrm(env.db.path)
        .then((ds) => writes.claimUnresolve(ds, id))
        .then((r): number => {
          if (ctx.json) console.log(JSON.stringify({ id, status: r.status, duplicate: r.duplicate }, null, 2));
          else ok(ctx, r.duplicate
            ? `claim ${id} already unverified (no change)`
            : `claim ${id}: ${c0.status} → unverified  (back in tracking; arbitration: claim resolve)`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }
    // Batch-nine P2-1 (user report): remove ONE claim↔evidence link. Before
    // this the only repair path was a raw `db sql` DELETE — it left the claim
    // status lying (still `supported` with zero evidence) and logged nothing.
    if (subAction === "unlink") {
      const [cid, eid] = [rest[1], rest[2]];
      if (!cid || !eid) {
        bad(ctx, "usage: research claim unlink <claimId> <evidenceId>");
        return 2;
      }
      const c0 = store.db.get("SELECT id FROM claims WHERE id=? AND project_id=?", [cid, project.id]);
      if (!c0) {
        bad(ctx, idNotFound(env.db, "claims", cid, "claim"));
        return 1;
      }
      const e0 = store.db.get("SELECT id FROM evidence WHERE id=? AND project_id=?", [eid, project.id]);
      if (!e0) {
        bad(ctx, idNotFound(env.db, "evidence", eid, "evidence"));
        return 1;
      }
      return getOrm(env.db.path)
        .then((ds) => writes.claimUnlink(ds, cid, eid))
        .then((r): number => {
          if (ctx.json) {
            console.log(JSON.stringify({ claim: r.claim, evidence: r.evidence, stance: r.stance, status: r.status, recalculated: r.recalculated }, null, 2));
          } else {
            ok(ctx, `unlinked ${r.stance} ${r.evidence} from claim ${r.claim}${r.recalculated ? ` — status now: ${r.status}` : " — prediction status kept (evidence is not arbitration)"}`);
          }
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }
    // R15.2: claim evaluate — decision model evaluates confidence from linked evidence
    if (subAction === "evaluate") {
      const id = rest[1];
      if (!id) {
        bad(ctx, "usage: research claim evaluate <claimId>");
        return 2;
      }
      const claim = store.db.get("SELECT id, text, status, confidence FROM claims WHERE id=? AND project_id=?", [id, project.id]) as any;
      if (!claim) {
        bad(ctx, idNotFound(env.db, "claims", id, "claim"));
        return 1;
      }
      const evidenceRows = store.db.all(
        `SELECT e.quote, ce.stance, s.title AS source_title
           FROM claim_evidence ce
           JOIN evidence e ON e.id = ce.evidence_id
           LEFT JOIN sources s ON s.id = e.source_id
          WHERE ce.claim_id = ?`,
        [id]
      ) as any[];
      // 0.86 M7-1: manual evaluate also goes through ctx.ops.evalClaim.
      const opsEval = (env as any).cordis?.ops;
      return (async () => {
      const result = opsEval
        ? await opsEval.evalClaim({
            claim_text: claim.text,
            claim_status: claim.status,
            evidence: evidenceRows.map((e: any) => ({ quote: e.quote, stance: e.stance, source_title: e.source_title })),
          })
        : { ok: false, confidence_score: null, confidence_label: "离线", reasoning: "eval service unavailable (ops plugin not loaded)" };
      // 0.84.0：判定落账——手动评估也写 claim.eval 事件，校准预测（模型 vs 人工）
      // 需要完整历史，否则每次判定蒸发在 stdout 里。
      if (result.ok) {
        const evTs = new Date().toISOString();
        const evPayload = JSON.stringify({ model_confidence: result.confidence_score, label: result.confidence_label, mode: "manual", human_status: claim.status, human_confidence: claim.confidence, evidence_count: evidenceRows.length });
        store.db.run(
          "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,?)",
          [`${Date.now().toString(36)}${Math.random().toString(36).slice(2,4)}`, evTs,
           process.env.YGL_SESSION || "cli", "claim.eval", "claim", id, evPayload, "info"]
        );
        // 0.91a: bus emission joins the audit row (post-commit, same snapshot);
        // best-effort per direct-55b4ca85 — never fail the durable write
        try { emitEvent({ kind: "claim.eval", entity: "claim", entityId: id, payload: evPayload, ts: evTs }); } catch { /* audit row is the source of truth */ }
      }
      if (ctx.json) {
        console.log(JSON.stringify({
          claim_id: id,
          claim_text: claim.text,
          current_status: claim.status,
          current_confidence: claim.confidence,
          model_confidence: result.confidence_score,
          model_label: result.confidence_label,
          evidence_count: evidenceRows.length,
          reasoning: result.reasoning,
        }, null, 2));
      } else {
        head(ctx, `claim evaluate: ${id}`);
        show(ctx, {
          断言: clip(claim.text, 60),
          当前状态: claim.status,
          当前置信度: claim.confidence,
          模型评分: result.confidence_score !== null ? `${result.confidence_score}/5` : "离线",
          模型置信度: result.confidence_label,
          证据数: evidenceRows.length,
        });
        out(ctx, paint(C.dim, `  ${result.reasoning}`, ctx.color));
      }
      return 0;
      })();
    }

    // 0.84.0: claim calibration — 模型置信度 vs 人工仲裁的档差读出。
    // 服务校准预测（claim.eval 事件历史 → 模型是否系统性低于人工一档）。
    if (subAction === "calibration") {
      const all = args.flags.all === true;
      const rows = store.db.all(
        `SELECT e.entity_id AS claim_id, e.payload, e.ts
           FROM events e
          WHERE e.kind = 'claim.eval'
          ORDER BY e.ts ASC`
      ) as any[];
      const claimIds = [...new Set(rows.map((r) => r.claim_id))];
      const claimsById = new Map<string, any>();
      for (const cid of claimIds) {
        const c = store.db.get("SELECT id, status, confidence, project_id FROM claims WHERE id=?", [cid]) as any;
        if (c) claimsById.set(cid, c);
      }
      // 每断言取最新一次评估
      const latest = new Map<string, any>();
      for (const r of rows) {
        const p = (() => { try { return JSON.parse(r.payload); } catch { return null; } })();
        if (!p || typeof p.model_confidence !== "number" || !p.label) continue;
        latest.set(r.claim_id, { ...p, ts: r.ts });
      }
      const HUMAN: Record<string, number | null> = { supported: 4, contested: 2, refuted: 1, unverified: null };
      const table2: any[] = [];
      let comparable = 0, lower1 = 0;
      for (const [cid, ev] of latest) {
        const c = claimsById.get(cid);
        if (!c) continue;
        if (!all && c.project_id !== project.id) continue;
        const hGrade = HUMAN[c.status] ?? null;
        const mGrade = ev.label === "A" ? 4 : ev.label === "B" ? 3 : ev.label === "C" ? 2 : ev.label === "D" ? 1 : null;
        if (mGrade === null) continue;
        const gap = hGrade === null ? null : hGrade - mGrade;
        if (gap !== null) {
          comparable++;
          if (gap >= 1) lower1++;
        }
        table2.push({
          claim: cid,
          model: `${ev.label}(${ev.model_confidence})`,
          human: c.status,
          gap: gap === null ? "—" : gap > 0 ? `模型低${gap}档` : gap < 0 ? `模型高${-gap}档` : "同档",
          mode: ev.mode || "auto-on-link",
        });
      }
      const share = comparable ? +(100 * lower1 / comparable).toFixed(1) : null;
      if (ctx.json) {
        console.log(JSON.stringify({
          evaluated: table2.length, comparable, model_lower_1plus: lower1,
          share_pct: share, rows: table2,
        }, null, 2));
      } else {
        head(ctx, `claim calibration${all ? " — workspace" : ` — ${project.name}`}`);
        table(ctx, table2, ["claim", "model", "human", "gap", "mode"], ["claim", "model", "human", "gap", "mode"]);
        const verdict = share === null ? "无可比对样本（先 claim evaluate / link，再 claim resolve）"
          : `模型低≥1档：${lower1}/${comparable} = ${share}%（校准预测判据 ≥60%）`;
        out(ctx, `  ${verdict}`);
      }
      return 0;
    }

    
if (subAction === "show") {
      // F2 (0.110.3): single-claim full view — list only projected 7 columns;
      // reading one record's full row + both link directions required sql/ORM.
      const id = rest[1];
      if (!id) {
        bad(ctx, "usage: research claim show <claimId> [--json]");
        return 2;
      }
      const c = store.db.get(
        "SELECT id, project_id, text, status, confidence, channel, created, updated FROM claims WHERE id=? AND project_id=?",
        [id, project.id]
      ) as any;
      if (!c) {
        // distinguish workspace-visible-but-other-project from truly missing
        const other = store.db.get("SELECT project_id FROM claims WHERE id=?", [id]) as any;
        if (other) {
          const pname = (store.db.get("SELECT name FROM projects WHERE id=?", [other.project_id]) as any)?.name || other.project_id;
          bad(ctx, `claim not found in project '${project.name}': ${id} (it belongs to project '${pname}' — use -p ${pname})`);
        } else {
          bad(ctx, `claim not found: ${id}`);
        }
        return 1;
      }
      const links = store.db.all(
        `SELECT ce.evidence_id, ce.stance, e.quote, e.locator, e.note, e.created,
                s.id AS source_id, s.title AS source_title, s.url AS source_url
           FROM claim_evidence ce
           JOIN evidence e ON e.id=ce.evidence_id
           LEFT JOIN sources s ON s.id=e.source_id
          WHERE ce.claim_id=? ORDER BY e.created`,
        [id]
      ) as any[];
      const payload = {
        id: c.id,
        project: project.name,
        text: c.text,
        status: c.status,
        confidence: c.confidence,
        channel: c.channel || "",
        created: c.created,
        updated: c.updated || "",
        evidence: links.map((l) => ({
          evidence_id: l.evidence_id,
          stance: l.stance,
          quote: l.quote,
          locator: l.locator || "",
          note: l.note || "",
          source: { id: l.source_id, title: l.source_title || "", url: l.source_url || "" },
          created: l.created,
        })),
      };
      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return 0;
      }
      head(ctx, `claim ${c.id} — ${project.name}`);
      out(ctx, `  status ${c.status} · confidence ${c.confidence} · channel ${c.channel || "(none)"}`);
      out(ctx, `  text: ${c.text}`);
      out(ctx, paint(C.dim, `  created ${c.created}${c.updated ? ` · updated ${c.updated}` : ""}`, ctx.color));
      if (!links.length) {
        out(ctx, paint(C.dim, "  evidence: (none linked)", ctx.color));
      } else {
        table(ctx, links, ["evidence", "stance", "source", "locator", "quote"], ["evidence_id", "stance", "source_title", "locator", "quote"]);
      }
      return 0;
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
            // 0.91.0 单T2: channel joins the projection — it is the settlement
            // ledger's classification axis; hiding it here leaves the ledger
            // half-blind (null explicit, snake_case frozen).
            channel: (c as any).channel ?? null,
            sup: (c.claimEvidence ?? []).filter((ce) => ce.stance === "supports").length,
            ref: (c.claimEvidence ?? []).filter((ce) => ce.stance === "refutes").length,
          }));
          if (ctx.json) {
            console.log(JSON.stringify(rows, null, 2));
            return 0;
          }
          table(ctx, rows, ["id", "text", "status", "conf", "channel", "sup", "ref"], ["id", "text", "status", "confidence", "channel", "sup", "ref"]);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, `orm query failed: ${e?.message || e}`);
          return 1;
        });
    }
  }

  // ---------------------------------------------------------------- predict group
  // pred-val/backtest-pipeline: deadline audit of `[预测·N天]` claims.
  // Measures locally-measurable criteria, reports hit/miss/pending/manual —
  // never auto-resolves (arbitration stays human, frozen contract).
  if (sub === "predict") {
    // F6 (0.110.0): predict is the one command family whose flags are part of
    // the audit workflow — a silently-ignored `--due` reads as "nothing is due"
    // and silently-ignored typos read as success. Same strict-flag discipline
    // as `verify submit` (unknown flag → rc=2, single JSON error object).
    const PREDICT_GLOBAL = new Set([
      "json", "color", "no-color", "quiet", "home", "db", "project", "p", "global", "force", "verbose",
    ]);
    const rejectPredictFlags = (subAction: string, allowed: string[]): boolean => {
      const unknown = Object.keys(args.flags ?? {}).filter((k) => !allowed.includes(k) && !PREDICT_GLOBAL.has(k));
      if (!unknown.length) return false;
      bad(ctx, `unknown flag${unknown.length > 1 ? "s" : ""} for research predict ${subAction}: ${unknown.map((k) => `--${k}`).join(" ")}`);
      return true;
    };
    const todayIso = new Date().toISOString().slice(0, 10);
    const daysLeftOf = (deadline: string): number | null => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return null;
      // days_left = floor((deadline - as_of) / 86400s), both parsed at UTC midnight
      return Math.floor((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000);
    };
    // 0.90 (direct-ce7e561b ②): settlement projection — every [预测·] claim
    // with outcome (未结算/1/0/ND), parsed settlement note tail
    // (`outcome=1|0, brier=…, settler=…`) and registered channel. The
    // calibration curve becomes SQL-direct: no re-parsing of prose.
    if (subAction === "list") {
      if (rejectPredictFlags("list", ["all", "due"])) return 2;
      // --all (gate-exempted above) = workspace scan, matching calibration
      // --all semantics; without it, single-project view (settled hidden).
      const ws = args.flags.all === true;
      const claims = (
        ws
          ? store.db.all(
              `SELECT c.id, c.text, c.status, c.created, c.channel FROM claims c
                WHERE c.text LIKE '[预测·%' ORDER BY c.created`
            )
          : store.db.all(
              `SELECT c.id, c.text, c.status, c.created, c.channel FROM claims c
                WHERE c.project_id=? AND c.text LIKE '[预测·%' ORDER BY c.created`,
              [project.id]
            )
      ) as any[];
      if (!claims.length) {
        if (ctx.json) console.log("[]");
        else out(ctx, paint(C.dim, "  no [预测·…] claims in this project", ctx.color));
        return 0;
      }
      // settlement notes: latest tail-segment match per claim wins
      const evRows = store.db.all(
        `SELECT ce.claim_id, e.note, e.created FROM claim_evidence ce
           JOIN evidence e ON e.id=ce.evidence_id ORDER BY e.created`
      ) as any[];
      const settled = new Map<string, { brier: string; settler: string }>();
      for (const r of evRows) {
        const m = /outcome=(1|0), brier=([\d.]+), settler=([^\s]+)\s*$/.exec(r.note || "");
        if (m) settled.set(r.claim_id, { brier: m[2], settler: m[3] });
      }
      const { parsePrediction } = require("./predict");
      const outcomeOf = (s: string): string =>
        s === "supported" ? "1" : s === "refuted" ? "0" : s === "contested" ? "ND" : "未结算";
      let rows = claims.map((c: any) => {
        const { horizon, deadline } = parsePrediction(c.text, c.created);
        const st = settled.get(c.id);
        const daysLeft = daysLeftOf(deadline);
        return {
          claim_id: c.id, text: c.text, horizon, deadline, status: c.status,
          outcome: outcomeOf(c.status), brier: st?.brier ?? null, settler: st?.settler ?? null,
          channel: c.channel || "", created: c.created,
          // F6: machine-readable due projection — `deadline <= today` is the
          // settlement-due predicate, days_left lets callers sort urgency.
          due: daysLeft !== null && daysLeft <= 0,
          days_left: daysLeft,
        };
      });
      const dueOnly = args.flags.due === true;
      if (dueOnly) rows = rows.filter((r: any) => r.due);
      if (ctx.json) {
        console.log(JSON.stringify(rows, null, 2));
        return 0;
      }
      const visible = args.flags.all ? rows : rows.filter((r: any) => r.outcome === "未结算");
      head(ctx, `predict list — ${ws ? "workspace" : project.name} (${visible.length}/${rows.length}${dueOnly ? " · due" : rows.length !== visible.length ? " · 已结案隐藏 (--all)" : ""})`);
      table(ctx, visible, ["claim", "deadline", "days", "outcome", "brier", "settler", "channel"], ["claim_id", "deadline", "days_left", "outcome", "brier", "settler", "channel"]);
      const noChannel = rows.filter((r: any) => r.outcome === "未结算" && !r.channel);
      if (noChannel.length) {
        out(ctx, paint(C.yellow, `  ⚠ ${noChannel.length} 条未结算预测未登记 channel（claim add --channel github-issues|review-rounds|…）——结算时可能通道错配`, ctx.color));
      }
      return 0;
    }
    if (subAction === "audit") {
      if (rejectPredictFlags("audit", ["offline", "state", "all", "due"])) return 2;
      const claims = store.db.all(
        "SELECT id, text, status, created FROM claims WHERE project_id=? AND text LIKE '[预测·%' ORDER BY created",
        [project.id]
      ) as any[];
      if (!claims.length) {
        if (ctx.json) console.log("[]");
        else out(ctx, paint(C.dim, "  no [预测·…] claims in this project", ctx.color));
        return 0;
      }
      const { auditPredictions, loadStateSource } = require("./predict");
      return (async () => {
        // 0.79.1 --state bridge: external counter map (JSON file or URL, e.g.
        // DSH API counts) turns state-referencing criteria auto-measurable.
        let state: Record<string, number> | null = null;
        if (args.flags.state) {
          state = await loadStateSource(String(args.flags.state));
          if (!state && !ctx.json) {
            out(ctx, paint(C.yellow, `  ⚠ --state ${args.flags.state} 加载失败（文件/URL 不可读或非 JSON）——相关判据回落 manual`, ctx.color));
          }
        }
        const audited = await auditPredictions({ claims, db: store.db, npmProbe: args.flags.offline !== true, state });
        // F6: three-bucket settlement calendar. due = deadline reached (or no
        // deadline recorded → unknown, stays future), near = ≤30 days out,
        // future = everything else. `--due` is the cron/日报 view.
        const rows = audited.map((r: any) => {
          const d = daysLeftOf(String(r.deadline ?? ""));
          const bucket = d === null ? "future" : d <= 0 ? "due" : d <= 30 ? "near" : "future";
          return { ...r, bucket, days_left: d };
        });
        const dueN = rows.filter((r: any) => r.bucket === "due").length;
        const nearN = rows.filter((r: any) => r.bucket === "near").length;
        const futureN = rows.filter((r: any) => r.bucket === "future").length;
        const resolvedN = rows.filter((r: any) => r.verdict === "resolved").length;
        const visible = args.flags.due
          ? rows.filter((r: any) => r.bucket === "due")
          : args.flags.all ? rows : rows.filter((r: any) => r.verdict !== "resolved");
        if (ctx.json) {
          // --due is a filter on the JSON face too; without it JSON keeps the
          // historical full projection (--all only shaped the human table).
          console.log(JSON.stringify(args.flags.due ? visible : rows, null, 2));
        } else if (!visible.length) {
          out(ctx, paint(C.dim, `  全部 ${rows.length} 条预测已结案（resolved）——--all 查看终态表`, ctx.color));
        } else {
          head(ctx, `prediction audit — ${project.name} (${visible.length}/${rows.length} · due ${dueN} / near ${nearN} / future ${futureN}${resolvedN && !args.flags.all && !args.flags.due ? ` · ${resolvedN} resolved 隐藏 (--all)` : ""})`);
          table(ctx, visible, ["claim", "horizon", "deadline", "判据", "实测", "判定", "days"], [
            "claim_id", "horizon", "deadline", "criterion", "actual", "verdict", "days_left",
          ]);
          const actionable = visible.filter((r: any) => r.verdict === "hit" || r.verdict === "miss");
          for (const r of actionable) {
            out(ctx, paint(C.dim, `  → research claim resolve ${r.claim_id} --as ${r.verdict === "hit" ? "supported" : "refuted"}   # ${r.deadline} 已到`, ctx.color));
          }
          for (const r of visible.filter((x: any) => x.verdict === "manual")) {
            out(ctx, paint(C.dim, `  · ${r.claim_id}: ${r.hint}`, ctx.color));
          }
        }
        return 0;
      })();
    }
    bad(ctx, "usage: research predict list [--all] [--due] · research predict audit [--offline] [--state <file|url>] [--all] [--due]");
    return 2;
  }

  // 0.91.0 (cold-run friction log): bare group = usage display (rc 0);
  // unknown subaction = usage ERROR (rc 2) — the frozen exit-code contract.
  if (action) {
    bad(ctx, `unknown research subcommand: ${action}`);
  }
  out(
    ctx,
    paint(
      C.dim,
      "  research: query add|list · source add|list|search|show|rm · evidence add|list · claim add|link|list · predict audit",
      ctx.color
    )
  );
  return action ? 2 : 0;
}
