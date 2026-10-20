/**
 * Controlled xyflow nodes for the tree and graph canvases. The layout is
 * recomputed on every live payload and nodes follow it — except the ones the
 * user moved: a finished drag (or keyboard move) pins that node where it was
 * dropped. Every node keeps the size xyflow measured (the MiniMap skips nodes
 * without one). Without onNodesChange neither ever reached the node list —
 * drags snapped back and the MiniMap drew nothing.
 */
import { useCallback, useState } from "react";
import { applyNodeChanges, type Node, type NodeChange, type OnNodesChange, type XYPosition } from "@xyflow/react";

export type Pins = Map<string, XYPosition>;

/**
 * Fresh layout in: pinned ids take their pinned position, every other node
 * takes the layout's (so a tier that grows re-spreads), and any node already on
 * the canvas keeps its measured size.
 */
export function mergeLayout<N extends Node>(prev: N[], next: N[], pins: ReadonlyMap<string, XYPosition>): N[] {
  const live = new Map(prev.map((n) => [n.id, n]));
  return next.map((n) => {
    const pin = pins.get(n.id);
    const measured = live.get(n.id)?.measured;
    if (!pin && !measured) return n;
    return { ...n, ...(pin && { position: pin }), ...(measured && { measured }) };
  });
}

/** A finished move (drag end, or a keyboard step) pins the node; in-flight drag frames don't. */
export function recordMoves<N extends Node>(changes: NodeChange<N>[], pins: Pins): void {
  for (const c of changes) {
    if (c.type === "position" && c.dragging === false && c.position) pins.set(c.id, c.position);
  }
}

// Pins outlive the component: switching views unmounts the canvas, and coming
// back must not undo the user's moves. Only moved nodes are remembered (not
// whole node lists), for this page session.
const pinsByCanvas = new Map<string, Pins>();
const pinsOf = (key: string): Pins => {
  let pins = pinsByCanvas.get(key);
  if (!pins) pinsByCanvas.set(key, (pins = new Map()));
  return pins;
};

interface CanvasState<N extends Node> {
  key: string;
  layout: N[];
  nodes: N[];
}

/**
 * Nodes for <ReactFlow nodes onNodesChange>. `canvasKey` names the canvas (e.g.
 * "tree:<name>"). A new key or a new layout is folded in during render, not in
 * an effect, so the first frame of another tree is that tree — never a flash of
 * the previous canvas.
 */
export function useLayoutNodes<N extends Node>(layout: N[], canvasKey: string): [N[], OnNodesChange<N>] {
  const [state, setState] = useState<CanvasState<N>>(() => ({
    key: canvasKey,
    layout,
    nodes: mergeLayout([], layout, pinsOf(canvasKey)),
  }));

  let current = state;
  if (state.key !== canvasKey || state.layout !== layout) {
    const prev = state.key === canvasKey ? state.nodes : [];
    current = { key: canvasKey, layout, nodes: mergeLayout(prev, layout, pinsOf(canvasKey)) };
    setState(current); // render-phase update: React re-renders before committing
  }

  const onNodesChange: OnNodesChange<N> = useCallback(
    (changes) => {
      recordMoves(changes, pinsOf(canvasKey));
      setState((s) => (s.key === canvasKey ? { ...s, nodes: applyNodeChanges(changes, s.nodes) } : s));
    },
    [canvasKey]
  );

  return [current.nodes, onNodesChange];
}
