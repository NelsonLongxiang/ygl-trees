/** skill group — the L1/L2/L3 registry agents query before acting.
 *  Writes run on the TypeORM write service (src/writes.ts). */
import * as fs from "node:fs";
import * as path from "node:path";
import { Env } from "../../../core/database/src/types";
import { ok, bad, out, head, table, show, paint, C, ack } from "../../../core/text/src/fmt";
import { parseFrontmatter } from "../../../core/text/src/text";
import { getOrm } from "../../../core/database/src/orm";
import * as writes from "../../../research/pipeline/src/writes";

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx, store } = env;
  const name = rest[0];

  const need = (v: string, what: string) => {
    if (!v) {
      bad(ctx, `missing ${what}`);
      return false;
    }
    return true;
  };

  switch (action) {
    case "import": {
      if (!need(name, "file")) return 2;
      const raw = fs.readFileSync(name, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const spec = {
        name: meta.name || path.basename(name, ".md"),
        description: meta.description || "",
        body,
        tags: (meta.tags || "").toString(),
        version: meta.version || "0.1.0",
        origin: name,
      };
      return getOrm(env.db.path)
        .then((ds) => writes.skillUpsert(ds, spec))
        .then((row): number => {
          if (ctx.json) console.log(JSON.stringify(row, null, 2));
          else {
            ok(ctx, `imported skill: ${row.name} (${row.version})`);
            out(ctx, paint(C.dim, `  L1: ${String(row.description).slice(0, 120)}`, ctx.color));
          }
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }
    case "init": {
      // v2: create a new skill from template — guides the author
      const name = String(args.flags.name || rest[0] || "");
      if (!name) {
        bad(ctx, "usage: skill init <name> [--description ...] [--body ...]");
        bad(ctx, "  creates a skill with frontmatter template; edit body with skill show + update");
        return 2;
      }
      const desc = String(args.flags.description || "");
      const body = String(args.flags.body || `# ${name}

## When to use
(describe when this skill should activate)

## What to do
(step-by-step instructions)

## Examples
(concrete command examples)
`);
      const tags = String(args.flags.tags || "");
      return getOrm(env.db.path)
        .then((ds) => writes.skillUpsert(ds, { name, description: desc, body, tags, version: "0.1.0" }))
        .then((r: any) => {
          ok(ctx, `skill created: ${name} v0.1.0`);
          out(ctx, paint(C.dim, `  edit: ygl-trees skill show ${name}`, ctx.color));
          out(ctx, paint(C.dim, `  add refs: ygl-trees skill refs add ${name} <path> --body "..."`, ctx.color));
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, String(e?.message || e));
          return 1;
        });
    }
    case "refs":
    case "references": {
      // v2: show all references linked to a skill (L3 progressive disclosure)
      const skillName = rest[0];
      if (!skillName) {
        bad(ctx, "usage: skill refs <name>");
        return 2;
      }
      const sk = store.skillGet(skillName);
      if (!sk) {
        bad(ctx, `skill not found: ${skillName}`);
        return 1;
      }
      const refs = env.db.all("SELECT * FROM skill_refs WHERE skill_id=? ORDER BY path", [(sk as any).id]) as any[];
      head(ctx, `Skill: ${skillName}`);
      if (ctx.json) {
        console.log(JSON.stringify(refs, null, 2));
        return 0;
      }
      if (!refs.length) {
        out(ctx, paint(C.dim, "  (no references — add with: skill refs add <name> <path> --body ...)", ctx.color));
        return 0;
      }
      for (const r of refs) {
        out(ctx, `  ${r.path}`);
        if (r.body) out(ctx, paint(C.dim, `    ${String(r.body).slice(0, 80)}`, ctx.color));
      }
      return 0;
    }
    case "add": {
      const n = args.flags.name ? String(args.flags.name) : "";
      const file = args.flags.f ? String(args.flags.f) : "";
      if (file) return run(env, "import", [file], args);
      if (!need(n, "--name")) return 2;
      const body = args.flags.body
        ? String(args.flags.body)
        : args.flags["body-file"]
        ? fs.readFileSync(String(args.flags["body-file"]), "utf8")
        : "";
      const spec = {
        name: n,
        description: String(args.flags.description || ""),
        body,
        tags: String(args.flags.tags || ""),
        version: String(args.flags.version || "0.1.0"),
      };
      return getOrm(env.db.path)
        .then((ds) => writes.skillUpsert(ds, spec))
        .then((row): number => {
          ack(ctx, row, `skill saved: ${row.name}`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }
    case "list":
      table(ctx, store.skillList(), ["name", "ver", "on", "hits", "tags", "updated"], [
        "name",
        "version",
        "enabled",
        "hits",
        "tags",
        "updated",
      ]);
      return 0;
    case "link": {
      // One-command symlink: skills/ → .agents/skills/ (or ~/.agents/skills/ with --global)
      // so host agents (DSH, Claude, etc.) can discover them without manual junction setup.
      const os = require("node:os");
      const globalFlag = args?.flags?.global === true;
      const targetDir = globalFlag
        ? path.join(os.homedir(), ".agents", "skills")
        : path.join(process.cwd(), ".agents", "skills");

      // Find source skills directory (probe upward from cwd, same as repoRoot)
      let skillsDir: string | null = null;
      for (let dir = process.cwd(), i = 0; i < 6; i++, dir = path.dirname(dir)) {
        const candidate = path.join(dir, "skills");
        if (fs.existsSync(candidate)) {
          const entries = fs.readdirSync(candidate).filter((e: string) =>
            fs.existsSync(path.join(candidate, e, "SKILL.md"))
          );
          if (entries.length > 0) {
            skillsDir = candidate;
            break;
          }
        }
      }
      if (!skillsDir) {
        bad(ctx, `no skills/ directory found (probed upward from ${process.cwd()})`);
        return 1;
      }

      // Create target directory
      fs.mkdirSync(targetDir, { recursive: true });

      // Link each skill
      const linked: string[] = [];
      const skipped: string[] = [];
      for (const entry of fs.readdirSync(skillsDir)) {
        if (!fs.existsSync(path.join(skillsDir, entry, "SKILL.md"))) continue;
        const linkPath = path.join(targetDir, entry);
        if (fs.existsSync(linkPath)) {
          skipped.push(entry);
          continue;
        }
        try {
          fs.symlinkSync(path.resolve(skillsDir, entry), linkPath, "junction");
          linked.push(entry);
        } catch (e: any) {
          skipped.push(`${entry} (error: ${String(e.message).slice(0, 40)})`);
        }
      }

      if (ctx.json) {
        console.log(JSON.stringify({ target: targetDir, linked, skipped }, null, 2));
        return 0;
      }
      head(ctx, `skill link → ${targetDir}`);
      if (linked.length) {
        ok(ctx, `linked ${linked.length} skill(s):`);
        for (const l of linked) out(ctx, `  ${l}`);
      }
      if (skipped.length) {
        out(ctx, paint(C.yellow, `  skipped ${skipped.length} (already exist or error):`, ctx.color));
        for (const s of skipped) out(ctx, paint(C.dim, `  ${s}`, ctx.color));
      }
      if (!linked.length && !skipped.length) {
        out(ctx, paint(C.dim, "  (no skills found to link)", ctx.color));
      }
      return 0;
    }
    case "show": {
      if (!need(name || "", "skill name")) return 2;
      const s = store.skillGet(name);
      if (!s) {
        bad(ctx, `skill not found: ${name}`);
        return 1;
      }
      const refs = store.skillRefs(s.id);
      if (ctx.json) {
        console.log(JSON.stringify({ ...s, refs }, null, 2));
        return 0;
      }
      head(ctx, `SKILL ${s.name}  v${s.version}`);
      show(ctx, { id: s.id, enabled: s.enabled, tags: s.tags || "-", origin: s.origin || "-", hits: s.hits });
      out(ctx, paint(C.bold, "\n  [L1] description — what + when to trigger", ctx.color));
      out(ctx, wrap(s.description || "(empty)"));
      out(ctx, paint(C.bold, "\n  [L2] body — loaded when activated", ctx.color));
      out(ctx, wrap(s.body || "(empty)"));
      if (refs.length) {
        out(ctx, paint(C.bold, "\n  [L3] references — load on demand", ctx.color));
        table(ctx, refs, ["path", "size"], ["path", "size"]);
        out(ctx, paint(C.dim, `  hint: ygl-trees skill refs show ${s.name} <path>`, ctx.color));
      }
      return 0;
    }
    case "match": {
      const q = rest.join(" ");
      if (!need(q, "query")) return 2;
      const hits = store.skillMatch(q, Number(args.flags.limit || 5));
      if (ctx.json) {
        console.log(JSON.stringify(hits, null, 2));
        return 0;
      }
      if (!hits.length) {
        out(ctx, paint(C.dim, "  no skill matched — consider writing one from the current project", ctx.color));
        return 0;
      }
      head(ctx, `Skills matching: ${q}`);
      for (const h of hits) {
        out(ctx, `  ${paint(C.bold, h.name, ctx.color)}  ${paint(C.dim, `score ${(h.score ?? 0).toFixed(2)}`, ctx.color)}`);
        out(ctx, wrap(h.description, 6));
      }
      return 0;
    }
    case "rm":
      return getOrm(env.db.path)
        .then((ds) => writes.skillDel(ds, name))
        .then((): number => {
          ack(ctx, { removed: name }, `removed skill: ${name}`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    case "enable":
    case "disable": {
      const on = action === "enable";
      return getOrm(env.db.path)
        .then((ds) => writes.skillEnabled(ds, name, on))
        .then((hit): number => {
          if (!hit) {
            bad(ctx, `skill not found: ${name}`);
            return 1;
          }
          ack(ctx, { name, enabled: on }, `${on ? "enabled" : "disabled"} ${name}`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }
    case "refs": {
      const sub = rest[0];
      if (sub === "add") {
        const skillName = rest[1];
        if (!need(skillName || "", "skill name")) return 2;
        const p = rest[2];
        if (!need(p || "", "ref path")) return 2;
        const content = args.flags.body
          ? String(args.flags.body)
          : args.flags.f
          ? fs.readFileSync(String(args.flags.f), "utf8")
          : "";
        return getOrm(env.db.path)
          .then((ds) => writes.skillRefAdd(ds, skillName, p, content))
          .then((): number => {
            ok(ctx, `ref saved: ${skillName}/${p}`);
            return 0;
          })
          .catch((e: any): number => {
            bad(ctx, e?.message || String(e));
            return 1;
          });
      }
      if (sub === "show") {
        const skill = store.skillGet(rest[1]);
        if (!skill) {
          bad(ctx, `skill not found: ${rest[1]}`);
          return 1;
        }
        const r = store.db.get("SELECT content FROM skill_refs WHERE skill_id=? AND path=?", [skill.id, rest[2]]);
        out(ctx, r ? r.content : paint(C.red, "  ref not found", ctx.color));
        return 0;
      }
      out(ctx, paint(C.dim, "  skill refs add <skill> <path> [--body|-f] | show <skill> <path>", ctx.color));
      return 0;
    }
    case "":
      out(
        ctx,
        paint(C.dim, "  skill: import|add|list|show|match|rm|enable|disable|refs", ctx.color)
      );
      return 0;
    default:
      bad(ctx, `unknown skill action: ${action}`);
      return 2;
  }
}

function wrap(text: string, indent = 4): string {
  const pad = " ".repeat(indent);
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => pad + l)
    .join("\n");
}
