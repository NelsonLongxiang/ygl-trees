import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { THEME_KEY, normalizeMode, readMode, resolveTheme, ThemeProvider, ThemeToggle } from "../src/theme";
import { AppRoutes } from "../src/App";
import { DashboardContext } from "../src/data";
import type { DashboardData } from "../src/api";

/**
 * Theme switch + routed shell (review of 66d10ab): render the real provider,
 * toggle and route table with react-dom/server (no jsdom, same as the other
 * web specs), and run index.html's pre-paint script against the React resolver
 * so first paint and the first React frame can't disagree.
 */

const REPO = resolve(__dirname, "../../..");

type StoredCase = string | null | "THROW";
const storage = (v: StoredCase) => ({
  getItem: (k: string) => {
    if (v === "THROW") throw new Error("SecurityError: storage blocked");
    return k === THEME_KEY ? v : null;
  },
});

describe("theme mode resolution", () => {
  it("normalizes anything but system|light|dark to system", () => {
    expect(normalizeMode("light")).toBe("light");
    expect(normalizeMode("dark")).toBe("dark");
    for (const raw of [null, undefined, "", "auto", "DARK", 1]) expect(normalizeMode(raw)).toBe("system");
  });

  it("readMode survives a throwing or missing storage", () => {
    expect(readMode(storage("THROW"))).toBe("system");
    expect(readMode(null)).toBe("system");
    expect(readMode(storage("dark"))).toBe("dark");
  });

  it("index.html pre-paint script agrees with resolveTheme(readMode()) in every case", () => {
    const html = readFileSync(resolve(REPO, "apps/web/index.html"), "utf8");
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script, "inline pre-paint script").toBeTruthy();
    for (const stored of [null, "light", "dark", "system", "auto", "THROW"] as StoredCase[]) {
      for (const prefersDark of [true, false]) {
        const dataset: Record<string, string> = {};
        const s = storage(stored);
        vm.runInNewContext(script!, {
          localStorage: s,
          window: { matchMedia: () => ({ matches: prefersDark }) },
          document: { documentElement: { dataset } },
        });
        expect(dataset.theme, `stored=${stored} prefersDark=${prefersDark}`).toBe(resolveTheme(readMode(s), prefersDark));
      }
    }
  });
});

describe("ThemeProvider + ThemeToggle render", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("renders the toggle with its label and current mode", () => {
    const html = renderToStaticMarkup(h(ThemeProvider, null, h(ThemeToggle)));
    expect(html).toContain('aria-label="切换主题"');
    expect(html).toContain('data-mode="system"');
  });

  it("does not throw when localStorage access throws (blocked cookies / sandbox)", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        get localStorage() {
          throw new Error("SecurityError: The operation is insecure.");
        },
      },
    });
    const html = renderToStaticMarkup(h(ThemeProvider, null, h(ThemeToggle)));
    expect(html).toContain('data-mode="system"');
  });
});

const data = {
  brief: { current_project: null, counts: { claims: 3, evidence: 5 }, next_actions: ["ygl-trees agent brief"] },
  tree: null,
  claims: [],
  tasks: [],
  artifacts: [],
  timeline: [],
} as unknown as DashboardData;

const renderAt = (path: string, state: { data: DashboardData | null; error: string | null }) =>
  renderToStaticMarkup(
    h(ThemeProvider, null,
      h(DashboardContext.Provider, { value: state },
        h(MemoryRouter, { initialEntries: [path] }, h(AppRoutes))))
  );

describe("routed shell", () => {
  it("marks the current view active in the nav", () => {
    const html = renderAt("/tree", { data, error: null });
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>科技树<\/a>/);
    expect(html).not.toMatch(/<a[^>]*aria-current="page"[^>]*>概览<\/a>/);
    expect(html).toContain("切换主题");
  });

  it("overview renders stats and runnable next actions", () => {
    const html = renderAt("/", { data, error: null });
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>概览<\/a>/);
    expect(html).toContain("claims");
    expect(html).toContain("→ ygl-trees agent brief");
  });

  it("unknown paths fall back to the overview", () => {
    expect(renderAt("/nope", { data, error: null })).toContain("→ ygl-trees agent brief");
  });

  it("shows 'unreachable' before any data, and keeps later errors visible over stale data", () => {
    const cold = renderAt("/", { data: null, error: "api/data 502" });
    expect(cold).toContain("API 不可达");
    expect(cold).toContain("ygl-trees webui serve --port 8642");

    const stale = renderAt("/", { data, error: "event parse: Unexpected token" });
    expect(stale).toContain("实时更新中断");
    expect(stale).toContain("event parse: Unexpected token");
    expect(stale).not.toContain("API 不可达");
  });
});
