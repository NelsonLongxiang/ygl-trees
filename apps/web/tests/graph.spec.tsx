import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { layoutGraph, linksOf, matchIds, resolveEntities, type GraphPayload } from "../src/graph";
import { GraphLegend } from "../src/KnowledgeGraph";

/**
 * Knowledge graph = the R9 relation fabric (tree node → asset). The old view
 * put ~100 cards on one ring; these pin the readable model: clusters per tree
 * node, titles instead of ids, done tasks out of the way, legend as filter.
 */

const g: GraphPayload = {
  nodes: [
    { id: "node:a", label: "路由外壳", type: "node" },
    { id: "node:b", label: "主题切换", type: "node" },
    { id: "claim:c1", label: "react-router 8 要求 React 19", type: "claim" },
    { id: "task:t1", label: "t1", type: "task" },
    { id: "task:t2", label: "t2", type: "task" },
    { id: "task:x9", label: "x9", type: "task" },
    { id: "source:s1", label: "s1", type: "source" },
    { id: "kb:k1", label: "孤立笔记", type: "kb" },
  ],
  edges: [
    { source: "node:a", target: "claim:c1", label: "decided-by" },
    { source: "node:a", target: "task:t1", label: "tracked-by" },
    { source: "node:b", target: "task:t2", label: "tracked-by" },
    { source: "node:b", target: "claim:c1", label: "evidenced-by" },
    { source: "node:b", target: "task:x9", label: "tracked-by" },
    { source: "node:a", target: "source:s1", label: "evidenced-by" },
  ],
};
const ctx = {
  tasks: [
    { id: "t1", title: "写报告", status: "doing" },
    { id: "t2", title: "旧任务", status: "done" },
  ],
  sources: [{ id: "s1", url: "https://example.com/doc", note: null }],
};
const all = resolveEntities(g, ctx);
const byId = (id: string) => all.find((e) => e.id === id)!;
const none = { hiddenTypes: new Set<string>(), showDoneTasks: false };

describe("resolveEntities", () => {
  it("shows task titles and source urls instead of the ids the server sends", () => {
    expect(byId("task:t1").label).toBe("写报告");
    expect(byId("source:s1").label).toBe("https://example.com/doc");
  });

  it("marks done tasks, and tasks from other projects (no title on this page, R16.4) as foreign", () => {
    expect(byId("task:t2").done).toBe(true);
    expect(byId("task:x9")).toMatchObject({ label: "x9", foreign: true });
    expect(byId("task:t1").foreign).toBeUndefined();
  });

  it("tree nodes are hubs", () => {
    expect(all.filter((e) => e.hub).map((e) => e.id)).toEqual(["node:a", "node:b"]);
  });
});

describe("layoutGraph", () => {
  it("hides done tasks by default and says how many", () => {
    const v = layoutGraph(g, all, none);
    expect(v.entities.map((e) => e.id)).not.toContain("task:t2");
    expect(v.doneTasks).toBe(1);
    expect(v.counts.task).toEqual({ total: 3, shown: 2 });
    expect(layoutGraph(g, all, { ...none, showDoneTasks: true }).entities.map((e) => e.id)).toContain("task:t2");
  });

  it("a hidden type drops its cards and their edges, never the hubs", () => {
    const v = layoutGraph(g, all, { ...none, hiddenTypes: new Set(["claim", "node"]) });
    expect(v.entities.some((e) => e.type === "claim")).toBe(false);
    expect(v.entities.filter((e) => e.hub)).toHaveLength(2);
    expect(v.edges.some((e) => e.target === "claim:c1")).toBe(false);
  });

  it("lists each asset under the first hub that links it, judgements before tasks", () => {
    const v = layoutGraph(g, all, none);
    const at = (id: string) => v.entities.find((e) => e.id === id)!;
    const a = at("node:a");
    // claim c1 sits in a's cluster (a links it first) even though b links it too
    expect(at("claim:c1").x).toBeGreaterThan(a.x);
    expect(at("claim:c1").y).toBeLessThan(at("task:t1").y);
    expect(at("source:s1").y).toBeLessThan(at("task:t1").y);
    // ...and b's link to it still draws
    expect(v.edges.some((e) => e.source === "node:b" && e.target === "claim:c1")).toBe(true);
  });

  it("cards never overlap", () => {
    const many: GraphPayload = {
      nodes: [{ id: "node:h", label: "h", type: "node" }, ...Array.from({ length: 20 }, (_, i) => ({ id: `claim:${i}`, label: `c${i}`, type: "claim" }))],
      edges: Array.from({ length: 20 }, (_, i) => ({ source: "node:h", target: `claim:${i}`, label: "decided-by" })),
    };
    const v = layoutGraph(many, resolveEntities(many), none);
    const spots = new Set(v.entities.map((e) => `${e.x},${e.y}`));
    expect(spots.size).toBe(v.entities.length);
    // a long cluster wraps into more columns instead of one tall stack
    expect(new Set(v.entities.filter((e) => !e.hub).map((e) => e.x)).size).toBeGreaterThan(1);
  });

  it("an asset no hub links still shows, in a group of its own", () => {
    expect(layoutGraph(g, all, none).entities.map((e) => e.id)).toContain("kb:k1");
  });
});

describe("focus helpers", () => {
  const v = layoutGraph(g, all, { ...none, showDoneTasks: true });

  it("linksOf lists both directions with the relation", () => {
    expect(linksOf(v.edges, "claim:c1")).toEqual([
      { other: "node:a", rel: "decided-by", dir: "in" },
      { other: "node:b", rel: "evidenced-by", dir: "in" },
    ]);
  });

  it("search matches titles case-insensitively; an empty query dims nothing", () => {
    expect([...matchIds(v.entities, "REACT")]).toEqual(["claim:c1"]);
    expect(matchIds(v.entities, "  ").size).toBe(0);
  });
});

describe("GraphLegend", () => {
  const html = renderToStaticMarkup(
    h(GraphLegend, {
      types: ["node", "claim", "task"],
      counts: { node: { total: 2, shown: 2 }, claim: { total: 1, shown: 1 }, task: { total: 3, shown: 2 } },
      hidden: new Set(["claim"]),
      onToggle: () => {},
    })
  );

  it("each asset type is a pressed / unpressed toggle with its count; hubs are not toggles", () => {
    expect(html).toContain('aria-pressed="false"'); // claim hidden
    expect(html).toContain('aria-pressed="true"'); // task shown
    expect(html).toContain("任务 2/3");
    expect((html.match(/<button/g) ?? []).length).toBe(2);
    expect(html).toContain("节点 2");
  });

  it("names the three relations by their colour", () => {
    for (const w of ["决策依据", "证据支撑", "任务跟踪"]) expect(html).toContain(w);
  });
});
