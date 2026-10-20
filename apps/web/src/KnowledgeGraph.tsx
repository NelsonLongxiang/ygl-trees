import { useMemo } from "react";
import {
  ReactFlow, Background, Controls, MiniMap,
  type Node, type Edge, type NodeProps,
  Handle, Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { C } from "./tokens";
import { useLayoutNodes } from "./flow";
import { useThemeName } from "./theme";

interface GraphData {
  nodes: Array<{ id: string; label: string; type: string; color: string }>;
  edges: Array<{ source: string; target: string; label: string }>;
}

// Entity fill by type — the same semantic families as the server map in
// ops/tools webui.ts, but as theme-following vars (the server's hex is dark-only).
const typeFill: Record<string, string> = {
  node: C.primary, claim: C.success, kb: C.secondary, evidence: C.warning,
  artifact: C.tertiary, skill: C.secondary, task: C.tertiary, source: C.warning,
};
const fillOf = (type: string): string => typeFill[type] ?? C.secondary;

const typeLabels: Record<string, string> = {
  node: "节点", claim: "断言", kb: "知识",
  evidence: "证据", artifact: "产出", skill: "技能",
};

function EntityNode({ data }: NodeProps) {
  const d = data as any;
  return (
    <div style={{
      background: fillOf(d.type),
      color: C["on-entity"], // dark: neutral ink (≥6.2:1), light: white (≥4.9:1)
      padding: "6px 12px",
      borderRadius: "var(--radius-lg)",
      fontSize: 11,
      minWidth: 80,
      textAlign: "center",
      border: "2px solid var(--entity-stroke)",
      boxShadow: "var(--shadow-entity)",
    }}>
      <Handle type="target" position={Position.Top} style={{ background: C.secondary }} />
      <div style={{ opacity: 0.8, fontSize: 9, marginBottom: 2 }}>
        {typeLabels[d.type] || d.type}
      </div>
      <div style={{ fontWeight: 600, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {d.label}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: C.secondary }} />
    </div>
  );
}

const nodeTypes = { entity: EntityNode };

export default function KnowledgeGraph({ graph }: { graph: GraphData }) {
  const colorMode = useThemeName();
  const { layout, edges } = useMemo(() => {
    if (!graph?.nodes) return { layout: [] as Node[], edges: [] as Edge[] };

    // Simple layout: circle for entities grouped by type
    const types = [...new Set(graph.nodes.map((n) => n.type))];
    const perRing = Math.ceil(graph.nodes.length / Math.max(types.length, 1));
    const radius = 200 + types.length * 40;

    const ns: Node[] = graph.nodes.map((n, i) => {
      const typeIdx = types.indexOf(n.type);
      const angleInGroup = ((i % perRing) / perRing) * 2 * Math.PI;
      const groupAngle = (typeIdx / types.length) * 2 * Math.PI;
      const angle = groupAngle + angleInGroup / types.length;
      const r = radius + typeIdx * 20;
      return {
        id: n.id,
        type: "entity" as const,
        position: { x: Math.cos(angle) * r, y: Math.sin(angle) * r },
        initialWidth: 100, // first-fit estimate (see TreeFlow)
        initialHeight: 40,
        data: { label: n.label, type: n.type },
      };
    });

    // 0.92 单B: DESIGN.md tokens only (import from ./tokens) — semantic family:
    // decided-by=success (adjudication), evidenced-by=warning, tracked-by=
    // tertiary, related/unknown=secondary.
    const edgeColors: Record<string, string> = {
      "decided-by": C.success,
      "evidenced-by": C.warning,
      "tracked-by": C.tertiary,
      related: C.secondary,
    };

    const es: Edge[] = graph.edges.map((e) => ({
      id: `${e.source}-${e.target}-${e.label}`,
      source: e.source,
      target: e.target,
      label: e.label,
      animated: false, // DESIGN.md: graph edges are never animated
      style: { stroke: edgeColors[e.label] || C.secondary, strokeWidth: 1.5 },
      labelStyle: { fontSize: 9, fill: C.secondary },
    }));

    return { layout: ns, edges: es };
  }, [graph]);

  const [nodes, onNodesChange] = useLayoutNodes(layout, "knowledge-graph");

  if (!nodes.length) return null;

  return (
    <div style={{ height: 460, border: "1px solid var(--color-border)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
      <ReactFlow
        colorMode={colorMode}
        nodes={nodes}
        onNodesChange={onNodesChange}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.15}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background color={C["border-dim"]} gap={20} />
        <Controls />
        <MiniMap
          pannable
          nodeColor={(n) => fillOf(String((n.data as { type?: string })?.type ?? ""))}
          style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)" }}
        />
      </ReactFlow>
    </div>
  );
}
