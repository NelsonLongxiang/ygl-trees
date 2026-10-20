import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import ActivityTimeline from "../src/ActivityTimeline";
import { OverviewPage } from "../src/pages";
import { DashboardContext } from "../src/data";
import { ThemeProvider } from "../src/theme";
import type { DashboardData } from "../src/api";

/**
 * Overview = the expert ↔ agent cockpit (user direction 2026-10-20: UI
 * interaction + sensible visualisation). Static render, no jsdom — same as the
 * other web specs.
 */

const today = new Date("2026-10-20T12:00:00Z");
const timeline = [
  { day: "2026-10-18", research: 3, tree: 1, eval: 0, other: 2 }, // peak, total 6
  { day: "2026-10-20", research: 1, tree: 0, eval: 4, other: 0 }, // latest, total 5
];

describe("ActivityTimeline", () => {
  const html = renderToStaticMarkup(h(ActivityTimeline, { timeline, days: 7, today }));

  it("legend names every series; the svg and every day column carry a text label", () => {
    for (const l of ["研究", "判定", "科技树", "其他"]) expect(html).toContain(l);
    expect(html).toContain('role="img"');
    expect((html.match(/<title[ >]/g) ?? []).length).toBe(8); // chart title (with id) + 7 day columns
    expect(html).toContain("10-20：共 5 件 · 研究 1 · 判定 4 · 科技树 0 · 其他 0");
  });

  it("marks wear chart tokens, text wears text tokens; direct labels only on the peak and latest day", () => {
    expect(html).toMatch(/style="fill:var\(--color-chart-research\)"/);
    expect(html).toMatch(/style="fill:var\(--color-chart-other\)"/); // 其他 = de-emphasis gray
    expect(html).not.toMatch(/<text[^>]*var\(--color-chart/);
    expect((html.match(/class="yt-tl-label"/g) ?? []).length).toBe(2);
    expect(html).toContain(">6</text>");
    expect(html).toContain(">5</text>");
  });

  it("table view holds the same numbers without hovering", () => {
    const t = renderToStaticMarkup(h(ActivityTimeline, { timeline, days: 7, today, defaultView: "table" }));
    expect(t).toContain("合计");
    expect(t).toContain("2026-10-18");
    expect(t).not.toContain('class="yt-tl"');
  });

  it("an empty strip explains what fills it", () => {
    const e = renderToStaticMarkup(h(ActivityTimeline, { timeline: [], days: 7, today }));
    expect(e).toContain("没有记录到活动");
    expect(e.replace(/<[^>]+>/g, "").length).toBeGreaterThanOrEqual(20);
    expect(e).not.toContain('class="yt-tl"'); // antd's Empty illustration is an svg too — only the chart counts
  });
});

describe("OverviewPage", () => {
  const data = {
    brief: {
      current_project: "p",
      counts: { claims: 3, trees: 1, nodes: 5 },
      next_actions: ["ygl-trees agent brief", "ygl-trees node index --tree demo"],
      project: { name: "p", question: null, sources: 1, evidence: 2, claims: 3, verified_claims: 1, artifacts: 0 },
    },
    tree: null,
    claims: [],
    tasks: [{ id: "t1", title: "整理证据", status: "todo" }],
    artifacts: [],
    timeline,
  } as unknown as DashboardData;

  const html = renderToStaticMarkup(
    h(ThemeProvider, null,
      h(DashboardContext.Provider, { value: { data, error: null } },
        h(MemoryRouter, null, h(OverviewPage))))
  );

  it("lays the cockpit out on the CSS grid with stat tiles linking to their views", () => {
    expect(html).toContain('class="yt-overview"');
    expect(html).toContain('href="/pipeline"');
    expect(html).toContain('href="/tree"');
    expect(html).toContain('href="/graph"');
  });

  it("next actions are copyable agent commands, never executed from the page", () => {
    expect(html).toContain('aria-label="复制命令：ygl-trees agent brief"');
    expect(html).toContain("→ ygl-trees node index --tree demo");
    const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
    expect(buttons.some((t) => /执行|运行/.test(t))).toBe(false);
    expect(buttons.filter((t) => t.includes("复制")).length).toBe(2);
  });

  it("shows the activity timeline and the task list", () => {
    expect(html).toContain("最近 30 天活动");
    expect(html).toContain("整理证据");
    expect(html).toContain("已证实断言");
  });
});
