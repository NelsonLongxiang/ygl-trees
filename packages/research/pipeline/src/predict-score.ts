/** Numeric prediction scoring; ND and unknown probabilities never become zeroes. */
export function predictionProbability(confidence: unknown): number | null {
  const raw = String(confidence ?? "").trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?%?$/.test(raw)) return null;
  const n = Number(raw.replace(/%$/, ""));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return raw.endsWith("%") || n > 1 ? n / 100 : n;
}
const rounded = (n: number) => Number(n.toFixed(12));
export function predictionScore(confidence: unknown, outcome: string, brier: string | null) {
  const p = predictionProbability(confidence);
  const brier_calc = p !== null && (outcome === "1" || outcome === "0") ? rounded((p - Number(outcome)) ** 2) : null;
  const note = brier === null ? NaN : Number(brier);
  return { p, brier_calc, brier_mismatch: brier_calc !== null && Number.isFinite(note) && rounded(Math.abs(note - brier_calc)) > 0.005 };
}
export interface PredictionScoreInput { channel: string; outcome: string; p: number | null; brier_calc: number | null }
export function summarizePredictions(rows: PredictionScoreInput[]) {
  const groups = new Map<string, { channel: string; settled: number; nd: number; open: number; no_p: number; hits: number; sum: number; scored: number }>();
  for (const row of rows) {
    let g = groups.get(row.channel);
    if (!g) { g = { channel: row.channel, settled: 0, nd: 0, open: 0, no_p: 0, hits: 0, sum: 0, scored: 0 }; groups.set(row.channel, g); }
    if (row.p === null) g.no_p++;
    if (row.outcome === "ND") g.nd++;
    else if (row.outcome !== "1" && row.outcome !== "0") g.open++;
    else {
      g.settled++;
      if (row.p !== null && row.brier_calc !== null) {
        g.scored++; g.sum += row.brier_calc;
        if ((row.p >= 0.5) === (row.outcome === "1")) g.hits++;
      }
    }
  }
  return [...groups.values()].sort((a, b) => a.channel.localeCompare(b.channel)).map(g => ({
    channel: g.channel, settled: g.settled, nd: g.nd, open: g.open, no_p: g.no_p,
    hit_rate: g.scored ? rounded(g.hits / g.scored) : null,
    brier_mean: g.scored ? rounded(g.sum / g.scored) : null,
  }));
}
