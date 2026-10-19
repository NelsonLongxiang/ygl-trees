import { useMemo } from "react";
import {
  ReactFlow, Background, Controls, MiniMap,
  type Node, type Edge, type NodeProps,
  Handle, Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { C } from "./tokens";

interface GraphData {
  nodes: Array<{ id: string; label: string; type: string; color: string }>;
  edges: Array<{ source: string; target: string; label: string }>;
}

const typeLabels: Record<string, string> = {
  node: "节点", claim: "断言", kb: "知识",
  evidence: "证据", artifact: "产出", skill: "技能",
};

function EntityNode({ data }: NodeProps) {
  const d = data as any;
  return (
    <div style={{
      background: d.color || C.secondary,
      color: "#fff",
      padding: "6px 12px",
      borderRadius: 8,
      fontSize: 11,
      minWidth: 80,
      textAlign: "center",
      border: "2px solid rgba(255,255,255,0.3)",
      boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
    }}>
      <Handle type="target" position={Position.Top} style={{ background: "#555" }} />
      <div style={{ opacity: 0.8, fontSize: 9, marginBottom: 2 }}>
        {typeLabels[d.type] || d.type}
      </div>
      <div style={{ fontWeight: 600, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {d.label}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: "#555" }} />
    </div>
  );
}

const nodeTypes = { entity: EntityNode };

export default function KnowledgeGraph({ graph }: { graph: GraphData }) {
  const { nodes, edges } = useMemo(() => {
    if (!graph?.nodes) return { nodes: [] as Node[], edges: [] as Edge[] };

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
        data: { label: n.label, type: n.type, color: n.color },
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
      animated: e.label === "decided-by",
      style: { stroke: edgeColors[e.label] || C.secondary, strokeWidth: 1.5 },
      labelStyle: { fontSize: 9, fill: C.secondary },
    }));

    return { nodes: ns, edges: es };
  }, [graph]);

  if (!nodes.length) return null;

  return (
    <div style={{ height: 420 }}>
      <ReactFlow
        nodes={nodes}
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
          nodeColor={(n) => (n.data as any)?.color || C.secondary}
          style={{ background: "#111" }}
        />
      </ReactFlow>
    </div>
  );
}
