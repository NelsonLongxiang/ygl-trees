import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import Verify, { ScopeTag, scopeLabel } from "../src/Verify";

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
  it("缺省按 structural 读并标明缺省", () => {
    expect(scopeLabel(undefined)).toBe("仅结构");
    expect(scopeLabel(null)).toBe("仅结构");
    const html = renderToStaticMarkup(createElement(ScopeTag, { scope: undefined }));
    expect(html).toContain("边界 仅结构·缺省");
    expect(html).toContain("不断言其内容或子结论为真");
    expect(html).toContain("报告无 semantic_scope 字段");
  });

  it("声明值按闭集映射，未知值原样显示、不升级", () => {
    expect(scopeLabel("structural")).toBe("仅结构");
    expect(scopeLabel("factual")).toBe("事实");
    expect(scopeLabel("semantic")).toBe("语义");
    expect(scopeLabel("whatever")).toBe("whatever");
    const html = renderToStaticMarkup(createElement(ScopeTag, { scope: "factual" }));
    expect(html).toContain("边界 事实");
    expect(html).not.toContain("缺省");
  });
});
