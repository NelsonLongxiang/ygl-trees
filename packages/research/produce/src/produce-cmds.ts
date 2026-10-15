/** produce group — evidence-backed outline → sections → report.
 *  Writes run on the TypeORM write service (src/writes.ts); reads stay on
 *  Store until their own migration batch. */
import * as fs from "node:fs";
import { Env } from "../../../core/database/src/types";
import { ok, bad, out, head, table, paint, C } from "../../../core/text/src/fmt";
import { clip } from "../../../core/text/src/text";
import { getOrm } from "../../../core/database/src/orm";
import * as writes from "../../pipeline/src/writes";

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx, store } = env;
  let project: any;
  try {
    project = store.projectResolve(args.flags.p ? String(args.flags.p) : undefined);
  } catch (e: any) {
    bad(ctx, e.message);
    return 1;
  }
  const pid = project.id;

  const readBody = (): string => {
    if (args.flags.body) return String(args.flags.body);
    if (args.flags.f) return fs.readFileSync(String(args.flags.f), "utf8");
    return "";
  };

  switch (action) {
    case "outline": {
      const claims = store.claimList(pid);
      const lines: string[] = [`# ${project.name}`, ""];
      if (project.question) lines.push(`> ${project.question}`, "");
      lines.push("## 结论要点", "");
      if (!claims.length) lines.push("_（尚无 claim，先跑 research claim add）_", "");
      claims.forEach((c: any, i: number) => {
        const mark = c.status === "supported" ? "[已证实]" : c.status === "refuted" ? "[已推翻]" : c.status === "contested" ? "[存争议]" : "[待验证]";
        lines.push(`${i + 1}. ${mark} ${c.text}`);
      });
      lines.push("", "## 证据基础", "");
      const ev = store.evidenceList(pid);
      if (!ev.length) lines.push("_（尚无 evidence）_", "");
      ev.forEach((e: any, i: number) => lines.push(`- [${i + 1}] ${e.source}：${clip(e.quote, 80)}`));
      const content = lines.join("\n");
      return getOrm(env.db.path)
        .then((ds) => writes.artifactAdd(ds, pid, "outline", `${project.name} outline`, content))
        .then((r): number => {
          if (ctx.json) console.log(JSON.stringify(r.row, null, 2));
          else {
            ok(ctx, `outline generated: ${r.row.id} (v${r.version})`);
            out(ctx, content);
          }
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }

    case "section": {
      const title = rest[0] || String(args.flags.title || "");
      const body = readBody();
      if (!title || !body) {
        bad(ctx, "usage: produce section <title> --body|-f <file>");
        return 2;
      }
      return getOrm(env.db.path)
        .then((ds) => writes.artifactAdd(ds, pid, "section", title, body))
        .then((r): number => {
          if (ctx.json) console.log(JSON.stringify(r.row, null, 2));
          else ok(ctx, `section saved: ${r.row.id} (v${r.version})`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }

    case "report": {
      const claims = store.claimList(pid);
      const evidence = store.evidenceList(pid);
      const sources = store.sourceList(pid);
      const sections = store.db.all(
        "SELECT title,content,version FROM artifacts WHERE project_id=? AND kind='section' ORDER BY created",
        [pid]
      );
      const evIndex = new Map(evidence.map((e: any, i: number) => [e.id, i + 1]));
      const L: string[] = [];
      L.push(`# ${project.name}`, "");
      L.push(`_generated ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC by ygl-trees_`, "");
      if (project.question) L.push(`**研究问题**：${project.question}`, "");

      L.push("## 摘要", "");
      const supported = claims.filter((c: any) => c.status === "supported");
      const contested = claims.filter((c: any) => c.status === "contested");
      const unverified = claims.filter((c: any) => c.status === "unverified");
      L.push(
        `共 ${claims.length} 条断言（${supported.length} 条已证实、${contested.length} 条存争议、${unverified.length} 条待验证），` +
          `基于 ${evidence.length} 条证据、${sources.length} 个来源。`,
        ""
      );

      L.push("## 主要结论", "");
      claims.forEach((c: any, i: number) => {
        const links = store.db.all("SELECT evidence_id,stance FROM claim_evidence WHERE claim_id=?", [c.id]);
        const cites = links.map((l: any) => `[${evIndex.get(l.evidence_id) ?? "?"}]`).join("");
        const mark =
          c.status === "supported" ? "✓" : c.status === "refuted" ? "✗" : c.status === "contested" ? "⚠" : "?";
        L.push(`${i + 1}. ${mark} ${c.text} ${cites ? ` ${cites}` : "_（无证据支撑）_"}  `);
        L.push(`   _置信度 ${c.confidence}，状态 ${c.status}_`);
      });
      L.push("");

      for (const s of sections) {
        L.push(`## ${s.title}`, "", s.content, "");
      }

      L.push("## 证据清单", "");
      evidence.forEach((e: any, i: number) => {
        L.push(`[${i + 1}] ${e.source}${e.locator ? ` · ${e.locator}` : ""} — ${e.quote}`);
      });
      L.push("");

      L.push("## 来源", "");
      for (const s of sources) {
        L.push(`- ${s.title}${s.url ? ` — ${s.url}` : ""} （置信度 ${s.confidence}）`);
      }
      L.push("", "## 局限与未决问题", "");
      const weak = claims.filter((c: any) => c.status !== "supported");
      if (!weak.length) L.push("_无_");
      else for (const c of weak) L.push(`- 待补证据：${c.text}`);

      const content = L.join("\n");
      return getOrm(env.db.path)
        .then((ds) => writes.artifactAdd(ds, pid, "report", `${project.name} report`, content))
        .then((r): number => {
          if (ctx.json) console.log(JSON.stringify(r.row, null, 2));
          else {
            ok(ctx, `report generated: ${r.row.id} (v${r.version})`);
            out(ctx, content);
            out(ctx, paint(C.dim, `\n  hint: ygl-trees produce export ${r.row.id} report.md`, ctx.color));
          }
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }

    case "list":
      table(ctx, store.artifactList(pid), ["id", "kind", "title", "ver", "format", "size", "created"], [
        "id",
        "kind",
        "title",
        "version",
        "format",
        "size",
        "created",
      ]);
      return 0;

    case "show": {
      const a = store.artifactGet(rest[0]);
      if (!a) {
        bad(ctx, "artifact not found");
        return 1;
      }
      if (ctx.json) console.log(JSON.stringify(a, null, 2));
      else {
        head(ctx, `${a.kind}: ${a.title} (v${a.version})`);
        out(ctx, a.content);
      }
      return 0;
    }

    case "export": {
      const a = store.artifactGet(rest[0]);
      if (!a) {
        bad(ctx, "artifact not found");
        return 1;
      }
      const dest = rest[1] || `${a.kind}-${a.id}.md`;
      fs.writeFileSync(dest, a.content, "utf8");
      store.log("artifact.export", "artifact", a.id, dest);
      ok(ctx, `written: ${dest} (${a.content.length} chars)`);
      return 0;
    }

    case "":
      out(ctx, paint(C.dim, "  produce: outline | section <title> | report | list | show | export <id> <file>", ctx.color));
      return 0;
    default:
      bad(ctx, `unknown produce action: ${action}`);
      return 2;
  }
}
