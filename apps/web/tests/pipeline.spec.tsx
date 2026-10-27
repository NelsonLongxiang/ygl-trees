import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import Pipeline, {
  pipelineRows, overallStance, readView, writeView, VIEW_KEY, type PipelineClaim, type PipelineLink, type PipelineEvidence,
  joinRows, summarize, facetRows, resolveCommand, sourceLabel,
} from "../src/Pipeline";

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

describe("研究管线 antd 重建：表格 + 筛选（用户裁定：不引 pro-components）", () => {
  it("筛选同时匹配断言文本与证据原文", () => {
    expect(pipelineRows(claims, links, evidence, "校准曲线").map((r) => r.id)).toEqual(["c2"]);
    expect(pipelineRows(claims, links, evidence, "相反证据").map((r) => r.id)).toEqual(["c3"]); // only in a quote
    expect(pipelineRows(claims, links, evidence, "  ").length).toBe(claims.length);
  });

  it("行带上已解析的证据，未知状态归入未验证", () => {
    const rows = pipelineRows([...claims, { id: "c9", text: "x", status: "weird" }], links, evidence);
    expect(rows.find((r) => r.id === "c1")!.items.map((x) => x.ev.id)).toEqual(["e1", "e2"]);
    expect(rows.find((r) => r.id === "c9")!.bucket).toBe("unverified");
  });

  it("表格看法：列头、状态词、默认按状态再按支持数排序", () => {
    const html = renderToStaticMarkup(
      createElement(Pipeline, { claims, claimEvidence: links, evidence, defaultView: "table" })
    );
    for (const h of ["状态", "断言", "支持", "反驳", "证据"]) expect(html).toContain(`>${h}<`);
    for (const w of ["已证实", "有争议", "未验证", "已反驳"]) expect(html).toContain(w);
    const order = ["断言一", "断言二", "断言三", "断言四", "断言五"].map((t) => html.indexOf(t));
    expect(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1]))).toBe(true);
    expect(html).not.toMatch(/border-left:3px solid/); // the scan edge is the board's, not the table's
  });

  it("看板 / 表格切换与筛选框都在", () => {
    const html = render();
    expect(html).toContain("看板");
    expect(html).toContain("表格");
    expect(html).toContain('aria-label="筛选断言"');
  });
});

describe("评审 0e0fcfa：看法持久化 / 筛选收窄看板 / 徽章整体立场 / 键盘可展开", () => {
  it("readView / writeView 走可注入的存储；坏值与抛错的存储都回 null、不抛", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
    expect(readView(store)).toBeNull();
    writeView("table", store);
    expect(mem.get(VIEW_KEY)).toBe("table");
    expect(readView(store)).toBe("table");
    mem.set(VIEW_KEY, "weird");
    expect(readView(store)).toBeNull();
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readView(throwing)).toBeNull();
    expect(() => writeView("board", throwing)).not.toThrow();
  });

  it("存储一访问就抛（localStorage getter 抛 SecurityError）：readView / writeView 不抛，管线照常渲染（780f894 回归）", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { get localStorage() { throw new Error("SecurityError: The operation is insecure."); } },
    });
    try {
      expect(readView()).toBeNull();
      expect(() => writeView("table")).not.toThrow();
      const html = renderToStaticMarkup(createElement(Pipeline, { claims, claimEvidence: links, evidence }));
      expect(html).toContain("已证实");
      expect(html).toContain("断言一");
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("筛选词只留下命中的断言（看板），并显示 n / N 计数", () => {
    const html = renderToStaticMarkup(
      createElement(Pipeline, { claims, claimEvidence: links, evidence, defaultView: "board", defaultNeedle: "校准曲线" })
    );
    expect(html).toContain("断言二");
    expect(html).not.toContain("断言一");
    expect(html).toContain("1 / 5 条断言");
  });

  it("证据徽章按整体立场取色（支持 + 反驳并存 = warning），是可聚焦的 button，立场标签用 ToneTag", () => {
    const mixed: PipelineLink[] = [
      { claim_id: "c1", evidence_id: "e1", stance: "supports" },
      { claim_id: "c1", evidence_id: "e3", stance: "refutes" },
    ];
    const html = renderToStaticMarkup(
      createElement(Pipeline, { claims: claims.slice(0, 1), claimEvidence: mixed, evidence, defaultView: "board" })
    );
    expect(html).toMatch(/<button[^>]*aria-expanded="false"/);
    expect(html).toContain('title="支持与反驳并存"');
    expect(html).toContain("color:var(--color-warning);border-color:var(--color-warning)");
    expect(overallStance(pipelineRows(claims, links, evidence).find((r) => r.id === "c3")!.items).color).toBe("var(--color-danger)");
    expect(overallStance(pipelineRows(claims, links, evidence).find((r) => r.id === "c1")!.items).color).toBe("var(--color-success)");
  });
});

describe("专家 ↔ agent 协同：状态条、证据薄弱筛选、裁决命令、来源标题", () => {
  const rows = joinRows(claims, links, evidence);

  it("summarize counts every status and how thin the evidence is", () => {
    const s = summarize(rows);
    expect(s.status).toEqual({ supported: 2, contested: 1, unverified: 1, refuted: 1 });
    expect(s.none).toBe(3); // c2, c4, c5 have no linked evidence
    expect(s.single).toBe(1); // c3
  });

  it("status and evidence facets narrow together; null means all", () => {
    expect(facetRows(rows, { status: "supported", evidence: null }).map((r) => r.id)).toEqual(["c1", "c2"]);
    expect(facetRows(rows, { status: "supported", evidence: "none" }).map((r) => r.id)).toEqual(["c2"]);
    expect(facetRows(rows, { status: null, evidence: "single" }).map((r) => r.id)).toEqual(["c3"]);
    expect(facetRows(rows, { status: null, evidence: null })).toHaveLength(5);
  });

  it("the verdict command is the CLI's own, pinned to the project on screen", () => {
    expect(resolveCommand("c4", "refuted", "jf")).toBe("ygl-trees research claim resolve c4 --as refuted -p jf");
    expect(resolveCommand("c4", "supported")).toBe("ygl-trees research claim resolve c4 --as supported");
  });

  it("evidence names its source by title when the page has it, else locator, else id", () => {
    const titles = new Map([["s1", "npm 发布记录"], ["s2", "评审纪要"]]);
    expect(sourceLabel({ id: "e", quote: "q", locator: "P1 段", source_id: "s2" }, titles)).toBe("评审纪要 · P1 段");
    expect(sourceLabel({ id: "e", quote: "q", locator: "https://example.com/a", source_id: "s1" }, titles)).toBe("npm 发布记录"); // a url locator adds nothing
    expect(sourceLabel({ id: "e", quote: "q", locator: "P2 段", source_id: "s9" }, titles)).toBe("P2 段");
    expect(sourceLabel({ id: "e", quote: "q", source_id: "s9" }, titles)).toBe("s9");
  });

  const html = renderToStaticMarkup(createElement(Pipeline, { claims, claimEvidence: links, evidence, project: "jf" }));

  it("the strip names each status with its count and share, and filters by pressed buttons", () => {
    expect(html).toContain('aria-label="按状态与证据筛选"');
    expect(html).toMatch(/已证实 2<\/span><span[^>]*>40%/);
    expect(html).toContain("无证据 3");
    expect(html).toContain("仅一条证据 1");
    expect((html.match(/aria-pressed="false"/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it("only claims awaiting a verdict (unverified / contested) offer the verdict copy", () => {
    expect((html.match(/>裁决 /g) ?? []).length).toBe(2);
  });

  it("a claim with no evidence says so instead of showing an empty badge", () => {
    expect(html).toContain("无证据</span>");
  });

  it("a facet narrows the board and shows how many remain", () => {
    const f = renderToStaticMarkup(createElement(Pipeline, { claims, claimEvidence: links, evidence, defaultFacets: { status: "refuted", evidence: null } }));
    expect(f).toContain("1 / 5 条断言");
    expect(f).toContain("断言五");
    expect(f).not.toContain("断言一");
    expect(f).toContain("清除筛选");
  });
});
