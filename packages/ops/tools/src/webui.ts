/**
 * WebUI — zero-dependency dashboard.
 *
 * Two modes:
 *   export  (default)  single-file HTML with data embedded as <script> JSON
 *   serve              live http server (node:http), data refreshed per request
 *
 * @module @ygl/ops-tools/webui
 */
import { Env } from "../../../core/database/src/types";
import { ok, bad, out, paint, C } from "../../../core/text/src/fmt";

interface DashboardData {
  brief: any;
  tree: any;
  claims: any[];
  sources: any[];
}

export function run(env: Env, action: string, rest: string[], args: any): number | Promise<number> {
  if (action === "serve") return serve(env, args);
  if (action !== "" && action !== "export") {
    bad(env.ctx, "usage: webui [export [--out <file>] | serve [--port N]]");
    return 2;
  }

  // ── export: gather once, embed, write file ──
  const data = gatherData(env);
  const html = generateHTML(data, false);
  const dest = String(args.flags.out || "dashboard.html");
  require("node:fs").writeFileSync(dest, html, "utf8");

  ok(env.ctx, `dashboard written to ${dest} (${(html.length / 1024).toFixed(1)} KB)`);
  out(env.ctx, paint(C.dim, `  open in browser: file://${require("node:path").resolve(dest)}`, env.ctx.color));
  return 0;
}

/** Collect dashboard data from the current workspace state. */
export function gatherData(env: Env): DashboardData {
  const { db, store } = env;

  const data: DashboardData = { brief: {}, tree: null, claims: [], sources: [] };

  const cur = db.metaGet("current_project");
  data.brief = { current_project: cur || null, counts: store.stats(), next_actions: [] };

  if (cur) {
    const project = store.projectByName(cur);
    if (project) {
      data.claims = store.claimList(project.id);
      data.sources = store.sourceList(project.id).slice(0, 20);
    }
  }

  const currentTree = db.metaGet("current_tree");
  if (currentTree) {
    const trees = db.all("SELECT * FROM trees WHERE name=? OR id=?", [currentTree, currentTree]);
    if (trees.length) {
      const tid = trees[0].id;
      const nodes = db.all(
        "SELECT key, name, kind, tier, cost, tags FROM nodes WHERE tree_id=? ORDER BY tier, key",
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
  return data;
}

/** Single-file dashboard HTML. `live` adds a fetch bootstrap + auto-refresh. */
export function generateHTML(data: DashboardData, live: boolean): string {
  // < escaped so embedded JSON can never terminate the script element
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const footer = live
    ? "live mode · /api/data · auto-refresh 10s"
    : "data embedded at export time";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ygl-trees dashboard</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
h1 { font-size: 1.4em; color: #58a6ff; margin-bottom: 16px; }
h2 { font-size: 1.1em; color: #79c0ff; margin: 20px 0 10px; border-bottom: 1px solid #21262d; padding-bottom: 6px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin: 10px 0; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; text-align: center; }
.card .num { font-size: 1.6em; font-weight: bold; color: #58a6ff; }
.card .label { font-size: 0.75em; color: #8b949e; margin-top: 4px; }
.claim { background: #161b22; border-left: 3px solid #30363d; border-radius: 4px; padding: 10px 14px; margin: 6px 0; }
.claim.supported { border-left-color: #3fb950; }
.claim.refuted { border-left-color: #f85149; }
.claim.contested { border-left-color: #d29922; }
.claim.unverified { border-left-color: #8b949e; }
.claim .status { font-size: 0.75em; text-transform: uppercase; font-weight: bold; }
.claim.supported .status { color: #3fb950; }
.claim.refuted .status { color: #f85149; }
.claim.contested .status { color: #d29922; }
.claim.unverified .status { color: #8b949e; }
.claim .text { margin-top: 4px; font-size: 0.9em; }
svg { max-width: 100%; height: auto; }
.node { fill: #161b22; stroke: #30363d; stroke-width: 1.5; rx: 4; }
.node text { fill: #c9d1d9; font-size: 11px; text-anchor: middle; }
.edge { stroke: #30363d; stroke-width: 1.5; fill: none; marker-end: url(#arrow); }
.edge.optional { stroke-dasharray: 4 3; stroke: #8b949e; }
.edge.excludes { stroke: #f85149; }
.edge.unlock { stroke: #58a6ff; }
.footer { margin-top: 30px; font-size: 0.75em; color: #484f58; text-align: center; }
</style>
</head>
<body>
<h1>🐵 ygl-trees dashboard</h1>

<h2>📊 Overview</h2>
<div class="grid" id="stats"></div>

<h2>🌳 Tech Tree: <span id="tree-name"></span></h2>
<div id="tree-container"></div>

<h2>🔬 Research Claims</h2>
<div id="claims"></div>

<h2>📚 Sources</h2>
<div id="sources" style="font-size:0.85em;color:#8b949e;"></div>

<div class="footer">generated by ygl-trees webui · ${footer}</div>

<script>
const FALLBACK = ${json};

function render(DATA) {
  // ── Stats cards ──
  const statsEl = document.getElementById('stats');
  const counts = DATA.brief.counts || {};
  const cards = [
    ['skills', 'Skills'], ['kb_notes', 'KB Notes'], ['sources', 'Sources'],
    ['evidence', 'Evidence'], ['claims', 'Claims'], ['artifacts', 'Artifacts'],
    ['trees', 'Trees'], ['nodes', 'Nodes'],
  ];
  statsEl.innerHTML = cards.map(([k, label]) =>
    '<div class="card"><div class="num">' + (counts[k] ?? 0) + '</div><div class="label">' + label + '</div></div>'
  ).join('');

  // ── Claims ──
  const claimsEl = document.getElementById('claims');
  if (DATA.claims && DATA.claims.length) {
    claimsEl.innerHTML = DATA.claims.map(c =>
      '<div class="claim ' + c.status + '">' +
      '<span class="status">' + c.status + '</span> ' +
      '<span class="text">' + c.text.slice(0, 120) + '</span>' +
      ' <small style="color:#8b949e">sup=' + c.sup + ' ref=' + c.ref + '</small></div>'
    ).join('');
  } else {
    claimsEl.innerHTML = '<p style="color:#484f58">No claims yet (select a project first)</p>';
  }

  // ── Sources ──
  const sourcesEl = document.getElementById('sources');
  if (DATA.sources && DATA.sources.length) {
    sourcesEl.innerHTML = DATA.sources.map(s =>
      '• <strong>' + (s.title || 'untitled') + '</strong>' +
      (s.url ? ' — <a href="' + s.url + '" style="color:#58a6ff">' + s.url.slice(0, 50) + '</a>' : '') +
      ' (relevance: ' + s.relevance + ')'
    ).join('<br>');
  } else {
    sourcesEl.innerHTML = '<p style="color:#484f58">No sources</p>';
  }

  // ── Tech Tree (SVG DAG) ──
  const treeEl = document.getElementById('tree-container');
  const treeNameEl = document.getElementById('tree-name');
  if (DATA.tree && DATA.tree.nodes && DATA.tree.nodes.length) {
    treeNameEl.textContent = DATA.tree.name;
    const nodes = DATA.tree.nodes;
    const edges = DATA.tree.edges || [];

    // Layout: tier-based vertical positioning
    const W = 900, nodeW = 120, nodeH = 36, vGap = 70, hGap = 140;
    const tiers = {};
    nodes.forEach(n => { const t = n.tier || 0; (tiers[t] = tiers[t] || []).push(n); });
    const tierKeys = Object.keys(tiers).map(Number).sort((a,b)=>a-b);
    const maxPerTier = Math.max(...tierKeys.map(t => tiers[t].length));

    const svgH = tierKeys.length * vGap + 80;
    const svgW = Math.max(W, maxPerTier * hGap + 100);

    const pos = {};
    tierKeys.forEach((t, ti) => {
      const row = tiers[t];
      row.forEach((n, ni) => {
        pos[n.key] = {
          x: svgW / 2 + (ni - (row.length - 1) / 2) * hGap,
          y: 40 + ti * vGap,
        };
      });
    });

    let svg = '<svg width="' + svgW + '" height="' + svgH + '" xmlns="http://www.w3.org/2000/svg">';
    svg += '<defs><marker id="arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6" fill="#30363d"/></marker></defs>';

    edges.forEach(e => {
      const from = pos[e.parent], to = pos[e.child];
      if (!from || !to) return;
      const cls = e.required ? '' : ' optional';
      const color = e.rel === 'excludes' ? ' excludes' : e.rel === 'unlock' ? ' unlock' : '';
      svg += '<line class="edge' + cls + color + '" x1="' + (from.x + nodeW/2) + '" y1="' + (from.y + nodeH/2) + '" x2="' + (to.x - nodeW/2 + nodeW) + '" y2="' + (to.y - nodeH/2 + nodeH) + '"/>';
    });

    nodes.forEach(n => {
      const p = pos[n.key];
      if (!p) return;
      svg += '<rect class="node" x="' + (p.x - nodeW/2) + '" y="' + p.y + '" width="' + nodeW + '" height="' + nodeH + '" rx="4"/>';
      svg += '<text x="' + p.x + '" y="' + (p.y + nodeH/2 + 4) + '">' + n.key.slice(0, 14) + '</text>';
    });

    svg += '</svg>';
    treeEl.innerHTML = svg;
  } else {
    treeNameEl.textContent = '(none selected)';
    treeEl.innerHTML = '<p style="color:#484f58">No tree selected (run: ygl-trees tree use &lt;name&gt;)</p>';
  }
}

// ── Bootstrap: paint embedded snapshot immediately; upgrade to live data ──
render(FALLBACK);
${live ? `
if (location.protocol.startsWith('http')) {
  const refresh = () => fetch('api/data')
    .then(r => r.ok ? r.json() : null)
    .then(d => { if (d) render(d); })
    .catch(() => {});
  refresh();
  setInterval(refresh, 10000);
}` : ""}
</script>
</body>
</html>`;
}

/** node:http dashboard server. Routes: / and /index.html → live HTML; /api/data → JSON. */
export function createDashboardServer(env: Env) {
  const http = require("node:http");
  return http.createServer((req: any, res: any) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(generateHTML(gatherData(env), true));
    } else if (url === "/api/data") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(gatherData(env)));
    } else {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  });
}

/** Live dashboard: blocks until SIGINT/SIGTERM, then resolves so the CLI can
 *  close the db in its finally block. */
function serve(env: Env, args: any): Promise<number> {
  const { ctx } = env;
  return new Promise<number>((resolve) => {
    const port = Number(args.flags.port || 8642);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      bad(ctx, `invalid --port: ${args.flags.port} (want 0-65535)`);
      resolve(2);
      return;
    }
    const server = createDashboardServer(env);
    const onErr = (e: any) => {
      bad(ctx, `webui serve: ${e?.message || e}`);
      resolve(1);
    };
    server.once("error", onErr);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onErr);
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      ok(ctx, `dashboard live at http://127.0.0.1:${p}/  (Ctrl+C to stop)`);
      out(ctx, paint(C.dim, `  data endpoint: http://127.0.0.1:${p}/api/data`, ctx.color));
    });
    const shutdown = () => {
      server.close(() => resolve(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
