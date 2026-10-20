/**
 * Controlled xyflow nodes for the tree and graph canvases. The layout is
 * recomputed on every live payload, but the canvas owns what the user did:
 * a node they dragged keeps its position, and every node keeps the size
 * xyflow measured (the MiniMap skips nodes without one). Without
 * onNodesChange neither ever reached the node list — drags snapped back and
 * the MiniMap drew nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { applyNodeChanges, type Node, type OnNodesChange } from "@xyflow/react";

/** Fresh layout in, live state kept: same id → previous position + measured size. */
export function mergeLayout<N extends Node>(prev: N[], next: N[]): N[] {
  const live = new Map(prev.map((n) => [n.id, n]));
  return next.map((n) => {
    const p = live.get(n.id);
    return p ? { ...n, position: p.position, measured: p.measured } : n;
  });
}

// Canvas state outlives the component: switching views unmounts the canvas,
// and coming back must not undo the user's drags. Page-session only.
const remembered = new Map<string, Node[]>();

/**
 * Nodes for <ReactFlow nodes onNodesChange>. `canvasKey` names the canvas
 * (e.g. "tree:<name>"): another key starts from that canvas's own state — or
 * the bare layout — instead of merging into the previous canvas. The memory is
 * written where the nodes are, so a key never stores another canvas's nodes.
 */
export function useLayoutNodes<N extends Node>(layout: N[], canvasKey: string): [N[], OnNodesChange<N>] {
  const recall = (key: string) => (remembered.get(key) ?? []) as N[];
  const [nodes, setNodes] = useState<N[]>(() => mergeLayout(recall(canvasKey), layout));
  const lastKey = useRef(canvasKey);

  useEffect(() => {
    const from = lastKey.current === canvasKey ? null : recall(canvasKey);
    lastKey.current = canvasKey;
    setNodes((prev) => {
      const next = mergeLayout(from ?? prev, layout);
      remembered.set(canvasKey, next);
      return next;
    });
  }, [layout, canvasKey]);

  const onNodesChange: OnNodesChange<N> = useCallback(
    (changes) =>
      setNodes((prev) => {
        const next = applyNodeChanges(changes, prev);
        remembered.set(canvasKey, next);
        return next;
      }),
    [canvasKey]
  );

  return [nodes, onNodesChange];
}
