/**
 * WebUI — zero-dependency dashboard.
 *
 * Two modes:
 *   export  (default)  single-file HTML with data embedded as <script> JSON
 *   serve              live http server (node:http), data refreshed per request
 *
 * @module @ygl/ops-tools/webui
 */
import { join } from "node:path";

import { Env } from "../../../core/database/src/types";
import { ok, bad, out, paint, C, ack } from "../../../core/text/src/fmt";
import { resolveDistRoot } from "../../../web/app/src/index";
import { TreeStore } from "../../../techtree/model/src/reads";
import { buildBrief } from "./agent-cmds";
import { resolveId } from "./rels";
import { getOrm } from "../../../core/database/src/orm";
import { openStatic as openWebApp } from "../../../web/app/src";
import { resolveProject, resolveTree, projectSample } from "../../../core/database/src/selection";
// 0.91a (direct-55b4ca85): static import — same ESM-silent-death family fix
import { onEvent } from "../../../core/text/src/eventbus";
import { BLOB_LIMIT, createMaterialDraft, handleVerifyApi, openBlobUpload, uploadAllowed, VERIFY_BODY_LIMIT } from "./verify-web";
import { prepareViaHttp, runViaHttp } from "./verify-jobs";
import { pruneIncoming } from "./blob-store";

interface DashboardData {
  brief: any;
  tree: any;
  /** R16.4: present when no session/env/flag selection resolves — the panel
   *  renders the 未选择 state with a picker instead of project data. */
  unselected?: { reason: string; projects: string[] };
  /** R16.1: how the tree pane's tree was picked (flag/env/session/global/only) */
  tree_selection_source?: string;
  claims: any[];
  sources: any[];
  /** evidence index: id -> {quote, locator, source_id} (for claim expand) */
  evidence: any[];
  /** claim↔evidence links (for claim expand) */
  claim_evidence: any[];
  /** R11.2: daily event aggregates [{day, research, tree, eval, other}] */
  timeline: any[];
  /** R12: task list [{id, title, status}] */
  tasks: any[];
  /** 0.35: artifact roster for the current project [{id, kind, title, version}] */
  artifacts: any[];
}

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  if (action === "serve") return serve(env, args);
  if (action !== "" && action !== "export") {
    bad(env.ctx, "usage: webui [export [--out <file>] | serve [--port N]]");
    return 2;
  }

  // ── export (0.88 单3): service-form snapshot — the same payload /api/data
  // serves, persisted to disk as JSON. The single-file HTML dashboard is
  // retired (user ruling: React is the only front end); visualization lives
  // in `webui serve`, data lives here.
  const data = gatherData(env);
  const snapshot = JSON.stringify({ meta: { generated: new Date().toISOString() }, ...data });
  const dest = String(args.flags.out || "snapshot.json");
  return (async (): Promise<number> => {
    // atomic write: a half-written snapshot on process kill is worse than none
    const { writeFileAtomic } = require("@deepseek-ai/dsh-atomic-write");
    await writeFileAtomic(dest, snapshot, {} as any);
    ack(env.ctx, { path: dest, bytes: snapshot.length }, `snapshot written to ${dest} (${(snapshot.length / 1024).toFixed(1)} KB)`);
    if (!env.ctx.json) out(env.ctx, paint(C.dim, `  service payload — visualize with: ygl-trees webui serve`, env.ctx.color));
    return 0;
  })();
}

/** Collect dashboard data from the current workspace state. */
export function gatherData(env: Env): DashboardData {
  const { db, store } = env;

  const data: DashboardData = { brief: {}, tree: null, claims: [], sources: [], evidence: [], claim_evidence: [], timeline: [], tasks: [], artifacts: [] };

  // full brief payload (next_actions / top_skills / project progress) — same
  // builder the `agent brief` command uses
  data.brief = buildBrief(env);

  // R16.4: webui reads the RESOLVED selection (session-aware); when nothing
  // resolves, the project pane shows the 未选择 state — never a silent
  // fallback onto the global pointer's content.
  const projSel = resolveProject(db);
  const cur = projSel.name || null;
  const projAuthorized =
    projSel.source === "flag" || projSel.source === "env" || projSel.source === "session" || projSel.source === "only";
  if (!projAuthorized) {
    // unselected (or global-pointer-only): don't render that project's data
    data.unselected = { reason: "no project selected", projects: projectSample(db, 20) };
    // 0.90.1 P2-1 (review direct-a35d58ae): buildBrief resolves the global
    // pointer too — strip brief.project so the unselected pane never leaks
    // the global project's name/progress ("never a silent fallback").
    if ((data.brief as any)?.project) delete (data.brief as any).project;
  }
  if (cur && projAuthorized) {
    const project = store.projectByName(cur);
    if (project) {
      data.claims = store.claimList(project.id);
      data.sources = store.sourceList(project.id).slice(0, 20);
      if (data.claims.length) {
        const ids = data.claims.map((c: any) => c.id);
        const ph = ids.map(() => "?").join(",");
        data.claim_evidence = db.all(
          `SELECT ce.claim_id, ce.evidence_id, ce.stance
             FROM claim_evidence ce WHERE ce.claim_id IN (${ph})`,
          ids
        );
        const evIds = [...new Set(data.claim_evidence.map((l: any) => l.evidence_id))];
        if (evIds.length) {
          const ph2 = evIds.map(() => "?").join(",");
          data.evidence = db.all(
            `SELECT id, quote, locator, source_id FROM evidence WHERE id IN (${ph2})`,
            evIds
          );
        }
      }
    }
  }

  // tree pane: resolved selection too (lenient — trees are workspace-level)
  const treeSel = resolveTree(db);
  const currentTree = treeSel.name || null;
  data.tree_selection_source = treeSel.source;
  if (currentTree) {
    const trees = db.all("SELECT * FROM trees WHERE name=? OR id=?", [currentTree, currentTree]);
    if (trees.length) {
      const tid = trees[0].id;
      // R11: created + unlock timestamp ride along for the time-axis layout
      // (node_state.updated is the unlock moment; default context)
      const nodes = db.all(
        `SELECT n.key, n.name, n.kind, n.tier, n.cost, n.tags, n.created,
                s.status AS state, s.updated AS unlocked_at
           FROM nodes n
           LEFT JOIN node_state s ON s.node_id = n.id AND s.context = 'default' AND s.status = 'unlocked'
          WHERE n.tree_id = ?
          ORDER BY n.tier, n.key`,
        [tid]
      );
      const edges = db.all(
        `SELECT p.key AS parent, c.key AS child, e.rel, e.mode, e.required
           FROM node_edges e
           JOIN nodes p ON p.id = e.parent_id
           JOIN nodes c ON c.id = e.child_id
          WHERE e.tree_id = ?`,
        [tid]
      );
      data.tree = { name: trees[0].name, nodes, edges };
    }
  }

  // R11.2: research-pipeline timeline — daily event aggregates, bucketed by
  // domain (research / tree / eval / other), last 30 days, capped
  data.timeline = db.all(
    `SELECT substr(ts, 1, 10) AS day,
            SUM(CASE WHEN kind LIKE 'source.%' OR kind LIKE 'evidence.%' OR kind LIKE 'claim.%'
                       OR kind LIKE 'query.%' OR kind LIKE 'kb.%' OR kind LIKE 'artifact.%' THEN 1 ELSE 0 END) AS research,
            SUM(CASE WHEN kind LIKE 'node.%' OR kind LIKE 'tree.%' THEN 1 ELSE 0 END) AS tree,
            SUM(CASE WHEN kind LIKE 'eval.%' THEN 1 ELSE 0 END) AS eval,
            SUM(CASE WHEN kind NOT LIKE 'source.%' AND kind NOT LIKE 'evidence.%' AND kind NOT LIKE 'claim.%'
                       AND kind NOT LIKE 'query.%' AND kind NOT LIKE 'kb.%' AND kind NOT LIKE 'artifact.%'
                       AND kind NOT LIKE 'node.%' AND kind NOT LIKE 'tree.%' AND kind NOT LIKE 'eval.%' THEN 1 ELSE 0 END) AS other
       FROM events
      WHERE ts >= date('now', '-30 days')
      GROUP BY day ORDER BY day`
  );

  // R12: task checklist (kind=task artifacts, status in the meta envelope)
  // R16.4: same authorization rule as the claims pane — no global fallback.
  if (cur && projAuthorized) {
    const project2 = store.projectByName(cur);
    if (project2) {
      data.tasks = db
        .all(
          "SELECT id, title, meta, created FROM artifacts WHERE project_id=? AND kind='task' ORDER BY created DESC",
          [project2.id]
        )
        .map((r: any) => {
          let meta: any = {};
          try { meta = r.meta ? JSON.parse(r.meta) : {}; } catch { /* malformed */ }

return { id: r.id, title: r.title, status: meta.status || "todo" };
        });
      // 0.35: artifact roster (non-task kinds; full text rides /api/artifact)
      data.artifacts = db
        .all(
          "SELECT id, kind, title, version, created FROM artifacts WHERE project_id=? AND kind<>'task' ORDER BY created DESC",
          [project2.id]
        )
        .map((r: any) => ({ id: r.id, kind: r.kind, title: r.title, version: r.version, created: r.created }));
    }
  }

  // R19 (0.90.1 P2-2, review direct-a35d58ae): knowledge graph is a
  // WORKSPACE-LEVEL view, but its endpoint labels carry claim/evidence text
  // — so it only renders under an AUTHORIZED selection, and label-bearing
  // endpoints (claim/evidence/artifact) outside the selected project are
  // dropped; nodes/trees and kb stay (workspace-level by design).
  const kgNodes: any[] = [];
  const kgEdges: any[] = [];
  const kgMap = new Map<string, any>();
  const kgInProject = (type: string, id: string): boolean => {
    try {
      if (type === "claim") return !!db.get("SELECT 1 FROM claims WHERE id=? AND project_id=?", [id, projSel.id]);
      if (type === "evidence") return !!db.get("SELECT 1 FROM evidence WHERE id=? AND project_id=?", [id, projSel.id]);
      if (type === "artifact") return !!db.get("SELECT 1 FROM artifacts WHERE id=? AND project_id=?", [id, projSel.id]);
      return true; // node / kb / skill / unknown: workspace-level
    } catch { return false; }
  };
  if (projAuthorized) {
    try {
      const rels = db.all("SELECT src_type, src_id, dst_type, dst_id, rel FROM relations ORDER BY rowid DESC LIMIT 200") as any[];
      // 0.92 单B: DESIGN.md palette only (see apps/web/src/tokens.ts) — type →
      // semantic token: node=primary (structure), claim=success (adjudication),
      // evidence/source=warning (evidence family), artifact/task=tertiary
      // (executable work), kb/skill=secondary (knowledge metadata).
      const colors: Record<string, string> = {
        node: "#58a6ff", claim: "#3fb950", kb: "#8b949e",
        evidence: "#d29922", artifact: "#79c0ff", skill: "#8b949e",
        task: "#79c0ff", source: "#d29922",
      };
      for (const r of rels) {
        if (!kgInProject(r.src_type, r.src_id) || !kgInProject(r.dst_type, r.dst_id)) continue;
        for (const side of ["src", "dst"]) {
          const type = r[`${side}_type`]; const id = r[`${side}_id`];
          const key = `${type}:${id}`;
          if (kgMap.has(key)) continue;
          let label = id;
          try {
            if (type === "node") { const n = db.get("SELECT name FROM nodes WHERE id=?", [id]) as any; if (n) label = n.name; }
            else if (type === "claim") { const c = db.get("SELECT substr(text,1,40) AS t FROM claims WHERE id=?", [id]) as any; if (c) label = c.t; }
            else if (type === "kb") { const k = db.get("SELECT title FROM kb_notes WHERE id=?", [id]) as any; if (k) label = k.title.slice(0, 40); }
            else if (type === "evidence") { const e = db.get("SELECT substr(quote,1,40) AS q FROM evidence WHERE id=?", [id]) as any; if (e) label = e.q; }
            else if (type === "artifact") { const a = db.get("SELECT title FROM artifacts WHERE id=?", [id]) as any; if (a) label = a.title; }
          } catch { /* best-effort */ }
          kgMap.set(key, { id: key, label, type, color: colors[type] || "#8b949e" });
        }
        kgEdges.push({ source: `${r.src_type}:${r.src_id}`, target: `${r.dst_type}:${r.dst_id}`, label: r.rel });
      }
    } catch { /* graph data best-effort */ }
  }
  (data as any).knowledge_graph = { nodes: Array.from(kgMap.values()), edges: kgEdges };

  return data;
}

/** node detail payload for /api/node — deterministic evaluation only
 *  (op=eval gates surface as missing entries, like `node can` without --eval). */
export function nodeDetail(env: Env, treeName: string, key: string): Record<string, any> | null {
  const { db } = env;
  const trees = db.all("SELECT * FROM trees WHERE name=? OR id=?", [treeName, treeName]);
  if (!trees.length) return null;
  const ts = new TreeStore(db);
  const tid = trees[0].id;
  const node = ts.nodeGet(tid, key);
  if (!node) return null;
  // R9: relation fabric — both directions, other end resolved to a display
  const rels = db.all(
    `SELECT rel, src_type AS other_type, src_id AS other_id, 'in' AS dir
       FROM relations WHERE dst_type='node' AND dst_id=?
      UNION ALL
     SELECT rel, dst_type AS other_type, dst_id AS other_id, 'out' AS dir
       FROM relations WHERE src_type='node' AND src_id=?`,
    [node.id, node.id]
  );
  return {
    node,
    parents: ts.parents(tid, key),
    children: ts.children(tid, key),
    conditions: ts.condList(tid, key),
    can: ts.canUnlock(tid, key),
    related: rels.map((r: any) => ({ rel: r.rel, type: r.other_type, id: r.other_id, dir: r.dir, display: resolveId(env, r.other_type, r.other_id) })),
  };
}

/** node:http dashboard server. Routes:
 *  / and /index.html → live HTML; /api/data → dashboard JSON;
 *  /api/events → SSE stream (server-side change detection, pushes fresh
 *  payloads so clients never poll); /api/node?tree=<name>&key=<key> → node detail. */
export function createDashboardServer(env: Env, opts: { allowUpload?: boolean; enableVerifyJobs?: boolean } = {}) {
  // 默认关闭：只有 serve 在回环地址上显式打开（或 YGL_VERIFY_ALLOW_UPLOAD=1）。
  // 嵌入方不传旗标时不该默默获得写盘能力。
  const allowUpload = opts.allowUpload === true;
  const enableVerifyJobs = opts.enableVerifyJobs === true;
  // command 型检查器的白名单在 serve 启动时定下（请求体永不携带 argv）：默认只放 node，
  // 需要更多就跑 `YGL_VERIFY_ALLOW_CMD="node,python" webui serve --enable-verify-jobs`。
  // 空串是**显式空表**（全禁 command，fail-closed），只有未设置才回落 node —— 用 ?? 不是 ||，
  // 否则操作员写 YGL_VERIFY_ALLOW_CMD= 想全禁，却静默拿到 node（fail-open）。
  const jobDeps = {
    commandAllowlist: String(process.env.YGL_VERIFY_ALLOW_CMD ?? "node")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  };
  // 启动时清掉上次异常退出留下的上传半截文件（fdc757f6 骑士②）。
  try { pruneIncoming(join(env.home, "verify")); } catch { /* 没有 verify 目录就是没上传过 */ }
  const http = require("node:http");
  // 0.88 单3 (user ruling): React client (apps/web/dist) is the ONLY front
  // end. Dist missing → non-API routes answer an honest 503 with the build
  // hint; `webui serve` refuses to start at all.
  const hasWebApp = openWebApp("/") !== null;

  // ── SSE live channel (0.39): a cheap fingerprint over the tables the
  // dashboard renders; when it moves, every connected client gets a push.
  // Server-side polling is 1.5s and constant-cost; clients do zero polling.
  // Fault-tolerant by table: a missing/renamed table must not freeze the
  // channel (tasks live in artifacts, not a table of their own).
  const sseClients = new Set<any>();
  const FP_TABLES = [
    "events", "artifacts", "nodes", "node_edges", "node_state", "node_conditions",
    "claims", "claim_evidence", "evidence", "sources", "queries", "kb_notes",
    "kb_links", "relations", "skills", "projects", "jobs", "runs",
  ];
  const fingerprint = (): string => {
    const parts: string[] = [];
    for (const t of FP_TABLES) {
      let n = "?";
      try {
        const r = env.db.get(`SELECT COUNT(*) AS n FROM ${t}`) as any;
        n = String(r?.n ?? 0);
      } catch { /* table absent — keep the marker, identity unaffected */ }
      parts.push(`${t}:${n}`);
    }
    return parts.join("|");
  };
  let lastFp = fingerprint();
  const push = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) {
      try { c.write(frame); } catch { sseClients.delete(c); }
    }
  };
  const tick = () => {
    if (!sseClients.size) return;
    // 0.90.1 P1-2 (review direct-a35d58ae): concurrent CLI writes can raise
    // SQLITE_BUSY on this read connection mid-gather — a failed frame is
    // DROPPED, never fatal: serve exists precisely because other processes
    // write while the panel stays alive.
    try {
      const fp = fingerprint();
      if (fp !== lastFp) {
        lastFp = fp;
        push("data", gatherData(env));
      }
    } catch { /* skip this frame */ }
  };
  // lifecycle-managed when the timer plugin is loaded (vendor ammo), else raw
  const timerCtx: any = (env as any).cordis;
  if (timerCtx?.timer?.setInterval) timerCtx.timer.setInterval(tick, 1500);
  else {
    const h = setInterval(tick, 1500);
    if (typeof h.unref === "function") h.unref();
  }

  // ── 0.76 Event-driven SSE / 0.86 M7-3 (Cordis P0-3): subscribe via the
  // PUBLIC Cordis channel ctx.on("ygl") — the eventbus is the internal
  // write-path transport (bridged into ctx.emit by DatabasePlugin); SSE
  // rides the documented API, not the transport. Direct-eventbus fallback
  // covers non-Cordis hosts (tests, embedded servers); the fingerprint
  // tick below stays as the degradation path.
  let unsubBus: (() => void) | null = null;
  const cordisCtx: any = (env as any).cordis;
  const onYglEvent = (evt: any) => {
    if (!sseClients.size) return;
    // 0.90.1 P1-2: same isolation as tick — one bad gather must not kill serve
    try {
      // Event received — push immediately (no polling delay)
      push("data", gatherData(env));
      // Also push the event itself as a named SSE event for fine-grained consumers
      push(String(evt.kind || "ygl").replace(/\//g, "-"), evt);
    } catch { /* skip this frame */ }
  };
  if (typeof cordisCtx?.on === "function") {
    unsubBus = cordisCtx.on("ygl", onYglEvent) as unknown as () => void;
  } else {
    // 0.91a review (direct-55b4ca85): static import — the old require() form
    // silently died under ESM hosts, leaving only the fingerprint tick.
    try {
      unsubBus = onEvent(onYglEvent);
    } catch { /* eventbus optional — fingerprint tick still covers */ }
  }

  const server = http.createServer((req: any, res: any) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    const url = u.pathname;
    if (url === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 3000\n\n");
      // initial snapshot: the client needs no separate fetch
      res.write(`event: data\ndata: ${JSON.stringify(gatherData(env))}\n\n`);
      sseClients.add(res);
      const drop = () => { sseClients.delete(res); };
      req.on("close", drop);
      req.on("error", drop);
      res.on("error", drop);
      return;
    }
    // 0.88 单3 (user ruling): React client is the ONLY front end — the
    // embedded pure-HTML dashboard is retired. No /classic, no silent
    // fallback: dist missing → honest 503 telling the user how to build.
    if (!url.startsWith("/api/")) {
      if (!hasWebApp) {
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
        res.end("React client dist missing — run: pnpm --filter @ygl/web build (repo) or reinstall the ygl-trees package");
        return;
      }
      const f = openWebApp(url);
      if (f) {
        const headers: Record<string, string> = { "content-type": f.mime };
        // 0.90.1 P3-3: hashed build assets are immutable; the shell must
        // always revalidate so upgrades are picked up on refresh.
        if (/\/assets\/.+\.[0-9a-f]{8,}\.(js|css|woff2?|png|svg)$/.test(url)) {
          headers["cache-control"] = "public, max-age=31536000, immutable";
        } else {
          headers["cache-control"] = "no-cache";
        }
        res.writeHead(200, headers);
        res.end(f.body);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`not found: ${url}`);
      return;
    }
    if (url === "/api/data") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(gatherData(env)));
    } else if (url === "/api/node") {
      // R16.4: tree param falls back to the RESOLVED selection (session-aware)
      const tree = u.searchParams.get("tree") || resolveTree(env.db).name || "";
      const key = u.searchParams.get("key") || "";
      if (!tree || !key) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("usage: /api/node?tree=<name>&key=<key>");
        return;
      }
      const detail = nodeDetail(env, tree, key);
      if (!detail) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end(`node not found: ${tree}/${key}`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(detail));
    } else if (url === "/api/artifact") {
      // 0.35: full artifact text for the markdown renderer.
      // R16.4: by id direct — artifacts.project_id is NOT NULL (db.ts:147).
      // Ownership check: an authorized selection (flag/env/session/only) must
      // match the artifact's project; unselected or cross-project → 404.
      const id = u.searchParams.get("id") || "";
      const row = id
        ? env.db.get(
            `SELECT a.id, a.kind, a.title, a.content, a.version, a.project_id, p.name AS project
               FROM artifacts a JOIN projects p ON p.id = a.project_id WHERE a.id=?`,
            [id]
          )
        : null;
      const psel = resolveProject(env.db);
      const authorized = psel.source === "flag" || psel.source === "env" || psel.source === "session" || psel.source === "only";
      const owned = row && authorized && (psel as any).id === String((row as any).project_id);
      if (!row || !owned) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end(
          !id
            ? "usage: /api/artifact?id=<id>"
            : row
              ? `artifact not accessible under current selection: ${id} (belongs to ${(row as any).project})`
              : `artifact not found: ${id}`
        );
        return;
      }
      const { project_id, ...pub } = row as any;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(pub));
    } else if (url === "/api/task" && req.method === "POST") {
      // R12: advance a task along its state machine from the dashboard.
      // 0.90.1 P1-1 (review direct-a35d58ae): write endpoints are fail-closed
      // like reads — ownership mirrors /api/artifact (authorized selection
      // must match the task's project); unselected/cross-project → 404,
      // malformed body or status → 400. Body capped (64 KB) for sanity.
      let body = "";
      let overflow = false;
      req.on("data", (c: any) => {
        body += c;
        if (body.length > 64 * 1024) { overflow = true; try { req.destroy(); } catch { /* */ } }
      });
      req.on("end", () => {
        (async () => {
          try {
            if (overflow) throw new Error("request body too large");
            const { id, status } = JSON.parse(body || "{}");
            if (!id || !["todo", "doing", "done"].includes(String(status))) {
              res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
              res.end('usage: POST /api/task {"id":"<task id>","status":"todo|doing|done"}');
              return;
            }
            const row = env.db.get(
              "SELECT id, project_id FROM artifacts WHERE id=? AND kind='task'",
              [String(id)]
            ) as any;
            const psel = resolveProject(env.db);
            const authorized = psel.source === "flag" || psel.source === "env" || psel.source === "session" || psel.source === "only";
            const owned = row && authorized && (psel as any).id === String(row.project_id);
            if (!row || !owned) {
              res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
              res.end(!row ? `task not found: ${id}` : `task not accessible under current selection: ${id}`);
              return;
            }
            const next = ({ todo: "doing", doing: "done", done: "done" } as any)[String(status)];
            const ds = await getOrm(env.db.path);
            const { taskSetStatus } = await import("../../../research/pipeline/src/writes");
            const r = await taskSetStatus(ds, String(id), next);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(r));
          } catch (e: any) {
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            res.end(String(e?.message || e));
          }
        })();
      });
      return;
    } else if (url.startsWith("/api/verify/")) {
      // M13-2 服务面：三视图的数据源。只读为主，唯一写入面是材料草稿
      // （POST /api/verify/material）。构造追溯没有 ✓/✗ 端点——它是事后审计面。
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
      };
      // 附件字节上传：内容寻址仓的唯一 HTTP 入口。原始字节 PUT（不解析 multipart），
      // 边收边哈希落 .incoming/*.part，超限立刻断连——半截文件永远不会变成"完整附件"。
      if (url === "/api/verify/blob" && (req.method || "").toUpperCase() === "PUT") {
        if (!allowUpload) {
          return send(403, {
            error: "blob upload is disabled: serve bound a non-loopback address; set YGL_VERIFY_ALLOW_UPLOAD=1 to enable",
          });
        }
        const name = u.searchParams.get("name") || "attachment";
        const mimeHint = u.searchParams.get("mime") || undefined;
        const sink = openBlobUpload(env);
        let done = false;
        req.on("data", (c: any) => {
          if (done) return;
          if (!sink.write(Buffer.isBuffer(c) ? c : Buffer.from(c))) {
            // 超限：立刻回 413 JSON 并丢弃后续字节。先 destroy 会让客户端只看到断连，
            // 与契约「失败也机器可读」相抵（r18 P3）。
            done = true;
            sink.abort();
            send(413, { error: `blob too large: exceeds ${BLOB_LIMIT} bytes` });
            try { req.resume(); } catch { /* */ }
          }
        });
        req.on("end", () => {
          if (done) return;
          done = true;
          if (sink.overflowed()) {
            sink.abort();
            return send(413, { error: `blob too large: exceeds ${BLOB_LIMIT} bytes` });
          }
          try {
            const ref = sink.finish(name, mimeHint);
            return send(200, ref);
          } catch (e: any) {
            sink.abort();
            return send(400, { error: String(e?.message || e) });
          }
        });
        req.on("error", () => {
          if (done) return;
          done = true;
          sink.abort();
        });
        return;
      }
      // 作业式验证面（0.102.0）：prepare/run。默认关闭——只有显式 --enable-verify-jobs
      // 才把"能跑 spec"这个能力交给 HTTP；执行面一律要求 JSON 请求体。
      if (url === "/api/verify/prepare" || url === "/api/verify/run") {
        if ((req.method || "").toUpperCase() !== "POST") {
          return send(405, { error: "use POST" });
        }
        if (!enableVerifyJobs) {
          return send(403, { error: "verify jobs are disabled: start serve with --enable-verify-jobs" });
        }
        const ct = String(req.headers["content-type"] || "").toLowerCase();
        if (!ct.includes("application/json")) {
          return send(415, { error: "content-type must be application/json" });
        }
        let body = "";
        let overflow = false;
        req.on("data", (c: any) => {
          if (overflow) return;
          body += c;
          if (body.length > VERIFY_BODY_LIMIT) { overflow = true; body = ""; }
        });
        req.on("end", () => {
          void (async () => {
            if (overflow) return send(413, { error: `request body too large (limit ${VERIFY_BODY_LIMIT} bytes)` });
            let parsed: unknown;
            try {
              parsed = JSON.parse(body || "{}");
            } catch (e: any) {
              return send(400, { error: `invalid JSON body: ${String(e?.message || e)}` });
            }
            const r = url === "/api/verify/prepare" ? await prepareViaHttp(env, parsed) : await runViaHttp(env, parsed, jobDeps);
            send(r.status, r.body);
          })().catch((e: any) => send(500, { error: String(e?.message || e) }));
        });
        return;
      }
      if (url === "/api/verify/material" && req.method === "POST") {
        // r18 P3：写端点要求 JSON（表单/跨站 simple request 直接挡在解析之前）。
        const ct = String(req.headers["content-type"] || "").toLowerCase();
        if (!ct.includes("application/json")) {
          return send(415, { error: "content-type must be application/json" });
        }
        let body = "";
        let overflow = false;
        req.on("data", (c: any) => {
          if (overflow) return; // 丢弃后续字节但把连接读完——直接 destroy 会让客户端看到断连而不是 JSON 错误
          body += c;
          if (body.length > VERIFY_BODY_LIMIT) { overflow = true; body = ""; }
        });
        req.on("end", () => {
          try {
            if (overflow) return send(413, { error: `request body too large (limit ${VERIFY_BODY_LIMIT} bytes)` });
            const parsed = JSON.parse(body || "{}");
            // attachments 现在是合法的 sha256 引用列表；引用不存在的 blob 由草稿层拒收。
            const r = createMaterialDraft(env, parsed ?? {});
            if (!r.ok) return send(400, { error: r.error });
            return send(200, r);
          } catch (e: any) {
            return send(400, { error: String(e?.message || e) });
          }
        });
        return;
      }
      const r = handleVerifyApi(env, req.method || "GET", u);
      send(r.status, r.body);
      return;
    } else {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  });
  // SSE clients hold the connection open — drop them on server close so the
  // process can exit (and so --json/none-mode callers never hang).
  const dropLive = () => {
    for (const c of sseClients) { try { c.end(); } catch { /* */ } }
    sseClients.clear();
  };
  server.on("close", dropLive);
  (server as any).closeLive = () => {
    dropLive();
    if (unsubBus) { try { unsubBus(); } catch { /* */ } unsubBus = null; }
  };
  return server;
}

/** Live dashboard: blocks until SIGINT/SIGTERM, then resolves so the CLI can
 *  close the db in its finally block. Server-side heartbeat (doctor-lite
 *  check every 60s) runs on ctx.timer (vendored cordis-plugin-timer) —
 *  lifecycle-managed: dispose cleans it automatically. */
function serve(env: Env, args: any): Promise<number> {
  const { ctx } = env;
  // 0.79.1 (R297 user report): `webui serve --help` used to fall through and
  // actually start a server — an accidental extra process. Short-circuit.
  if (args.flags.help || args.flags.h) {
    out(ctx, `usage: ygl-trees webui serve [--port N] [--host H] [--enable-verify-jobs]`);
    out(ctx, paint(C.dim, `  --port N    listen port (default 8642; 0 = pick a free one)`, ctx.color));
    out(ctx, paint(C.dim, `  --host H    bind address (default 127.0.0.1; 0.0.0.0 opens to LAN)`, ctx.color));
    out(ctx, paint(C.dim, `  --enable-verify-jobs  enable POST /api/verify/prepare + /api/verify/run (default off; command allowlist from YGL_VERIFY_ALLOW_CMD, default node)`, ctx.color));
    out(ctx, paint(C.dim, `  endpoints:  / React client · /api/data · /api/events SSE · /api/node /api/artifact /api/task · /api/verify/*`, ctx.color));
    return Promise.resolve(0);
  }
  // 0.88 单3 (user ruling): React is the only front end — no embedded-HTML
  // fallback. Missing dist = honest refusal instead of a degraded dashboard.
  const reactAvailable = resolveDistRoot() !== null;
  if (!reactAvailable) {
    bad(
      ctx,
      `webui serve: React client dist not found (apps/web/dist) — build it with: pnpm --filter @ygl/web build (repo checkout) or reinstall the ygl-trees package (npm install ships dist/apps/web/dist)`
    );
    return Promise.resolve(1);
  }
  return new Promise<number>((resolve) => {
    const port = Number(args.flags.port || 8642);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      bad(ctx, `invalid --port: ${args.flags.port} (want 0-65535)`);
      resolve(2);
      return;
    }
    // ④ cold-user report: hardcoded 127.0.0.1 blocks LAN/WSL access.
    // Default stays 127.0.0.1 (safe); --host 0.0.0.0 opens to the network.
    const host = String(args.flags.host || "127.0.0.1");
    // 附件上传面随绑定地址收放：非回环地址默认关闭（写端点 + 任意字节 = 磁盘填充面）。
    const server = createDashboardServer(env, { allowUpload: uploadAllowed(host), enableVerifyJobs: args.flags["enable-verify-jobs"] === true });
    const onErr = (e: any) => {
      bad(ctx, `webui serve: ${e?.message || e}`);
      resolve(1);
    };
    server.once("error", onErr);
    server.listen(port, host, () => {
      server.removeListener("error", onErr);
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      ok(ctx, `dashboard live at http://127.0.0.1:${p}/  (Ctrl+C to stop)`);
      out(ctx, paint(C.dim, `  data endpoint: http://127.0.0.1:${p}/api/data`, ctx.color));

      // vendored cordis-plugin-timer: lifecycle-managed heartbeat
      // (auto-cleans on ctx dispose — no manual clearInterval needed)
      const cordisCtx = (env as any).cordis;
      if (cordisCtx?.timer) {
        cordisCtx.timer.setInterval(() => {
          try {
            const stats = env.store.stats();
            const total = Object.values(stats).reduce((a: number, b: any) => a + Number(b), 0);
            if (ctx.quiet !== true) {
              out(ctx, paint(C.dim, `  [heartbeat] ${new Date().toISOString().slice(11, 19)} · ${total} rows`, ctx.color));
            }
          } catch { /* heartbeat best-effort */ }
        }, 60_000);
      }
    });
    const shutdown = () => {
      // SSE clients hold live sockets forever: server.close() alone would wait
      // for them and never call back. Drop them, then close.
      try { (server as any).closeLive?.(); } catch { /* */ }
      try { (server as any).closeAllConnections?.(); } catch { /* older node */ }
      server.close(() => resolve(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
