import { useMemo, useState } from "react";
import { Button, Card, Collapse, Empty, Input, Space, Table, Tag, Typography } from "antd";
import { C } from "./tokens";
import { ToneTag } from "./ToneTag";
import { copyText } from "./clipboard";
import { shellQuote } from "./shell";

/**
 * 研究管线视图（0.92 单A，direct-0f20e882 队列工单；spec webui-design.md §3）。
 *
 * R19 同口径（docs/webui-design.md「0. 未选择态」）：claims/evidence 载荷由
 * 服务端按授权域收集——未选择/仅全局指针时 gatherData 根本不填这两组键，
 * 本组件在 App 中也仅在 data.claims 存在时挂载（双重不渲染）。
 *
 * 状态色只用 DESIGN.md token（单B 纪律）：supported=success / refuted=danger
 * / contested=warning / unverified=secondary——词 + 色双信号，永不负载裸 hex。
 *
 * 两种看法（用户裁定：已打包的 antd 重建，不引 pro-components）：看板 = 按状态
 * 四列水流（扫读）；表格 = 状态筛选 + 支持/反驳排序 + 行内展开证据（核对）。
 * 筛选框对两种看法都生效，匹配断言文本与其证据原文。
 *
 * 专家 ↔ agent 协同：顶部状态条一眼看出研究走到哪（兼作状态筛选），证据薄弱的
 * 断言（无证据 / 仅一条）一键筛出；未验证与有争议的断言可复制 `claim resolve`
 * 裁决命令——人工仲裁是专家的事，写入仍走 CLI，页面不执行。
 */

const { Text, Paragraph } = Typography;

export interface PipelineClaim {
  id: string;
  text: string;
  status: string;
  /** decision-model grade as stored (e.g. "A"), or a number on older rows */
  confidence?: string | number | null;
  sup?: number;
  ref?: number;
}

export interface PipelineLink {
  claim_id: string;
  evidence_id: string;
  stance: string;
}

export interface PipelineEvidence {
  id: string;
  quote: string;
  locator?: string | null;
  source_id: string;
}

export interface PipelineSource {
  id: string;
  title?: string | null;
  url?: string | null;
}

type Linked = { l: PipelineLink; ev: PipelineEvidence };
type Row = PipelineClaim & { bucket: Status; items: Linked[] };
export type PipelineView = "board" | "table";

const STATUS_ORDER = ["supported", "contested", "unverified", "refuted"] as const;
type Status = (typeof STATUS_ORDER)[number];

const statusMeta: Record<Status, { color: string; label: string }> = {
  supported: { color: C.success, label: "已证实" },
  contested: { color: C.warning, label: "有争议" },
  unverified: { color: C.secondary, label: "未验证" },
  refuted: { color: C.danger, label: "已反驳" },
};

const stanceMeta: Record<string, { color: string; label: string }> = {
  supports: { color: C.success, label: "支持" },
  refutes: { color: C.danger, label: "反驳" },
  related: { color: C.secondary, label: "相关" },
};
const stanceOf = (s: string) => stanceMeta[s] ?? stanceMeta.related;

export const VIEW_KEY = "ygl-pipeline-view";
type ViewStore = Pick<Storage, "getItem" | "setItem">;
const viewStore = (): ViewStore | null => (typeof window === "undefined" ? null : window.localStorage);
/**
 * The remembered view; null when nothing valid is stored or storage throws. The
 * storage getter itself throws when storage is blocked, so it is read inside the
 * try — never as a default parameter (review of 780f894).
 */
export function readView(s?: ViewStore | null): PipelineView | null {
  try {
    const store = s === undefined ? viewStore() : s;
    const v = store?.getItem(VIEW_KEY);
    return v === "board" || v === "table" ? v : null;
  } catch {
    return null;
  }
}
export function writeView(v: PipelineView, s?: ViewStore | null): void {
  try {
    const store = s === undefined ? viewStore() : s;
    store?.setItem(VIEW_KEY, v);
  } catch {
    /* per-viewer convenience only */
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

const bucketOf = (status: string): Status =>
  (STATUS_ORDER as readonly string[]).includes(status) ? (status as Status) : "unverified";

/** Claims joined to their evidence — one pass over the links, computed once per payload (not per keystroke). */
export function joinRows(claims: PipelineClaim[], claimEvidence: PipelineLink[], evidence: PipelineEvidence[]): Row[] {
  const evById = new Map(evidence.map((e) => [e.id, e]));
  const byClaim = new Map<string, Linked[]>();
  for (const l of claimEvidence) {
    const ev = evById.get(l.evidence_id);
    if (!ev) continue;
    const list = byClaim.get(l.claim_id);
    if (list) list.push({ l, ev });
    else byClaim.set(l.claim_id, [{ l, ev }]);
  }
  return claims.map((c) => ({ ...c, bucket: bucketOf(c.status), items: byClaim.get(c.id) ?? [] }));
}

/** The needle over claim text and evidence quotes — the per-keystroke part. */
export function filterRows(rows: Row[], needle = ""): Row[] {
  const q = needle.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.text.toLowerCase().includes(q) || r.items.some((x) => x.ev.quote.toLowerCase().includes(q)));
}

export const pipelineRows = (claims: PipelineClaim[], claimEvidence: PipelineLink[], evidence: PipelineEvidence[], needle = ""): Row[] =>
  filterRows(joinRows(claims, claimEvidence, evidence), needle);

/** How thin the evidence is: no link at all, or a single one. */
export type EvidenceFacet = "none" | "single";
export interface Facets {
  status: Status | null;
  evidence: EvidenceFacet | null;
}
const evidenceOf = (r: Row, f: EvidenceFacet) => (f === "none" ? r.items.length === 0 : r.items.length === 1);

/** Counts for the strip: per status, and how many claims stand on no / one piece of evidence. */
export function summarize(rows: Row[]): { status: Record<Status, number>; none: number; single: number } {
  const status = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<Status, number>;
  let none = 0, single = 0;
  for (const r of rows) {
    status[r.bucket]++;
    if (r.items.length === 0) none++;
    else if (r.items.length === 1) single++;
  }
  return { status, none, single };
}

/** Status and evidence facets narrow what the needle left. */
export function facetRows(rows: Row[], f: Facets): Row[] {
  return rows.filter((r) => (!f.status || r.bucket === f.status) && (!f.evidence || evidenceOf(r, f.evidence)));
}

/**
 * The command an expert runs to adjudicate a claim (writes stay in the CLI; the
 * page only copies). Claim id and project are data, so both are shell-quoted
 * (#101): a free-text project name must never run as shell when pasted.
 */
export function resolveCommand(claimId: string, as: "supported" | "refuted" | "contested", project?: string | null): string {
  const cmd = `ygl-trees research claim resolve ${shellQuote(claimId)} --as ${as}`;
  return project ? `${cmd} -p ${shellQuote(project)}` : cmd;
}

/** Where a quote comes from: the source's title when this page has it, else the locator, else the source id. */
export function sourceLabel(ev: PipelineEvidence, titles: ReadonlyMap<string, string>): string {
  const t = titles.get(ev.source_id);
  if (t && ev.locator && !/^https?:|^file:/.test(ev.locator)) return `${clip(t, 48)} · ${ev.locator}`;
  return t ? clip(t, 60) : ev.locator || ev.source_id;
}

export default function Pipeline({
  claims,
  claimEvidence,
  evidence,
  sources = [],
  project,
  defaultView,
  defaultNeedle = "",
  defaultFacets = { status: null, evidence: null },
}: {
  claims: PipelineClaim[];
  claimEvidence: PipelineLink[];
  evidence: PipelineEvidence[];
  /** this project's sources (top 20 by relevance) — titles for the evidence lines */
  sources?: PipelineSource[];
  /** pinned into copied commands (-p) so they land in the project on screen */
  project?: string | null;
  defaultView?: PipelineView;
  /** test seam — the filter box's initial text */
  defaultNeedle?: string;
  /** test seam — the strip's initial filters */
  defaultFacets?: Facets;
}) {
  const [view, setView] = useState<PipelineView>(() => defaultView ?? readView() ?? "board");
  const [needle, setNeedle] = useState(defaultNeedle);
  const [facets, setFacets] = useState<Facets>(defaultFacets);
  const joined = useMemo(() => joinRows(claims, claimEvidence, evidence), [claims, claimEvidence, evidence]);
  const searched = useMemo(() => filterRows(joined, needle), [joined, needle]);
  const rows = useMemo(() => facetRows(searched, facets), [searched, facets]);
  const summary = useMemo(() => summarize(searched), [searched]);
  const titles = useMemo(() => new Map(sources.filter((s) => s.title).map((s) => [s.id, s.title!])), [sources]);
  const ctx = useMemo(() => ({ titles, project }), [titles, project]);
  const narrowed = !!needle || !!facets.status || !!facets.evidence;

  if (!claims.length) return <Empty description="暂无断言" />;

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        {/* two bundled Buttons, not Segmented: same control, no new antd module (ratchet) */}
        <Space.Compact role="group" aria-label="管线看法">
          {(["board", "table"] as const).map((v) => (
            <Button
              key={v}
              type={view === v ? "primary" : "default"}
              aria-pressed={view === v}
              autoInsertSpace={false}
              onClick={() => {
                setView(v);
                writeView(v);
              }}
            >
              {v === "board" ? "看板" : "表格"}
            </Button>
          ))}
        </Space.Compact>
        <Input
          allowClear
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
          placeholder="筛选断言文本 / 证据原文"
          aria-label="筛选断言"
          style={{ maxWidth: 320 }}
        />
        {narrowed && <Text type="secondary">{rows.length} / {claims.length} 条断言</Text>}
      </div>
      <StatusStrip summary={summary} total={searched.length} facets={facets} onChange={setFacets} />
      {!rows.length ? (
        <Empty description="没有匹配的断言" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : view === "table" ? (
        <ClaimTable rows={rows} ctx={ctx} />
      ) : (
        <Board rows={rows} ctx={ctx} />
      )}
    </Space>
  );
}

type Ctx = { titles: ReadonlyMap<string, string>; project?: string | null };

/**
 * Where the research stands, in one strip: a proportional bar (status tokens,
 * 2px surface gaps) over buttons that name each status with its count and
 * filter to it — the bar is decoration, the buttons carry the words.
 */
export function StatusStrip({ summary, total, facets, onChange }: { summary: ReturnType<typeof summarize>; total: number; facets: Facets; onChange: (f: Facets) => void }) {
  if (!total) return null;
  const pick = (patch: Partial<Facets>) => onChange({ ...facets, ...patch });
  return (
    <div className="yt-pipe-strip">
      <div aria-hidden style={{ display: "flex", gap: 2, height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
        {STATUS_ORDER.filter((s) => summary.status[s]).map((s) => (
          <span key={s} style={{ flex: summary.status[s], background: statusMeta[s].color, opacity: facets.status && facets.status !== s ? 0.35 : 1 }} />
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }} role="group" aria-label="按状态与证据筛选">
        {STATUS_ORDER.filter((s) => summary.status[s]).map((s) => {
          const on = facets.status === s;
          return (
            <Button key={s} size="small" autoInsertSpace={false} aria-pressed={on} onClick={() => pick({ status: on ? null : s })}
              style={on ? { borderColor: statusMeta[s].color, color: statusMeta[s].color } : undefined}>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: 4, background: statusMeta[s].color, display: "inline-block", marginRight: 4 }} />
              {statusMeta[s].label} {summary.status[s]}
              <Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>{Math.round((summary.status[s] / total) * 100)}%</Text>
            </Button>
          );
        })}
        <span aria-hidden style={{ width: 1, height: 16, background: "var(--color-border)", margin: "0 4px" }} />
        {([["none", "无证据", summary.none], ["single", "仅一条证据", summary.single]] as const).map(([f, label, n]) => {
          const on = facets.evidence === f;
          return (
            <Button key={f} size="small" autoInsertSpace={false} aria-pressed={on} disabled={!n && !on} onClick={() => pick({ evidence: on ? null : f })}
              style={on ? { borderColor: C.warning, color: C.warning } : undefined}>
              {label} {n}
            </Button>
          );
        })}
        {(facets.status || facets.evidence) && (
          <Button size="small" type="link" autoInsertSpace={false} onClick={() => onChange({ status: null, evidence: null })}>清除筛选</Button>
        )}
      </div>
    </div>
  );
}

/**
 * 裁决命令：未验证 / 有争议的断言等专家仲裁。三个按钮各复制一条
 * `claim resolve` 命令，标签只在剪贴板真收下时说已复制（同 下一步操作）。
 */
export function ResolveCopy({ claimId, project }: { claimId: string; project?: string | null }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const copy = async (as: "supported" | "refuted" | "contested", label: string) => {
    const ok = await copyText(resolveCommand(claimId, as, project));
    setDone(ok ? `已复制「${label}」命令` : "复制失败，请手动复制");
    window.setTimeout(() => setDone(null), ok ? 1800 : 4000);
  };
  return (
    <>
      <Button size="small" type="text" autoInsertSpace={false} aria-expanded={open} onClick={() => setOpen((v) => !v)} style={{ fontSize: 12, height: 22, padding: "0 6px" }}>
        裁决 {open ? "▲" : "▼"}
      </Button>
      {open && (
        <div style={{ flexBasis: "100%", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>复制命令到终端执行：</Text>
          {(["supported", "refuted", "contested"] as const).map((as) => (
            <Button key={as} size="small" autoInsertSpace={false} aria-label={`复制裁决命令：${statusMeta[as].label}`} onClick={() => copy(as, statusMeta[as].label)}
              style={{ color: statusMeta[as].color, borderColor: statusMeta[as].color, background: "transparent", fontSize: 12, height: 22, padding: "0 7px" }}>
              {statusMeta[as].label}
            </Button>
          ))}
          {done && <Text type={done.startsWith("复制失败") ? "danger" : "success"} style={{ fontSize: 12 }} role="status">{done}</Text>}
        </div>
      )}
    </>
  );
}

const needsVerdict = (r: Row) => r.bucket === "unverified" || r.bucket === "contested";

/** 看板：按状态四列水流，claim 卡 3px 状态色左沿（DESIGN.md：管线的扫读路径）。 */
function Board({ rows, ctx }: { rows: Row[]; ctx: Ctx }) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
      {STATUS_ORDER.map((status) => {
        const list = rows.filter((r) => r.bucket === status);
        if (!list.length) return null;
        const meta = statusMeta[status];
        return (
          <div key={status} style={{ flex: "1 1 220px", minWidth: 220 }}>
            <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: 5, background: meta.color, display: "inline-block" }} />
              <Text strong style={{ color: meta.color }}>{meta.label}</Text>
              <Text type="secondary">（{list.length}）</Text>
            </div>
            {list.map((c) => (
              <Card key={c.id} size="small" style={{ marginBottom: 8, borderLeft: `3px solid ${meta.color}` }}>
                <Paragraph style={{ marginBottom: c.items.length ? 4 : 0 }} ellipsis={{ rows: 3, expandable: true, symbol: "展开" }}>
                  {c.text}
                </Paragraph>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <Tag>支持 {c.sup ?? 0}</Tag>
                  <Tag>反驳 {c.ref ?? 0}</Tag>
                  {c.confidence != null && c.confidence !== "" && <Tag title="决策模型置信度">置信 {String(c.confidence)}</Tag>}
                  {c.items.length > 0 ? <EvidenceLinks items={c.items} titles={ctx.titles} /> : <Text type="warning" style={{ fontSize: 12 }}>无证据</Text>}
                  {needsVerdict(c) && <ResolveCopy claimId={c.id} project={ctx.project} />}
                </div>
              </Card>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** The badge wears the claim's overall stance: supports and refutes together read as contested, never the first link's colour alone. */
export function overallStance(items: Linked[]): { color: string; label: string } {
  const has = (s: string) => items.some((x) => x.l.stance === s);
  if (has("supports") && has("refutes")) return { color: C.warning, label: "支持与反驳并存" };
  if (has("supports")) return stanceMeta.supports;
  if (has("refutes")) return stanceMeta.refutes;
  return stanceMeta.related;
}

/** 证据链接折叠列表——点击展开（webui-design.md §3：点击展开证据链接列表）。 */
function EvidenceLinks({ items, titles }: { items: Linked[]; titles: ReadonlyMap<string, string> }) {
  const [open, setOpen] = useState(false);
  const tone = overallStance(items);
  return (
    <>
      {/* a real button: Enter / Space toggle, focus ring, aria-expanded (a span with onClick had none of these) */}
      <Button
        size="small"
        aria-expanded={open}
        autoInsertSpace={false}
        title={tone.label}
        onClick={() => setOpen((v) => !v)}
        style={{ color: tone.color, borderColor: tone.color, background: "transparent", fontSize: 12, height: 22, padding: "0 7px" }}
      >
        证据 ×{items.length} {open ? "▲" : "▼"}
      </Button>
      {open && (
        <Collapse
          ghost
          size="small"
          style={{ marginTop: 6 }}
          items={items.map(({ l, ev }, i) => ({
            key: String(i),
            label: (
              <span>
                <ToneTag color={stanceOf(l.stance).color}>{stanceOf(l.stance).label}</ToneTag>
                <Text type="secondary" style={{ fontSize: 12 }}>{sourceLabel(ev, titles)}</Text>
              </span>
            ),
            children: (
              <Text code style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
                {clip(ev.quote, 400)}
              </Text>
            ),
          }))}
        />
      )}
    </>
  );
}

/** 表格：核对用——状态筛选、支持/反驳排序、行内展开证据（立场 + 出处 + 原文）。 */
function ClaimTable({ rows, ctx }: { rows: Row[]; ctx: Ctx }) {
  const rank = (s: Status) => STATUS_ORDER.indexOf(s);
  return (
    <Table<Row>
      size="small"
      rowKey="id"
      dataSource={[...rows].sort((a, b) => rank(a.bucket) - rank(b.bucket) || (b.sup ?? 0) - (a.sup ?? 0))}
      pagination={{ pageSize: 10, hideOnSinglePage: true }}
      expandable={{
        rowExpandable: (r) => r.items.length > 0,
        expandedRowRender: (r) => <EvidenceList items={r.items} titles={ctx.titles} />,
      }}
      columns={[
        {
          title: "状态",
          dataIndex: "bucket",
          width: 96,
          filters: STATUS_ORDER.map((s) => ({ text: statusMeta[s].label, value: s })),
          onFilter: (value, r) => r.bucket === value,
          render: (s: Status) => <ToneTag color={statusMeta[s].color}>{statusMeta[s].label}</ToneTag>,
        },
        {
          title: "断言",
          dataIndex: "text",
          render: (t: string) => (
            <Paragraph style={{ margin: 0 }} ellipsis={{ rows: 2, expandable: true, symbol: "展开" }}>
              {t}
            </Paragraph>
          ),
        },
        { title: "支持", dataIndex: "sup", width: 72, align: "right", sorter: (a, b) => (a.sup ?? 0) - (b.sup ?? 0), render: (v?: number) => v ?? 0 },
        { title: "反驳", dataIndex: "ref", width: 72, align: "right", sorter: (a, b) => (a.ref ?? 0) - (b.ref ?? 0), render: (v?: number) => v ?? 0 },
        { title: "证据", key: "evidence", width: 72, align: "right", render: (_: unknown, r) => r.items.length },
        {
          title: "裁决",
          key: "resolve",
          width: 120,
          render: (_: unknown, r) => (needsVerdict(r) ? <div style={{ display: "flex", flexWrap: "wrap" }}><ResolveCopy claimId={r.id} project={ctx.project} /></div> : null),
        },
      ]}
    />
  );
}

function EvidenceList({ items, titles }: { items: Linked[]; titles: ReadonlyMap<string, string> }) {
  return (
    <Space orientation="vertical" size={8} style={{ width: "100%" }}>
      {items.map(({ l, ev }) => (
        <div key={ev.id}>
          <Space size={6} wrap>
            <ToneTag color={stanceOf(l.stance).color}>{stanceOf(l.stance).label}</ToneTag>
            <Text type="secondary" style={{ fontSize: 12 }}>{sourceLabel(ev, titles)}</Text>
          </Space>
          <Paragraph style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>
            <Text code style={{ fontSize: 12 }}>{clip(ev.quote, 400)}</Text>
          </Paragraph>
        </div>
      ))}
    </Space>
  );
}
