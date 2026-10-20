import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import Pipeline, { type PipelineClaim, type PipelineLink, type PipelineEvidence } from "../src/Pipeline";

/**
 * 0.92 单A 渲染验证（direct-0f20e882 队列工单验收①）：管线视图按状态分组
 * 水流式渲染，claim 卡携带状态色左沿 + 支持/反驳计数，证据链接可展开。
 * 用 react-dom/server 的 renderToStaticMarkup（已有依赖，不引 jsdom）：
 * 断言分组标题/计数/引文文本/状态色 token 全部落在产出 markup 里。
 */

const claims: PipelineClaim[] = [
  { id: "c1", text: "断言一：npm 版本序列会自然增长", status: "supported", sup: 3, ref: 0 },
  { id: "c2", text: "断言二：校准曲线模型档偏低", status: "supported", sup: 2, ref: 1 },
  { id: "c3", text: "断言三：第 9 轮口径按评审轮计", status: "contested", sup: 1, ref: 1 },
  { id: "c4", text: "断言四：未验证的观察", status: "unverified", sup: 0, ref: 0 },
  { id: "c5", text: "断言五：已被推翻", status: "refuted", sup: 0, ref: 2 },
];

const links: PipelineLink[] = [
  { claim_id: "c1", evidence_id: "e1", stance: "supports" },
  { claim_id: "c1", evidence_id: "e2", stance: "supports" },
  { claim_id: "c3", evidence_id: "e3", stance: "refutes" },
];

const evidence: PipelineEvidence[] = [
  { id: "e1", quote: "npm view 返回 0.91.0 实测记录", locator: "https://example.com/a", source_id: "s1" },
  { id: "e2", quote: "第二证据原文摘录", source_id: "s2" },
  { id: "e3", quote: "口径争议的相反证据", source_id: "s3" },
];

const render = () =>
  renderToStaticMarkup(createElement(Pipeline, { claims, claimEvidence: links, evidence }));

describe("0.92 单A 管线视图渲染验证", () => {
  it("groups by status with labels + counts (word + color, never color alone)", () => {
    const html = render();
    expect(html).toContain("已证实");
    expect(html).toContain("（2）"); // two supported
    expect(html).toContain("有争议");
    expect(html).toContain("未验证");
    expect(html).toContain("已反驳");
    expect(html).toContain("（1）");
  });

  it("renders claim texts and sup/ref counters", () => {
    const html = render();
    expect(html).toContain("断言一：npm 版本序列会自然增长");
    expect(html).toContain("支持 3");
    expect(html).toContain("反驳 2"); // c5 ref=2
  });

  it("carries status-color left borders from DESIGN.md tokens", () => {
    const html = render();
    // Two themes (DESIGN.md ## Themes): inline colors are the token's CSS var,
    // so the edge follows the theme switch — assert the token NAME, never a
    // literal hex that would pin one theme.
    expect(html).toMatch(/border-left:3px solid var\(--color-success\)/);
    expect(html).toMatch(/border-left:3px solid var\(--color-danger\)/);
    expect(html).not.toMatch(/border-left:3px solid #/);
  });

  it("shows the evidence link affordance with per-claim counts", () => {
    const html = render();
    expect(html).toContain("证据 ×2"); // c1 has two links
    expect(html).toContain("证据 ×1"); // c3
  });

  it("renders nothing but the empty state when no claims (R19: unselected → not mounted at all)", () => {
    const html = renderToStaticMarkup(
      createElement(Pipeline, { claims: [], claimEvidence: [], evidence: [] })
    );
    expect(html).toContain("暂无断言");
    expect(html).not.toContain("已证实");
  });

  it("unknown status buckets into 未验证 (defensive default)", () => {
    const html = renderToStaticMarkup(
      createElement(Pipeline, {
        claims: [{ id: "x", text: "神秘状态断言", status: "weird", sup: 0, ref: 0 }],
        claimEvidence: [],
        evidence: [],
      })
    );
    expect(html).toContain("未验证");
    expect(html).toContain("神秘状态断言");
  });
});
