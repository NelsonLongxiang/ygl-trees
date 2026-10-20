/**
 * DESIGN.md is the single source of truth for the visual identity.
 * This module maps those tokens onto the antd ConfigProvider theme (per
 * theme) and exposes CSS-var references for inline styles. Do not hand-edit
 * the hex values: they must stay in sync with DESIGN.md (colors: = dark,
 * colors-light: = light) and src/tokens.css — the drift guard is
 * apps/web/tests/tokens.spec.ts, which parses DESIGN.md and fails on any
 * divergence. Change the palette in DESIGN.md first, then mirror here.
 */
import { theme as antdTheme, type ThemeConfig } from "antd";

export type ThemeName = "dark" | "light";

// DESIGN.md colors.* — mirrored, guarded by tokens.spec.ts
export const DARK = {
  primary: "#58a6ff", // the sole interaction driver: links, focus, selected
  secondary: "#8b949e", // metadata, captions, secondary text
  tertiary: "#79c0ff", // section headings, executable command lines
  neutral: "#0d1117", // page background
  surface: "#161b22", // cards, panels, claims
  "surface-hover": "#1c2129", // hover state on interactive rows
  border: "#30363d", // hairlines, chips, node strokes
  "border-dim": "#21262d", // table rules, dividers, canvas dots
  text: "#c9d1d9", // primary text on surface
  "text-dim": "#484f58", // de-emphasized footer text
  success: "#3fb950", // supported / pass / unlockable
  danger: "#f85149", // refuted / fail / excludes edges
  warning: "#d29922", // contested / pending-adjacent emphasis
} as const;

// DESIGN.md colors-light.* — same keys, same roles
export const LIGHT = {
  primary: "#0969da",
  secondary: "#59636e",
  tertiary: "#0550ae",
  neutral: "#f6f8fa",
  surface: "#ffffff",
  "surface-hover": "#eff2f5",
  border: "#d0d7de",
  "border-dim": "#d8dee4",
  text: "#1f2328",
  "text-dim": "#636c76",
  success: "#1a7f37",
  danger: "#d1242f",
  warning: "#8a5c00",
} as const;

export type ColorKey = keyof typeof DARK;
export const PALETTES: Record<ThemeName, Record<ColorKey, string>> = { dark: DARK, light: LIGHT };

/**
 * Inline-style colors: CSS var references, so every view follows the theme
 * switch without re-rendering. Use C.* in style props; use PALETTES only where
 * a library needs a literal (antd's algorithm derives shades from hex).
 */
export const C = Object.fromEntries(
  (Object.keys(DARK) as ColorKey[]).map((k) => [k, `var(--color-${k})`])
) as Record<ColorKey, string>;

const FONT_SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// antd theme token mapping (DESIGN.md → ConfigProvider), both themes
export function themeConfig(name: ThemeName): ThemeConfig {
  const p = PALETTES[name];
  return {
    algorithm: name === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: p.primary,
      colorSuccess: p.success,
      colorWarning: p.warning,
      colorError: p.danger,
      colorInfo: p.tertiary, // info accents use the tertiary "executable" voice
      colorLink: p.primary,
      colorText: p.text,
      colorTextSecondary: p.secondary,
      colorBgLayout: p.neutral, // page
      colorBgContainer: p.surface, // cards, tables, inputs
      colorBgElevated: p.surface, // popovers, dropdowns
      colorBorder: p.border,
      colorBorderSecondary: p["border-dim"],
      borderRadius: 4, // DESIGN.md rounded.sm — 4px controls
      fontFamily: FONT_SANS,
      fontFamilyCode: "ui-monospace, Consolas, monospace",
    },
    components: {
      Layout: { headerBg: p.surface, bodyBg: p.neutral, headerPadding: "0 24px" },
      Card: { borderRadiusLG: 6 }, // DESIGN.md rounded.md — cards
    },
  };
}

/**
 * Stat-card icon accents. DESIGN.md: "keep the palette to the tokens above —
 * a new color needs a reason", and "Don't introduce a second accent color".
 * Icons differentiate by glyph; color only carries the semantic family:
 * claims → success (adjudication), evidence → warning (feeds contested states),
 * sources/kb_notes → secondary (metadata), the rest → tertiary (knowledge).
 */
export const statColors: Record<string, string> = {
  skills: C.tertiary,
  kb_notes: C.secondary,
  sources: C.secondary,
  evidence: C.warning,
  claims: C.success,
  trees: C.tertiary,
  nodes: C.tertiary,
};
