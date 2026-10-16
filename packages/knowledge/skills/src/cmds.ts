/** kb group — long-term knowledge: store, retrieve, connect, promote to skill.
 *  Writes (add/ingest) run on the TypeORM write service (src/writes.ts). */
import * as fs from "node:fs";
import * as path from "node:path";
import { Env } from "../../../core/database/src/types";
import { ok, bad, out, head, table, show, paint, C, writeResult } from "../../../core/text/src/fmt";
import { clip, parseFrontmatter } from "../../../core/text/src/text";
import { getOrm } from "../../../core/database/src/orm";
import * as writes from "../../../research/pipeline/src/writes";
import { deriveL1 } from "../../../research/pipeline/src/reads";
import { configGet, configGetNumber } from "../../../ops/tools/src/config";

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx, store } = env;

  const readBody = (): string => {
    if (args.flags.body) return String(args.flags.body);
    if (args.flags.f) return fs.readFileSync(String(args.flags.f), "utf8");
    return "";
  };

  const force = args.flags.force === true || args.flags.force === "true";

  switch (action) {
    case "add": {
      const title = String(args.flags.title || rest[0] || "");
      const body = readBody();
      if (!title || !body) {
        bad(ctx, "usage: kb add --title \"...\" --body|-f <file>");
        return 2;
      }
      return getOrm(env.db.path)
        .then((ds) =>
          writes.kbAdd(ds, {
            title,
            body,
            tags: String(args.flags.tags || ""),
            source_url: String(args.flags.url || ""),
            confidence: String(args.flags.confidence || configGet(env.db, "default_confidence")),
            force,
          })
        )
        .then((r): number => {
          writeResult(ctx, r as any, (row) => `note stored: ${row.id}  ${clip(title, 50)}`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }
    case "search": {
      const q = rest.join(" ");
      if (!q) {
        bad(ctx, "missing query");
        return 2;
      }
      const raw = store.kbSearch(q, Number(args.flags.limit || configGetNumber(env.db, "search.limit")));
      // R15.1: semantic re-ranking via decision model (--eval)
      if (args.flags.eval) {
        const { semanticReRank } = require("../../../ops/tools/src/eval-enhance");
        const candidates = raw.map((r: any) => ({ id: r.id, title: r.title, excerpt: String(r.body || r.title).slice(0, 200) }));
        return semanticReRank(q, candidates).then((reRanked: any[]) => {
        const idToRaw = new Map(raw.map((r: any) => [r.id, r]));
        const rows = reRanked.map((rr: any) => {
          const orig = idToRaw.get(rr.id) as any;
          return {
            id: rr.id,
            title: clip(orig.title, 42),
            semantic: rr.semantic_relevance !== null ? rr.semantic_relevance.toFixed(2) : "离线",
            orig_rank: rr.original_rank,
            tags: orig.tags || "-",
            conf: orig.confidence,
          };
        });
        if (ctx.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
        head(ctx, `kb search "${q}"  (语义重排)`);
        table(ctx, rows, ["id", "title", "semantic", "orig_rank", "tags", "conf"],
                        ["id", "title", "semantic", "orig_rank", "tags", "conf"]);
        return 0;
        });
      }
      const rows = raw.map((r: any) => ({
        id: r.id,
        title: clip(r.title, 46),
        tags: r.tags || "-",
        conf: r.confidence,
        reuse: r.reuse,
        score: typeof r.score === "number" ? r.score.toFixed(2) : "-",
      }));
      table(ctx, rows, ["id", "title", "tags", "conf", "reuse", "score"], ["id", "title", "tags", "conf", "reuse", "score"]);
      return 0;
    }
    case "list":
      table(ctx, store.kbList(), ["id", "title", "tags", "conf", "reuse", "updated"], [
        "id",
        "title",
        "tags",
        "confidence",
        "reuse",
        "updated",
      ]);
      return 0;
    case "show": {
      const n = store.kbGet(rest[0]);
      if (!n) {
        bad(ctx, `note not found: ${rest[0]}`);
        return 1;
      }
      if (ctx.json) {
        console.log(JSON.stringify(n, null, 2));
        return 0;
      }
      head(ctx, n.title);
      show(ctx, { id: n.id, tags: n.tags || "-", confidence: n.confidence, reuse: n.reuse, origin: n.origin || "-" });
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
      const a = store.kbGet(rest[0]);
      const b = store.kbGet(rest[1]);
      if (!a || !b) {
        bad(ctx, "both notes must exist");
        return 1;
      }
      store.kbLink(a.id, b.id, String(args.flags.rel || "related"));
      ok(ctx, `linked ${a.title} --${args.flags.rel || "related"}--> ${b.title}`);
      return 0;
    }
    case "ingest": {
      if (!rest[0]) {
        bad(ctx, "usage: kb ingest <artifactId> [--force]");
        return 2;
      }
      const forceKb = args.flags.force === true || args.flags.force === "true";
      return getOrm(env.db.path)
        .then((ds) => writes.kbIngestArtifact(ds, rest[0], forceKb))
        .then((r): number => {
          writeResult(ctx, r as any, (row) => `artifact ingested into kb: ${row.id}  ${clip(row.title, 50)}`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }
    case "promote": {
      if (!rest[0]) {
        bad(ctx, "usage: kb promote <noteId> [--name <skill>]");
        return 2;
      }
      const note = store.kbGet(rest[0]);
      if (!note) {
        bad(ctx, `kb note not found: ${rest[0]}`);
        return 1;
      }
      const name = args.flags.name ? String(args.flags.name) : note.title;
      return getOrm(env.db.path)
        .then((ds) =>
          writes.skillUpsert(ds, {
            name,
            description: deriveL1(note.body || "", note.title),
            body: note.body,
            tags: note.tags,
            origin: `kb:${note.id}`,
          })
        )
        .then((s): number => {
          ok(ctx, `promoted to skill: ${s.name}`);
          out(ctx, paint(C.dim, `  L1: ${clip(String(s.description), 100)}`, ctx.color));
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }
    case "import": {
      const target = rest[0];
      if (!target) {
        bad(ctx, "usage: kb import <dir|file.md> [--tags ..]");
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
      const items: writes.KbImportItem[] = importable.map((f) => {
        const raw = fs.readFileSync(f, "utf8");
        const { meta, body } = parseFrontmatter(raw);
        const heading = /^#\s+(.+)\s*$/m.exec(body)?.[1]?.trim();
        const title = meta.title || meta.name || heading || path.basename(f, ".md");
        return {
          title,
          body,
          tags: meta.tags || String(args.flags.tags || ""),
          source_url: meta.url || "",
          confidence: meta.confidence || "B",
          origin: `import:${f}`,
        };
      });
      return getOrm(env.db.path)
        .then((ds) => writes.kbImportBulk(ds, items))
        .then((r): number => {
          if (ctx.json) console.log(JSON.stringify({ added: r.added, duplicates: r.dups, files: files.length, target }, null, 2));
          else ok(ctx, `kb import: ${r.added} added, ${r.dups} duplicate(s) kept — ${files.length} file(s) from ${target}`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }
    case "":
      out(ctx, paint(C.dim, "  kb: add | import <dir|file> | search | list | show | link | ingest <artifactId> | promote <noteId>", ctx.color));
      return 0;
    default:
      bad(ctx, `unknown kb action: ${action}`);
      return 2;
  }
}
