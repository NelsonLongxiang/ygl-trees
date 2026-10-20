/**
 * R13.3: the real-scale tree view — xyflow gives pan/zoom/drag and a minimap
 * for free; tier layout maps onto Y, siblings fan out on X. Clicking a node
 * opens the detail panel (conditions / deterministic can / R9 related).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow, Background, Controls, MiniMap,
  type Edge, type Node, type NodeProps, type NodeMouseHandler,
  Handle, Position,
} from "@xyflow/react";
import { fetchNode, type NodeDetail, type TreeData } from "./api";
import { useLayoutNodes } from "./flow";
import { useThemeName } from "./theme";

type TreeNodeData = {
  label: string;
  unlocked: boolean;
  selected?: boolean;
} & Record<string, unknown>;

function TreeNode({ data }: NodeProps<Node<TreeNodeData>>) {
  const d = data as TreeNodeData;
  return (
    <div
      style={{
        padding: "6px 12px",
        borderRadius: "var(--radius-md)",
        background: "var(--color-surface)",
        border: `1.5px solid ${d.selected ? "var(--color-primary)" : "var(--color-border)"}`,
        // locked = secondary, not text-dim: text-dim is 2.3:1 in dark (DESIGN.md: decorative only)
        color: d.unlocked ? "var(--color-text)" : "var(--color-secondary)",
        fontSize: 11,
        cursor: "pointer",
        minWidth: 90,
        textAlign: "center",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      {d.label}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { treeNode: TreeNode };

export default function TreeFlow({ tree }: { tree: TreeData | null }) {
  const colorMode = useThemeName();
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<NodeDetail | null>(null);

  // layout from the payload only; selection is applied on top so a click never
  // rebuilds (and never resets) the canvas
  const { layout, edges } = useMemo(() => {
    if (!tree) return { layout: [] as Node<TreeNodeData>[], edges: [] as Edge[] };
    const tiers = new Map<number, typeof tree.nodes>();
    for (const n of tree.nodes) {
      const t = n.tier || 0;
      if (!tiers.has(t)) tiers.set(t, []);
      tiers.get(t)!.push(n);
    }
    const tierKeys = [...tiers.keys()].sort((a, b) => a - b);
    const ROW = 110, COL = 180;
    const layout: Node<TreeNodeData>[] = tree.nodes.map((n) => {
      const t = n.tier || 0;
      const row = tierKeys.indexOf(t);
      const siblings = tiers.get(t)!;
      const col = siblings.indexOf(n);
      // horizontal layout: tier advances left→right (COL), siblings fan vertically (ROW)
      return {
        id: n.key,
        type: "treeNode",
        position: { x: row * COL, y: (col - (siblings.length - 1) / 2) * ROW },
        // first-fit estimate only: fitView runs before xyflow has measured the
        // nodes; the measured size (kept by useLayoutNodes) replaces it
        initialWidth: 90,
        initialHeight: 32,
        data: { label: n.key.slice(0, 16), unlocked: !!n.unlocked_at },
      };
    });
    const edges: Edge[] = tree.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.parent,
      target: e.child,
      animated: false,
      style: {
        stroke: e.required ? "var(--color-border)" : "var(--color-secondary)",
        strokeWidth: 1.5,
        strokeDasharray: e.required ? undefined : "5 4",
      },
    }));
    return { layout, edges };
  }, [tree]);

  const [liveNodes, onNodesChange] = useLayoutNodes(layout, `tree:${tree?.name ?? ""}`);
  const nodes = useMemo(
    () => liveNodes.map((n) => (!!n.data.selected === (n.id === selected) ? n : { ...n, data: { ...n.data, selected: n.id === selected } })),
    [liveNodes, selected]
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (_e, node) => {
      setSelected(node.id);
      setDetail(null);
      if (tree) fetchNode(tree.name, node.id).then(setDetail);
    },
    [tree]
  );

  useEffect(() => {
    setDetail(null);
    setSelected(null);
  }, [tree?.name]);

  if (!tree) return <p className="dim">No tree selected (ygl-trees tree use &lt;name&gt;)</p>;

  return (
    <div style={{ display: "flex", gap: "var(--spacing-md)" }}>
      <div style={{ flex: 1, height: 460, border: "1px solid var(--color-border)", borderRadius: "var(--radius-lg)", background: "var(--color-neutral)" }}>
        <ReactFlow
          colorMode={colorMode}
          nodes={nodes}
          onNodesChange={onNodesChange}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          fitView
          minZoom={0.15}
          maxZoom={2.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--color-border-dim)" gap={24} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)" }}
            nodeColor="var(--color-text-dim)"
          />
        </ReactFlow>
      </div>
      <aside
        style={{
          width: 300,
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          background: "var(--color-surface)",
          padding: "var(--spacing-md)",
          alignSelf: "flex-start",
        }}
      >
        <h2 style={{ marginTop: 0 }}>{selected ?? "点击节点"}</h2>
        {!detail && <p className="dim">{selected ? "加载中…" : "拖拽缩放自由导航，点击节点看详情（条件 / 判定 / 关联）"}</p>}
        {detail && (
          <>
            <p className="dim">
              {detail.node.kind} · tier {detail.node.tier} · cost {detail.node.cost}
            </p>
            <p style={{ color: detail.can.ok ? "var(--color-success)" : "var(--color-danger)", fontWeight: 700 }}>
              {detail.can.ok ? "✓ 可解锁" : "✗ 未满足"}
            </p>
            {detail.conditions.length > 0 && (
              <>
                <p className="dim">条件 ({detail.conditions.length})</p>
                <table style={{ width: "100%", fontSize: "0.78em", borderCollapse: "collapse" }}>
                  <tbody>
                    {detail.conditions.map((c) => (
                      <tr key={c.name}>
                        <td style={{ border: "1px solid var(--color-border-dim)", padding: "2px 5px" }}>{c.name}</td>
                        <td style={{ border: "1px solid var(--color-border-dim)", padding: "2px 5px" }}>{c.op}</td>
                        <td style={{ border: "1px solid var(--color-border-dim)", padding: "2px 5px" }}>{String(c.value).slice(0, 24)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            {detail.related.length > 0 && (
              <>
                <p className="dim">关联 ({detail.related.length})</p>
                {detail.related.map((r) => (
                  <div key={r.id + r.rel} style={{ fontSize: "0.78em" }}>
                    <b style={{ color: "var(--color-tertiary)" }}>{r.rel}</b> {r.type}: {String(r.display).slice(0, 30)}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
