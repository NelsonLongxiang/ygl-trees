/**
 * agent group — the entry point an AI agent calls to orient itself.
 *
 * `agent brief` answers three questions in one shot:
 *   where am I, what exists, what should I do next.
 */
import { Env } from "../cli";
import { ok, bad, out, head, table, paint, C } from "../fmt";
import { clip } from "../text";

export function run(env: Env, action: string, rest: string[], args: any): number {
  const { ctx, store } = env;

  switch (action) {
    case "brief": {
      const cur = store.db.metaGet("current_project");
      const stats = store.stats();
      const skills = store.skillList().slice(0, 5);
      const notes = store.kbList().slice(0, 5);

      const payload: any = {
        workspace: env.home,
        current_project: cur || null,
        counts: stats,
        top_skills: skills.map((s: any) => ({ name: s.name, description: clip(s.description, 120) })),
        recent_notes: notes.map((n: any) => ({ id: n.id, title: n.title, reuse: n.reuse })),
        next_actions: [] as string[],
      };

      let project: any = null;
      if (cur) project = store.projectByName(cur);
      if (project) {
        const claims = store.claimList(project.id);
        const ev = store.evidenceList(project.id);
        const src = store.sourceList(project.id);
        const arts = store.artifactList(project.id);
        payload.project = {
          name: project.name,
          question: project.question || null,
          sources: src.length,
          evidence: ev.length,
          claims: claims.length,
          verified_claims: claims.filter((c: any) => c.status === "supported").length,
          artifacts: arts.length,
        };
        payload.unverified_claims = claims
          .filter((c: any) => c.status !== "supported")
          .map((c: any) => ({ id: c.id, text: clip(c.text, 80), status: c.status }));

        if (!src.length) payload.next_actions.push(`ygl-trees research source add --title "..." --url "..."`);
        if (src.length && !ev.length) payload.next_actions.push(`ygl-trees research evidence add <sourceId> --quote "..." `);
        if (ev.length && !claims.length) payload.next_actions.push(`ygl-trees research claim add "<断言>"`);
        if (claims.length) payload.next_actions.push(`ygl-trees research claim link <claimId> <evidenceId>`);
        if (claims.some((c: any) => c.status === "supported") && !arts.length)
          payload.next_actions.push(`ygl-trees produce report`);
        if (arts.some((a: any) => a.kind === "report"))
          payload.next_actions.push(`ygl-trees kb ingest <artifactId>   # 沉淀为长期知识`);
        if (!stats.skills) payload.next_actions.push(`ygl-trees skill import path/to/SKILL.md`);
      } else {
        payload.next_actions.push(`ygl-trees project new <name> -q "<研究问题>"`);
        payload.next_actions.push(`ygl-trees skill import path/to/SKILL.md`);
      }

      // Health: surface data problems an agent should fix first.
      const dirtyTrees = store.db.all(`SELECT t.name FROM trees t JOIN node_index i ON i.tree_id=t.id WHERE i.dirty=1`);
      for (const t of dirtyTrees) payload.next_actions.push(`ygl-trees node index   # tree '${t.name}' index is stale`);
      const dupGroups = store.db.all(
        `SELECT 'claims' t, COUNT(*) c FROM (SELECT 1 FROM claims GROUP BY project_id, text HAVING COUNT(*)>1)
         UNION ALL SELECT 'queries', COUNT(*) FROM (SELECT 1 FROM queries GROUP BY project_id, text HAVING COUNT(*)>1)
         UNION ALL SELECT 'evidence', COUNT(*) FROM (SELECT 1 FROM evidence GROUP BY source_id, quote HAVING COUNT(*)>1)
         UNION ALL SELECT 'kb_notes', COUNT(*) FROM (SELECT 1 FROM kb_notes GROUP BY title, body HAVING COUNT(*)>1)`
      );
      if (dupGroups.some((g: any) => g.c > 0)) payload.next_actions.push(`ygl-trees db dups   # duplicate content rows exist`);

      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return 0;
      }

      head(ctx, "ygl-trees brief");
      out(ctx, `  workspace   ${env.home}`);
      out(ctx, `  project     ${cur || paint(C.dim, "(none)", ctx.color)}`);
      if (payload.project) {
        const p = payload.project;
        out(
          ctx,
          `  progress    sources ${p.sources} · evidence ${p.evidence} · claims ${p.verified_claims}/${p.claims} verified · artifacts ${p.artifacts}`
        );
      }
      out(ctx, `  counts      skills ${stats.skills} · kb ${stats.kb_notes} · jobs ${stats.jobs} · events ${stats.events}`);
      if (skills.length) {
        out(ctx, paint(C.bold, "\n  available skills", ctx.color));
        for (const s of skills) out(ctx, `  - ${s.name}  ${paint(C.dim, clip(s.description, 90), ctx.color)}`);
      }
      out(ctx, paint(C.bold, "\n  next actions", ctx.color));
      for (const a of payload.next_actions) out(ctx, `  → ${a}`);
      return 0;
    }

    case "match": {
      const q = rest.join(" ");
      if (!q) {
        bad(ctx, 'usage: agent match "<task description>"');
        return 2;
      }
      const hits = store.skillMatch(q, Number(args.flags.limit || 3));
      const payload = { query: q, matches: hits.map((h: any) => ({ name: h.name, score: h.score, description: h.description })) };
      if (ctx.json) {
        console.log(JSON.stringify(payload, null, 2));
        return 0;
      }
      if (!hits.length) {
        out(ctx, paint(C.dim, "  no skill matched", ctx.color));
        return 0;
      }
      head(ctx, `Best skill for: ${q}`);
      const top = hits[0];
      out(ctx, `  ${paint(C.bold, top.name, ctx.color)}`);
      out(ctx, `  ${top.description}`);
      out(ctx, paint(C.dim, `\n  load L2:  ygl-trees skill show ${top.name}`, ctx.color));
      if (hits.length > 1) {
        out(ctx, paint(C.dim, "  runners-up:", ctx.color));
        for (const h of hits.slice(1)) out(ctx, `    ${h.name} (${(h.score ?? 0).toFixed(2)})`);
      }
      return 0;
    }

    case "log": {
      const rows = store.tail(Number(args.flags.limit || 30));
      table(ctx, rows, ["ts", "actor", "kind", "entity", "id", "payload"], [
        "ts",
        "actor",
        "kind",
        "entity",
        "entity_id",
        "payload",
      ]);
      return 0;
    }

    case "":
      out(ctx, paint(C.dim, "  agent: brief | match \"<task>\" | log", ctx.color));
      return 0;
    default:
      bad(ctx, `unknown agent action: ${action}`);
      return 2;
  }
}
