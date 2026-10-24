import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { TreeLegend, TreeNode, treeGraph } from "../src/TreeFlow";
import type { TreeData } from "../src/api";
import { treeExtra } from "../src/pages";

/**
 * Tree view legibility: a node reads as the expert names it, says its state in
 * words and an icon (never color alone), and the header says how far along the
 * tree is. Static render, no jsdom — same as the other web specs.
 */

const node = (data: Record<string, unknown>) =>
  renderToStaticMarkup(h(ReactFlowProvider, null, h(TreeNode as any, { id: "n", data, type: "treeNode", selected: false, dragging: false, zIndex: 0, isConnectable: false, positionAbsoluteX: 0, positionAbsoluteY: 0 })));

describe("TreeNode", () => {
  it("leads with the node's name, keeps the key underneath", () => {
    const html = node({ name: "路由外壳（hash 路由 + 全局订阅）", nodeKey: "router-shell", unlocked: true });
    expect(html).toContain("路由外壳（hash 路由 + 全局订阅）");
    expect(html).toContain(">router-shell<");
    expect(html.indexOf("路由外壳")).toBeLessThan(html.indexOf(">router-shell<"));
  });

  it("shows its state as an icon, with the words on hover — not color alone", () => {
    const open = node({ name: "设计系统", nodeKey: "design-system", unlocked: true });
    const shut = node({ name: "产出工件 PDF", nodeKey: "artifacts-pdf", unlocked: false });
    expect(open).toContain("anticon-check-circle");
    expect(shut).toContain("anticon-lock");
    expect(shut).toContain("（artifacts-pdf）· 未解锁"); // full name + key on hover when the name is cut
  });

  it("puts no name on the inner card: a generic div may not carry one (ARIA 1.2)", () => {
    const html = node({ name: "设计系统", nodeKey: "design-system", unlocked: true });
    expect(html).not.toMatch(/<div[^>]*aria-label/); // icons keep their own role="img" labels
    expect(html).not.toMatch(/aria-label="[^"]*设计系统/);
  });
});

describe("treeGraph (review of b6d8a74)", () => {
  const tree = {
    name: "webui",
    nodes: [
      { key: "design-system", name: "设计系统", kind: "tech", tier: 0, cost: 0, tags: "", created: "", unlocked_at: "2026-10-20" },
      { key: "artifacts-pdf", name: "", kind: "tech", tier: 1, cost: 0, tags: "", created: "", unlocked_at: null },
    ],
    edges: [{ parent: "design-system", child: "artifacts-pdf", rel: "prereq", mode: "AND", required: 0 }],
  } as TreeData;

  it("names every node for screen readers by its name and state — xyflow reads node.ariaLabel on focus", () => {
    const { layout } = treeGraph(tree);
    expect(layout.map((n) => n.ariaLabel)).toEqual(["设计系统 · 已解锁", "artifacts-pdf · 未解锁"]); // no name → key
  });

  it("an optional prerequisite is drawn dashed", () => {
    expect(treeGraph(tree).edges[0].style?.strokeDasharray).toBe("5 4");
  });
});

describe("tree header and legend", () => {
  it("the header names the tree and its progress", () => {
    const tree = { name: "webui", nodes: [{ unlocked_at: "2026-10-20" }, { unlocked_at: null }, { unlocked_at: "2026-10-21" }] };
    expect(treeExtra(tree)).toBe("webui · 已解锁 2 / 3 节点");
  });

  it("the legend explains both state icons and both edge kinds", () => {
    const html = renderToStaticMarkup(h(TreeLegend));
    for (const t of ["已解锁", "未解锁", "必检前置", "可选前置"]) expect(html).toContain(t);
    expect(html).toContain('stroke-dasharray="5 4"');
  });
});
