import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import ActivityTimeline from "../src/ActivityTimeline";
import { OverviewPage } from "../src/pages";
import { DashboardContext } from "../src/data";
import { ThemeProvider } from "../src/theme";
import type { DashboardData } from "../src/api";
import { copyText } from "../src/clipboard";
import { SERIES_NOTE } from "../src/timeline";
import { DONE_CONFIRM, TaskList, groupTasks, shownStatus, stepOutcome, stepTarget } from "../src/Tasks";

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

  it("defaults to 31 UTC days (today + the server's 30 days back) and names each bucket's scope", () => {
    const d = renderToStaticMarkup(h(ActivityTimeline, { timeline, today }));
    expect((d.match(/<title[ >]/g) ?? []).length).toBe(32); // chart title + 31 day columns
    expect(d).toContain("今天 + 前 30 天的活动，按 UTC 日");
    expect(d).toContain(`title="${SERIES_NOTE.eval}"`); // legend item
    expect(SERIES_NOTE.eval).toContain("eval.*");
    expect(SERIES_NOTE.research).toContain("claim.eval");
    const t = renderToStaticMarkup(h(ActivityTimeline, { timeline, today, defaultView: "table" }));
    expect(t).toContain(`title="${SERIES_NOTE.research}"`); // column header
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

  it("shows the activity timeline (labelled workspace-wide, UTC days) and the task list", () => {
    expect(html).toContain("活动时间线");
    expect(html).toContain("今天 + 前 30 天 · 每天事件数 · 全工作区 · UTC 日");
    expect(html).toContain("整理证据");
    expect(html).toContain("已证实断言");
  });

  it("hides the workspace-wide timeline while no project is selected (R16.4 / R19)", () => {
    const unselected = { ...data, brief: { ...data.brief, project: undefined }, unselected: { reason: "no project selected", projects: [{ name: "a" }] } } as unknown as DashboardData;
    const u = renderToStaticMarkup(
      h(ThemeProvider, null,
        h(DashboardContext.Provider, { value: { data: unselected, error: null } },
          h(MemoryRouter, null, h(OverviewPage))))
    );
    expect(u).toContain("未选择项目");
    expect(u).not.toContain("活动时间线");
  });
});

describe("TaskList (R12.2 勾销)", () => {
  const tasks = [
    { id: "a", title: "旧的已完成", status: "done" },
    { id: "b", title: "写报告", status: "todo" },
    { id: "c", title: "核对证据", status: "doing" },
    { id: "d", title: "整理来源", status: "todo" },
  ];
  const html = renderToStaticMarkup(h(ThemeProvider, null, h(TaskList, { tasks })));
  const text = html.replace(/<[^>]+>/g, " ");

  it("open work first: doing, then todo, then done, newest-first inside each group", () => {
    expect(groupTasks(tasks).map((t) => t.id)).toEqual(["c", "b", "d", "a"]);
    const at = (s: string) => text.indexOf(s);
    expect(at("核对证据")).toBeLessThan(at("写报告"));
    expect(at("写报告")).toBeLessThan(at("整理来源"));
    expect(at("整理来源")).toBeLessThan(at("旧的已完成"));
  });

  it("each open task has exactly one forward step; done has none", () => {
    expect(html).toContain('aria-label="开始：写报告"');
    expect(html).toContain('aria-label="开始：整理来源"');
    expect(html).toContain('aria-label="完成：核对证据"');
    expect(html).not.toMatch(/aria-label="[^"]*：旧的已完成"/);
    expect(html).not.toMatch(/退回|撤销|重新打开/);
  });

  it("counts every status above the table", () => {
    expect(text).toContain("待办 2 · 进行中 1 · 已完成 1");
  });

  it("a step this page wrote shows only over the payload it was written against", () => {
    const seen = [{ id: "b", title: "写报告", status: "todo" }];
    expect(shownStatus("todo", seen, { to: "doing", seen })).toBe("doing");
    expect(shownStatus("weird", seen)).toBe("todo");
  });

  it("any newer payload is the server's word — a CLI step back wins over the page's step (review of ee1af12, #66)", () => {
    const seen = [{ id: "b", title: "写报告", status: "todo" }];
    const written = { to: "doing" as const, seen };
    // page wrote todo → doing, then the CLI ran `task todo`: the next push says todo and must show todo,
    // so the row offers 开始 again instead of 完成 (which would send "doing" and overwrite the reset)
    expect(shownStatus("todo", [{ ...seen[0] }], written)).toBe("todo");
    expect(shownStatus("doing", [{ ...seen[0], status: "doing" }], written)).toBe("doing");
    expect(shownStatus("done", [{ ...seen[0], status: "done" }], written)).toBe("done");
  });

  it("each button asks for the next status — the request body's status is the target (#70)", () => {
    expect(stepTarget("todo")).toBe("doing");
    expect(stepTarget("doing")).toBe("done");
    expect(stepTarget("done")).toBeNull();
  });

  it("a receipt that moved nothing is not reported as a success (0.114.29 idempotent, review of e879e43)", () => {
    const same = stepOutcome("写报告", { id: "b", from: "doing", to: "doing", idempotent: true });
    expect(same.changed).toBe(false);
    expect(same.text).toContain("没有改动");
    expect(same.text).not.toContain("→");
    expect(stepOutcome("写报告", { id: "b", from: "todo", to: "todo" }).changed).toBe(false);
    expect(stepOutcome("写报告", { id: "b", from: "todo", to: "doing" })).toEqual({ changed: true, text: "「写报告」待办 → 进行中" });
  });

  it("the confirm tells the truth: no step back on the page, the CLI can (review of ee1af12)", () => {
    expect(DONE_CONFIRM.description).toContain("总览里不能退回");
    expect(DONE_CONFIRM.description).toContain("task todo");
  });
});

describe("copyText (review of 314e64b): 已复制 only when the clipboard really took it", () => {
  it("async clipboard success → true", async () => {
    expect(await copyText("x", { clipboard: { writeText: async () => {} } })).toBe(true);
  });
  it("no clipboard (insecure context) → the legacy result decides", async () => {
    expect(await copyText("x", { clipboard: null, exec: () => false })).toBe(false);
    expect(await copyText("x", { clipboard: null, exec: () => true })).toBe(true);
  });
  it("a throwing legacy path is a failure, not an unhandled rejection", async () => {
    await expect(copyText("x", { clipboard: null, exec: () => { throw new Error("denied"); } })).resolves.toBe(false);
  });
  it("a rejected clipboard falls back to the legacy path", async () => {
    expect(await copyText("x", { clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } }, exec: () => true })).toBe(true);
  });
  it("nothing available → false", async () => {
    expect(await copyText("x", { clipboard: null })).toBe(false);
  });
});
