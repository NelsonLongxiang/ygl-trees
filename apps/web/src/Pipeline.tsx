import { useMemo, useState } from "react";
import { Card, Collapse, Empty, Tag, Typography } from "antd";
import { C } from "./tokens";

/**
 * 研究管线视图（0.92 单A，direct-0f20e882 队列工单；spec webui-design.md §3）。
 *
 * R19 同口径（docs/webui-design.md「0. 未选择态」）：claims/evidence 载荷由
 * 服务端按授权域收集——未选择/仅全局指针时 gatherData 根本不填这两组键，
 * 本组件在 App 中也仅在 data.claims 存在时挂载（双重不渲染）。
 *
 * 状态色只用 DESIGN.md token（单B 纪律）：supported=success / refuted=danger
 * / contested=warning / unverified=secondary——词 + 色双信号，永不负载裸 hex。
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

const STATUS_ORDER = ["supported", "contested", "unverified", "refuted"] as const;

const statusMeta: Record<string, { color: string; label: string }> = {
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

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export default function Pipeline({
  claims,
  claimEvidence,
  evidence,
}: {
  claims: PipelineClaim[];
  claimEvidence: PipelineLink[];
  evidence: PipelineEvidence[];
}) {
  const grouped = useMemo(() => {
    const g: Record<string, PipelineClaim[]> = {};
    for (const c of claims) {
      const k = (STATUS_ORDER as readonly string[]).includes(c.status) ? c.status : "unverified";
      (g[k] ??= []).push(c);
    }
    return g;
  }, [claims]);

  const evById = useMemo(() => {
    const m = new Map<string, PipelineEvidence>();
    for (const e of evidence) m.set(e.id, e);
    return m;
  }, [evidence]);

  if (!claims.length) return <Empty description="暂无断言" />;

  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
      {STATUS_ORDER.map((status) => {
        const list = grouped[status] ?? [];
        if (!list.length) return null;
        const meta = statusMeta[status];
        return (
          <div key={status} style={{ flex: "1 1 220px", minWidth: 220 }}>
            <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: 5, background: meta.color, display: "inline-block" }} />
              <Text strong style={{ color: meta.color }}>{meta.label}</Text>
              <Text type="secondary">（{list.length}）</Text>
            </div>
            {list.map((c) => {
              const links = claimEvidence.filter((l) => l.claim_id === c.id);
              const items = links
                .map((l) => ({ l, ev: evById.get(l.evidence_id) }))
                .filter((x) => x.ev);
              return (
                <Card
                  key={c.id}
                  size="small"
                  style={{ marginBottom: 8, borderLeft: `3px solid ${meta.color}` }}
                >
                  <Paragraph style={{ marginBottom: items.length ? 4 : 0 }} ellipsis={{ rows: 3, expandable: true, symbol: "展开" }}>
                    {c.text}
                  </Paragraph>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <Tag>支持 {c.sup ?? 0}</Tag>
                    <Tag>反驳 {c.ref ?? 0}</Tag>
                    {items.length > 0 && (
                      <EvidenceLinks items={items} />
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** 证据链接折叠列表——点击展开（webui-design.md §3：点击展开证据链接列表）。 */
function EvidenceLinks({
  items,
}: {
  items: Array<{ l: PipelineLink; ev: PipelineEvidence }>;
}) {
  const [open, setOpen] = useState(false);
  const sm = stanceMeta[items[0]?.l.stance] ?? stanceMeta.related;
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
                <Tag style={{ color: (stanceMeta[l.stance] ?? stanceMeta.related).color, borderColor: (stanceMeta[l.stance] ?? stanceMeta.related).color }}>
                  {(stanceMeta[l.stance] ?? stanceMeta.related).label}
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
