/**
 * R13.3: the real-scale tree view — xyflow gives pan/zoom/drag and a minimap
 * for free; tier layout maps onto Y, siblings fan out on X. Clicking a node
 * opens the detail panel (conditions / deterministic can / R9 related).
 * A node reads as the expert names it (name over key) and says its state in
 * an icon as well as a color, so progress is legible at a glance.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow, Background, Controls, MiniMap,
  type Edge, type Node, type NodeProps, type NodeMouseHandler,
  Handle, Position,
} from "@xyflow/react";
import { CheckCircleFilled, LockOutlined } from "@ant-design/icons";
import { fetchNode, type NodeDetail, type TreeData } from "./api";
import { useLayoutNodes } from "./flow";
import { useThemeName } from "./theme";

type TreeNodeData = {
  name: string;
  nodeKey: string;
  unlocked: boolean;
  selected?: boolean;
} & Record<string, unknown>;

const NODE_W = 176;

export function TreeNode({ data }: NodeProps<Node<TreeNodeData>>) {
  const d = data as TreeNodeData;
  const state = d.unlocked ? "已解锁" : "未解锁";
  return (
    <div
      title={`${d.name}（${d.nodeKey}）· ${state}`}
      aria-label={`${d.name}，${state}`}
      style={{
        width: NODE_W,
        padding: "6px 10px",
        borderRadius: "var(--radius-md)",
        background: "var(--color-surface)",
        border: `1.5px solid ${d.selected ? "var(--color-primary)" : "var(--color-border)"}`,
        // locked = secondary, not text-dim: text-dim is a non-text token (DESIGN.md: minimap blocks, never text)
        color: d.unlocked ? "var(--color-text)" : "var(--color-secondary)",
        fontSize: 12,
        lineHeight: 1.35,
        cursor: "pointer",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {d.unlocked ? (
          <CheckCircleFilled aria-hidden style={{ color: "var(--color-success)", flex: "none" }} />
        ) : (
          <LockOutlined aria-hidden style={{ color: "var(--color-secondary)", flex: "none" }} />
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--color-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {d.nodeKey}
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

/** What the marks mean: state icons and the two edge kinds. */
export function TreeLegend() {
  const line = (dash?: string) => (
    <svg width="24" height="8" aria-hidden style={{ verticalAlign: "middle" }}>
      <line x1="0" y1="4" x2="24" y2="4" stroke={dash ? "var(--color-secondary)" : "var(--color-border)"} strokeWidth="1.5" strokeDasharray={dash} />
    </svg>
  );
  return (
    <div className="yt-tree-legend" style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 12, color: "var(--color-secondary)", marginTop: 8 }}>
      <span><CheckCircleFilled style={{ color: "var(--color-success)" }} /> 已解锁</span>
      <span><LockOutlined /> 未解锁</span>
      <span>{line()} 必检前置</span>
      <span>{line("5 4")} 可选前置</span>
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
    const ROW = 72, COL = NODE_W + 64;
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
        initialWidth: NODE_W,
        initialHeight: 46,
        data: { name: n.name || n.key, nodeKey: n.key, unlocked: !!n.unlocked_at },
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
    // canvas and panel side by side; on a narrow screen the panel wraps below a full-width canvas
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--spacing-md)" }}>
      <div style={{ flex: "999 1 420px", minWidth: 0 }}>
      <div style={{ height: 460, border: "1px solid var(--color-border)", borderRadius: "var(--radius-lg)", background: "var(--color-neutral)" }}>
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
            zoomable
            ariaLabel="科技树小地图"
            style={{ width: 128, height: 84, background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)" }}
            nodeColor={(n) => ((n.data as TreeNodeData).unlocked ? "var(--color-success)" : "var(--color-text-dim)")}
          />
        </ReactFlow>
      </div>
      <TreeLegend />
      </div>
      <aside
        style={{
          flex: "1 1 280px",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          background: "var(--color-surface)",
          padding: "var(--spacing-md)",
          alignSelf: "flex-start",
        }}
      >
        <h2 style={{ marginTop: 0, marginBottom: selected ? 4 : undefined }}>
          {selected ? tree.nodes.find((n) => n.key === selected)?.name || selected : "点击节点"}
        </h2>
        {selected && <p className="dim" style={{ marginTop: 0, fontFamily: "var(--font-mono)" }}>{selected}</p>}
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
