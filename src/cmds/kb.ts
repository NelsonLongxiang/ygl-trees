/** kb group — long-term knowledge: store, retrieve, connect, promote to skill. */
import * as fs from "node:fs";
import * as path from "node:path";
import { Env } from "../cli";
import { ok, bad, out, head, table, show, paint, C, writeResult } from "../fmt";
import { clip, parseFrontmatter } from "../text";

export function run(env: Env, action: string, rest: string[], args: any): number {
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
      const n = store.kbAdd({
        title,
        body,
        tags: String(args.flags.tags || ""),
        source_url: String(args.flags.url || ""),
        confidence: String(args.flags.confidence || "B"),
        force,
      });
      writeResult(ctx, n, (r) => `note stored: ${r.id}  ${clip(title, 50)}`);
      return 0;
    }
    case "search": {
      const q = rest.join(" ");
      if (!q) {
        bad(ctx, "missing query");
        return 2;
      }
      const rows = store.kbSearch(q, Number(args.flags.limit || 20)).map((r: any) => ({
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
      const n = store.kbIngestArtifact(rest[0], args.flags.force === true || args.flags.force === "true");
      writeResult(ctx, n, (r) => `artifact ingested into kb: ${r.id}  ${clip(r.title, 50)}`);
      return 0;
    }
    case "promote": {
      const s = store.kbPromote(rest[0], args.flags.name ? String(args.flags.name) : undefined);
      ok(ctx, `promoted to skill: ${s.name}`);
      out(ctx, paint(C.dim, `  L1: ${clip(s.description, 100)}`, ctx.color));
      return 0;
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
      let added = 0;
      let dups = 0;
      for (const f of files) {
        const raw = fs.readFileSync(f, "utf8");
        const { meta, body } = parseFrontmatter(raw);
        const heading = /^#\s+(.+)\s*$/m.exec(body)?.[1]?.trim();
        const title = meta.title || meta.name || heading || path.basename(f, ".md");
        const r = store.kbAdd({
          title,
          body,
          tags: meta.tags || String(args.flags.tags || ""),
          source_url: meta.url || "",
          confidence: meta.confidence || "B",
          origin: `import:${f}`,
        });
        if (r.dup) dups++;
        else added++;
      }
      if (ctx.json) console.log(JSON.stringify({ added, duplicates: dups, files: files.length, target }, null, 2));
      else ok(ctx, `kb import: ${added} added, ${dups} duplicate(s) kept — ${files.length} file(s) from ${target}`);
      return 0;
    }
    case "":
      out(ctx, paint(C.dim, "  kb: add | import <dir|file> | search | list | show | link | ingest <artifactId> | promote <noteId>", ctx.color));
      return 0;
    default:
      bad(ctx, `unknown kb action: ${action}`);
      return 2;
  }
}
