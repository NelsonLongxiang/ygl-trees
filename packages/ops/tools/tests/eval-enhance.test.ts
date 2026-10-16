/** Tests for eval-enhance (R15) — offline safety paths. */
import { describe, it, expect } from "vitest";
import {
  semanticReRank,
  evaluateClaimConfidence,
  assessEvidenceQuality,
} from "../src/eval-enhance";

describe("R15.1 semanticReRank（离线安全）", () => {
  it("无 token → 保持原序，semantic_relevance=null", async () => {
    const candidates = [
      { id: "a", title: "笔记A", excerpt: "内容A" },
      { id: "b", title: "笔记B", excerpt: "内容B" },
    ];
    const result = await semanticReRank("查询", candidates, ""); // 空 token
    expect(result.length).toBe(2);
    expect(result[0].id).toBe("a"); // 原序
    expect(result[0].semantic_relevance).toBeNull();
    expect(result[0].re_ranked).toBe(false);
  });
});

describe("R15.2 evaluateClaimConfidence（离线安全）", () => {
  it("无 token → ok=false, label=uncertain, 不炸", async () => {
    const result = await evaluateClaimConfidence(
      { claim_text: "测试断言", claim_status: "supported", evidence: [{ quote: "证据", stance: "supports" }] },
      "" // 空 token
    );
    expect(result.ok).toBe(false);
    expect(result.confidence_score).toBeNull();
    expect(result.confidence_label).toBe("uncertain");
    expect(result.reasoning).toContain("不可用");
  });
});

describe("R15.3 assessEvidenceQuality（离线安全）", () => {
  it("无 token → ok=false, reliability=uncertain, 不炸", async () => {
    const result = await assessEvidenceQuality(
      { quote: "引文", source_title: "来源" },
      "" // 空 token
    );
    expect(result.ok).toBe(false);
    expect(result.quality_score).toBeNull();
    expect(result.reliability).toBe("uncertain");
  });
});
