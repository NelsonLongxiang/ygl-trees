/**
 * Decision-model boolean evaluator — spec R8 (docs/spec.md).
 *
 * Speaks the Vercel AI Gateway v4 evaluation-model protocol (TypeSafe jev):
 * deterministic P(true) judgments, 1-2s/call, native CJK, collapses toward
 * the gray band instead of hard-answering on thin evidence. Material:
 * F:/Users/Administrator/Downloads/vercel-ai-gateway-eval-api.md.
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
 *  state, never a terminal verdict. */
const GRAY = { low: 0.4, high: 0.7 };

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
  error?: string;
}

/** One boolean question about a state. Retries 429/529 with exponential
 *  backoff (<=3); 400/401 and malformed answers return without retry;
 *  60s timeout per attempt. */
export async function evalBoolean(state: unknown, question: string, token: string): Promise<EvalBooleanResult> {
  if (!token) return { ok: false, error: "no evaluator configured (set AI_GATEWAY_API_KEY or ~/.vercel.ai-gateway.env)" };
  const body = JSON.stringify({
    state,
    questions: { q: { type: "boolean", instructions: question } },
  });
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(GATEWAY_URL, {
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
      const p = j?.answers?.q?.probability;
      if (typeof p !== "number") return { ok: false, error: "malformed answer: no boolean probability" };
      return { ok: true, p };
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

export type EvalOutcome = "pass" | "fail" | "pending";

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
