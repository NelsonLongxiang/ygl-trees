import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 单B (direct-0f20e882, 0.92): visual token single-sourcing.
 * DESIGN.md is the source of truth; tokens.css (CSS vars) and tokens.ts
 * (antd theme + stat accents) are the two consumption faces. This drift
 * guard parses DESIGN.md's frontmatter and fails when either face diverges,
 * so the palette can only change by changing DESIGN.md first.
 */

const REPO = resolve(__dirname, "../../.."); // tests → web → apps → repo
const design = readFileSync(resolve(REPO, "DESIGN.md"), "utf8");
const css = readFileSync(resolve(REPO, "apps/web/src/tokens.css"), "utf8");
const ts = readFileSync(resolve(REPO, "apps/web/src/tokens.ts"), "utf8");

// frontmatter ends at the first line that is exactly "---" after line 1
const fmEnd = design.indexOf("\n---\n", 4);
const fm = design.slice(0, fmEnd);

// colors: (dark) and colors-light: (light) are sibling top-level maps; slice each block
const block = (src: string, start: RegExp): string => {
  const m = start.exec(src);
  if (!m) return "";
  const rest = src.slice(m.index + m[0].length);
  const end = rest.search(/\n[^\s#]/); // next top-level key
  return end < 0 ? rest : rest.slice(0, end);
};
const fmDark = block(fm, /\ncolors:\n/);
const fmLight = block(fm, /\ncolors-light:\n/);

const hexIn = (src: string, name: string): string => {
  const m = src.match(new RegExp(`(?:^|\\n)\\s+${name}:\\s*"(#[0-9a-f]{6})"`));
  return m ? m[1].toLowerCase() : "";
};
const designColor = (name: string): string => hexIn(fmDark, name);
const designLight = (name: string): string => hexIn(fmLight, name);

// tokens.css: :root/[data-theme="dark"] block, then [data-theme="light"] block
const cssDark = block(css, /\[data-theme="dark"\] \{/);
const cssLight = block(css, /\[data-theme="light"\] \{/);
const cssVarIn = (src: string, name: string): string => {
  const m = src.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`));
  return m ? m[1].toLowerCase() : "";
};
const cssVar = (name: string): string => cssVarIn(cssDark, name);

// tokens.ts: DARK = { … } and LIGHT = { … } literal maps
const tsMap = (name: string): string => {
  const m = new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\} as const`).exec(ts);
  return m ? m[1] : "";
};
const tsHex = (src: string, key: string): string => {
  const m = src.match(new RegExp(`"?${key}"?:\\s*"(#[0-9a-f]{6})"`));
  return m ? m[1].toLowerCase() : "";
};

describe("0.92 visual token single-source (单B drift guard)", () => {
  const colorKeys = [
    "primary",
    "secondary",
    "tertiary",
    "neutral",
    "surface",
    "surface-hover",
    "border",
    "border-dim",
    "text",
    "text-dim",
    "success",
    "danger",
    "warning",
  ];

  it("DESIGN.md defines every color in both themes", () => {
    for (const k of colorKeys) {
      expect(designColor(k), `colors.${k}`).toMatch(/^#[0-9a-f]{6}$/);
      expect(designLight(k), `colors-light.${k}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("tokens.css stays in sync with DESIGN.md (all 13 colors × dark/light)", () => {
    for (const k of colorKeys) {
      expect(cssVar(k), `dark --color-${k}`).toBe(designColor(k));
      expect(cssVarIn(cssLight, k), `light --color-${k}`).toBe(designLight(k));
    }
  });

  it("tokens.ts DARK/LIGHT palettes mirror DESIGN.md (all 13 colors × dark/light)", () => {
    const dark = tsMap("DARK"), light = tsMap("LIGHT");
    for (const k of colorKeys) {
      expect(tsHex(dark, k), `DARK.${k}`).toBe(designColor(k));
      expect(tsHex(light, k), `LIGHT.${k}`).toBe(designLight(k));
    }
  });

  it("tokens.ts antd theme maps DESIGN.md roles in both themes", () => {
    expect(ts).toContain("colorPrimary: p.primary");
    expect(ts).toContain("colorSuccess: p.success");
    expect(ts).toContain("colorWarning: p.warning");
    expect(ts).toContain("colorError: p.danger");
    expect(ts).toContain("colorInfo: p.tertiary");
    expect(ts).toContain("colorBgLayout: p.neutral");
    expect(ts).toContain("colorBgContainer: p.surface");
    expect(ts).toContain("darkAlgorithm");
    expect(ts).toContain("defaultAlgorithm");
    expect(ts).toContain("borderRadius: 4"); // DESIGN.md rounded.sm — controls
  });

  it("index.html pre-paint script and theme.tsx share the storage key", () => {
    const html = readFileSync(resolve(REPO, "apps/web/index.html"), "utf8");
    const theme = readFileSync(resolve(REPO, "apps/web/src/theme.tsx"), "utf8");
    expect(html).toContain(`localStorage.getItem("ygl-theme")`);
    expect(theme).toContain(`THEME_KEY = "ygl-theme"`);
  });

  it("tokens.ts fontFamily matches DESIGN.md typography voice", () => {
    expect(ts).toContain("-apple-system, BlinkMacSystemFont");
  });

  it("App.tsx has no raw hex color left (palette lives in tokens.ts only)", () => {
    const app = readFileSync(resolve(REPO, "apps/web/src/App.tsx"), "utf8");
    const hexes = app.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(hexes, `raw hex in App.tsx: ${hexes.join(", ")}`).toEqual([]);
  });

  it("KnowledgeGraph.tsx: every hex is a DESIGN.md token", () => {
    const src = readFileSync(resolve(REPO, "apps/web/src/KnowledgeGraph.tsx"), "utf8");
    const tokenSet = new Set(colorKeys.map(designColor));
    const hexes = src.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    for (const h of hexes) {
      expect(tokenSet.has(h.toLowerCase()), `non-token hex ${h} in KnowledgeGraph.tsx`).toBe(true);
    }
  });

  it("webui.ts server-side KG palette uses DESIGN.md tokens only", () => {
    const src = readFileSync(resolve(REPO, "packages/ops/tools/src/webui.ts"), "utf8");
    const tokenSet = new Set(colorKeys.map(designColor));
    const hexes = src.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    for (const h of hexes) {
      expect(tokenSet.has(h.toLowerCase()), `non-token hex ${h} in webui.ts`).toBe(true);
    }
  });

  it("statColors uses only DESIGN.md token values (as theme-following CSS vars)", () => {
    const values = [...ts.matchAll(/:\s*C\.(\w+)/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(colorKeys.includes(v), `statColor ${v} not a DESIGN.md color`).toBe(true);
    }
  });
});
