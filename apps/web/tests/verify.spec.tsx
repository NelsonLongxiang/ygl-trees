import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import Verify from "../src/Verify";

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

  it("材料提交：标题 + 一段话 + 附件走 CLI 的诚实说明", () => {
    expect(html).toContain("标题");
    expect(html).toContain("一段话");
    // 附件还没接 WebUI：必须明说，不能让「提交成功」掩盖材料缺失
    expect(html).toContain("verify submit --attach");
    expect(html).toContain("结构化是 agent 构造的产物");
  });

  it("构造追溯是只读审计面：有说明、没有确认按钮", () => {
    // 入口标签在，选中规范后才有只读审计说明；这里断言不存在放行类按钮文案
    expect(html).not.toContain("确认通过");
    expect(html).not.toContain("批准");
    expect(html).not.toContain("✓ 通过");
  });
});
