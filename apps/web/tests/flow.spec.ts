import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import { mergeLayout } from "../src/flow";

/**
 * Controlled canvas nodes: a live payload recomputes the layout, but what the
 * user did (drag) and what xyflow measured (MiniMap needs it) must survive.
 */

const node = (id: string, x: number, extra: Partial<Node> = {}): Node => ({
  id,
  position: { x, y: 0 },
  data: { label: id },
  ...extra,
});

describe("mergeLayout", () => {
  it("keeps a dragged position and the measured size across a fresh layout", () => {
    const live = [node("a", 999, { measured: { width: 110, height: 30 } }), node("b", 180)];
    const fresh = [node("a", 0, { data: { label: "a v2" } }), node("b", 180)];
    const [a, b] = mergeLayout(live, fresh);
    expect(a.position).toEqual({ x: 999, y: 0 });
    expect(a.measured).toEqual({ width: 110, height: 30 });
    expect(a.data).toEqual({ label: "a v2" }); // payload fields still refresh
    expect(b.position).toEqual({ x: 180, y: 0 });
  });

  it("adds new nodes at their layout position and drops removed ones", () => {
    const live = [node("a", 5), node("gone", 7)];
    const out = mergeLayout(live, [node("a", 0), node("new", 360)]);
    expect(out.map((n) => n.id)).toEqual(["a", "new"]);
    expect(out[1].position).toEqual({ x: 360, y: 0 });
    expect(out[1].measured).toBeUndefined();
  });

  it("first paint (no live nodes) is the layout itself", () => {
    const fresh = [node("a", 0)];
    expect(mergeLayout([], fresh)).toEqual(fresh);
  });
});
