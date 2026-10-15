import { describe, it, expect } from "vitest";
import { resolveEndpoint, mapOutcome } from "../packages/techtree/eval";

describe("resolveEndpoint (decision_model_llm_api_base 归一化)", () => {
  it("空值回落默认网关", () => {
    expect(resolveEndpoint("")).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
  });
  it("裸主机名自动补标准路径", () => {
    expect(resolveEndpoint("http://127.0.0.1:18999")).toBe(
      "http://127.0.0.1:18999/v4/ai/evaluation-model"
    );
  });
  it("尾斜杠先剥再补", () => {
    expect(resolveEndpoint("https://proxy.example.com/")).toBe(
      "https://proxy.example.com/v4/ai/evaluation-model"
    );
  });
  it("完整端点直用不重复追加", () => {
    const full = "https://gw.internal/v4/ai/evaluation-model";
    expect(resolveEndpoint(full)).toBe(full);
  });
});

describe("mapOutcome (三态映射 + 灰带边界)", () => {
  const t = (p?: number, err?: string) => mapOutcome({ ok: p !== undefined, p, error: err });

  it("P≥pass 阈值 → pass（边界含等号）", () => {
    expect(t(0.7).outcome).toBe("pass");
    expect(t(0.97).outcome).toBe("pass");
  });
  it("P≤fail 阈值 → fail（边界含等号）", () => {
    expect(t(0.4).outcome).toBe("fail");
    expect(t(0.39).outcome).toBe("fail");
  });
  it("灰带开区间 → pending 且带 reason", () => {
    const r = t(0.45);
    expect(r.outcome).toBe("pending");
    expect(r.reason).toContain("gray band");
  });
  it("错误/无概率 → pending 带原因", () => {
    const r = t(undefined, "HTTP 401");
    expect(r.outcome).toBe("pending");
    expect(r.reason).toBe("HTTP 401");
  });
  it("自定义阈值生效（config 传导）", () => {
    expect(mapOutcome({ ok: true, p: 0.75 }, 0.8, 0.4).outcome).toBe("pending");
    expect(mapOutcome({ ok: true, p: 0.85 }, 0.8, 0.4).outcome).toBe("pass");
  });
});
