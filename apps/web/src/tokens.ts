/**
 * DESIGN.md is the single source of truth for the visual identity.
 * This module maps those tokens onto the antd ConfigProvider theme and the
 * stat-card accents. Do not hand-edit the hex values: they must stay in sync
 * with DESIGN.md (colors:) and src/tokens.css — the drift guard is
 * apps/web/tests/tokens.spec.ts, which parses DESIGN.md and fails on any
 * divergence. Change the palette in DESIGN.md first, then mirror here.
 */

// DESIGN.md colors.* — mirrored, guarded by tokens.spec.ts
export const C = {
  primary: "#58a6ff", // the sole interaction driver: links, focus, selected
  secondary: "#8b949e", // metadata, captions, secondary text
  tertiary: "#79c0ff", // section headings, executable command lines
  neutral: "#0d1117", // page background
  surface: "#161b22", // cards, panels, claims
  border: "#30363d", // hairlines, chips, node strokes
  "border-dim": "#21262d", // table rules, dividers, canvas dots
  success: "#3fb950", // supported / pass / unlockable
  danger: "#f85149", // refuted / fail / excludes edges
  warning: "#d29922", // contested / pending-adjacent emphasis
} as const;

// antd theme token mapping (DESIGN.md → ConfigProvider)
export const themeTokens = {
  colorPrimary: C.primary,
  colorSuccess: C.success,
  colorWarning: C.warning,
  colorInfo: C.tertiary, // info accents use the tertiary "executable" voice
  borderRadius: 4, // DESIGN.md rounded.sm — 4px controls
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
} as const;

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
