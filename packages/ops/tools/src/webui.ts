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
import { TreeStore } from "../../../techtree/model/src/reads";
import { buildBrief } from "./agent-cmds";
import { resolveId } from "./rels";
import { getOrm } from "../../../core/database/src/orm";
import { openStatic as openWebApp } from "../../../web/app/src";

interface DashboardData {
  brief: any;
  tree: any;
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
  return (async (): Promise<number> => {
    // atomic write: a half-written dashboard on process kill is worse than none
    const { writeFileAtomic } = require("@deepseek-ai/dsh-atomic-write");
    await writeFileAtomic(dest, html, {} as any);
    ok(env.ctx, `dashboard written to ${dest} (${(html.length / 1024).toFixed(1)} KB)`);
    out(env.ctx, paint(C.dim, `  open in browser: file://${require("node:path").resolve(dest)}`, env.ctx.color));
    return 0;
  })();
}

/** Collect dashboard data from the current workspace state. */
export function gatherData(env: Env): DashboardData {
  const { db, store } = env;

  const data: DashboardData = { brief: {}, tree: null, claims: [], sources: [], evidence: [], claim_evidence: [], timeline: [], tasks: [] };

  // full brief payload (next_actions / top_skills / project progress) — same
  // builder the `agent brief` command uses
  data.brief = buildBrief(env);

  const cur = db.metaGet("current_project");
  if (cur) {
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

  const currentTree = db.metaGet("current_tree");
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
  if (cur) {
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
    }
  }
  return data;
}

/** Single-file dashboard HTML. `live` adds a fetch bootstrap + auto-refresh. */
export function generateHTML(data: DashboardData, live: boolean): string {
  // < escaped so embedded JSON can never terminate the script element
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const footer = live
    ? "live 模式 · /api/data · 每 10 秒自动刷新"
    : "数据内嵌于导出时";
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
.claim { background: #161b22; border-left: 3px solid #30363d; border-radius: 4px; padding: 10px 14px; margin: 6px 0; cursor: pointer; transition: background .15s ease; }
.claim:hover, .claim:focus-visible { background: #1c2129; }
.claim:focus-visible { outline: 2px solid #58a6ff; outline-offset: -2px; }
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
.claim .meta { font-size: 0.75em; color: #8b949e; margin-top: 4px; }
.progress { margin: 10px 0 4px; color: #c9d1d9; font-size: 0.88em; }
.progress .dim { margin-top: 2px; }
.action { font-family: ui-monospace, Consolas, monospace; font-size: 0.78em; color: #79c0ff; margin: 3px 0; overflow-wrap: anywhere; }
.group-h { font-size: 0.78em; text-transform: uppercase; letter-spacing: .05em; color: #8b949e; margin: 14px 0 4px; }
.group-h b { color: #c9d1d9; }
.ev-list { margin-top: 8px; border-top: 1px dashed #21262d; padding-top: 8px; }
.ev { font-size: 0.82em; color: #8b949e; margin: 5px 0; line-height: 1.5; }
.ev .stance { display: inline-block; font-size: 0.85em; padding: 0 7px; border-radius: 8px; border: 1px solid #30363d; margin-right: 6px; }
.ev .stance.supports { color: #3fb950; border-color: rgba(63,185,80,.4); }
.ev .stance.refutes { color: #f85149; border-color: rgba(248,81,73,.4); }
.chip { display: inline-block; padding: 1px 9px; margin: 2px 4px 2px 0; border: 1px solid #30363d; border-radius: 10px; font-size: 0.75em; color: #c9d1d9; background: #0d1117; }
a.chip, .chip.click { cursor: pointer; text-decoration: none; }
.chip.click:hover, .chip.click:focus-visible { border-color: #58a6ff; color: #58a6ff; outline: none; }
#node-panel { position: fixed; right: 20px; top: 20px; bottom: 20px; width: 330px; max-width: calc(100vw - 40px); background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; overflow-y: auto; display: none; z-index: 100; box-shadow: 0 8px 24px rgba(0,0,0,.45); }
#node-panel h3 { color: #58a6ff; margin-bottom: 8px; padding-right: 26px; font-size: 1.05em; }
.panel-close { position: absolute; top: 8px; right: 10px; cursor: pointer; color: #8b949e; background: none; border: none; font-size: 15px; line-height: 1; padding: 4px; }
.panel-close:hover, .panel-close:focus-visible { color: #c9d1d9; outline: none; }
.panel-sec { font-size: 0.78em; text-transform: uppercase; letter-spacing: .05em; color: #8b949e; margin: 14px 0 4px; }
.can-badge { font-weight: bold; font-size: 0.9em; }
.can-badge.ok { color: #3fb950; }
.can-badge.bad { color: #f85149; }
.cond-table { width: 100%; border-collapse: collapse; font-size: 0.78em; margin: 6px 0; }
.cond-table th, .cond-table td { border: 1px solid #21262d; padding: 3px 6px; text-align: left; color: #c9d1d9; }
.cond-table th { color: #8b949e; font-weight: normal; }
.dim { color: #8b949e; font-size: 0.82em; }
.node-box { cursor: pointer; }
.node-box:hover rect, .node-box:focus-visible rect { stroke: #58a6ff; }
.node-box:focus-visible rect { outline: none; }
.node-box.selected rect { stroke: #58a6ff; stroke-width: 2.5; }
.node-box:focus { outline: none; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
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

<h2>📊 总览</h2>
<div class="grid" id="stats"></div>
<div id="brief-extra"></div>

<h2>🌳 Tech Tree: <span id="tree-name"></span>
  <span class="chip click" id="layout-toggle" role="button" tabindex="0"
        onclick="toggleLayout()" onkeydown="keyToggle(event,'__lt')">布局：分层</span>
</h2>
<div id="tree-container"></div>

<h2>🕒 Timeline <span class="dim">(近 30 天事件推进)</span></h2>
<div id="timeline"></div>

<h2>✅ Tasks</h2>
<div id="tasks"></div>

<h2>🔬 研究断言</h2>
<div id="claims"></div>

<h2>📚 Sources</h2>
<div id="sources" style="font-size:0.85em;color:#8b949e;"></div>

<aside id="node-panel" aria-live="polite" aria-label="node detail"></aside>

<div class="footer">由 ygl-trees webui 生成 · ${footer}</div>

<script>
const FALLBACK = ${json};

var LAST = null;
var uiState = { expanded: {}, selectedNode: null, layout: "tier" };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function jq(s) { return String(s == null ? '' : s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"); }

function render(DATA) {
  LAST = DATA;

  // ── Stats cards ──
  const statsEl = document.getElementById('stats');
  const counts = DATA.brief.counts || {};
  const cards = [
    ['skills', '技能'], ['kb_notes', '知识笔记'], ['sources', '来源'],
    ['evidence', '证据'], ['claims', '断言'], ['artifacts', '产出'],
    ['trees', '科技树'], ['nodes', '节点'],
  ];
  statsEl.innerHTML = cards.map(function (card) {
    return '<div class="card"><div class="num">' + (counts[card[0]] ?? 0) + '</div><div class="label">' + card[1] + '</div></div>';
  }).join('');

  // ── brief extras: project progress + next actions + top skills ──
  const extraEl = document.getElementById('brief-extra');
  let extra = '';
  const p = DATA.brief.project;
  if (p) {
    extra += '<div class="progress">项目 <b>' + esc(p.name) + '</b>' +
      ' · 来源 ' + p.sources + ' · 证据 ' + p.evidence +
      ' · 断言 ' + p.verified_claims + '/' + p.claims + ' 已证实 · 产出 ' + p.artifacts +
      (p.question ? '<div class="dim">' + esc(p.question) + '</div>' : '') + '</div>';
  }
  const na = DATA.brief.next_actions || [];
  if (na.length) {
    extra += '<div class="panel-sec">下一步操作</div>' +
      na.map(function (a) { return '<div class="action">→ ' + esc(a) + '</div>'; }).join('');
  }
  const ts = DATA.brief.top_skills || [];
  if (ts.length) {
    extra += '<div class="panel-sec">常用技能</div><div>' +
      ts.map(function (s) { return '<span class="chip">' + esc(s.name) + '</span>'; }).join('') + '</div>';
  }
  extraEl.innerHTML = extra;

  renderClaims(DATA);
  renderSources(DATA);
  renderTree(DATA);
  renderTimeline(DATA);
  renderTasks(DATA);
}

// ── Claims: grouped by status, click to expand evidence ──
function renderClaims(DATA) {
  const el = document.getElementById('claims');
  const claims = DATA.claims || [];
  if (!claims.length) {
    el.innerHTML = '<p class="dim">尚无断言（先选择项目：ygl-trees project use &lt;名&gt;）</p>';
    return;
  }
  const evIdx = {};
  (DATA.evidence || []).forEach(function (e) { evIdx[e.id] = e; });
  const byClaim = {};
  (DATA.claim_evidence || []).forEach(function (l) { (byClaim[l.claim_id] = byClaim[l.claim_id] || []).push(l); });

  const order = ['supported', 'contested', 'refuted', 'unverified'];
  const statusZh = { supported: '已证实', contested: '存争议', refuted: '已推翻', unverified: '待验证' };
  const groups = {};
  claims.forEach(function (c) { (groups[c.status] = groups[c.status] || []).push(c); });
  el.innerHTML = order.slice()
    .concat(Object.keys(groups).filter(function (s) { return order.indexOf(s) < 0; }))
    .filter(function (s) { return groups[s] && groups[s].length; })
    .map(function (s) {
      return '<div class="group-h">' + esc(statusZh[s] || s) + ' · <b>' + groups[s].length + '</b></div>' +
        groups[s].map(function (c) { return claimHtml(c, byClaim[c.id] || [], evIdx); }).join('');
    }).join('');
}

function claimHtml(c, links, evIdx) {
  const open = !!uiState.expanded[c.id];
  const evid = links.map(function (l) {
    const e = evIdx[l.evidence_id];
    const quote = e ? esc(String(e.quote).slice(0, 160)) : '<i>(evidence ' + esc(l.evidence_id) + ')</i>';
    const loc = e && e.locator ? ' <i>§' + esc(e.locator) + '</i>' : '';
    return '<div class="ev"><span class="stance ' + esc(l.stance) + '">' + esc(l.stance) + '</span>' + quote + loc + '</div>';
  }).join('');
  return '<div class="claim ' + esc(c.status) + '" role="button" tabindex="0" aria-expanded="' + open + '"' +
    ' onclick="toggleClaim(\\'' + jq(c.id) + '\\')"' +
    ' onkeydown="keyToggle(event, \\'' + jq(c.id) + '\\')">' +
    '<span class="status">' + esc(c.status) + '</span>' +
    '<span class="text">' + esc(String(c.text).slice(0, 140)) + '</span>' +
    '<div class="meta">sup=' + (c.sup ?? 0) + ' ref=' + (c.ref ?? 0) + ' evidence=' + links.length + (open ? ' ▴' : ' ▾') + '</div>' +
    (open && evid ? '<div class="ev-list">' + evid + '</div>' : '') +
    '</div>';
}

function toggleClaim(id) { uiState.expanded[id] = !uiState.expanded[id]; renderClaims(LAST); }
function keyToggle(ev, id) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleClaim(id); } }

// ── Sources ──
function renderSources(DATA) {
  const el = document.getElementById('sources');
  if (DATA.sources && DATA.sources.length) {
    el.innerHTML = DATA.sources.map(function (s) {
      return '• <strong>' + esc(s.title || 'untitled') + '</strong>' +
        (s.url ? ' — <a href="' + esc(s.url) + '" style="color:#58a6ff">' + esc(String(s.url).slice(0, 50)) + '</a>' : '') +
        ' (relevance: ' + esc(s.relevance) + ')';
    }).join('<br>');
  } else {
    el.innerHTML = '<p class="dim">暂无来源</p>';
  }
}

// ── R11.2: timeline — one stacked bar per active day (DESIGN.md tokens:
// research=primary, tree=tertiary, eval=warning, other=secondary) ──
function renderTimeline(DATA) {
  const el = document.getElementById('timeline');
  const days = (DATA.timeline || []).filter(function (d) {
    return (d.research + d.tree + d.eval + d.other) > 0;
  });
  if (!days.length) {
    el.innerHTML = '<p class="dim">近 30 天无事件</p>';
    return;
  }
  const max = Math.max.apply(null, days.map(function (d) { return d.research + d.tree + d.eval + d.other; }));
  const barW = 18, gap = 6, h = 80, legend = [
    ['research', '研究'], ['tree', '科技树'], ['eval', '评估'], ['other', '其他'],
  ];
  let svg = '<svg width="' + (days.length * (barW + gap) + 10) + '" height="' + (h + 40) + '" xmlns="http://www.w3.org/2000/svg">';
  days.forEach(function (d, i) {
    const x = 5 + i * (barW + gap);
    let y = h;
    [['research', '#58a6ff'], ['tree', '#79c0ff'], ['eval', '#d29922'], ['other', '#8b949e']].forEach(function (seg) {
      const n = Number(d[seg[0]]) || 0;
      if (!n) return;
      const hh = Math.max(2, (n / max) * h);
      y -= hh;
      svg += '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + hh + '" fill="' + seg[1] + '"><title>' +
        d.day + ' · ' + legend.find(function (l) { return l[0] === seg[0]; })[1] + ' ' + n + '</title></rect>';
    });
    svg += '<text x="' + (x + barW / 2) + '" y="' + (h + 14) + '" font-size="9" fill="#8b949e" text-anchor="middle">' +
      String(d.day).slice(5) + '</text>';
  });
  svg += '</svg>';
  const legendHtml = legend.map(function (l) {
    return '<span class="chip"><b style="color:' + l[1] + '">■</b> ' + l[0] + '</span>';
  }).join('');
  el.innerHTML = svg + '<div style="margin-top:6px">' + legendHtml + '</div>';
}

// ── Tech Tree (SVG DAG, clickable nodes; tier or time layout) ──
function toggleLayout() {
  uiState.layout = uiState.layout === "time" ? "tier" : "time";
  renderTree(LAST);
}
function renderTree(DATA) {
  const treeEl = document.getElementById('tree-container');
  const treeNameEl = document.getElementById('tree-name');
  const toggleEl = document.getElementById('layout-toggle');
  if (toggleEl) toggleEl.textContent = '布局：' + (uiState.layout === 'time' ? '时间轴' : '分层');
  if (DATA.tree && DATA.tree.nodes && DATA.tree.nodes.length) {
    treeNameEl.textContent = DATA.tree.name;
    treeEl.innerHTML = uiState.layout === 'time' ? treeTimeSvg(DATA.tree) : treeTierSvg(DATA.tree);
    // re-apply selection after re-render
    if (uiState.selectedNode) {
      document.querySelectorAll('.node-box').forEach(function (g) {
        if (g.getAttribute('data-key') === uiState.selectedNode) g.classList.add('selected');
      });
    }
  } else {
    treeNameEl.textContent = '（未选择）';
    treeEl.innerHTML = '<p class="dim">未选择树（ygl-trees tree use &lt;名&gt;）</p>';
  }
}

/** R11.1: time-axis layout — one lane per node (sorted by created); a solid
 *  arc from created to unlocked_at, a dashed run to "now" while locked.
 *  Tokens from DESIGN.md: locked = secondary/dim, unlocked arc = success. */
function treeTimeSvg(tree) {
  const nodes = tree.nodes.slice().sort(function (a, b) { return String(a.created).localeCompare(String(b.created)); });
  const now = Date.now();
  const t0 = Math.min.apply(null, nodes.map(function (n) { return Date.parse(n.created || now); }));
  const t1 = Math.max.apply(null, nodes.map(function (n) {
    return Math.max(Date.parse(n.created || now), n.unlocked_at ? Date.parse(n.unlocked_at) : now, now);
  }));
  const span = Math.max(t1 - t0, 1);
  const labelW = 130, rightPad = 30, laneH = 34, topPad = 26;
  const W = 900, H = topPad + nodes.length * laneH + 10;
  const x = function (t) { return labelW + ((t - t0) / span) * (W - labelW - rightPad); };
  const day = 86400000;
  const ticks = [];
  for (let t = t0; t <= t1; t += day) {
    const px = x(t);
    const d = new Date(t);
    if (px > labelW + 20 && px < W - rightPad && (d.getDate() === 1 || ticks.length === 0 || span <= 3 * day)) {
      ticks.push('<line stroke="#21262d" x1="' + px + '" y1="' + (topPad - 8) + '" x2="' + px + '" y2="' + H + '"/>' +
        '<text fill="#8b949e" font-size="9" x="' + px + '" y="' + (topPad - 12) + '" text-anchor="middle">' +
        (d.getMonth() + 1) + '/' + d.getDate() + '</text>');
    }
  }
  let svg = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg">';
  svg += '<defs><marker id="tarrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6" fill="#30363d"/></marker></defs>';
  svg += ticks.join('');
  nodes.forEach(function (n, i) {
    const y = topPad + i * laneH + laneH / 2;
    const c = Date.parse(n.created || now);
    const u = n.unlocked_at ? Date.parse(n.unlocked_at) : null;
    const locked = !u;
    const stroke = locked ? '#484f58' : '#3fb950';
    const textFill = locked ? '#484f58' : '#c9d1d9';
    // lane base line
    svg += '<line x1="' + labelW + '" y1="' + y + '" x2="' + (W - rightPad) + '" y2="' + y + '" stroke="#21262d" stroke-dasharray="2 4"/>';
    // arc: created -> unlocked (solid) or created -> now (dashed, dim)
    if (u) {
      svg += '<line x1="' + x(c) + '" y1="' + y + '" x2="' + x(u) + '" y2="' + y + '" stroke="' + stroke + '" stroke-width="3" marker-end="url(#tarrow)"/>';
      svg += '<circle cx="' + x(u) + '" cy="' + y + '" r="4.5" fill="#3fb950"><title>unlocked ' + esc(String(n.unlocked_at).slice(0, 16).replace('T', ' ')) + '</title></circle>';
    } else {
      svg += '<line x1="' + x(c) + '" y1="' + y + '" x2="' + (W - rightPad) + '" y2="' + y + '" stroke="' + stroke + '" stroke-width="2" stroke-dasharray="5 4"/>';
    }
    svg += '<circle cx="' + x(c) + '" cy="' + y + '" r="3.5" fill="' + (locked ? '#484f58' : '#58a6ff') + '"><title>created ' + esc(String(n.created || '').slice(0, 16).replace('T', ' ')) + '</title></circle>';
    svg += '<g class="node-box' + (uiState.selectedNode === n.key ? ' selected' : '') + '" role="button" tabindex="0" data-key="' + esc(n.key) + '"' +
      ' onclick="nodeClick(\\'' + jq(n.key) + '\\')"' +
      ' onkeydown="keyNode(event, \\'' + jq(n.key) + '\\')">' +
      '<text x="' + (labelW - 10) + '" y="' + (y + 3.5) + '" text-anchor="end" font-size="11" fill="' + textFill + '">' + esc(String(n.key).slice(0, 16)) + '</text></g>';
  });
  svg += '</svg>';
  return svg;
}

function treeTierSvg(tree) {
    const nodes = tree.nodes;
    const edges = tree.edges || [];
    const nodeW = 120, nodeH = 36, colGap = 180, rowGap = 70;
    const tiers = {};
    nodes.forEach(function (n) { const t = n.tier || 0; (tiers[t] = tiers[t] || []).push(n); });
    const tierKeys = Object.keys(tiers).map(Number).sort(function (a, b) { return a - b; });
    const maxPerTier = Math.max.apply(null, tierKeys.map(function (t) { return tiers[t].length; }));

    // horizontal layout: tier advances left→right, siblings fan vertically
    const svgW = tierKeys.length * colGap + 60;
    const svgH = Math.max(300, maxPerTier * rowGap + 60);

    const pos = {};
    tierKeys.forEach(function (t, ti) {
      const row = tiers[t];
      row.forEach(function (n, ni) {
        pos[n.key] = {
          x: 60 + ti * colGap + nodeW / 2,
          y: 40 + ni * rowGap,
        };
      });
    });

    let svg = '<svg width="' + svgW + '" height="' + svgH + '" xmlns="http://www.w3.org/2000/svg">';
    svg += '<defs><marker id="arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6" fill="#30363d"/></marker></defs>';

    edges.forEach(function (e) {
      const from = pos[e.parent], to = pos[e.child];
      if (!from || !to) return;
      const cls = e.required ? '' : ' optional';
      const color = e.rel === 'excludes' ? ' excludes' : e.rel === 'unlock' ? ' unlock' : '';
      svg += '<line class="edge' + cls + color + '" x1="' + (from.x + nodeW / 2) + '" y1="' + (from.y + nodeH / 2) + '" x2="' + (to.x - nodeW / 2) + '" y2="' + (to.y + nodeH / 2) + '"/>';
    });

    nodes.forEach(function (n) {
      const p = pos[n.key];
      if (!p) return;
      svg += '<g class="node-box' + (uiState.selectedNode === n.key ? ' selected' : '') + '" role="button" tabindex="0"' +
        ' data-key="' + esc(n.key) + '"' +
        ' onclick="nodeClick(\\'' + jq(n.key) + '\\')"' +
        ' onkeydown="keyNode(event, \\'' + jq(n.key) + '\\')">' +
        '<rect class="node" x="' + (p.x - nodeW / 2) + '" y="' + p.y + '" width="' + nodeW + '" height="' + nodeH + '" rx="4"/>' +
        '<text x="' + p.x + '" y="' + (p.y + nodeH / 2 + 4) + '">' + esc(String(n.key).slice(0, 14)) + '</text></g>';
    });

    svg += '</svg>';
    return svg;
}

// ── Node detail panel (live fetch; static export shows a hint) ──
function nodeClick(key) {
  uiState.selectedNode = key;
  document.querySelectorAll('.node-box').forEach(function (g) {
    g.classList.toggle('selected', g.getAttribute('data-key') === key);
  });
  const panel = document.getElementById('node-panel');
  panel.style.display = 'block';
  panel.innerHTML = '<button class="panel-close" onclick="closePanel()" aria-label="close">✕</button>' +
    '<h3>' + esc(key) + '</h3><p class="dim">加载中…</p>';
  const tree = LAST.tree ? LAST.tree.name : '';
  fetch('api/node?tree=' + encodeURIComponent(tree) + '&key=' + encodeURIComponent(key))
    .then(function (r) { if (r.ok) return r.json(); throw new Error('http ' + r.status); })
    .then(renderNodePanel)
    .catch(function () {
      panel.innerHTML = '<button class="panel-close" onclick="closePanel()" aria-label="close">✕</button>' +
        '<h3>' + esc(key) + '</h3>' +
        '<p class="dim">节点详情需要 live 模式：<br>ygl-trees webui serve</p>';
    });
}
function keyNode(ev, key) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); nodeClick(key); } }
function closePanel() {
  const panel = document.getElementById('node-panel');
  panel.style.display = 'none';
  panel.innerHTML = '';
  uiState.selectedNode = null;
  document.querySelectorAll('.node-box.selected').forEach(function (g) { g.classList.remove('selected'); });
}

function renderNodePanel(d) {
  const panel = document.getElementById('node-panel');
  const n = d.node || {};
  const can = d.can || {};
  let html = '<button class="panel-close" onclick="closePanel()" aria-label="close">✕</button>' +
    '<h3>' + esc(n.key) + (n.name && n.name !== n.key ? ' · ' + esc(n.name) : '') + '</h3>' +
    '<div class="dim">' + esc(n.kind || 'tech') + ' · tier ' + (n.tier ?? 0) + ' · cost ' + (n.cost ?? 0) +
    (Number(can.cost_multiplier) !== 1 ? ' ×' + can.cost_multiplier : '') + '</div>';

  html += '<div class="panel-sec">解锁状态</div>';
  if (can.ok) {
    html += '<div class="can-badge ok">✓ 可解锁</div>';
  } else {
    html += '<div class="can-badge bad">✗ 未满足</div>';
  }
  const list = function (title, arr) {
    if (arr && arr.length) return '<div class="panel-sec">' + esc(title) + ' (' + arr.length + ')</div>' +
      '<div>' + arr.map(function (m) { return '<span class="chip">' + esc(m) + '</span>'; }).join('') + '</div>';
    return '';
  };
  html += list('必检未满足', can.missing_required);
  html += list('可选未满足', can.missing_optional);
  html += list('被排斥', can.blocked_by);

  if ((d.conditions || []).length) {
    html += '<div class="panel-sec">条件 (' + d.conditions.length + ')</div><table class="cond-table">' +
      '<tr><th>名称</th><th>类型</th><th>操作</th><th>值</th><th>必检</th><th>效果</th></tr>' +
      d.conditions.map(function (c) {
        return '<tr><td>' + esc(c.name) + '</td><td>' + esc(c.kind) + '</td><td>' + esc(c.op) + '</td><td>' +
          esc(String(c.value).slice(0, 30)) + '</td><td>' + (c.required ? '✓' : '-') + '</td><td>' + esc(c.effect || '') + '</td></tr>';
      }).join('') + '</table>';
  }

  const rel = function (title, arr) {
    if (arr && arr.length) return '<div class="panel-sec">' + esc(title) + ' (' + arr.length + ')</div><div>' +
      arr.map(function (r) {
        return '<span class="chip click" role="button" tabindex="0" onclick="nodeClick(\\'' + jq(r.key) + '\\')"' +
          ' onkeydown="keyNode(event, \\'' + jq(r.key) + '\\')">' + esc(r.key) +
          (r.required === 0 ? ' <i>(可选)</i>' : '') + '</span>';
      }).join('') + '</div>';
    return '';
  };
  html += rel('父节点', d.parents);
  html += rel('子节点', d.children);

  if ((d.related || []).length) {
    html += '<div class="panel-sec">关联 (' + d.related.length + ')</div><div>' +
      d.related.map(function (r) {
        return '<span class="chip" title="' + esc(r.type + ':' + r.id + ' ' + (r.dir === 'in' ? '←' : '→')) + '">' +
          '<b>' + esc(r.rel) + '</b> ' + esc(r.type) + ': ' + esc(String(r.display).slice(0, 40)) + '</span>';
      }).join('') + '</div>';
  }

  panel.innerHTML = html;
}

// ── R12: task checklist — grouped by status, click advances the machine ──
function renderTasks(DATA) {
  const el = document.getElementById('tasks');
  const tasks = DATA.tasks || [];
  if (!tasks.length) {
    el.innerHTML = '<p class="dim">暂无任务（ygl-trees task add "&lt;标题&gt;"）</p>';
    return;
  }
  const groups = ['todo', 'doing', 'done'];
  el.innerHTML = groups.map(function (s) {
    const rows = tasks.filter(function (t) { return t.status === s; });
    if (!rows.length) return '';
    const label = s === 'todo' ? '待办' : s === 'doing' ? '进行中' : '已完成 ✓';
    const color = s === 'todo' ? '#8b949e' : s === 'doing' ? '#d29922' : '#3fb950';
    return '<div class="group-h" style="color:' + color + '">' + label + ' · ' + rows.length + '</div>' +
      rows.map(function (t) {
        const next = s === 'todo' ? '▶ 开始' : s === 'doing' ? '✓ 完成' : '';
        const clickable = s !== 'done';
        return '<div class="claim" style="cursor:' + (clickable ? 'pointer' : 'default') + '"' +
          (clickable ? ' role="button" tabindex="0" onclick="advanceTask(\\'' + jq(t.id) + '\\',\\'' + s + '\\')"' +
            ' onkeydown="keyTask(event,\\'' + jq(t.id) + '\\',\\'' + s + '\\')"' : '') + '>' +
          '<span class="text" style="' + (s === 'done' ? 'color:#8b949e;text-decoration:line-through' : '') + '">' + esc(t.title) + '</span>' +
          (next ? ' <span class="chip click">' + next + '</span>' : '') +
          '</div>';
      }).join('');
  }).join('') || '<p class="dim">暂无任务</p>';
}

async function advanceTask(id, status) {
  try {
    const r = await fetch('api/task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    if (!r.ok) throw new Error('http ' + r.status);
    const d = await r.json();
    // live mode: refresh data (static export: tasks are read-only)
    if (location.protocol.startsWith('http')) {
      const fresh = await fetch('api/data').then((x) => x.json());
      render(fresh);
    }
  } catch (e) {
    // static export (file://): no write endpoint — surface it honestly
    const el = document.getElementById('tasks');
    if (el) el.insertAdjacentHTML('afterbegin', '<p class="dim">勾销需要 live 模式：ygl-trees webui serve</p>');
  }
}

function keyTask(ev, id, status) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); advanceTask(id, status); } }

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
 *  /api/node?tree=<name>&key=<key> → node detail (deterministic can). */
export function createDashboardServer(env: Env) {
  const http = require("node:http");
  // R13.5: when the React client is built (apps/web/dist), it takes "/" and
  // the zero-dep embedded dashboard moves to /classic; without a build the
  // embedded dashboard keeps "/" (offline single-file contract unchanged).
  const hasWebApp = openWebApp("/") !== null;
  return http.createServer((req: any, res: any) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    const url = u.pathname;
    if (hasWebApp && url !== "/classic" && !url.startsWith("/api/")) {
      const f = openWebApp(url);
      if (f) {
        res.writeHead(200, { "content-type": f.mime });
        res.end(f.body);
        return;
      }
    }
    if (url === "/" || url === "/index.html" || (hasWebApp && url === "/classic")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(generateHTML(gatherData(env), true));
    } else if (url === "/api/data") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(gatherData(env)));
    } else if (url === "/api/node") {
      const tree = u.searchParams.get("tree") || env.db.metaGet("current_tree") || "";
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
    } else if (url === "/api/task" && req.method === "POST") {
      // R12: advance a task along its state machine from the dashboard
      let body = "";
      req.on("data", (c: any) => (body += c));
      req.on("end", () => {
        (async () => {
          try {
            const { id, status } = JSON.parse(body || "{}");
            const next = ({ todo: "doing", doing: "done", done: "done" } as any)[String(status)] || "doing";
            const ds = await getOrm(env.db.path);
            const { taskSetStatus } = await import("../../../research/pipeline/src/writes");
            const r = await taskSetStatus(ds, String(id), next);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(r));
          } catch (e: any) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(e?.message || e) }));
          }
        })();
      });
      return;
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
