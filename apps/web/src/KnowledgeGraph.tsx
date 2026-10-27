/**
 * 知识图谱 = the R9 relation fabric: which research assets each tech-tree node
 * is tracked by / decided by / evidenced by. Laid out as clusters (graph.ts),
 * the legend doubles as a type filter, done tasks hide by default, search dims
 * what does not match, and a click focuses an entity and lists its links.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, useReactFlow,
  type Node, type Edge, type NodeProps, type NodeMouseHandler,
  Handle, Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button, Input, Switch, Tag, Typography } from "antd";
import { C } from "./tokens";
import { useLayoutNodes } from "./flow";
import { useThemeName } from "./theme";
import { CARD_W, TYPE_ORDER, layoutGraph, linksOf, matchIds, resolveEntities, type Entity, type GraphPayload } from "./graph";

const { Text } = Typography;

// Entity fill by type — the same semantic families as the server map in
// ops/tools webui.ts, but as theme-following vars (the server's hex is dark-only).
const typeFill: Record<string, string> = {
  node: C.primary, claim: C.success, kb: C.secondary, evidence: C.warning,
  artifact: C.tertiary, skill: C.secondary, task: C.tertiary, source: C.warning,
};
const fillOf = (type: string): string => typeFill[type] ?? C.secondary;

export const typeLabels: Record<string, string> = {
  node: "节点", claim: "断言", kb: "知识", evidence: "证据",
  artifact: "产出", skill: "技能", task: "任务", source: "来源",
};
const typeLabel = (t: string) => typeLabels[t] || t;

// 0.92 单B: DESIGN.md tokens only — semantic family: decided-by=success
// (adjudication), evidenced-by=warning, tracked-by=tertiary, related=secondary.
export const relColor: Record<string, string> = {
  "decided-by": C.success,
  "evidenced-by": C.warning,
  "tracked-by": C.tertiary,
  related: C.secondary,
};
export const relWords: Record<string, string> = {
  "decided-by": "决策依据",
  "evidenced-by": "证据支撑",
  "tracked-by": "任务跟踪",
  related: "相关",
};

type EntityData = { entity: Entity; dim: boolean; selected: boolean } & Record<string, unknown>;

function EntityNode({ data }: NodeProps<Node<EntityData>>) {
  const { entity: e, dim, selected } = data as EntityData;
  return (
    <div
      title={`${typeLabel(e.type)}：${e.label}`}
      style={{
        width: e.hub ? CARD_W + 28 : CARD_W,
        background: fillOf(e.type),
        color: C["on-entity"], // dark: neutral ink (≥6.2:1), light: white (≥4.9:1)
        padding: "4px 10px",
        borderRadius: "var(--radius-md)",
        fontSize: 12,
        lineHeight: 1.3,
        border: `2px solid ${selected ? "var(--color-text)" : "var(--entity-stroke)"}`,
        boxShadow: "var(--shadow-entity)",
        opacity: dim ? 0.22 : 1,
        transition: "opacity 120ms",
        cursor: "pointer",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div style={{ fontSize: 10, opacity: 0.85 }}>
        {typeLabel(e.type)}
        {e.done && " · 已完成"}
        {e.foreign && " · 其他项目"}
      </div>
      <div style={{ fontWeight: e.hub ? 700 : 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.label}</div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { entity: EntityNode };

interface Props {
  graph: GraphPayload;
  tasks?: Array<{ id: string; title: string; status: string }>;
  sources?: Array<{ id: string; url: string; note?: string | null }>;
}

export default function KnowledgeGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

function GraphCanvas({ graph, tasks, sources }: Props) {
  const colorMode = useThemeName();
  const flow = useReactFlow();
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<string>>(new Set());
  const [showDoneTasks, setShowDoneTasks] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const all = useMemo(() => resolveEntities(graph, { tasks, sources }), [graph, tasks, sources]);
  const view = useMemo(() => layoutGraph(graph, all, { hiddenTypes, showDoneTasks }), [graph, all, hiddenTypes, showDoneTasks]);
  const byId = useMemo(() => new Map(all.map((e) => [e.id, e])), [all]);
  const matches = useMemo(() => matchIds(view.entities, query), [view, query]);
  const links = useMemo(() => (selected ? linksOf(view.edges, selected) : []), [view, selected]);

  // a selection that the filters just hid is dropped, so the panel never describes an invisible card
  useEffect(() => {
    if (selected && !view.entities.some((e) => e.id === selected)) setSelected(null);
  }, [view, selected]);

  const layout = useMemo(
    () =>
      view.entities.map<Node<EntityData>>((e) => ({
        id: e.id,
        type: "entity",
        position: { x: e.x, y: e.y },
        initialWidth: e.hub ? CARD_W + 28 : CARD_W,
        initialHeight: 44,
        ariaLabel: `${typeLabel(e.type)}：${e.label}${e.done ? "，已完成" : ""}${e.foreign ? "，其他项目" : ""}`,
        data: { entity: e, dim: false, selected: false },
      })),
    [view]
  );
  const [liveNodes, onNodesChange] = useLayoutNodes(layout, "knowledge-graph");

  // focus (selection, else search) dims everything outside it; layout never moves for it
  const focus = useMemo(() => {
    if (selected) return new Set([selected, ...links.map((l) => l.other)]);
    return matches.size ? matches : null;
  }, [selected, links, matches]);
  const nodes = useMemo(
    () =>
      liveNodes.map((n) => {
        const dim = !!focus && !focus.has(n.id);
        const sel = n.id === selected;
        return n.data.dim === dim && n.data.selected === sel ? n : { ...n, data: { ...n.data, dim, selected: sel } };
      }),
    [liveNodes, focus, selected]
  );
  const edges = useMemo<Edge[]>(
    () =>
      view.edges.map((e) => {
        const on = !focus || (selected ? e.source === selected || e.target === selected : focus.has(e.source) && focus.has(e.target));
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "smoothstep",
          animated: false, // DESIGN.md: graph edges are never animated
          style: { stroke: relColor[e.rel] || C.secondary, strokeWidth: on && selected ? 2 : 1.25, opacity: on ? 1 : 0.12 },
        };
      }),
    [view, focus, selected]
  );

  // filters change the layout: refit once xyflow has the new nodes
  useEffect(() => {
    const id = requestAnimationFrame(() => flow.fitView({ duration: 200 }));
    return () => cancelAnimationFrame(id);
  }, [hiddenTypes, showDoneTasks, flow]);

  const focusOn = useCallback(
    (id: string) => {
      setSelected(id);
      requestAnimationFrame(() => flow.fitView({ nodes: [{ id }, ...linksOf(view.edges, id).map((l) => ({ id: l.other }))], duration: 250, maxZoom: 1.2 }));
    },
    [flow, view]
  );
  const onNodeClick: NodeMouseHandler = useCallback((_e, n) => focusOn(n.id), [focusOn]);

  const toggleType = (t: string) =>
    setHiddenTypes((h) => {
      const next = new Set(h);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  const types = Object.keys(view.counts).sort((a, b) => (a === "node" ? -1 : b === "node" ? 1 : TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b)));
  const sel = selected ? byId.get(selected) : null;
  const firstMatch = view.entities.find((e) => matches.has(e.id));

  return (
    <div>
      <div className="yt-kg-controls" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 16px", marginBottom: 8 }}>
        <Input.Search
          allowClear
          size="small"
          placeholder="查找实体（回车定位）"
          aria-label="查找实体"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onSearch={() => firstMatch && focusOn(firstMatch.id)}
          style={{ width: 240 }}
        />
        {query.trim() && <Text type="secondary" style={{ fontSize: 12 }}>匹配 {matches.size}</Text>}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <Switch size="small" checked={showDoneTasks} onChange={setShowDoneTasks} aria-label="显示已完成任务" />
          <span>显示已完成任务（{view.doneTasks}）</span>
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--spacing-md)" }}>
        <div style={{ flex: "999 1 420px", minWidth: 0 }}>
          <div style={{ height: 520, border: "1px solid var(--color-border)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
            <ReactFlow
              colorMode={colorMode}
              nodes={nodes}
              onNodesChange={onNodesChange}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={onNodeClick}
              onPaneClick={() => setSelected(null)}
              fitView
              minZoom={0.1}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
            >
              <Background color={C["border-dim"]} gap={20} />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                ariaLabel="知识图谱小地图"
                nodeColor={(n) => fillOf((n.data as EntityData).entity.type)}
                style={{ width: 128, height: 84, border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)" }}
              />
            </ReactFlow>
          </div>
          <GraphLegend types={types} counts={view.counts} hidden={hiddenTypes} onToggle={toggleType} />
        </div>

        <aside
          aria-label="实体详情"
          style={{ flex: "1 1 280px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-lg)", background: "var(--color-surface)", padding: "var(--spacing-md)", alignSelf: "flex-start" }}
        >
          {!sel ? (
            <>
              <h2 style={{ marginTop: 0 }}>点击实体</h2>
              <p className="dim">
                每个科技树节点和它关联的任务、断言、证据排成一组。点实体看它的全部关联；图例里的类型可以点选显示或隐藏。
              </p>
            </>
          ) : (
            <>
              <p className="dim" style={{ margin: 0 }}>{typeLabel(sel.type)}{sel.done && " · 已完成"}{sel.foreign && " · 其他项目（标题只在选中该项目时可见）"}</p>
              <h2 style={{ marginTop: 4, marginBottom: 8, overflowWrap: "anywhere" }}>{sel.label}</h2>
              <p className="dim" style={{ marginTop: 0, fontFamily: "var(--font-mono)", fontSize: 11, overflowWrap: "anywhere" }}>{sel.id}</p>
              <p className="dim" style={{ marginBottom: 4 }}>关联（{links.length}）</p>
              {links.length === 0 && <Text type="secondary">当前筛选下没有可见的关联</Text>}
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {links.map((l) => {
                  const o = byId.get(l.other);
                  return (
                    <li key={`${l.other}|${l.rel}`} style={{ marginBottom: 6 }}>
                      <Tag style={{ color: relColor[l.rel] || C.secondary, borderColor: relColor[l.rel] || C.secondary, background: "transparent", marginRight: 6 }}>
                        {relWords[l.rel] || l.rel}
                      </Tag>
                      <Button type="link" size="small" style={{ padding: 0, height: "auto", whiteSpace: "normal", textAlign: "left" }} onClick={() => focusOn(l.other)}>
                        {typeLabel(o?.type ?? "")}：{o?.label ?? l.other}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Legend = filter: each asset type is a toggle with shown / total; edge colours name the relation. */
export function GraphLegend({
  types, counts, hidden, onToggle,
}: {
  types: string[];
  counts: Record<string, { total: number; shown: number }>;
  hidden: ReadonlySet<string>;
  onToggle: (t: string) => void;
}) {
  const swatch = (color: string) => (
    <span aria-hidden style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: color, border: "1px solid var(--color-border)", marginRight: 4, verticalAlign: "-1px" }} />
  );
  return (
    <div className="yt-kg-legend" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px", fontSize: 12, color: "var(--color-secondary)", marginTop: 8 }}>
      {types.map((t) => {
        const c = counts[t];
        const label = `${typeLabel(t)} ${c.shown === c.total ? c.total : `${c.shown}/${c.total}`}`;
        if (t === "node") return <span key={t}>{swatch(fillOf(t))}{label}</span>; // hubs always show
        const off = hidden.has(t);
        return (
          // a plain pressed button, not CheckableTag: its checked state is on-primary over the primary fill
          <Button
            key={t}
            size="small"
            autoInsertSpace={false}
            aria-pressed={!off}
            title={off ? `显示${typeLabel(t)}` : `隐藏${typeLabel(t)}`}
            onClick={() => onToggle(t)}
            style={{ fontSize: 12, textDecoration: off ? "line-through" : undefined, color: off ? "var(--color-secondary)" : undefined }}
          >
            {swatch(off ? "transparent" : fillOf(t))}{label}
          </Button>
        );
      })}
      <span aria-hidden style={{ width: 1, height: 14, background: "var(--color-border)" }} />
      {Object.keys(relWords).filter((r) => r !== "related").map((r) => (
        <span key={r}>
          <svg width="20" height="8" aria-hidden style={{ verticalAlign: "middle", marginRight: 4 }}>
            <line x1="0" y1="4" x2="20" y2="4" stroke={relColor[r]} strokeWidth="2" />
          </svg>
          {relWords[r]}
        </span>
      ))}
    </div>
  );
}
