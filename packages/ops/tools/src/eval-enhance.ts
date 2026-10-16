/**
 * Decision-model enhancements (spec R15): the eval-gates model infrastructure
 * (R8) applied BEYOND node unlock gates — semantic search re-ranking, claim
 * confidence evaluation, and evidence quality assessment.
 *
 * All three reuse the same model connection (evalToken / postEval / TypeSafe
 * jev), the same three-state mapping (pass/fail/pending), and the same
 * offline safety (no token → pending, never crash).
 *
 * @module @ygl/ops/eval-enhance
 */
import { evalToken, evalBoolean, evalScore } from "../../../techtree/eval/src/eval";

// ================================================================
// R15.1 — semantic search re-ranking
// ================================================================

export interface ReRankCandidate {
  id: string;
  title: string;
  excerpt: string; // first N chars of body/content
}

export interface ReRankedResult {
  id: string;
  title: string;
  semantic_relevance: number | null; // P(relevant) or null if offline
  original_rank: number;
  re_ranked: boolean;
}

/**
 * Re-rank FTS candidates by semantic relevance to the query.
 * Falls back to original order if the model is unavailable (offline safety).
 */
export async function semanticReRank(
  query: string,
  candidates: ReRankCandidate[],
  token?: string
): Promise<ReRankedResult[]> {
  const t = token || evalToken();
  if (!t) {
    // Offline: return original order, no re-ranking
    return candidates.map((c, i) => ({
      id: c.id,
      title: c.title,
      semantic_relevance: null,
      original_rank: i + 1,
      re_ranked: false,
    }));
  }

  const results: Array<ReRankedResult & { _score: number }> = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const question = `查询："${query}"。候选结果标题："${c.title}"，内容摘录："${c.excerpt.slice(0, 200)}"。该候选结果与查询在语义上相关吗？`;
    const state = { query, candidate_title: c.title, candidate_excerpt: c.excerpt.slice(0, 300) };
    const r = await evalBoolean(state, question, t);
    const score = r.ok && typeof r.p === 'number' ? r.p : 0.5; // model error → neutral 0.5
    results.push({
      id: c.id,
      title: c.title,
      semantic_relevance: r.ok && typeof score === 'number' ? +(score.toFixed(3)) : null,
      original_rank: i + 1,
      re_ranked: true,
      _score: score,
    });
  }

  // Sort by semantic score descending
  results.sort((a, b) => b._score - a._score);
  return results.map(({ _score, ...rest }) => rest);
}

// ================================================================
// R15.2 — claim confidence evaluation
// ================================================================

export interface ClaimEvalContext {
  claim_text: string;
  claim_status: string;
  evidence: Array<{ quote: string; stance: string; source_title?: string }>;
}

export interface ClaimEvalResult {
  ok: boolean;
  confidence_score: number | null; // 0-10 model score, null if offline
  confidence_label: string; // A/B/C/uncertain
  reasoning: string;
  usage?: any;
}

/**
 * Evaluate a claim's confidence based on its linked evidence.
 * Returns a score 0-10 and maps it to an A/B/C label.
 */
export async function evaluateClaimConfidence(
  ctx: ClaimEvalContext,
  token?: string
): Promise<ClaimEvalResult> {
  const t = token || evalToken();
  if (!t) {
    return {
      ok: false,
      confidence_score: null,
      confidence_label: "uncertain",
      reasoning: "决策模型不可用（未配置 AI_GATEWAY_API_KEY）——回退手动置信度",
    };
  }

  const evidenceSummary = ctx.evidence
    .map((e, i) => `[${i + 1}] ${e.stance}: "${e.quote.slice(0, 150)}"${e.source_title ? ` (来源: ${e.source_title})` : ""}`)
    .join("\n");

  const question = `断言："${ctx.claim_text}"（当前状态：${ctx.claim_status}）。
关联证据：
${evidenceSummary || "（无关联证据）"}

基于以上证据，这条断言的可信度有多高？`;
  const levels = ["完全不可信", "很可能错误", "存疑", "有一定依据", "基本可信", "高度可信"];
  const state = { claim: ctx.claim_text, evidence: ctx.evidence };

  const r = await evalScore(state, question, levels, t);
  if (!r.ok) {
    return {
      ok: false,
      confidence_score: null,
      confidence_label: "uncertain",
      reasoning: `模型评估失败：${r.error}`,
    };
  }

  // Map score (0-5 from levels) to confidence label
  const s = typeof r.score === "number" ? r.score : 3;
  const label = s >= 4.5 ? "A" : s >= 3.5 ? "B" : s >= 2 ? "C" : "D";
  return {
    ok: true,
    confidence_score: +(s.toFixed(1)),
    confidence_label: label,
    reasoning: `模型评分 ${s.toFixed(1)}/5（${levels[Math.round(s)] || "未知"}），映射为置信度 ${label}`,
    usage: r.usage,
  };
}

// ================================================================
// R15.3 — evidence quality assessment
// ================================================================

export interface EvidenceAssessContext {
  quote: string;
  locator?: string;
  source_title: string;
  source_url?: string;
}

export interface EvidenceAssessResult {
  ok: boolean;
  quality_score: number | null; // 0-5, null if offline
  reliability: string; // 高/中/低/uncertain
  reasoning: string;
  usage?: any;
}

/**
 * Assess evidence quality: source reliability + quote relevance.
 */
export async function assessEvidenceQuality(
  ctx: EvidenceAssessContext,
  token?: string
): Promise<EvidenceAssessResult> {
  const t = token || evalToken();
  if (!t) {
    return {
      ok: false,
      quality_score: null,
      reliability: "uncertain",
      reasoning: "决策模型不可用——回退手动评估",
    };
  }

  const question = `证据引文："${ctx.quote.slice(0, 200)}"。
来源："${ctx.source_title}"${ctx.source_url ? ` (${ctx.source_url})` : ""}。

该证据的质量如何？考虑：来源可靠性、引文的具体性、是否支持进一步推理。`;
  const levels = ["不可用", "质量差", "质量一般", "质量良好", "质量很高"];
  const state = { quote: ctx.quote.slice(0, 300), source: ctx.source_title, url: ctx.source_url };

  const r = await evalScore(state, question, levels, t);
  if (!r.ok) {
    return {
      ok: false,
      quality_score: null,
      reliability: "uncertain",
      reasoning: `模型评估失败：${r.error}`,
    };
  }

  const s = typeof r.score === "number" ? r.score : 3;
  const reliability = s >= 4 ? "高" : s >= 2.5 ? "中" : "低";
  return {
    ok: true,
    quality_score: +(s.toFixed(1)),
    reliability,
    reasoning: `模型评分 ${s.toFixed(1)}/5，可靠性：${reliability}`,
    usage: r.usage,
  };
}
