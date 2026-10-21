import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import Verify, { ReportDetail, ScopeTag, scopeHint, scopeLabel } from "../src/Verify";
import type { VerifyReportDetail } from "../src/api";

/**
 * M13-2 三视图渲染验证（静态渲染，不引 jsdom——与 pipeline.spec.tsx 同法）：
 * 三个视图入口存在、材料提交是「标题 + 一段话 + 附件走 CLI」的诚实形态、
 * 构造追溯明确标出「只读审计面」而不是假放行按钮。
 */
describe("verify 三视图（M13-2）", () => {
  const html = renderToStaticMarkup(createElement(Verify));

  it("三个视图入口齐备", () => {
    expect(html).toContain("材料提交");
    expect(html).toContain("构造追溯");
    expect(html).toContain("报告看板");
  });

  it("材料提交：标题 + 一段话 + 附件先入内容寻址仓（提交只带 sha256 引用）", () => {
    expect(html).toContain("标题");
    expect(html).toContain("一段话");
    // 附件走原始字节 PUT：客户端不报哈希、不传路径，服务端算 sha256 并去重
    expect(html).toContain("选择文件并上传");
    expect(html).toContain("全局去重");
    expect(html).toContain("结构化是 agent 构造的产物");
  });

  it("构造追溯是只读审计面：有说明、没有确认按钮", () => {
    // 入口标签在，选中规范后才有只读审计说明；这里断言不存在放行类按钮文案
    expect(html).not.toContain("确认通过");
    expect(html).not.toContain("批准");
    expect(html).not.toContain("✓ 通过");
  });
});

/**
 * #27 Q3 / 方案 T6：报告看板首屏透出语义边界。契约 ≤1.2 的报告没有 semantic_scope 字段，
 * 必须按最保守的 structural（「仅结构」）显示并标明缺省——父 PASS 不代表子结论为真。
 */
describe("语义边界标签（T6）", () => {
  it("缺省按 structural 读并标明缺省；说明对读屏可达（aria-label），且不描述检查器实际做了什么", () => {
    expect(scopeLabel(undefined)).toBe("仅结构");
    expect(scopeLabel(null)).toBe("仅结构");
    const html = renderToStaticMarkup(createElement(ScopeTag, { scope: undefined }));
    expect(html).toContain("边界 仅结构·缺省");
    expect(html).toMatch(/tabindex="0"/);
    // 说明是读屏可读的视觉隐藏文本，不是给 generic span 的 aria-label（ARIA 1.2 禁止命名 generic）
    expect(html).not.toContain("aria-label");
    expect(html).toMatch(/clip:rect\(0 0 0 0\)[^>]*>：报告未声明边界/);
    expect(scopeHint(undefined)).toContain("按最保守的 structural 读");
    expect(scopeHint(undefined)).toContain("不据此断言子结论为真");
    // 缺省提示只说「怎么读」：一个按缺省读的 sql 判据确实判了数据，不能被说成「文件 / 归档在场」
    expect(scopeHint(undefined)).not.toContain("文件 / 行 / 归档可验");
    expect(scopeHint("structural")).toContain("文件 / 行 / 归档可验");
  });

  it("声明值按闭集映射，未知值原样显示、不升级", () => {
    expect(scopeLabel("structural")).toBe("仅结构");
    expect(scopeLabel("factual")).toBe("事实");
    expect(scopeLabel("semantic")).toBe("语义");
    expect(scopeLabel("whatever")).toBe("whatever");
    expect(scopeHint("whatever")).toContain("按 structural 读");
    const html = renderToStaticMarkup(createElement(ScopeTag, { scope: "factual" }));
    expect(html).toContain("边界 事实");
    expect(html).not.toContain("缺省");
  });

  const fixture = (over: Partial<VerifyReportDetail["report"]> = {}): VerifyReportDetail => ({
    report: {
      run_id: "run_fixture0000000001",
      overall: "PASS",
      reason: "all assert units PASS",
      summary: { pass: 2, fail: 0, needs_material: 0, error: 0 },
      started: "2026-10-21T00:00:00.000Z",
      finished: "2026-10-21T00:00:01.000Z",
      verifier: { mode: "open" },
      vu: [
        { id: "V1", verdict: "PASS", checker_type: "sql", source_clause: "账单金额不得为负。", evidence: { violations: 0 } },
        { id: "V2", verdict: "PASS", checker_type: "file", source_clause: "附件齐备。", evidence: { files: 2, matched: 2 } },
      ],
      exceptions: [],
      ...over,
    },
    archives: [],
  });

  it("≤1.2 报告的详情：边界只在首屏出现一次 + 一行缺省说明；VU 表不加边界列", () => {
    const html = renderToStaticMarkup(createElement(ReportDetail, { detail: fixture() }));
    // 只数可见文本节点（aria-label 里还有一份同文，那是给读屏的，不算重复显示）
    expect((html.match(/>边界 仅结构·缺省</g) ?? []).length).toBe(1);
    expect(html).toContain("父验证器的 PASS 不代表子结论为真");
    expect(html).not.toMatch(/<th[^>]*>边界<\/th>/);
    expect(html).toContain("V1");
    expect(html).toContain("V2");
  });

  it("带 semantic_scope 的报告（契约 1.3 起）：首屏显示声明值，VU 表按声明逐行显示边界", () => {
    const d = fixture({ semantic_scope: "structural" });
    d.report.vu[0].semantic_scope = "factual";
    d.report.vu[1].semantic_scope = "structural";
    const html = renderToStaticMarkup(createElement(ReportDetail, { detail: d }));
    expect(html).not.toContain("缺省");
    expect(html).toMatch(/<th[^>]*>边界<\/th>/);
    expect((html.match(/>边界 事实</g) ?? []).length).toBe(1); // V1 一行
    expect((html.match(/>边界 仅结构</g) ?? []).length).toBe(2); // 报告头一次 + V2 一行
  });
});
