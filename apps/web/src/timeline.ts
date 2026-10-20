/**
 * Activity timeline data helpers (pure; the chart in ActivityTimeline.tsx
 * only draws). The server (ops/tools webui.ts R11.2) sends one row per UTC day
 * that had events in its window (today and the 30 days before it) — days
 * without events are absent, so
 * the strip fills the gaps itself; stacking order is chosen for colour
 * adjacency (blue parts amber from green; the neutral "其他" rides on top).
 */
export interface TimelineRow {
  day: string; // YYYY-MM-DD (UTC, substr of the event ts)
  research: number;
  tree: number;
  eval: number;
  other: number;
}

/** Stack order, bottom → top: blue between amber and green (deutan separation), the gray tail on top. */
export const SERIES = ["research", "tree", "eval", "other"] as const;
export type SeriesKey = (typeof SERIES)[number];

export const SERIES_LABEL: Record<SeriesKey, string> = {
  research: "研究",
  eval: "判定",
  tree: "科技树",
  other: "其他",
};

/** What each bucket counts — the server buckets by event-kind prefix (ops/tools webui.ts); claim.eval is a claim event, so it is 研究. */
export const SERIES_NOTE: Record<SeriesKey, string> = {
  research: "研究 = source / evidence / claim / query / kb / artifact 事件（含断言评估 claim.eval）",
  tree: "科技树 = node / tree 事件",
  eval: "判定 = eval.* 事件（节点条件判定）；断言评估计入研究",
  other: "其他 = 其余事件（task、project、config 等）",
};

export interface Segment {
  key: SeriesKey;
  value: number;
  y0: number; // cumulative start
  y1: number; // cumulative end
}

export interface Column {
  day: string;
  total: number;
  segments: Segment[];
}

const DAY_MS = 86_400_000;
const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** One row per calendar day for the last `days` days ending `today` (UTC), zeros filled, oldest first. */
export function fillDays(rows: TimelineRow[], days = 30, today = new Date()): TimelineRow[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const out: TimelineRow[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = utcDay(new Date(end - i * DAY_MS));
    const r = byDay.get(day);
    out.push({ day, research: r?.research ?? 0, tree: r?.tree ?? 0, eval: r?.eval ?? 0, other: r?.other ?? 0 });
  }
  return out;
}

/** Cumulative segments per day in SERIES order; zero-value segments are kept out of the list. */
export function stackColumns(rows: TimelineRow[]): Column[] {
  return rows.map((r) => {
    let acc = 0;
    const segments: Segment[] = [];
    for (const key of SERIES) {
      const value = Math.max(0, Number(r[key]) || 0);
      if (value === 0) continue;
      segments.push({ key, value, y0: acc, y1: acc + value });
      acc += value;
    }
    return { day: r.day, total: acc, segments };
  });
}

/** 1 / 2 / 5 × 10^k step (Heckbert's 1.5 / 3 / 7 rounding) so about `count` ticks span the data; always starts at 0. */
export function niceTicks(max: number, count = 3): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/** Which column indexes get an axis date label: the first, then every `every` days. */
export function dayTickIndexes(n: number, every = 7): number[] {
  const idx: number[] = [];
  for (let i = 0; i < n; i += every) idx.push(i);
  return idx;
}

/** Columns that earn a direct total label: the peak day and the latest day with activity (selective, never every column). */
export function labelledColumns(columns: Column[]): Set<number> {
  const out = new Set<number>();
  let peak = -1;
  for (let i = 0; i < columns.length; i++) if (columns[i].total > 0 && (peak < 0 || columns[i].total > columns[peak].total)) peak = i;
  if (peak >= 0) out.add(peak);
  for (let i = columns.length - 1; i >= 0; i--) if (columns[i].total > 0) { out.add(i); break; }
  return out;
}

/** "10-20" — the month and day; the year is implied by a 30-day strip. */
export const fmtDay = (day: string): string => day.slice(5);
