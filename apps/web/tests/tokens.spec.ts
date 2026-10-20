import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { theme as antdTheme } from "antd";
import { PALETTES, themeConfig } from "../src/tokens";

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
    "on-entity",
    "on-primary",
    "chart-research",
    "chart-tree",
    "chart-eval",
    "chart-other",
  ];

  it("DESIGN.md defines every color in both themes", () => {
    for (const k of colorKeys) {
      expect(designColor(k), `colors.${k}`).toMatch(/^#[0-9a-f]{6}$/);
      expect(designLight(k), `colors-light.${k}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("tokens.css declares no --color-* outside DESIGN.md (both theme blocks)", () => {
    for (const blk of [cssDark, cssLight]) {
      const names = [...blk.matchAll(/--color-([a-z-]+):/g)].map((m) => m[1]);
      for (const n of names) expect(colorKeys, `--color-${n} not in DESIGN.md`).toContain(n);
    }
  });

  it("non-color theme values in tokens.css are written down in DESIGN.md", () => {
    for (const blk of [cssDark, cssLight]) {
      for (const m of blk.matchAll(/--((?:shadow|entity)-[a-z-]+):\s*([^;]+);/g)) {
        expect(design, `--${m[1]}: ${m[2]} missing from DESIGN.md`).toContain(m[2].trim());
      }
    }
  });

  it("tokens.css stays in sync with DESIGN.md (all colors × dark/light)", () => {
    for (const k of colorKeys) {
      expect(cssVar(k), `dark --color-${k}`).toBe(designColor(k));
      expect(cssVarIn(cssLight, k), `light --color-${k}`).toBe(designLight(k));
    }
  });

  it("tokens.ts DARK/LIGHT palettes mirror DESIGN.md (all colors × dark/light)", () => {
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

  it("KnowledgeGraph type fills match the server's dark colour map type for type", () => {
    // webui.ts still ships a dark hex per entity (snapshot.json contract); the
    // client themes by type instead — the two maps must name the same token.
    const server = readFileSync(resolve(REPO, "packages/ops/tools/src/webui.ts"), "utf8");
    const sMap = /const colors: Record<string, string> = \{([\s\S]*?)\};/.exec(server)?.[1] ?? "";
    const serverHex = Object.fromEntries([...sMap.matchAll(/(\w+):\s*"(#[0-9a-f]{6})"/g)].map((m) => [m[1], m[2]]));
    const kg = readFileSync(resolve(REPO, "apps/web/src/KnowledgeGraph.tsx"), "utf8");
    const cMap = /const typeFill: Record<string, string> = \{([\s\S]*?)\};/.exec(kg)?.[1] ?? "";
    const clientKey = Object.fromEntries([...cMap.matchAll(/(\w+):\s*C\.(\w+)/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(clientKey).sort()).toEqual(Object.keys(serverHex).sort());
    expect(Object.keys(serverHex).length).toBeGreaterThan(0);
    for (const [type, key] of Object.entries(clientKey)) {
      expect(designColor(key), `${type}: client ${key} vs server ${serverHex[type]}`).toBe(serverHex[type]);
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

/**
 * S1 (verifier, b735565 → 3f83e69): a solid primary button in dark rendered
 * white on antd's derived #4e90dc at 3.31:1. Check the RENDERED fills — what
 * antd derives from our seeds, plus the Button overrides — never the seed hex.
 */
describe("solid control text: on-primary ≥ 4.5:1 on every primary / danger button state, both themes", () => {
  const norm = (h: string) => (h.length === 4 ? "#" + [...h.slice(1)].map((c) => c + c).join("") : h).toLowerCase();
  const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (h: string) => { const n = norm(h).slice(1); const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
  const ratio = (a: string, b: string) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const STATES = ["colorPrimary", "colorPrimaryHover", "colorPrimaryActive", "colorError", "colorErrorHover", "colorErrorActive"] as const;

  for (const name of ["dark", "light"] as const) {
    it(`${name}: text on solid fills and the tooltip`, () => {
      const cfg = themeConfig(name);
      const t = antdTheme.getDesignToken(cfg) as unknown as Record<string, string>;
      const button = (cfg.components?.Button ?? {}) as Record<string, string>;
      const ink = PALETTES[name]["on-primary"];
      for (const k of ["primaryColor", "dangerColor", "solidTextColor"]) expect(norm(button[k]), `${name} Button.${k}`).toBe(ink);
      expect(norm(t.colorTextLightSolid)).toBe("#ffffff"); // the global stays white: tooltips and badges share it
      for (const k of STATES) {
        const fill = button[k] ?? t[k];
        expect(ratio(ink, fill), `${name} ${k} ${fill} vs ${ink}`).toBeGreaterThanOrEqual(4.5);
      }
      // the tooltip's text on its spotlight ground (light: rgba(0,0,0,.85) over white ≈ #262626)
      const tip = ((cfg.components?.Tooltip ?? {}) as Record<string, string>).colorTextLightSolid ?? t.colorTextLightSolid;
      const spot = t.colorBgSpotlight.startsWith("#") ? t.colorBgSpotlight : "#262626";
      expect(ratio(tip, spot), `${name} tooltip ${tip} on ${spot}`).toBeGreaterThanOrEqual(4.5);
      // checked boxes stay non-text 3:1: antd's white check on the derived primary
      expect(ratio("#ffffff", t.colorPrimary)).toBeGreaterThanOrEqual(3);
    });
  }
});
