/**
 * agent group — the entry point an AI agent calls to orient itself.
 *
 * `agent brief` answers three questions in one shot:
 *   where am I, what exists, what should I do next.
 */
import { Env } from "../../../core/database/src/types";
import { ok, bad, out, head, table, paint, C } from "../../../core/text/src/fmt";
import { clip } from "../../../core/text/src/text";

/** Build the brief payload (where am I / what exists / what next).
 *  Shared by the `agent brief` command and the WebUI dashboard. */
export function buildBrief(env: Env): any {
  const { store } = env;
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
  return payload;
}

export function run(env: Env, action: string, rest: string[], args: any): number {
  const { ctx, store } = env;

  switch (action) {
    case "ask":
    case "?": {
      // v2: natural language interface — keyword routing to other commands
      const question = rest.join(" ");
      if (!question) {
        bad(ctx, 'usage: ygl-trees agent ask "<question>"');
        out(ctx, '  examples: ask "what projects" | ask "search AI" | ask "健康"');
        return 2;
      }
      const q = question.toLowerCase();
      type Route = { pattern: RegExp; label: string; group: string; action: string; extra?: string[] };
      const routes: Route[] = [
        { pattern: /what.*project|项目列表|所有项目/, label: "project list", group: "project", action: "list" },
        { pattern: /search|搜索|检索|找/, label: "kb search", group: "kb", action: "search",
          extra: [question.replace(/.*?(search|搜索|检索|找)\s*/i, "").replace(/["']/g, "")] },
        { pattern: /tree|树/, label: "node list", group: "node", action: "list" },
        { pattern: /health|健康|doctor|检查/, label: "doctor", group: "doctor", action: "" },
        { pattern: /skill|技能/, label: "skill list", group: "skill", action: "list" },
        { pattern: /task|任务/, label: "task list", group: "task", action: "list" },
        { pattern: /metric|指标/, label: "agent metrics", group: "agent", action: "metrics" },
      ];
      let matched = false;
      for (const r of routes) {
        if (r.pattern.test(q)) {
          if (!ctx.json) out(ctx, paint(C.dim, `  → ${r.label}`, ctx.color));
          // F1 fix (a2a review): parent holds .ygllock → child self-deadlocks.
          // Fix: child gets YGL_TEST=1 to skip lock (parent already holds it —
          // no concurrent write risk for read-only routing).
          const cmdParts = [r.group, r.action, ...(r.extra || [])].filter(Boolean);
          const { execSync } = require("node:child_process") as typeof import("node:child_process");
          const self = process.argv[1];
          try {
            const result = execSync(
              `${JSON.stringify(process.execPath)} ${JSON.stringify(self)} --no-color ${cmdParts.map(c => JSON.stringify(c)).join(" ")}`,
              { env: { ...process.env, YGL_TEST: "1" }, encoding: "utf8", timeout: 10000 }
            );
            // F2 fix: --json mode outputs only the inner result (contract ④)
            if (ctx.json) { console.log(result.trim()); return 0; }
            out(ctx, result.trim());
            return 0;
          } catch (e: any) {
            if (ctx.json) { console.log(JSON.stringify({ error: String(e?.message || e).slice(0, 200) })); return 1; }
            bad(ctx, String(e?.stdout || e?.message || e).slice(0, 200));
            return 1;
          }
        }
      }
      // Default: brief
      if (!ctx.json) out(ctx, paint(C.dim, "  → agent brief (no specific match)", ctx.color));
      const payload = buildBrief(env);
      if (ctx.json) { console.log(JSON.stringify(payload, null, 2)); return 0; }
      // Reuse brief rendering
      return run(env, "brief", [], args);
    }
    case "metrics": {
      // R11 cold-start research → automated measurement. Health/efficiency
      // metrics for the workspace — one command answers "how good is this
      // workbench?" with quantified data.
      const t0 = Date.now();
      const brief = buildBrief(env);
      const briefMs = Date.now() - t0;

      // Knowledge metrics
      const kbTotal = (env.db.get("SELECT COUNT(*) AS n FROM kb_notes") as any)?.n || 0;
      const kbRecent = (env.db.get(
        "SELECT COUNT(*) AS n FROM kb_notes WHERE created > datetime('now', '-7 days')"
      ) as any)?.n || 0;

      // Research metrics
      const claims = (env.db.get("SELECT COUNT(*) AS n FROM claims") as any)?.n || 0;
      const claimsVerified = (env.db.get(
        "SELECT COUNT(*) AS n FROM claims WHERE status='supported'"
      ) as any)?.n || 0;
      const evidence = (env.db.get("SELECT COUNT(*) AS n FROM evidence") as any)?.n || 0;
      const sources = (env.db.get("SELECT COUNT(*) AS n FROM sources") as any)?.n || 0;

      // Skill metrics
      const skills = store.skillList();
      const skillHits = skills.reduce((s: number, x: any) => s + (x.hits || 0), 0);

      // Tree metrics
      const trees = env.db.all("SELECT id, name FROM trees") as any[];
      let nodesTotal = 0, nodesUnlocked = 0;
      for (const t of trees) {
        const r = env.db.get(
          "SELECT COUNT(*) AS total, SUM(CASE WHEN ns.status='unlocked' THEN 1 ELSE 0 END) AS unlocked FROM nodes n LEFT JOIN node_state ns ON ns.node_id=n.id AND ns.context='default' WHERE n.tree_id=?",
          [t.id]
        ) as any;
        nodesTotal += r?.total || 0;
        nodesUnlocked += r?.unlocked || 0;
      }

      // Event metrics
      const events7d = (env.db.get(
        "SELECT COUNT(*) AS n FROM events WHERE ts > datetime('now', '-7 days')"
      ) as any)?.n || 0;

      const metrics = {
        cold_start: {
          brief_ms: briefMs,
          next_actions: brief.next_actions?.length || 0,
          skills_available: skills.length,
        },
        knowledge: {
          total_notes: kbTotal,
          recent_7d: kbRecent,
          growth_rate_7d: kbTotal > 0 ? Math.round(kbRecent / kbTotal * 100) : 0,
        },
        research: {
          sources, evidence, claims,
          verified_claims: claimsVerified,
          verification_rate: claims > 0 ? Math.round(claimsVerified / claims * 100) : 0,
          evidence_per_claim: claims > 0 ? (evidence / claims).toFixed(1) : "0",
        },
        skills: {
          total: skills.length,
          total_hits: skillHits,
          avg_hits: skills.length > 0 ? (skillHits / skills.length).toFixed(1) : "0",
        },
        trees: {
          total_trees: trees.length,
          nodes: nodesTotal,
          unlocked: nodesUnlocked,
          unlock_rate: nodesTotal > 0 ? Math.round(nodesUnlocked / nodesTotal * 100) : 0,
        },
        activity: { events_7d: events7d },
        doctor: "run `doctor` for health checks",
      };

      if (ctx.json) {
        console.log(JSON.stringify(metrics, null, 2));
        return 0;
      }
      head(ctx, "ygl-trees metrics");
      out(ctx, `  冷启动     brief ${metrics.cold_start.brief_ms}ms · ${metrics.cold_start.next_actions} next actions · ${metrics.cold_start.skills_available} skills`);
      out(ctx, `  知识       ${metrics.knowledge.total_notes} notes (${metrics.knowledge.recent_7d} in 7d, ${metrics.knowledge.growth_rate_7d}% growth)`);
      out(ctx, `  研究       ${metrics.research.sources} sources · ${metrics.research.evidence} evidence · ${metrics.research.verified_claims}/${metrics.research.claims} verified (${metrics.research.verification_rate}%)`);
      out(ctx, `  技能       ${metrics.skills.total} skills · ${metrics.skills.total_hits} hits (avg ${metrics.skills.avg_hits})`);
      out(ctx, `  科技树     ${metrics.trees.total_trees} trees · ${metrics.trees.unlocked}/${metrics.trees.nodes} unlocked (${metrics.trees.unlock_rate}%)`);
      out(ctx, `  活动       ${metrics.activity.events_7d} events in 7d`);
      return 0;
    }
    case "brief": {
      const payload = buildBrief(env);
      const cur = payload.current_project;
      const stats = payload.counts;
      const skills = store.skillList().slice(0, 5);

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
      // R10.5: --level filter (info|warn|error), --run aggregation,
      // --usage token spend summary over eval events
      const level = String(args.flags.level || "");
      const run = String(args.flags.run || "");
      if (args.flags.usage) {
        const rows = env.db.all(`SELECT payload FROM events WHERE kind IN ('eval.gate','eval.ready')`);
        let inputTokens = 0, outputTokens = 0, calls = 0;
        for (const r of rows) {
          try {
            const j = JSON.parse(r.payload || "{}");
            const u = j.usage || {};
            if (u.inputTokens || u.outputTokens) {
              inputTokens += Number(u.inputTokens) || 0;
              outputTokens += Number(u.outputTokens) || 0;
              calls++;
            }
          } catch { /* malformed legacy payload */ }
        }
        const summary = { calls, inputTokens, outputTokens };
        if (ctx.json) {
          console.log(JSON.stringify(summary, null, 2));
          return 0;
        }
        head(ctx, "eval token spend");
        out(ctx, `  calls ${calls} · input ${inputTokens} tok · output ${outputTokens} tok`);
        return 0;
      }
      let sql = "SELECT * FROM events WHERE 1=1";
      const params: any[] = [];
      if (level) {
        sql += " AND level=?";
        params.push(level);
      }
      if (run) {
        sql += " AND payload LIKE ?";
        params.push(`%"run":"${run}"%`);
      }
      sql += " ORDER BY ts DESC LIMIT ?";
      params.push(Number(args.flags.limit || 30));
      const rows = env.db.all(sql, params);
      if (ctx.json) {
        console.log(JSON.stringify(rows, null, 2));
        return 0;
      }
      table(ctx, rows, ["ts", "level", "kind", "entity", "id", "payload"], [
        "ts", "level", "kind", "entity", "entity_id", "payload",
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
