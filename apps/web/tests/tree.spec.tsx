import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { TreeLegend, TreeNode } from "../src/TreeFlow";
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

  it("says its state in words and an icon, not color alone", () => {
    const open = node({ name: "设计系统", nodeKey: "design-system", unlocked: true });
    const shut = node({ name: "产出工件 PDF", nodeKey: "artifacts-pdf", unlocked: false });
    expect(open).toContain('aria-label="设计系统，已解锁"');
    expect(open).toContain("anticon-check-circle");
    expect(shut).toContain('aria-label="产出工件 PDF，未解锁"');
    expect(shut).toContain("anticon-lock");
    expect(shut).toContain("（artifacts-pdf）· 未解锁"); // full name + key on hover when the name is cut
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
