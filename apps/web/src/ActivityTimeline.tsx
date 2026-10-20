/**
 * Activity timeline (overview): one stacked column per UTC day for the last 30
 * days — research / eval / tree / other event counts from /api/data `timeline`.
 * Pure SVG in token colours (--color-chart-*; "其他" is the de-emphasis gray),
 * text only ever in text tokens (dataviz: text never wears the series colour).
 * A legend is always shown (4 series); direct labels only on the peak day and
 * the latest active day; hovering or focusing a column reads out every series;
 * a table view holds every number without hovering.
 */
import { useId, useMemo, useState } from "react";
import { Button, Empty, Space, Table, Typography } from "antd";
import {
  SERIES, SERIES_LABEL, SERIES_NOTE, dayTickIndexes, fillDays, fmtDay, labelledColumns, niceTicks, stackColumns,
  type Column, type SeriesKey, type TimelineRow,
} from "./timeline";

const { Text } = Typography;

export const SERIES_FILL: Record<SeriesKey, string> = {
  research: "var(--color-chart-research)",
  eval: "var(--color-chart-eval)",
  tree: "var(--color-chart-tree)",
  other: "var(--color-chart-other)", // the folded tail: a de-emphasis gray, never a categorical hue
};

// SVG coordinate space; the element scales to the card width
const W = 720, H = 190;
const PAD = { top: 16, right: 8, bottom: 22, left: 30 };
const BAR_MAX = 24, GAP = 2, R = 4; // marks: ≤24px thick, 2px surface gap between segments, 4px rounded data-end

/** Column cap: rounded top corners, square at the baseline. */
function capPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(R, w / 2, h);
  return `M${x},${y + r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} h${-w} z`;
}

const describe = (r: TimelineRow, total: number): string =>
  `${fmtDay(r.day)}：共 ${total} 件 · 研究 ${r.research} · 判定 ${r.eval} · 科技树 ${r.tree} · 其他 ${r.other}`;

type View = "chart" | "table";

export default function ActivityTimeline({
  timeline,
  days = 31, // today + the server's 30 days back (ts >= date('now','-30 days')), UTC days
  today,
  defaultView = "chart",
}: {
  timeline: TimelineRow[];
  days?: number;
  /** test seam — the strip ends on this UTC day */
  today?: Date;
  defaultView?: View;
}) {
  const rows = useMemo(() => fillDays(timeline, days, today), [timeline, days, today]);
  const columns = useMemo(() => stackColumns(rows), [rows]);
  const [view, setView] = useState<View>(defaultView);
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();

  if (!columns.some((c) => c.total > 0)) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={`最近 ${days - 1} 天（含今天）没有记录到活动：用 research / node / eval 等命令工作后，这里会按 UTC 日显示事件数。`}
      />
    );
  }

  return (
    <div className="yt-tl-wrap">
      <div className="yt-tl-head">
        <ul className="yt-tl-legend" aria-label="图例">
          {SERIES.map((k) => (
            <li key={k} title={SERIES_NOTE[k]}>
              <i className="yt-tl-swatch" style={{ background: SERIES_FILL[k] }} aria-hidden="true" />
              {SERIES_LABEL[k]}
            </li>
          ))}
        </ul>
        <Space.Compact role="group" aria-label="时间线看法">
          {(["chart", "table"] as const).map((v) => (
            <Button key={v} size="small" type={view === v ? "primary" : "default"} aria-pressed={view === v} autoInsertSpace={false} onClick={() => setView(v)}>
              {v === "chart" ? "图" : "表"}
            </Button>
          ))}
        </Space.Compact>
      </div>
      {view === "table" ? (
        <Table<TimelineRow>
          className="yt-tl-table"
          size="small"
          rowKey="day"
          dataSource={[...rows].reverse()}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          columns={[
            { title: "日期", dataIndex: "day", width: 120 },
            ...SERIES.map((k) => ({ title: <span title={SERIES_NOTE[k]}>{SERIES_LABEL[k]}</span>, dataIndex: k, align: "right" as const, width: 88 })),
            { title: "合计", key: "total", align: "right" as const, render: (_: unknown, r) => r.research + r.eval + r.tree + r.other },
          ]}
        />
      ) : (
        <Chart rows={rows} columns={columns} days={days} active={active} setActive={setActive} titleId={titleId} />
      )}
    </div>
  );
}

function Chart({
  rows, columns, days, active, setActive, titleId,
}: {
  rows: TimelineRow[]; columns: Column[]; days: number; active: number | null; setActive: (i: number | null) => void; titleId: string;
}) {
  const plotW = W - PAD.left - PAD.right, plotH = H - PAD.top - PAD.bottom;
  const n = columns.length;
  const band = plotW / n;
  const bar = Math.min(BAR_MAX, band * 0.7);
  const ticks = niceTicks(Math.max(...columns.map((c) => c.total)));
  const top = ticks[ticks.length - 1];
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const labelled = labelledColumns(columns);
  const xTicks = new Set(dayTickIndexes(n));

  return (
    <>
      <div className="yt-tl-readout" aria-live="polite">
        {active === null ? (
          <Text type="secondary">悬停或用 Tab 聚焦某一天，查看当天明细</Text>
        ) : (
          <Readout row={rows[active]} column={columns[active]} />
        )}
      </div>
      <svg className="yt-tl" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={titleId}>
        <title id={titleId}>最近 {days - 1} 天（含今天）活动，按 UTC 日堆叠的研究、科技树、判定、其他事件数</title>
        {ticks.map((t) => (
          <g key={t}>
            <line className="yt-tl-grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="yt-tl-axis" x={PAD.left - 6} y={y(t) + 3.5} textAnchor="end">{t}</text>
          </g>
        ))}
        {columns.map((c, i) => {
          const x0 = PAD.left + i * band + (band - bar) / 2;
          const last = c.segments.length - 1;
          const label = describe(rows[i], c.total);
          return (
            <g key={c.day} className={active === i ? "yt-tl-col is-active" : "yt-tl-col"}>
              {c.segments.map((s, j) => {
                const yTop = y(s.y1), yBot = y(s.y0);
                const isCap = j === last;
                const yy = isCap ? yTop : yTop + GAP; // the 2px surface gap sits above every lower segment
                const h = Math.max(1, yBot - yy);
                return isCap && h >= R ? (
                  <path key={s.key} d={capPath(x0, yy, bar, h)} style={{ fill: SERIES_FILL[s.key] }} />
                ) : (
                  <rect key={s.key} x={x0} y={yy} width={bar} height={h} style={{ fill: SERIES_FILL[s.key] }} />
                );
              })}
              {labelled.has(i) && (
                <text className="yt-tl-label" x={x0 + bar / 2} y={y(c.total) - 5} textAnchor="middle">{c.total}</text>
              )}
              {xTicks.has(i) && (
                <text className="yt-tl-axis" x={x0 + bar / 2} y={H - 6} textAnchor="middle">{fmtDay(c.day)}</text>
              )}
              <rect
                className="yt-tl-hit"
                x={PAD.left + i * band}
                y={PAD.top}
                width={band}
                height={plotH}
                tabIndex={0}
                role="img"
                aria-label={label}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              >
                <title>{label}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </>
  );
}

/** One readout, every series — values lead, labels follow, keyed by a short stroke in the series colour. */
function Readout({ row, column }: { row: TimelineRow; column: Column }) {
  return (
    <span className="yt-tl-values">
      <b>{column.total}</b> 件
      {SERIES.map((k) => (
        <span key={k} className="yt-tl-value">
          <i className="yt-tl-key" style={{ background: SERIES_FILL[k] }} aria-hidden="true" />
          <b>{row[k]}</b> {SERIES_LABEL[k]}
        </span>
      ))}
      <Text type="secondary">— {fmtDay(row.day)}</Text>
    </span>
  );
}
