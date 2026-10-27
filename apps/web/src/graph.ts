/**
 * Knowledge-graph model, kept pure so it is testable without a canvas.
 *
 * The payload is the R9 relation fabric: every edge runs from a tech-tree node
 * (the hub) to a research asset (task / claim / evidence / kb / artifact /
 * source). So the readable picture is a set of clusters — each tree node with
 * its linked assets listed under it — not one ring of 100 overlapping cards.
 */

export interface GraphPayload {
  nodes: Array<{ id: string; label: string; type: string; color?: string }>;
  edges: Array<{ source: string; target: string; label: string }>;
}

export interface Entity {
  id: string;
  type: string;
  /** what the expert reads: a task's title, a source's url, else the payload label */
  label: string;
  hub: boolean;
  done?: boolean;
  /** a task from another project: the page only gets titles for the selected one (R16.4) */
  foreign?: boolean;
  /** a source outside the page's list (other project, or past the server's top-20-by-relevance cap) */
  unlisted?: boolean;
}

export interface Placed extends Entity {
  x: number;
  y: number;
}

export interface GraphView {
  entities: Placed[];
  edges: Array<{ id: string; source: string; target: string; rel: string }>;
  /** per type: how many exist, how many are shown */
  counts: Record<string, { total: number; shown: number }>;
  doneTasks: number;
}

export interface ViewOptions {
  hiddenTypes: ReadonlySet<string>;
  showDoneTasks: boolean;
}

/** Assets list in this order under their hub: judgements first, bookkeeping last. */
export const TYPE_ORDER = ["claim", "evidence", "kb", "artifact", "source", "skill", "task"];

export const CARD_W = 168;
const CARD_H = 44;
const ROW = CARD_H + 10;
const INDENT = 28;
const SUB_COL = CARD_W + 12;
/** a cluster longer than this wraps its assets into another column */
const MAX_ROWS = 8;
const GAP_X = 48;
const GAP_Y = 56;

const rank = (type: string) => {
  const i = TYPE_ORDER.indexOf(type);
  return i < 0 ? TYPE_ORDER.length : i;
};

/** Payload entities with their readable labels (the server sends task / source ids as labels). */
export function resolveEntities(
  g: GraphPayload,
  ctx: { tasks?: Array<{ id: string; title: string; status: string }>; sources?: Array<{ id: string; title?: string | null; url?: string | null }> } = {}
): Entity[] {
  const tasks = new Map((ctx.tasks ?? []).map((t) => [t.id, t]));
  const sources = new Map((ctx.sources ?? []).map((s) => [s.id, s]));
  const hubs = new Set(g.edges.map((e) => e.source));
  return g.nodes.map((n) => {
    const raw = n.id.slice(n.id.indexOf(":") + 1);
    const task = n.type === "task" ? tasks.get(raw) : undefined;
    const source = n.type === "source" ? sources.get(raw) : undefined;
    return {
      id: n.id,
      type: n.type,
      label: task?.title || source?.title || source?.url || n.label,
      hub: n.type === "node" || hubs.has(n.id),
      ...(task && { done: task.status === "done" }),
      ...(n.type === "task" && !task && { foreign: true }),
      ...(n.type === "source" && !source && { unlisted: true }),
    };
  });
}

/**
 * Which entities to show and where. Hubs always show (they are the skeleton);
 * an asset shows unless its type is switched off or it is a done task while
 * done tasks are hidden. An asset sits under the first hub that links it; its
 * other links still draw as edges.
 */
export function layoutGraph(g: GraphPayload, all: Entity[], opts: ViewOptions): GraphView {
  const counts: GraphView["counts"] = {};
  const visible = new Map<string, Entity>();
  let doneTasks = 0;
  for (const e of all) {
    const c = (counts[e.type] ??= { total: 0, shown: 0 });
    c.total++;
    if (e.done) doneTasks++;
    const show = e.hub || (!opts.hiddenTypes.has(e.type) && (opts.showDoneTasks || !e.done));
    if (show) {
      c.shown++;
      visible.set(e.id, e);
    }
  }

  const edges = g.edges
    .filter((e) => visible.has(e.source) && visible.has(e.target))
    .map((e) => ({ id: `${e.source}|${e.target}|${e.label}`, source: e.source, target: e.target, rel: e.label }));

  // group: each visible asset under its first visible hub
  const hubs = all.filter((e) => e.hub && visible.has(e.id));
  const members = new Map<string, Entity[]>(hubs.map((h) => [h.id, []]));
  const placedUnder = new Set<string>();
  for (const e of edges) {
    const t = visible.get(e.target)!;
    if (t.hub || placedUnder.has(t.id)) continue;
    members.get(e.source)?.push(t);
    placedUnder.add(t.id);
  }
  const loose = [...visible.values()].filter((e) => !e.hub && !placedUnder.has(e.id));
  const byRank = (a: Entity, b: Entity) => rank(a.type) - rank(b.type) || a.label.localeCompare(b.label, "zh");
  for (const list of members.values()) list.sort(byRank);
  loose.sort(byRank);

  // biggest clusters first; long ones wrap into extra columns; clusters pack into
  // rows about twice as wide as the whole is tall, so fitView keeps cards legible
  const groups = hubs
    .map((h) => ({ hub: h as Entity | null, items: members.get(h.id)! }))
    .sort((a, b) => b.items.length - a.items.length || a.hub!.label.localeCompare(b.hub!.label, "zh"));
  if (loose.length) groups.push({ hub: null, items: loose });
  const sized = groups.map((g) => {
    const subCols = Math.max(1, Math.ceil(g.items.length / MAX_ROWS));
    const rows = Math.min(g.items.length, MAX_ROWS);
    const head = g.hub ? ROW + 6 : 0;
    return { ...g, subCols, w: (g.hub ? INDENT : 0) + subCols * SUB_COL, h: head + rows * ROW };
  });
  const area = sized.reduce((a, g) => a + (g.w + GAP_X) * (g.h + GAP_Y), 0);
  const rowWidth = Math.max(...sized.map((g) => g.w), Math.sqrt(area * 2));

  const entities: Placed[] = [];
  let x = 0, y = 0, tallest = 0;
  for (const g of sized) {
    if (x > 0 && x + g.w > rowWidth) {
      x = 0;
      y += tallest + GAP_Y;
      tallest = 0;
    }
    let top = y;
    if (g.hub) {
      entities.push({ ...g.hub, x, y: top });
      top += ROW + 6;
    }
    const left = g.hub ? x + INDENT : x;
    g.items.forEach((it, i) => {
      entities.push({ ...it, x: left + Math.floor(i / MAX_ROWS) * SUB_COL, y: top + (i % MAX_ROWS) * ROW });
    });
    x += g.w + GAP_X;
    tallest = Math.max(tallest, g.h);
  }
  return { entities, edges, counts, doneTasks };
}

/** Everything one hop from `id`, with the relation word and direction. */
export function linksOf(edges: GraphView["edges"], id: string): Array<{ other: string; rel: string; dir: "out" | "in" }> {
  const out: Array<{ other: string; rel: string; dir: "out" | "in" }> = [];
  for (const e of edges) {
    if (e.source === id) out.push({ other: e.target, rel: e.rel, dir: "out" });
    else if (e.target === id) out.push({ other: e.source, rel: e.rel, dir: "in" });
  }
  return out;
}

/** Case-insensitive label match; an empty query matches nothing (nothing dims). */
export function matchIds(entities: Entity[], query: string): Set<string> {
  const q = query.trim().toLowerCase();
  if (!q) return new Set();
  return new Set(entities.filter((e) => e.label.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)).map((e) => e.id));
}
