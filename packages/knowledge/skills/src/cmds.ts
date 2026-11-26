import { sqliteOrm, pgOrm, workspaceOrm } from "../../../core/database/src/orm-access";
/** kb group — long-term knowledge: store, retrieve, connect, promote to skill.
 *  Writes (add/ingest) run on the TypeORM write service (src/writes.ts). */
import * as fs from "node:fs";
import * as path from "node:path";
import { Env } from "../../../core/database/src/types";
import { emitJson, ok, bad, out, head, table, show, paint, C, writeResult, ack } from "../../../core/text/src/fmt";
import { clip, parseFrontmatter } from "../../../core/text/src/text";
import { emitEvent } from "../../../core/text/src/eventbus";

import { pgFailure, PgCapabilityError } from "../../../core/database/src/pg-workspace";
import { type KbImportItem as writes_KbImportItem, kbAdd as writes_kbAdd, kbImportBulk as writes_kbImportBulk, kbIngestArtifact as writes_kbIngestArtifact, kbLinkPg as writes_kbLinkPg, kbPromote as writes_kbPromote, kbRemove as writes_kbRemove, kbSupersede as writes_kbSupersede, kbUnsupersede as writes_kbUnsupersede, kbDeprecate as writes_kbDeprecate, kbUndeprecate as writes_kbUndeprecate, kbRescope as writes_kbRescope, validateScope as writes_validateScope } from "../../../research/pipeline/src/writes";
import { configGet, configGetNumber } from "../../../core/database/src/config";
import { rejectBare } from "../../../core/text/src/flagcheck";

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx, store } = env;

  const readBody = (): string => {
    if (args.flags.body) return String(args.flags.body);
    if (args.flags.f) return fs.readFileSync(String(args.flags.f), "utf8");
    return "";
  };

  const force = args.flags.force === true || args.flags.force === "true";
  let scope: string | undefined;
  if (args.flags.scope !== undefined) {
    if (rejectBare(ctx, args.flags, ["scope"])) return 2;
    try { scope = writes_validateScope(args.flags.scope); }
    catch (e: any) { bad(ctx, e.message); return 2; }
  }

  switch (action) {
    case "add": {
      if (rejectBare(ctx, args.flags, ["title", "body", "tags", "confidence"])) return 2;
      const title = String(args.flags.title || rest[0] || "");
      const body = readBody();
      if (!title || !body) {
        bad(ctx, "usage: kb add --title \"...\" --body|-f <file>");
        return 2;
      }
      return (workspaceOrm(env))
        .then(async (ds) =>
          writes_kbAdd(ds, {
            title,
            body,
            tags: String(args.flags.tags || ""),
            source_url: String(args.flags["source-url"] || args.flags.url || ""), // #275: market 写站相对路径；--source-url 与 --url 同义
            confidence: String(args.flags.confidence || (env.pgUrl ? await env.asyncStore.configValue("default_confidence", "B") : configGet(env.db, "default_confidence"))),
            scope: scope ?? "",
            force,
          })
        )
        .then(async (r): Promise<number> => {
          const row = (r as any).row;
          // Real-user report ①: three kb adds returned ✓, none was ever
          // readable back. The transaction itself is sound (kb_notes +
          // kb_fts + event commit together), so the loss was environmental
          // (split workspace / different YGL_HOME between calls). Two in-band
          // signals now make the landing point visible:
          //   1. every receipt carries the workspace it wrote to
          //   2. a verify probe re-reads the row through the SAME read path
          //      kb search/list use — a miss is printed loudly, not silently
          const verify = env.pgUrl ? await env.asyncStore.kbGet(row.id) : store.kbGet(row.id);
          if (ctx.json) {
            emitJson(ctx, {
              ...row,
              ...((r as any).dup ? { duplicate: true } : {}),
              verified: !!verify,
              workspace: env.home,
            }, 2);
          } else {
            writeResult(ctx, r as any, (rw) => `note stored: ${rw.id}  ${clip(title, 50)}`);
            out(ctx, paint(C.dim, `  @ ${env.home}`, ctx.color));
            if (!verify) {
              out(ctx, paint(C.yellow, `  ⚠ verify miss: id ${row.id} not readable back — the write may not have landed.`, ctx.color));
              out(ctx, paint(C.yellow, `    run: ygl-trees doctor   (write_integrity check names phantom writes)`, ctx.color));
            }
          }
          return env.pgUrl && !verify ? 1 : 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.rc === 2 ? e.message : env.pgUrl ? pgFailure() : e?.message || String(e));
          return typeof e?.rc === "number" ? e.rc : 1; // #276：校验类错误（rc2）原样透传
        });
    }
    case "search": {
      const q = rest.join(" ");
      if (!q) {
        bad(ctx, "missing query");
        return 2;
      }
      // #321: superseded / deprecated notes are hidden unless --all
      const includeRetired = args.flags.all === true || args.flags.all === "true";
      const raw = store.kbSearch(q, Number(args.flags.limit || configGetNumber(env.db, "search.limit")), scope, includeRetired);
      // R15.1: semantic re-ranking via decision model (--eval)
      // 0.86 M7-1: re-rank goes through ctx.ops.semanticRank (Cordis service);
      // service missing (crash-safety boot) → fall back to raw FTS order.
      const opsEval = (env as any).cordis?.ops;
      if (args.flags.eval) {
        const candidates = raw.map((r: any) => ({ id: r.id, title: r.title, excerpt: String(r.body || r.title).slice(0, 200) }));
        const rerankPromise: Promise<any[]> = opsEval
          ? opsEval.semanticRank(q, candidates)
          : Promise.resolve(candidates.map((c: any, i: number) => ({ ...c, semantic_relevance: null, original_rank: i + 1 })));
        return rerankPromise.then((reRanked: any[]) => {
          const idToRaw = new Map(raw.map((r: any) => [r.id, r]));
          const rows = reRanked.map((rr: any) => {
            const orig = idToRaw.get(rr.id) as any;
            return {
              id: rr.id,
              title: clip(orig.title, 42),
              semantic: rr.semantic_relevance != null ? rr.semantic_relevance.toFixed(2) : "离线",
              orig_rank: rr.original_rank,
              tags: orig.tags || "-",
              conf: orig.confidence,
            };
          });
          if (ctx.json) { emitJson(ctx, rows, 2); return 0; }
          head(ctx, `kb search "${q}"  (语义重排)`);
          table(ctx, rows, ["id", "title", "semantic", "orig_rank", "tags", "conf"],
                          ["id", "title", "semantic", "orig_rank", "tags", "conf"]);
          return 0;
        });
      }
      const anyRetired = raw.some((r: any) => r.superseded_by || r.deprecated);
      const rows = raw.map((r: any) => ({
        id: r.id,
        title: clip(r.title, 46),
        tags: r.tags || "-",
        conf: r.confidence,
        reuse: r.reuse,
        score: typeof r.score === "number" ? r.score.toFixed(2) : "-",
        ...(anyRetired ? { retired: r.superseded_by ? `已被 ${r.superseded_by} 取代` : r.deprecated ? "已作废" : "" } : {}),
      }));
      if (anyRetired) table(ctx, rows, ["id", "title", "tags", "conf", "reuse", "score", "retired"], ["id", "title", "tags", "conf", "reuse", "score", "retired"]);
      else table(ctx, rows, ["id", "title", "tags", "conf", "reuse", "score"], ["id", "title", "tags", "conf", "reuse", "score"]);
      return 0;
    }
    case "list":
      if (env.pgUrl) return env.asyncStore.kbList(scope).then((rows) => {
        table(ctx, rows, ["id", "title", "tags", "conf", "reuse", "updated"], ["id", "title", "tags", "confidence", "reuse", "updated"]); return 0;
      });
      {
        const listRows = store.kbList(scope, args.flags.all === true || args.flags.all === "true").map((r: any) => ({
          ...r,
          ...(r.superseded_by || r.deprecated ? { retired: r.superseded_by ? `已被 ${r.superseded_by} 取代` : "已作废" } : {}),
        }));
        const withRetired = listRows.some((r: any) => r.retired);
        table(ctx, listRows, ["id", "title", "tags", "conf", "reuse", "updated", ...(withRetired ? ["retired"] : [])], [
          "id",
          "title",
          "tags",
          "confidence",
          "reuse",
          "updated",
          ...(withRetired ? ["retired"] : []),
        ], "kb add --title ... --body ... | kb import <dir>");
      }
      return 0;
    case "rm":
    case "remove": {
      const id = rest[0];
      if (!id) {
        bad(ctx, "usage: kb rm <id>");
        return 2;
      }
      const note = store.kbGet(id);
      if (!note) {
        bad(ctx, `note not found: ${id}`);
        return 1;
      }
      // #49/批十六: base row + FTS shadow + links + kb.rm event commit together.
      // The previous two autocommit DELETEs could leave kb_fts out of sync when
      // a crash/busy error landed between them (the doctor-visible seam).
      return sqliteOrm(env)
        .then((ds) => writes_kbRemove(ds, id))
        .then((r): number => {
          try {
            emitEvent({
              kind: "kb.rm",
              entity: "kb_note",
              entityId: id,
              payload: JSON.stringify({ title: String(r.row.title || "") }),
              ts: new Date().toISOString(),
            });
          } catch {
            /* bus emission is best-effort; the transactional event is the record */
          }
          ok(ctx, `note removed: ${id}  ${String(r.row.title || "").slice(0, 40)}`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, env.pgUrl ? (e instanceof PgCapabilityError ? e.message : pgFailure()) : e?.message || String(e));
          return 1;
        });
    }
    // #321 item 3: retire a note without deleting it. Only needs write access.
    case "supersede": {
      if (rejectBare(ctx, args.flags, ["reason"])) return 2;
      if (!rest[0] || !rest[1]) {
        bad(ctx, "usage: kb supersede <old> <new> [--reason \"...\"]");
        return 2;
      }
      const oldN = store.kbGet(rest[0]);
      const newN = store.kbGet(rest[1]);
      if (!oldN || !newN) {
        bad(ctx, `note not found: ${!oldN ? rest[0] : rest[1]}`);
        return 1;
      }
      return sqliteOrm(env)
        .then((ds) => writes_kbSupersede(ds, String(oldN.id), String(newN.id), String(args.flags.reason || "")))
        .then((r): number => {
          ack(ctx, r.row, `${r.dup ? "already superseded" : "superseded"}: ${r.row.old} → ${r.row.new}  (${clip(String(r.row.old_title), 30)} → ${clip(String(r.row.new_title), 30)})`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e instanceof PgCapabilityError ? e.message : env.pgUrl ? pgFailure() : e?.message || String(e));
          return typeof e?.rc === "number" ? e.rc : 1;
        });
    }
    case "unsupersede": {
      if (!rest[0]) {
        bad(ctx, "usage: kb unsupersede <old>");
        return 2;
      }
      const n0 = store.kbGet(rest[0]);
      if (!n0) { bad(ctx, `note not found: ${rest[0]}`); return 1; }
      return sqliteOrm(env)
        .then((ds) => writes_kbUnsupersede(ds, String(n0.id)))
        .then((r): number => { ack(ctx, r.row, `supersede undone: ${r.row.id}  ${clip(String(r.row.title), 40)}`); return 0; })
        .catch((e: any): number => {
          bad(ctx, e instanceof PgCapabilityError ? e.message : env.pgUrl ? pgFailure() : e?.message || String(e));
          return typeof e?.rc === "number" ? e.rc : 1;
        });
    }
    case "deprecate": {
      if (rejectBare(ctx, args.flags, ["reason"])) return 2;
      if (!rest[0] || !args.flags.reason) {
        bad(ctx, "usage: kb deprecate <id> --reason \"...\"  (retire a note that has no replacement; use kb supersede when one exists)");
        return 2;
      }
      const n0 = store.kbGet(rest[0]);
      if (!n0) { bad(ctx, `note not found: ${rest[0]}`); return 1; }
      return sqliteOrm(env)
        .then((ds) => writes_kbDeprecate(ds, String(n0.id), String(args.flags.reason)))
        .then((r): number => { ack(ctx, r.row, `${r.dup ? "already deprecated" : "deprecated"}: ${r.row.id}  ${clip(String(r.row.title), 40)}`); return 0; })
        .catch((e: any): number => {
          bad(ctx, e instanceof PgCapabilityError ? e.message : env.pgUrl ? pgFailure() : e?.message || String(e));
          return typeof e?.rc === "number" ? e.rc : 1;
        });
    }
    case "undeprecate": {
      if (!rest[0]) {
        bad(ctx, "usage: kb undeprecate <id>");
        return 2;
      }
      const n0 = store.kbGet(rest[0]);
      if (!n0) { bad(ctx, `note not found: ${rest[0]}`); return 1; }
      return sqliteOrm(env)
        .then((ds) => writes_kbUndeprecate(ds, String(n0.id)))
        .then((r): number => { ack(ctx, r.row, `deprecation undone: ${r.row.id}  ${clip(String(r.row.title), 40)}`); return 0; })
        .catch((e: any): number => {
          bad(ctx, e instanceof PgCapabilityError ? e.message : env.pgUrl ? pgFailure() : e?.message || String(e));
          return typeof e?.rc === "number" ? e.rc : 1;
        });
    }
    case "show": {
      if (!rest[0]) {
        bad(ctx, "usage: kb show <note-key> [--json]");
        return 2;
      }
      if (env.pgUrl) return env.asyncStore.kbGet(rest[0]).then((n) => {
        if (!n) { bad(ctx, "note not found: " + rest[0]); return 1; }
        if (ctx.json) emitJson(ctx, n, 2);
        else { head(ctx, n.title); show(ctx, { id: n.id, tags: n.tags || "-", confidence: n.confidence, reuse: n.reuse, origin: n.origin || "-" }); out(ctx, ""); out(ctx, n.body); }
        return 0;
      });
      const n = store.kbGet(rest[0]);
      if (!n) {
        bad(ctx, `note not found: ${rest[0]}`);
        return 1;
      }
      const retiredHit = store.kbRetired().get(String(n.id));
      const replaces = store.kbSupersedes(String(n.id));
      if (ctx.json) {
        emitJson(ctx, {
          ...n,
          ...(retiredHit?.by ? { superseded_by: retiredHit.by } : {}),
          ...(retiredHit && !retiredHit.by ? { deprecated: true } : {}),
          ...(replaces.length ? { supersedes: replaces } : {}),
        }, 2);
        return 0;
      }
      head(ctx, n.title);
      show(ctx, { id: n.id, tags: n.tags || "-", confidence: n.confidence, reuse: n.reuse, origin: n.origin || "-" });
      if (retiredHit?.by) out(ctx, paint(C.yellow, `  已被 ${retiredHit.by} 取代 (superseded-by) — 请改用替代者`, ctx.color));
      else if (retiredHit) out(ctx, paint(C.yellow, "  已作废 (deprecated)", ctx.color));
      if (replaces.length) out(ctx, paint(C.dim, `  取代了: ${replaces.join(", ")}`, ctx.color));
      out(ctx, "");
      out(ctx, n.body);
      const links = store.kbLinks(n.id);
      if (links.length) {
        out(ctx, paint(C.bold, "\n  links", ctx.color));
        for (const l of links) out(ctx, `  - ${l.rel}: ${l.other}`);
      }
      return 0;
    }
    case "link": {
      if (!rest[0] || !rest[1]) {
        bad(ctx, "usage: kb link <note-a> <note-b> [--rel <type>]");
        return 2;
      }
      if (env.pgUrl) return pgOrm(env).then(ds => writes_kbLinkPg(ds, rest[0], rest[1], String(args.flags.rel || "related"))).then(r => { ack(ctx, r, `linked ${r.a.title} --${r.rel}--> ${r.b.title}`); return 0; }).catch(e => { bad(ctx, e instanceof PgCapabilityError ? e.message : pgFailure()); return 1; });
      const a = store.kbGet(rest[0]);
      const b = store.kbGet(rest[1]);
      if (!a || !b) {
        bad(ctx, "both notes must exist");
        return 1;
      }
      const rel = String(args.flags.rel || "related");
      store.kbLink(a.id, b.id, rel);
      ack(ctx, { a: { id: a.id, title: a.title }, b: { id: b.id, title: b.title }, rel }, `linked ${a.title} --${rel}--> ${b.title}`);
      return 0;
    }
    case "ingest": {
      if (!rest[0]) {
        bad(ctx, "usage: kb ingest <artifactId> [--scope <key>] [--force]");
        return 2;
      }
      const forceKb = args.flags.force === true || args.flags.force === "true";
      return sqliteOrm(env)
        .then((ds) => writes_kbIngestArtifact(ds, rest[0], forceKb, scope))
        .then((r): number => {
          writeResult(ctx, r as any, (row) => `artifact ingested into kb: ${row.id}  ${clip(row.title, 50)}`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, env.pgUrl ? (e instanceof PgCapabilityError ? e.message : pgFailure()) : e?.message || String(e));
          return 1;
        });
    }
    case "rescope": { // #276：改笔记 grant scope；--scope 必给（可空串=未归属）
      if (!rest[0] || args.flags.scope === undefined) {
        bad(ctx, "usage: kb rescope <id> --scope <dept:id|bench:id|*|restricted|empty>");
        return 2;
      }
      return (workspaceOrm(env))
        .then(ds => writes_kbRescope(ds, rest[0], args.flags.scope))
        .then((r): number => {
          if (ctx.json) { emitJson(ctx, { ...r.row, ...(r.dup ? { duplicate: true } : {}) }, 2); return 0; }
          out(ctx, `rescoped: ${r.row.title} -> ${r.row.scope || "(unattributed)"}`);
          return 0;
        })
        .catch((e: any) => { bad(ctx, env.pgUrl && !(e instanceof PgCapabilityError) && e?.rc !== 2 ? pgFailure() : e?.message || String(e)); return typeof e?.rc === "number" ? e.rc : 1; });
    }
    case "promote": {
      if (!rest[0]) {
        bad(ctx, "usage: kb promote <noteId> [--name <skill>] [--force]");
        return 2;
      }
      return sqliteOrm(env)
        .then(ds => writes_kbPromote(ds, rest[0], { name: args.flags.name ? String(args.flags.name) : undefined, force }))
        .then((s): number => {
          ack(
            ctx,
            { name: s.name, description: s.description, origin: s.origin },
            `promoted to skill: ${s.name}`
          );
          if (!ctx.json) out(ctx, paint(C.dim, `  L1: ${clip(String(s.description), 100)}`, ctx.color));
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, env.pgUrl ? (e instanceof PgCapabilityError ? e.message : pgFailure()) : e?.message || String(e));
          return 1;
        });
    }
    case "import": {
      const target = rest[0];
      if (!target) {
        bad(ctx, "usage: kb import <dir|file.md> [--tags ..] [--scope <key>]");
        return 2;
      }
      let st;
      try {
        st = fs.statSync(target);
      } catch {
        bad(ctx, `not found: ${target}`);
        return 1;
      }
      const files: string[] = [];
      if (st.isFile()) files.push(target);
      else {
        for (const f of fs.readdirSync(target, { recursive: true }) as string[])
          if (String(f).toLowerCase().endsWith(".md")) files.push(path.join(target, String(f)));
      }
      if (!files.length) {
        bad(ctx, `no .md files under ${target}`);
        return 1;
      }
      files.sort();
      // P0-1 guard (real-user incident): >1MB .md files are skipped by default.
      // A 483MB file corrupted the DB — tool-layer guardrails beat human discipline.
      const MAX_FILE_BYTES = 1 * 1024 * 1024;
      const skipped: Array<{ file: string; size: string }> = [];
      const importable = files.filter((f) => {
        const sz = fs.statSync(f).size;
        if (sz > MAX_FILE_BYTES && !args.flags.force) {
          skipped.push({ file: f, size: `${(sz / 1024 / 1024).toFixed(1)}MB` });
          return false;
        }
        return true;
      });
      if (skipped.length && !ctx.json) {
        out(ctx, paint(C.yellow, `  ! skipped ${skipped.length} file(s) >1MB (--force to include):`, ctx.color));
        for (const sk of skipped) out(ctx, paint(C.dim, `    ${sk.file}  (${sk.size})`, ctx.color));
      }
      if (!importable.length) {
        bad(ctx, `all ${files.length} file(s) exceeded 1MB limit — use --force to import anyway`);
        return 1;
      }
      // parse everything first, then ONE bulk transaction (writes.kbImportBulk)
      const items: writes_KbImportItem[] = importable.map((f) => {
        const raw = fs.readFileSync(f, "utf8");
        const { meta, body } = parseFrontmatter(raw);
        const heading = /^#\s+(.+)\s*$/m.exec(body)?.[1]?.trim();
        const title = meta.title || meta.name || heading || path.basename(f, ".md");
        return {
          title,
          body: ["cue", "lesson", "evidence"].some(key => Object.hasOwn(meta, key)) ? raw : body,
          tags: meta.tags || String(args.flags.tags || ""),
          source_url: meta.url || "",
          confidence: meta.confidence || "B",
          scope: meta.scope !== undefined ? meta.scope : (args.flags.scope !== undefined ? String(args.flags.scope) : ""), // #276
          origin: `import:${f}`,
        };
      });
      return (workspaceOrm(env))
        .then((ds) => writes_kbImportBulk(ds, items))
        .then((r): number => {
          if (ctx.json) emitJson(ctx, { added: r.added, duplicates: r.dups, files: files.length, target }, 2);
          else ok(ctx, `kb import: ${r.added} added, ${r.dups} duplicate(s) kept — ${files.length} file(s) from ${target}`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, env.pgUrl ? (e instanceof PgCapabilityError ? e.message : pgFailure()) : e?.message || String(e));
          return typeof e?.rc === "number" ? e.rc : 1; // #276
        });
    }
    case "":
      out(ctx, paint(C.dim, "  kb: add | import <dir|file> | search | list | show | link | ingest <artifactId> | promote <noteId> | supersede <old> <new> | unsupersede <old> | deprecate <id> | undeprecate <id> | rm <id> (writes a kb.rm event)", ctx.color));
      return 0;
    default:
      bad(ctx, `unknown kb action: ${action}`);
      return 2;
  }
}
