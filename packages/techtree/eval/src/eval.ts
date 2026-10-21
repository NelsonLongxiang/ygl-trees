/**
 * Decision-model boolean evaluator — spec R8 (docs/spec.md).
 *
 * Speaks the Vercel AI Gateway v4 evaluation-model protocol (TypeSafe jev):
 * deterministic P(true) judgments, 1-2s/call, native CJK, collapses toward
 * the gray band instead of hard-answering on thin evidence. Material:
 * Protocol reference: the Vercel AI Gateway eval API documentation
 * (protocol summarized in docs/spec.md R8; no local path ships with the package).
 *
 * Offline-safe by design: callers map "no token / network failure" to a
 * PENDING gate outcome (never a hard fail) — the evaluator is an
 * enhancement, not a dependency.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";
const MODEL_ID = "typesafe-ai/jev";
/** Gray band per the material's discipline: P in (0.4, 0.7) is a process
 *  state, never a terminal verdict. Thresholds are config-tunable. */
const GRAY = { low: 0.4, high: 0.7 };

export const DEFAULT_ENDPOINT = GATEWAY_URL;

/** Normalize a configured api_base: a bare host gets the standard v4
 *  evaluation-model path appended; a full endpoint is used as-is.
 *  Config priority is composed by the CALLER (cmds layer):
 *  config(decision_model_llm_api_base) > this default. */
export function resolveEndpoint(base: string): string {
  const v = String(base || "").trim().replace(/\/+$/, "");
  if (!v) return GATEWAY_URL;
  if (/\/v4\/ai\/evaluation-model$/.test(v)) return v;
  return `${v}/v4/ai/evaluation-model`;
}

/** Token resolution: env first, then ~/.vercel.ai-gateway.env (token=...).
 *  Set YGL_EVAL_OFFLINE=1 to force the offline path (tests/demos on
 *  machines that DO have a token file — keeps them deterministic). */
export function evalToken(): string {
  if (process.env.YGL_EVAL_OFFLINE) return "";
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY;
  try {
    const m = /^token\s*=\s*(\S+)/m.exec(fs.readFileSync(path.join(os.homedir(), ".vercel.ai-gateway.env"), "utf8"));
    if (m) return m[1];
  } catch {
    /* file absent — fine */
  }
  return "";
}

export interface EvalBooleanResult {
  ok: boolean;
  p?: number;
  usage?: any;
  error?: string;
}

/** One boolean question about a state. Retries 429/529 with exponential
 *  backoff (<=3); 400/401 and malformed answers return without retry;
 *  60s timeout per attempt. `endpoint` defaults to the Vercel gateway —
 *  callers pass the config-resolved value (decision_model_llm_api_base
 *  has priority over the default). */
export async function evalBoolean(state: unknown, question: string, token: string, endpoint = GATEWAY_URL): Promise<EvalBooleanResult> {
  if (!token) return { ok: false, error: NO_TOKEN };
  const r = await postEval(state, { q: { type: "boolean", instructions: question } }, token, endpoint);
  if (!r.ok) return { ok: false, error: r.error };
  const p = r.answers.q?.probability;
  if (typeof p !== "number") return { ok: false, error: "malformed answer: no boolean probability" };
  return { ok: true, p, usage: r.usage };
}

export type EvalOutcome = "pass" | "fail" | "pending";

// ================================================================
// question-type envelope (0.26.0) — zero schema change
//
// op=eval keeps value = plain question wording (R8.1, frozen).
// op=eval-choice / op=eval-score pack an envelope into value:
//   {"q":"问题", "options":{"k":"描述"}, "answer":"k"}   (choice)
//   {"q":"问题", "levels":["级0","级1"], "min":2}        (score)
// parseEvalSpec tolerates plain strings (backward compatible).

export interface EvalSpec {
  q: string;
  options?: Record<string, string>;
  answer?: string;
  levels?: string[];
  min?: number;
}

export function parseEvalSpec(value: unknown): EvalSpec {
  const s = String(value ?? "").trim();
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      if (j && typeof j.q === "string") return j as EvalSpec;
    } catch {
      /* fall through to plain */
    }
  }
  return { q: s };
}

export function packEvalChoiceSpec(q: string, options: Record<string, string>, answer: string): string {
  return JSON.stringify({ q, options, answer });
}

export function packEvalScoreSpec(q: string, levels: string[], min: number): string {
  return JSON.stringify({ q, levels, min });
}

// ================================================================
// shared transport — one request, N typed questions (protocol native)

async function postEval(
  state: unknown,
  questions: Record<string, any>,
  token: string,
  endpoint: string
): Promise<{ ok: true; answers: any; usage?: any } | { ok: false; error: string }> {
  const url = resolveEndpoint(endpoint);
  const body = JSON.stringify({ state, questions });
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "ai-model-id": MODEL_ID,
          "ai-evaluation-model-specification-version": "4",
          "ai-gateway-protocol-version": "0.0.1",
          "ai-gateway-auth-method": "api-key",
        },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429 || res.status === 529) {
        if (attempt >= 3) return { ok: false, error: `HTTP ${res.status} after ${attempt + 1} attempts` };
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status} (protocol/auth error — no retry)` };
      const j: any = await res.json();
      if (!j?.answers) return { ok: false, error: "malformed response: no answers" };
      // R10.4: gateway reports token usage — capture it for the telemetry ledger
      return { ok: true, answers: j.answers, usage: j.usage ?? undefined };
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (attempt < 3 && /timeout|abort|network|fetch failed|ECONN/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      return { ok: false, error: msg };
    }
  }
}

const NO_TOKEN = "no evaluator configured (set config decision_model_llm_token, or AI_GATEWAY_API_KEY / ~/.vercel.ai-gateway.env)";

// ================================================================
// choice (1-255 options, full probability distribution over options)

export interface EvalChoiceResult {
  ok: boolean;
  choice?: string;
  probabilities?: Record<string, number>;
  usage?: any;
  error?: string;
}

export async function evalChoice(
  state: unknown,
  question: string,
  options: Record<string, string>,
  token: string,
  endpoint = GATEWAY_URL
): Promise<EvalChoiceResult> {
  if (!token) return { ok: false, error: NO_TOKEN };
  const criteria: Record<string, any> = {};
  for (const [k, v] of Object.entries(options)) criteria[k] = v || null;
  const r = await postEval(state, { q: { type: "choice", instructions: question, criteria } }, token, endpoint);
  if (!r.ok) return { ok: false, error: r.error };
  const a = r.answers.q ?? {};
  if (typeof a.choice !== "string" || !a.probabilities) return { ok: false, error: "malformed answer: no choice/probabilities" };
  return { ok: true, choice: a.choice, probabilities: a.probabilities, usage: r.usage };
}

/** Tri-state on the EXPECTED answer's probability — same thresholds and
 *  gray-band philosophy as boolean P(true). */
export function mapChoiceOutcome(
  r: EvalChoiceResult,
  answer: string,
  high = 0.7,
  low = 0.4
): { outcome: EvalOutcome; p?: number; choice?: string; reason?: string } {
  if (!r.ok || !r.probabilities) return { outcome: "pending", reason: r.error || "no probabilities" };
  const p = r.probabilities[answer];
  if (typeof p !== "number") return { outcome: "pending", reason: `expected answer '${answer}' not in distribution` };
  const base = { p, choice: r.choice };
  if (p >= high) return { outcome: "pass", ...base };
  if (p <= low) return { outcome: "fail", ...base };
  return { outcome: "pending", ...base, reason: `gray band ${low}<P<${high} (process state)` };
}

// ================================================================
// score (2-10 ordinal levels; score = probability-weighted mean)

export interface EvalScoreResult {
  ok: boolean;
  score?: number;
  probabilities?: Record<string, number>;
  usage?: any;
  error?: string;
}

export async function evalScore(
  state: unknown,
  question: string,
  levels: string[],
  token: string,
  endpoint = GATEWAY_URL
): Promise<EvalScoreResult> {
  if (!token) return { ok: false, error: NO_TOKEN };
  const r = await postEval(state, { q: { type: "score", instructions: question, criteria: levels } }, token, endpoint);
  if (!r.ok) return { ok: false, error: r.error };
  const a = r.answers.q ?? {};
  if (typeof a.score !== "number" || !a.probabilities) return { ok: false, error: "malformed answer: no score/probabilities" };
  return { ok: true, score: a.score, probabilities: a.probabilities, usage: r.usage };
}

/** Tri-state on the ordinal scale: score >= min → pass; score <= min-1 →
 *  fail; the ±1 band around the threshold is the gray zone (the score
 *  counterpart of boolean's (0.4, 0.7) process state). */
export function mapScoreOutcome(
  r: EvalScoreResult,
  min: number
): { outcome: EvalOutcome; score?: number; reason?: string } {
  if (!r.ok || r.score === undefined) return { outcome: "pending", reason: r.error || "no score" };
  const s = r.score;
  if (s >= min) return { outcome: "pass", score: s };
  if (s <= min - 1) return { outcome: "fail", score: s };
  return { outcome: "pending", score: s, reason: `gray band [${min - 1}, ${min}) around expected level ${min}` };
}

/** Multi-question variant — the protocol natively evaluates many questions
 *  against ONE state in a single request (~same latency as one question).
 *  Used by `node ready --eval` to judge all of a node's eval gates at once. */
export async function evalBooleanMany(
  state: unknown,
  questions: string[],
  token: string,
  endpoint = GATEWAY_URL
): Promise<{ ok: boolean; ps?: number[]; error?: string }> {
  if (!questions.length) return { ok: true, ps: [] };
  if (!token) return { ok: false, error: NO_TOKEN };
  const qmap: Record<string, any> = {};
  questions.forEach((q, i) => (qmap[`q${i}`] = { type: "boolean", instructions: q }));
  const r = await postEval(state, qmap, token, endpoint);
  if (!r.ok) return { ok: false, error: r.error };
  const ps: number[] = [];
  for (let i = 0; i < questions.length; i++) {
    const p = r.answers[`q${i}`]?.probability;
    if (typeof p !== "number") return { ok: false, error: `malformed answer q${i}: no probability` };
    ps.push(p);
  }
  return { ok: true, ps };
}

// ================================================================
// mixed batch (0.27.0) — the protocol evaluates boolean/choice/score
// questions against ONE state in a single request. Results are shaped
// exactly like the single-question functions so the existing tri-state
// mappers (mapOutcome / mapChoiceOutcome / mapScoreOutcome) apply directly.

export type MixedQuestion =
  | { type: "boolean"; question: string }
  | { type: "choice"; question: string; options: Record<string, string>; answer: string }
  | { type: "score"; question: string; levels: string[]; min: number };

export type MixedResult =
  | { ok: false; error: string }
  | { ok: true; type: "boolean"; p: number }
  | { ok: true; type: "choice"; choice: string; probabilities: Record<string, number> }
  | { ok: true; type: "score"; score: number; probabilities: Record<string, number> };

export async function evalMixed(
  state: unknown,
  questions: MixedQuestion[],
  token: string,
  endpoint = GATEWAY_URL
): Promise<{ ok: true; results: MixedResult[]; usage?: any } | { ok: false; error: string }> {
  if (!questions.length) return { ok: true, results: [] };
  if (!token) return { ok: false, error: NO_TOKEN };
  const qmap: Record<string, any> = {};
  questions.forEach((q, i) => {
    if (q.type === "boolean") qmap[`q${i}`] = { type: "boolean", instructions: q.question };
    else if (q.type === "choice") {
      const criteria: Record<string, any> = {};
      for (const [k, v] of Object.entries(q.options)) criteria[k] = v || null;
      qmap[`q${i}`] = { type: "choice", instructions: q.question, criteria };
    } else qmap[`q${i}`] = { type: "score", instructions: q.question, criteria: q.levels };
  });
  const r = await postEval(state, qmap, token, endpoint);
  if (!r.ok) return { ok: false, error: r.error };
  const results: MixedResult[] = [];
  for (let i = 0; i < questions.length; i++) {
    const a = r.answers[`q${i}`] ?? {};
    const t = questions[i].type;
    if (t === "boolean") {
      if (typeof a.probability !== "number") return { ok: false, error: `malformed answer q${i}: no boolean probability` };
      results.push({ ok: true, type: "boolean", p: a.probability });
    } else if (t === "choice") {
      if (typeof a.choice !== "string" || !a.probabilities) return { ok: false, error: `malformed answer q${i}: no choice/probabilities` };
      results.push({ ok: true, type: "choice", choice: a.choice, probabilities: a.probabilities });
    } else {
      if (typeof a.score !== "number" || !a.probabilities) return { ok: false, error: `malformed answer q${i}: no score/probabilities` };
      results.push({ ok: true, type: "score", score: a.score, probabilities: a.probabilities });
    }
  }
  return { ok: true, results, usage: r.usage };
}

/** R8.4 tri-state mapping. Thresholds come from config (eval.pass_threshold
 *  / eval.fail_threshold) so callers pass the resolved values. */
export function mapOutcome(
  r: EvalBooleanResult,
  high = 0.7,
  low = 0.4
): { outcome: EvalOutcome; p?: number; reason?: string } {
  if (!r.ok || r.p === undefined) return { outcome: "pending", reason: r.error || "no probability" };
  if (r.p >= high) return { outcome: "pass", p: r.p };
  if (r.p <= low) return { outcome: "fail", p: r.p };
  return { outcome: "pending", p: r.p, reason: `gray band ${low}<P<${high} (process state)` };
}
