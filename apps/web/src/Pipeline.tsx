import { useMemo, useState } from "react";
import { Button, Card, Collapse, Empty, Input, Space, Table, Tag, Typography } from "antd";
import { C } from "./tokens";
import { ToneTag } from "./ToneTag";

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
 */

const { Text, Paragraph } = Typography;

export interface PipelineClaim {
  id: string;
  text: string;
  status: string;
  confidence?: number | null;
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

const VIEW_KEY = "ygl-pipeline-view";
const readView = (): PipelineView | null => {
  try {
    const v = typeof window === "undefined" ? null : window.localStorage.getItem(VIEW_KEY);
    return v === "board" || v === "table" ? v : null;
  } catch {
    return null;
  }
};
const writeView = (v: PipelineView) => {
  try {
    window.localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* per-viewer convenience only */
  }
};

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

const bucketOf = (status: string): Status =>
  (STATUS_ORDER as readonly string[]).includes(status) ? (status as Status) : "unverified";

/** Claims joined to their evidence, filtered by a needle over claim text and quotes. */
export function pipelineRows(
  claims: PipelineClaim[],
  claimEvidence: PipelineLink[],
  evidence: PipelineEvidence[],
  needle = ""
): Row[] {
  const evById = new Map(evidence.map((e) => [e.id, e]));
  const q = needle.trim().toLowerCase();
  return claims
    .map((c) => ({
      ...c,
      bucket: bucketOf(c.status),
      items: claimEvidence
        .filter((l) => l.claim_id === c.id)
        .map((l) => ({ l, ev: evById.get(l.evidence_id) }))
        .filter((x): x is Linked => !!x.ev),
    }))
    .filter((r) => !q || r.text.toLowerCase().includes(q) || r.items.some((x) => x.ev.quote.toLowerCase().includes(q)));
}

export default function Pipeline({
  claims,
  claimEvidence,
  evidence,
  defaultView,
}: {
  claims: PipelineClaim[];
  claimEvidence: PipelineLink[];
  evidence: PipelineEvidence[];
  defaultView?: PipelineView;
}) {
  const [view, setView] = useState<PipelineView>(() => defaultView ?? readView() ?? "board");
  const [needle, setNeedle] = useState("");
  const rows = useMemo(() => pipelineRows(claims, claimEvidence, evidence, needle), [claims, claimEvidence, evidence, needle]);

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
        {needle && <Text type="secondary">{rows.length} / {claims.length} 条断言</Text>}
      </div>
      {!rows.length ? (
        <Empty description="没有匹配的断言" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : view === "table" ? (
        <ClaimTable rows={rows} />
      ) : (
        <Board rows={rows} />
      )}
    </Space>
  );
}

/** 看板：按状态四列水流，claim 卡 3px 状态色左沿（DESIGN.md：管线的扫读路径）。 */
function Board({ rows }: { rows: Row[] }) {
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
                  {c.items.length > 0 && <EvidenceLinks items={c.items} />}
                </div>
              </Card>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** 证据链接折叠列表——点击展开（webui-design.md §3：点击展开证据链接列表）。 */
function EvidenceLinks({ items }: { items: Linked[] }) {
  const [open, setOpen] = useState(false);
  const sm = stanceOf(items[0]?.l.stance);
  return (
    <>
      <Tag
        color={undefined}
        style={{ color: sm.color, borderColor: sm.color, cursor: "pointer" }}
        onClick={() => setOpen((v) => !v)}
      >
        证据 ×{items.length} {open ? "▲" : "▼"}
      </Tag>
      {open && (
        <Collapse
          ghost
          size="small"
          style={{ marginTop: 6 }}
          items={items.map(({ l, ev }, i) => ({
            key: String(i),
            label: (
              <span>
                <Tag style={{ color: stanceOf(l.stance).color, borderColor: stanceOf(l.stance).color }}>
                  {stanceOf(l.stance).label}
                </Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>{ev.locator || ev.source_id}</Text>
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
function ClaimTable({ rows }: { rows: Row[] }) {
  const rank = (s: Status) => STATUS_ORDER.indexOf(s);
  return (
    <Table<Row>
      size="small"
      rowKey="id"
      dataSource={[...rows].sort((a, b) => rank(a.bucket) - rank(b.bucket) || (b.sup ?? 0) - (a.sup ?? 0))}
      pagination={{ pageSize: 10, hideOnSinglePage: true }}
      expandable={{
        rowExpandable: (r) => r.items.length > 0,
        expandedRowRender: (r) => <EvidenceList items={r.items} />,
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
      ]}
    />
  );
}

function EvidenceList({ items }: { items: Linked[] }) {
  return (
    <Space orientation="vertical" size={8} style={{ width: "100%" }}>
      {items.map(({ l, ev }) => (
        <div key={ev.id}>
          <Space size={6} wrap>
            <ToneTag color={stanceOf(l.stance).color}>{stanceOf(l.stance).label}</ToneTag>
            <Text type="secondary" style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>{ev.locator || ev.source_id}</Text>
          </Space>
          <Paragraph style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>
            <Text code style={{ fontSize: 12 }}>{clip(ev.quote, 400)}</Text>
          </Paragraph>
        </div>
      ))}
    </Space>
  );
}
