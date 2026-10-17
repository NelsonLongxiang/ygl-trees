/**
 * Prediction backtest pipeline (spec: pred-val/backtest-pipeline).
 *
 * Predictions are claims whose text starts with `[预测·<horizon>]` and contains
 * a deadline (`YYYY-MM-DD 前`) plus one or more criteria separated by ` 或 `.
 * The audit parses those locally-measurable criteria, measures the current
 * actual from the workspace DB (or a fast registry probe for npm counts), and
 * reports hit / miss / pending / manual — it NEVER auto-resolves; resolution
 * stays a human arbitration (frozen contract).
 */

export interface PredictionAuditRow {
  claim_id: string;
  horizon: string;            // "7天" | "90天" | …
  deadline: string;           // YYYY-MM-DD ("" when unparseable)
  criterion: string;          // raw criterion text
  actual: string;             // human-readable measurement ("trees=12 kb=30")
  verdict: "hit" | "miss" | "pending" | "manual";
  days_left: number | null;   // null when deadline unknown
  hint?: string;              // how to measure the manual ones
}

/** Extract `[预测·X]` horizon + deadline. Explicit `YYYY-MM-DD 前` wins;
 *  otherwise derive from claim creation date + horizon days (7天/90天). */
export function parsePrediction(text: string, created?: string): { horizon: string; deadline: string } {
  const h = text.match(/\[预测·([^\]]+)\]/);
  const horizon = h ? h[1] : "";
  const d = text.match(/(\d{4}-\d{2}-\d{2})\s*前/);
  if (d) return { horizon, deadline: d[1] };
  const days = horizon.match(/(\d+)\s*天/);
  if (days && created) {
    const t = Date.parse(created.replace(" ", "T"));
    if (!Number.isNaN(t)) {
      return { horizon, deadline: new Date(t + +days[1] * 86400000).toISOString().slice(0, 10) };
    }
  }
  return { horizon, deadline: "" };
}

type Measure = { actual: string; hit: boolean } | null; // null = cannot measure

/** Locally measurable criterion matchers. Null → manual. */
export function measureCriterion(crit: string, db: any): Measure {
  // 树≥N / kb≥N — workspace counts (pure local truth)
  const tree = crit.match(/树\s*≥\s*(\d+)/);
  const kb = crit.match(/kb\s*≥\s*(\d+)/);
  if (!tree && !kb) return null;
  const parts: string[] = [];
  const hits: boolean[] = [];
  if (tree) {
    const n = db.get("SELECT COUNT(*) c FROM trees").c;
    parts.push(`trees=${n}/${tree[1]}`);
    hits.push(n >= +tree[1]);
  }
  if (kb) {
    const n = db.get("SELECT COUNT(*) c FROM kb_notes").c;
    parts.push(`kb=${n}/${kb[1]}`);
    hits.push(n >= +kb[1]);
  }
  const hasOr = crit.includes(" 或 ");
  const hit = hasOr ? hits.some(Boolean) : hits.every(Boolean);
  return { actual: parts.join(" · "), hit };
}

/** npm version count since a date — registry probe with a hard 3s timeout,
 *  offline-safe fallback to manual. */
export async function measureNpmVersions(pkg: string, since: string, fetchImpl: typeof fetch): Promise<Measure> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetchImpl(`https://registry.npmjs.org/${pkg}`, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const meta = await r.json() as any;
    const times = meta.time || {};
    const versions = Object.entries(times)
      .filter(([v, ts]) => v !== "created" && v !== "modified" && String(ts) >= since)
      .map(([v]) => v);
    return { actual: `npm versions since ${since}: ${versions.length} (${versions.slice(-3).join(",")})`, hit: versions.length > 0 };
  } catch { return null; }
}

export interface AuditInput {
  claims: { id: string; text: string; status: string; created?: string }[];
  db: any;
  today?: string;             // ISO date for testability
  npmProbe?: boolean;         // enable registry probe (default true)
  fetchImpl?: typeof fetch;
}

export async function auditPredictions(inp: AuditInput): Promise<PredictionAuditRow[]> {
  const today = inp.today || new Date().toISOString().slice(0, 10);
  const rows: PredictionAuditRow[] = [];
  for (const c of inp.claims) {
    if (!c.text.startsWith("[预测·")) continue;
    const { horizon, deadline } = parsePrediction(c.text, c.created);
    // criterion: prefer the "DATE 前" anchor; fall back to "] " (no-date texts)
    const m = c.text.match(/\d{4}-\d{2}-\d{2}\s*前\s*(.+?)(?:——|$)/) || c.text.match(/\]\s*(.+?)(?:——|$)/);
    const criterion = m ? m[1].trim() : "";
    const daysLeft = deadline ? Math.round((Date.parse(deadline) - Date.parse(today)) / 86400000) : null;
    let measure = measureCriterion(criterion, inp.db);
    // npm version criterion → registry probe (opt-out for offline/tests)
    if (!measure && /npm 再发\s*≥\s*(\d+)\s*个版本/.test(criterion)) {
      const need = +criterion.match(/npm 再发\s*≥\s*(\d+)/)![1];
      const base = c.text.match(/基线\s*\S*?@?(\d{4}-\d{2}-\d{2})/);
      const since = base ? base[1] : (c.created || today).slice(0, 10);
      if (inp.npmProbe !== false) {
        const v = await measureNpmVersions("ygl-trees", since, inp.fetchImpl || fetch);
        if (v) {
          const n = +(v.actual.match(/:\s*(\d+)/) || [0, 0])[1];
          measure = { actual: `${v.actual} · need ≥${need}`, hit: n >= need };
        }
      }
    }
    let verdict: PredictionAuditRow["verdict"];
    let hint: string | undefined;
    if (!measure) { verdict = "manual"; hint = "外部世界判据——人工核验后 claim resolve"; }
    else if (daysLeft !== null && daysLeft > 0) verdict = "pending";
    else verdict = measure.hit ? "hit" : "miss";
    rows.push({
      claim_id: c.id, horizon, deadline, criterion,
      actual: measure ? measure.actual + (verdict === "pending" && measure.hit ? " · 已达标" : "") : "—",
      verdict, days_left: daysLeft, hint,
    });
  }
  return rows;
}
