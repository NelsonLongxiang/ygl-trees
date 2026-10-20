import { describe, it, expect } from "vitest";
import type { Node, NodeChange, XYPosition } from "@xyflow/react";
import { mergeLayout, recordMoves, type Pins } from "../src/flow";

/**
 * Controlled canvas nodes: a live payload recomputes the layout and nodes
 * follow it — only what the user moved stays put; what xyflow measured
 * (MiniMap needs it) survives for every node.
 */

const node = (id: string, y: number, extra: Partial<Node> = {}): Node => ({
  id,
  position: { x: 0, y },
  data: { label: id },
  ...extra,
});
const ys = (ns: Node[]) => Object.fromEntries(ns.map((n) => [n.id, n.position.y]));
const noPins: ReadonlyMap<string, XYPosition> = new Map();

describe("mergeLayout", () => {
  it("unmoved nodes follow a re-spread tier (review of 30372f7: a must not stay on top of b)", () => {
    const live = [node("a", 0, { measured: { width: 90, height: 32 } })];
    const fresh = [node("a", -110), node("b", 0), node("c", 110)];
    const out = mergeLayout(live, fresh, noPins);
    expect(ys(out)).toEqual({ a: -110, b: 0, c: 110 });
    expect(out[0].measured).toEqual({ width: 90, height: 32 }); // size still kept
  });

  it("a moved (pinned) node keeps where it was dropped while the rest re-spread", () => {
    const live = [node("a", 0), node("b", 0)];
    const pins = new Map([["b", { x: 40, y: 300 }]]);
    const out = mergeLayout(live, [node("a", -110), node("b", 0), node("c", 110)], pins);
    expect(out.find((n) => n.id === "a")!.position).toEqual({ x: 0, y: -110 });
    expect(out.find((n) => n.id === "b")!.position).toEqual({ x: 40, y: 300 });
    expect(out.find((n) => n.id === "c")!.position).toEqual({ x: 0, y: 110 });
  });

  it("payload fields refresh, removed nodes drop, new nodes arrive unmeasured", () => {
    const live = [node("a", 0, { measured: { width: 1, height: 1 } }), node("gone", 7)];
    const out = mergeLayout(live, [node("a", 0, { data: { label: "a v2" } }), node("new", 360)], noPins);
    expect(out.map((n) => n.id)).toEqual(["a", "new"]);
    expect(out[0].data).toEqual({ label: "a v2" });
    expect(out[1].measured).toBeUndefined();
  });

  it("first paint (nothing live, nothing pinned) is the layout itself", () => {
    const fresh = [node("a", 0)];
    expect(mergeLayout([], fresh, noPins)).toEqual(fresh);
  });
});

describe("recordMoves", () => {
  const move = (id: string, y: number, dragging: boolean): NodeChange => ({ id, type: "position", position: { x: 0, y }, dragging });

  it("pins only a finished move, at its final position", () => {
    const pins: Pins = new Map();
    recordMoves([move("a", 10, true), move("a", 20, true)], pins);
    expect(pins.has("a")).toBe(false); // in-flight drag frames don't pin
    recordMoves([move("a", 30, false)], pins);
    expect(pins.get("a")).toEqual({ x: 0, y: 30 });
  });

  it("ignores selection and dimension changes", () => {
    const pins: Pins = new Map();
    recordMoves(
      [
        { id: "a", type: "select", selected: true },
        { id: "a", type: "dimensions", dimensions: { width: 90, height: 32 } },
      ] as NodeChange[],
      pins
    );
    expect(pins.size).toBe(0);
  });
});
