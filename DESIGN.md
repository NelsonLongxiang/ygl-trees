---
name: ygl-trees Workbench
description: >-
  Developer-console identity for an AI-agent research workbench — GitHub
  dark + light themes (switchable), one blue interaction driver, semantic status colors, monospace for
  anything executable. Zero-dependency rendering (inline CSS in a single HTML
  file) — tokens stay small and flat by design.
colors:
  primary: "#58a6ff"        # the sole interaction driver: links, focus, selected
  secondary: "#8b949e"      # metadata, captions, secondary text
  tertiary: "#79c0ff"       # section headings, executable command lines
  neutral: "#0d1117"        # page background
  surface: "#161b22"        # cards, panels, claims
  surface-hover: "#1c2129"  # hover state on interactive rows
  border: "#30363d"         # hairlines, chips, node strokes
  border-dim: "#21262d"     # table rules, dividers
  text: "#c9d1d9"           # primary text on surface
  text-dim: "#6e7681"       # non-text only (minimap node blocks, decorative fills) — never text; ≥3:1 non-text floor
  success: "#3fb950"        # supported / pass / unlockable
  danger: "#f85149"         # refuted / fail / excludes edges
  warning: "#d29922"        # contested / pending-adjacent emphasis
  on-entity: "#0d1117"      # labels on knowledge-graph entity fills (≥6.2:1 on every fill)
  on-primary: "#0d1117"     # text on solid primary / danger buttons (antd Button primaryColor / solidTextColor / dangerColor; the global colorTextLightSolid stays white): ink in dark — white was 3.3:1 on the rendered #4e90dc
  chart-research: "#b68104" # chart series · research events — warning hue stepped into the dark chart band (OKLCH L 0.64)
  chart-tree: "#4b92ce"     # chart series · tree events — tertiary hue, stepped
  chart-eval: "#28a73e"     # chart series · eval events — success hue, stepped
  chart-other: "#6e7681"    # chart series · other events — the de-emphasis gray, never a categorical hue
# Light theme — same keys, same roles; every text pair AA (see ## Themes).
colors-light:
  primary: "#0969da"
  secondary: "#59636e"
  tertiary: "#0550ae"
  neutral: "#f6f8fa"
  surface: "#ffffff"
  surface-hover: "#eff2f5"
  border: "#d0d7de"
  border-dim: "#d8dee4"
  text: "#1f2328"
  text-dim: "#636c76"
  success: "#1a7f37"
  danger: "#d1242f"
  warning: "#8a5c00"
  on-entity: "#ffffff"
  on-primary: "#ffffff"
  chart-research: "#8a5c00"
  chart-tree: "#0550ae"
  chart-eval: "#1a7f37"
  chart-other: "#7d8590"
typography:
  h1:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
    fontSize: 1.4em
    fontWeight: 700
  h2:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
    fontSize: 1.1em
    fontWeight: 700
  body-md:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
    fontSize: 0.9em
    lineHeight: 1.5
  label-caps:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
    fontSize: 0.78em
    fontWeight: 700
    letterSpacing: 0.05em
  code-md:
    fontFamily: ui-monospace, Consolas, monospace
    fontSize: 0.78em
rounded:
  sm: 4px
  md: 6px
  lg: 8px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 20px
components:
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 12px
  chip:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.text}"
    rounded: 10px
    padding: 9px
  chip-hover:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
  action-line:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.tertiary}"
    typography: "{typography.code-md}"
  claim-row:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
  claim-supported:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.success}"
  claim-refuted:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
  claim-contested:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.warning}"
  claim-unverified:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.secondary}"
  panel-close:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.secondary}"
    rounded: "{rounded.sm}"
  entity-node:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-entity}"
    rounded: "{rounded.lg}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.sm}"
---

## Overview

A developer console, not a marketing page. The identity is GitHub by
lineage, in two switchable themes (dark is the original, light its twin):
a two-depth canvas, one tier of surface cards, and **exactly one
interaction color** (primary blue). Everything an agent can execute — next
actions, commands — renders in monospace tertiary blue so "runnable" is a
typographic property, not a button. Status is always word + color, never
color alone.

## Themes

Two themes, `dark` and `light`, selected by `data-theme` on `<html>`. Every
color key exists in both maps (`colors` = dark, `colors-light` = light) with
the same role, so components read CSS variables and never branch on theme.

- **Default** follows `prefers-color-scheme`; the user's pick persists in
  `localStorage["ygl-theme"]` (`system` / `light` / `dark`) and is applied by an
  inline script before first paint (no flash).
- **Switch**: one icon button at the header's right end (切换主题), cycling
  跟随系统 → 浅色 → 深色; the tooltip names the current mode. Switching never
  resets selection, scroll or open panels.
- **antd** follows the switch (`darkAlgorithm` / `defaultAlgorithm`, token map
  applied in both); **xyflow** gets `colorMode`.
- Light keeps the depth model: `neutral` (pale page) under `surface` (white
  cards). Every text pair meets AA in both themes (≥4.5:1 on neutral/surface/
  surface-hover). `text-dim` carries no text — it is a non-text token (minimap
  node blocks, decorative fills) held to the WCAG 1.4.11 non-text floor, ≥3:1 on
  every ground in both themes (dark `#6e7681`: 4.1:1 / 3.8:1 / 3.5:1).

## Colors

Hex values below are the dark theme; `colors-light` holds the light twin.

- **Primary (#58a6ff):** the only interaction driver — links, focus rings,
  selected tree nodes, hovered chips. Never used for body text.
- **Secondary (#8b949e):** metadata, captions, locators. Dim but still AA on
  surface.
- **Tertiary (#79c0ff):** section headings and executable command lines —
  "this is a thing you can run".
- **Neutral (#0d1117) / Surface (#161b22):** two-depth canvas; elevation is
  expressed by border, not shadow, except the fixed side panel.
- **Success / Danger / Warning:** claim statuses and eval outcomes; each is
  paired with a word (`supported`, `fail`, `pending`) — color is reinforcement,
  never the sole signal.
- **Text on solid fills (`on-primary`):** antd renders a solid primary button from
  `primary` as a derived shade (`#4e90dc` in dark), where white text reads 3.3:1.
  Dark therefore sets the Button's solid text (`primaryColor` / `solidTextColor` /
  `dangerColor`) to ink (`on-primary` = `neutral`: 5.7:1 normal, 8.3:1 hover, 4.6:1
  pressed); light keeps white (5.2:1 / 4.5:1 / 7.7:1). Danger fills follow the same rule. The derived state shades that fall short are slid
  toward the nearest passing step of the same hue, set on the Button in `tokens.ts`
  (BUTTON_STATES) — dark: pressed `#467fc0`, danger `#f85149` (the `danger` seed
  itself), danger pressed `#da4942`; light: hover `#1f76d6`, danger hover `#d54047`.
  Every state in both themes is checked against antd's real derivation by a test.
  The global `colorTextLightSolid` stays white: tooltips and badges share it, and
  their grounds are dark in both themes.
- **Chart series (`chart-research` / `chart-tree` / `chart-eval` / `chart-other`):**
  the only colors that paint data marks (the overview activity timeline). Fixed
  stack order research → tree → eval → other: blue sits between amber and green so
  deutan readers can part them (adjacent-pair CVD ΔE ≥ 8 and normal-vision ≥ 15 in
  both themes, checked with a palette validator); `chart-other` is the folded
  tail, a de-emphasis gray (`#7d8590` light / `#6e7681` dark), never a categorical hue.
  In light the three hues are the semantic tokens themselves; in dark they are the
  same hues stepped down into the chart band (OKLCH L 0.64, ≥ 5:1 on `surface`).
  A legend is always shown, text never wears a series color (labels, axes and
  legends use `text` / `secondary`), and every number is also in a table view.

## Typography

System font stack only — the dashboard renders offline from a single HTML
file, so webfonts are a non-goal. Two voices: the system sans for prose and
hierarchy, and ui-monospace for anything executable (next actions, node
keys). Size scale is compact (0.78–1.4em): this is a data-dense console.

## Layout

Single scrolling column; the node detail panel is a fixed right-side overlay
(width 330px, lg rounded, single shadow). Cards grid auto-fills at 140px
minimum. The panel survives live-data refreshes — selection state is sacred.

## Elevation & Depth

Border-first: cards and chips separate by 1px `border`, not shadow. The one
exception is the fixed node panel (`0 8px 24px rgba(0,0,0,.45)`), which must
read as floating above the page.

Per theme (tokens.css; the drift guard checks these literals appear here):

| token | dark | light |
|---|---|---|
| `--shadow-panel` | `0 8px 24px rgba(0, 0, 0, 0.45)` | `0 8px 24px rgba(140, 149, 159, 0.2)` |
| `--shadow-entity` (graph entities) | `0 2px 6px rgba(0, 0, 0, 0.3)` | `0 1px 3px rgba(31, 35, 40, 0.12)` |
| `--entity-stroke` (2px entity ring) | `rgba(255, 255, 255, 0.3)` | `rgba(31, 35, 40, 0.15)` |

Entity fills are the status/role colors by type (node=primary, claim=success,
evidence/source=warning, artifact/task=tertiary, kb/skill=secondary); labels on
them use `on-entity`.

## Shapes

Radii stay small and utilitarian: 4px controls, 6px cards, 8px overlay
panels, 10px pill chips.

## Components

Claim rows carry a 3px left border in their status color — the fastest scan
path in the research pipeline view. Chips are the universal relation/label
atom (skills, parents/children, related items). `action-line` rows are
non-interactive by default; they exist to be copied.

## Do's and Don'ts

- Do pair every status color with its word.
- Do keep executable text monospace + tertiary.
- Do keep the palette to the tokens above — a new color needs a reason.
- Don't introduce a second accent color; primary is the only driver.
- Don't animate layout properties; transitions are 150ms on
  background/color only, and `prefers-reduced-motion` disables them.
- Don't ship webfonts or external assets — the file must open from `file://`.
