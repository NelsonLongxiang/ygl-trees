/** produce group — evidence-backed outline → sections → report.
 *  Writes run on the TypeORM write service (src/writes.ts); reads stay on
 *  Store until their own migration batch. */
import * as fs from "node:fs";
import { Env } from "../../../core/database/src/types";
import { ok, bad, out, head, table, paint, C } from "../../../core/text/src/fmt";
import { rejectBare } from "../../../core/text/src/flagcheck";
import { clip } from "../../../core/text/src/text";
import { getOrm } from "../../../core/database/src/orm";
import { resolveProject, ambiguousProject, projectCount, projectSample } from "../../../core/database/src/selection";
import * as writes from "../../pipeline/src/writes";
import { relAdd, RelError } from "../../../ops/tools/src/rels";

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  const { ctx, store } = env;

  // R12: the `task` command group rides this router — translate its verbs
  // onto the task-* cases (doing/done/todo carry their status in rest[1]).
  if (env.group === "task") {
    const map: Record<string, string> = { add: "task-add", list: "task-list", doing: "task-status", done: "task-status", todo: "task-status" };
    if (!action || !map[action]) {
      bad(ctx, 'usage: task add "<title>" [--note ...] | list [--status todo|doing|done] | todo|doing|done <id>');
      return 2;
    }
    if (map[action] === "task-status") rest = [rest[0], action];
    action = map[action];
  }

  // -- project resolution (R16: flag > env > session > global; strict gate) --
  let project: any;
  const sel = resolveProject(
    store.db,
    (args.flags.p ?? args.flags.project) ? String(args.flags.p ?? args.flags.project) : undefined
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
  project = store.projectByName(sel.name);
  if (!project) {
    bad(ctx, `project not found: ${sel.name}`);
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

    // ── R12 engineering artifacts (0.32) ──
    case "spec": {
      const title = rest[0] || String(args.flags.title || "");
      const body = readBody();
      // Feedback confirmation ①: --design-type is a produce design flag; spec
      // silently swallowing it let a decision record land as a plain spec.
      if (args.flags["design-type"] !== undefined) {
        bad(ctx, "--design-type belongs to 'produce design' (spec does not take it; if this is a design decision, use: produce design <title> --design-type decision)");
        return 2;
      }
      if (!title || !body) {
        bad(ctx, "usage: produce spec <title> --body|-f <file>");
        return 2;
      }
      return getOrm(env.db.path)
        .then((ds) => writes.artifactAdd(ds, pid, "spec", title, body))
        .then((r): number => {
          if (ctx.json) console.log(JSON.stringify(r.row, null, 2));
          else ok(ctx, `spec saved: ${r.row.id} (v${r.version})`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }

    case "design": {
      const title = rest[0] || String(args.flags.title || "");
      const body = readBody();
      const designType = String(args.flags["design-type"] || "arch");
      if (!title || !body) {
        bad(ctx, "usage: produce design <title> --body|-f <file> [--design-type ui-ux|arch|decision]");
        return 2;
      }
      if (!["ui-ux", "arch", "decision"].includes(designType)) {
        bad(ctx, "--design-type must be one of ui-ux|arch|decision");
        return 2;
      }
      // R12.1a ruling: ui-ux designs follow the DESIGN.md format
      // (google-labs-code); arch/decision follow the ADR style.
      return getOrm(env.db.path)
        .then((ds) => writes.artifactAdd(ds, pid, "design", title, body, "markdown", JSON.stringify({ design_type: designType })))
        .then((r): number => {
          if (ctx.json) console.log(JSON.stringify(r.row, null, 2));
          else ok(ctx, `design saved: ${r.row.id} (v${r.version}) [${designType}]`);
          return 0;
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return 1;
        });
    }

    // ── task group rides the produce router (`ygl-trees task ...`, R12) ──
    case "task-add": {
      if (rejectBare(ctx, args.flags, ["note", "node"])) return 2;
      const title = rest.join(" ");
      if (!title) {
        bad(ctx, 'usage: task add "<title>" [--note ...] [--node <tree>/<key>]');
        return 2;
      }
      const note = String(args.flags.note || "");
      const nodeRef = args.flags.node !== undefined ? String(args.flags.node) : "";
      return getOrm(env.db.path)
        .then((ds) => writes.taskAdd(ds, pid, title, note))
        .then((row): number | Promise<number> => {
          if (!nodeRef) {
            if (ctx.json) console.log(JSON.stringify(row, null, 2));
            else ok(ctx, `task added: ${row.id}  ${title}  · project ${project.name}`);
            return 0;
          }
          // 0.81 ⑦: tasks join the relation fabric — `task add --node` links
          // the fresh task to a tree node (rel=tracked-by) in the same breath,
          // so task lists and node timelines stop being parallel pipelines.
          return relAdd(env, `node:${nodeRef}`, `task:${row.id}`, "tracked-by")
            .then((r): number => {
              if (ctx.json) console.log(JSON.stringify({ ...row, node: nodeRef, relation: "tracked-by" }, null, 2));
              else ok(ctx, `task added: ${row.id}  ${title}  (tracked-by node:${nodeRef})`);
              return 0;
            });
        })
        .catch((e: any): number => {
          bad(ctx, e?.message || String(e));
          return e instanceof RelError && e.code === 2 ? 2 : 1;
        });
    }

    case "task-list": {
      const rows = store.db.all(
        "SELECT id, title, meta, created FROM artifacts WHERE project_id=? AND kind='task' ORDER BY created DESC",
        [pid]
      ).map((r: any) => {
        let meta: any = {};
        try { meta = r.meta ? JSON.parse(r.meta) : {}; } catch { /* malformed */ }
        return { id: r.id, title: r.title, status: meta.status || "todo", created: r.created };
      });
      const statusF = String(args.flags.status || "");
      const filtered = statusF ? rows.filter((r: any) => r.status === statusF) : rows;
      if (ctx.json) {
        console.log(JSON.stringify(filtered, null, 2));
        return 0;
      }
      head(ctx, `Tasks (${filtered.length})`);
      table(ctx, filtered, ["id", "status", "title"], ["id", "status", "title"]);
      return 0;
    }

    case "task-status": {
      const id = rest[0];
      const status = rest[1];
      if (!id || !status) {
        bad(ctx, "usage: task doing|done|todo <taskId>");
        return 2;
      }
      return getOrm(env.db.path)
        .then((ds) => writes.taskSetStatus(ds, id, status))
        .then((r): number => {
          if (ctx.json) console.log(JSON.stringify(r, null, 2));
          else ok(ctx, `task ${r.id}: ${r.from} → ${r.to}`);
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
        // R15 深度集成：如果决策模型已评估过（events 表有 claim.eval），附上模型评分
        try {
          const lastEval = store.db.get(
            `SELECT payload FROM events WHERE kind='claim.eval' AND entity_id=? ORDER BY rowid DESC LIMIT 1`,
            [c.id]
          ) as any;
          if (lastEval) {
            const p = JSON.parse(lastEval.payload);
            if (typeof p.model_confidence === "number") {
              L.push(`   _模型置信度 ${p.label}（${p.model_confidence}/5）_`);
            }
          }
        } catch { /* events read is best-effort */ }
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
      // #46: a write command's --json success path is ONE JSON object (frozen
      // contract); the human ack was leaking into the machine channel.
      if (ctx.json) {
        console.log(JSON.stringify({ artifact_id: a.id, path: dest, chars: a.content.length, bytes: Buffer.byteLength(a.content, "utf8") }, null, 2));
      } else {
        ok(ctx, `written: ${dest} (${a.content.length} chars)`);
      }
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
