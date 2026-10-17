/**
 * OpsPlugin — provides ctx.ops (OpsService).
 * Injects: database.
 *
 * Model-eval services (R15 eval-enhance) exposed as a Cordis service so
 * domains call ctx.ops.evalClaim instead of cross-package requires:
 * research pipeline (claim link auto-eval / manual evaluate / evidence
 * assess) and knowledge skills (semantic re-rank).
 *
 * @module @ygl/ops-tools/plugin
 */
import { Context, Service } from "@deepseek-ai/cordis";
import {
  evaluateClaimConfidence,
  assessEvidenceQuality,
  semanticReRank,
} from "./eval-enhance";

declare module "@deepseek-ai/cordis" {
  interface Context {
    ops: OpsService;
  }
}

export class OpsService extends Service {
  static readonly inject = ["database"] as const;

  constructor(ctx: Context) {
    super(ctx, "ops");
  }

  /** Claim confidence eval (0.84 claim.eval channel). Offline → ok:false. */
  evalClaim(payload: Parameters<typeof evaluateClaimConfidence>[0]) {
    return evaluateClaimConfidence(payload);
  }

  /** Evidence quality assessment (R15.2). */
  assessEvidence(payload: Parameters<typeof assessEvidenceQuality>[0]) {
    return assessEvidenceQuality(payload);
  }

  /** KB semantic re-rank (R15.1). */
  semanticRank(query: string, candidates: Parameters<typeof semanticReRank>[1]) {
    return semanticReRank(query, candidates);
  }
}

export const inject = ["database"];

export function apply(ctx: Context) {
  new OpsService(ctx);
}
