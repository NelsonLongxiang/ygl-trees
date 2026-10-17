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
import * as writes from "./writes";
import { configGet, configGetNumber } from "../../../ops/tools/src/config";
import { Claim, Evidence, Query, Source } from "./entities";

/** Run a write through the TypeORM transactional write service and print
 *  with JSON discipline. Keeps every write command 6 lines. */
/** 0.80: compact timestamp for session:// adjudication urls (yyyymmddhhmm). */
function nowCompact(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
}

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
      if (url && !/^https?:\/\/|^file:\/\/|^session:\/\//.test(url)) {
        bad(ctx, `--url must be http(s)://, file:// or session:// (got: "${clip(url, 30)}")`);
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
      const note = String(args.flags.note || "");
      const locator = String(args.flags.locator || "");
      return runWrite(
        env,
        (ds) => writes.evidenceAdd(ds, project.id, sourceId, quote, note, locator, force),
        (r) => `evidence added: ${r.id}  ${clip(quote, 50)}`
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
        bad(ctx, `evidence not found: ${id}`);
        return 1;
      }
      const { assessEvidenceQuality } = require("../../../ops/tools/src/eval-enhance");
      return assessEvidenceQuality({
        quote: ev.quote,
        locator: ev.locator,
        source_title: ev.source_title || "(无来源)",
        source_url: ev.source_url,
      }).then((result: any) => {
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
      if (validateEnum(ctx, args.flags, "confidence", ["A", "B", "C"])) return 2;
      const text = rest.slice(1).join(" ") || String(args.flags.text || "");
      if (!text) {
        bad(ctx, 'missing claim text: research claim add "<text>"');
        return 2;
      }
      const confidence = String(args.flags.confidence || configGet(env.db, "default_confidence"));
      return runWrite(
        env,
        (ds) => writes.claimAdd(ds, project.id, text, confidence, force),
        (r) => `claim added: ${r.id}  ${clip(text, 60)}`
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
      if (args.flags["by-source"]) {
        const evs = store.db.all(
          "SELECT id FROM evidence WHERE source_id=? AND project_id=? ORDER BY created",
          [rest[2], project.id]
        ) as any[];
        if (!evs.length) {
          const srcExists = store.db.get("SELECT id FROM sources WHERE id=? AND project_id=?", [rest[2], project.id]);
          bad(ctx, srcExists
            ? `source ${rest[2]} has no evidence yet — research evidence add ${rest[2]} --quote ".." first`
            : `source not found: ${rest[2]}`);
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
            if (ctx.json) console.log(JSON.stringify({ claim: rest[1], source: rest[2], linked, duplicates: dups, status }, null, 2));
            else ok(ctx, `linked ${linked} evidence from source ${rest[2]} (${dups} already) — claim status: ${status}`);
            return 0;
          })
          .catch((e: any): number => {
            bad(ctx, e?.message || String(e));
            return 1;
          });
      }
      return getOrm(env.db.path)
        .then((ds) => writes.claimLink(ds, rest[1], rest[2], stance))
        .then((r): number => {
          ok(ctx, `linked; claim status now: ${r.status}`);
          // R15 深度集成：链接后自动触发置信度评估（有模型时静默执行）
          try {
            const { evaluateClaimConfidence } = require("../../../ops/tools/src/eval-enhance");
            const evRows = store.db.all(
              `SELECT e.quote, ce.stance, s.title AS source_title
                 FROM claim_evidence ce
                 JOIN evidence e ON e.id = ce.evidence_id
                 LEFT JOIN sources s ON s.id = e.source_id
                WHERE ce.claim_id = ?`, [rest[1]]) as any[];
            evaluateClaimConfidence({
              claim_text: (store.db.get("SELECT text FROM claims WHERE id=?", [rest[1]]) as any)?.text || "",
              claim_status: r.status,
              evidence: evRows,
            }).then((evalResult: any) => {
              if (evalResult.ok) {
                store.db.run(
                  "INSERT INTO events(id,ts,actor,kind,entity,entity_id,payload,level) VALUES(?,?,?,?,?,?,?,?)",
                  [`${Date.now().toString(36)}${Math.random().toString(36).slice(2,4)}`, new Date().toISOString(),
                   "cli", "claim.eval", "claim", rest[1],
                   JSON.stringify({ model_confidence: evalResult.confidence_score, label: evalResult.confidence_label }), "info"]
                );
                out(ctx, paint(C.dim, `  [模型] 置信度 ${evalResult.confidence_label} (${evalResult.confidence_score}/5) — ${evalResult.reasoning.slice(0, 60)}`, ctx.color));
              }
            }).catch(() => { /* eval is best-effort, never blocks the link */ });
          } catch { /* eval-enhance not loadable — skip */ }
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
    // R15.2: claim evaluate — decision model evaluates confidence from linked evidence
    if (subAction === "evaluate") {
      const id = rest[1];
      if (!id) {
        bad(ctx, "usage: research claim evaluate <claimId>");
        return 2;
      }
      const claim = store.db.get("SELECT id, text, status, confidence FROM claims WHERE id=? AND project_id=?", [id, project.id]) as any;
      if (!claim) {
        bad(ctx, `claim not found: ${id}`);
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
      const { evaluateClaimConfidence } = require("../../../ops/tools/src/eval-enhance");
      return (async () => {
      const result = await evaluateClaimConfidence({
        claim_text: claim.text,
        claim_status: claim.status,
        evidence: evidenceRows.map((e: any) => ({ quote: e.quote, stance: e.stance, source_title: e.source_title })),
      });
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

  // ---------------------------------------------------------------- predict group
  // pred-val/backtest-pipeline: deadline audit of `[预测·N天]` claims.
  // Measures locally-measurable criteria, reports hit/miss/pending/manual —
  // never auto-resolves (arbitration stays human, frozen contract).
  if (sub === "predict") {
    if (subAction === "audit") {
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
        const rows = await auditPredictions({ claims, db: store.db, npmProbe: args.flags.offline !== true, state });
        const resolvedN = rows.filter((r: any) => r.verdict === "resolved").length;
        const visible = args.flags.all ? rows : rows.filter((r: any) => r.verdict !== "resolved");
        if (ctx.json) {
          console.log(JSON.stringify(rows, null, 2));
        } else if (!visible.length) {
          out(ctx, paint(C.dim, `  全部 ${rows.length} 条预测已结案（resolved）——--all 查看终态表`, ctx.color));
        } else {
          head(ctx, `prediction audit — ${project.name} (${visible.length}/${rows.length}${resolvedN && !args.flags.all ? ` · ${resolvedN} resolved 隐藏 (--all)` : ""})`);
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
    bad(ctx, "usage: research predict audit [--offline] [--state <file|url>] [--all]");
    return 2;
  }

  out(
    ctx,
    paint(
      C.dim,
      "  research: query add|list · source add|list|search|show|rm · evidence add|list · claim add|link|list · predict audit",
      ctx.color
    )
  );
  return 0;
}
