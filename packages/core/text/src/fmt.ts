/** Output helpers: colourised text tables and --json mode. */

export interface Ctx {
  json: boolean;
  color: boolean;
  quiet: boolean;
}

export const C = {
  reset: "[0m",
  bold: "[1m",
  dim: "[2m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  cyan: "[36m",
};

export function paint(code: string, s: string, on: boolean): string {
  return on ? `${code}${s}${C.reset}` : s;
}

export function out(ctx: Ctx, msg = ""): void {
  if (!ctx.quiet) console.log(msg);
}

export function ok(ctx: Ctx, msg: string): void {
  out(ctx, paint(C.green, `  ✓ ${msg}`, ctx.color));
}
export function warn(ctx: Ctx, msg: string): void {
  out(ctx, paint(C.yellow, `  ! ${msg}`, ctx.color));
}
/**
 * Failure report. In --json mode stdout is the MACHINE channel, so a failure
 * must still be parseable there: a single `{"error": "..."}` object (the exit
 * code carries the class: 1 runtime, 2 usage). Human text otherwise.
 */
export function bad(ctx: Ctx, msg: string): void {
  if (ctx.json) {
    console.log(JSON.stringify({ error: msg }, null, 2));
    return;
  }
  out(ctx, paint(C.red, `  ✗ ${msg}`, ctx.color));
}
export function head(ctx: Ctx, msg: string): void {
  out(ctx, paint(C.bold + C.cyan, `\n${msg}`, ctx.color));
}

/** Display width: CJK/fullwidth glyphs occupy two terminal columns. */
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1f9ff);
    w += wide ? 2 : 1;
  }
  return w;
}

function padEnd(s: string, width: number): string {
  const gap = width - dispWidth(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

/** Render rows as an aligned table (falls back to JSON when ctx.json). */
export function table(ctx: Ctx, rows: any[], headers?: string[], keys?: string[], hint?: string): void {
  if (ctx.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    out(ctx, paint(C.dim, "  (empty)", ctx.color));
    if (hint) out(ctx, paint(C.dim, `  → ${hint}`, ctx.color));
    return;
  }
  const cols = keys || Object.keys(rows[0]).filter((k) => !k.startsWith("_"));
  const hs = headers || cols;
  const widthOf = (k: string) => Math.min(40, Math.max(...rows.map((r) => dispWidth(String(r[k] ?? "")))));
  const w = cols.map((k, i) => Math.max(dispWidth(hs[i] ?? ""), widthOf(k)));
  const trunc = (s: string) => s.length > 40 ? s.slice(0, 39) + "…" : s;
  const line = (cells: string[]) => cells.map((c, i) => padEnd(trunc(String(c)), w[i])).join("  ");
  out(ctx, paint(C.bold, "  " + line(hs), ctx.color));
  out(ctx, paint(C.dim, "  " + w.map((n) => "-".repeat(n)).join("  "), ctx.color));
  for (const r of rows) out(ctx, "  " + line(cols.map((k) => String(r[k] ?? ""))));
}

export function show(ctx: Ctx, obj: any, title?: string): void {
  if (ctx.json) {
    console.log(JSON.stringify(obj, null, 2));
    return;
  }
  if (title) head(ctx, title);
  const width = Math.max(...Object.keys(obj).map((k) => k.length));
  for (const [k, v] of Object.entries(obj)) {
    const val = v === null || v === undefined ? "" : String(v);
    out(ctx, `  ${paint(C.dim, k.padEnd(width), ctx.color)}  ${val}`);
  }
}

export function dump(ctx: Ctx, data: any): void {
  if (ctx.json) console.log(JSON.stringify(data, null, 2));
  else console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

/**
 * Write-path result printer with JSON discipline: under --json the ONLY
 * stdout is one JSON object (duplicate or new, duplicates carry
 * `duplicate: true`); human-readable lines are tty-only, so agents can
 * always JSON.parse the full stdout of a write command.
 */
export function writeResult(
  ctx: Ctx,
  o: { row: any; dup: boolean },
  human: (row: any) => string,
  /** F1 (0.110.x): write-target amplification. Callers pass the resolved
   *  project + the selection layer that authorized it; JSON keeps one object. */
  extra?: { project?: string; project_source?: string },
): void {
  if (ctx.json) {
    const payload = { ...o.row, ...(extra?.project ? { project: extra.project } : {}), ...(extra?.project_source ? { project_source: extra.project_source } : {}), ...(o.dup ? { duplicate: true } : {}) };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (o.dup) out(ctx, paint(C.yellow, `  ! duplicate, kept existing: ${o.row.id}`, ctx.color));
  else ok(ctx, human(o.row));
}

/** Ack for mutating commands without a meaningful row: --json prints the
 *  payload object; tty prints a ✓ line. Keeps stdout JSON-pure. */
export function ack(ctx: Ctx, payload: any, msg: string): void {
  if (ctx.json) console.log(JSON.stringify(payload, null, 2));
  else ok(ctx, msg);
}
