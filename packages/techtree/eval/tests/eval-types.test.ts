import { describe, it, expect, afterAll } from "vitest";
import * as http from "node:http";
import {
  parseEvalSpec,
  packEvalChoiceSpec,
  packEvalScoreSpec,
  mapChoiceOutcome,
  mapScoreOutcome,
  evalChoice,
  evalScore,
  evalBoolean,
} from "../src/eval";

// ── local stub gateway: records request bodies, answers canned shapes ──
let lastBodies: any[] = [];
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    lastBodies.push(JSON.parse(body));
    const qs = Object.keys(JSON.parse(body).questions);
    const answers: any = {};
    for (const q of qs) {
      const type = JSON.parse(body).questions[q].type;
      if (type === "boolean") answers[q] = { type, probability: 0.95 };
      if (type === "choice") answers[q] = { type, choice: "proc", probabilities: { proc: 0.9, ops: 0.1 } };
      if (type === "score") answers[q] = { type, score: 2.31, probabilities: { "0": 0.02, "1": 0.3, "2": 0.68 } };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ answers, rounding: { probabilityDecimals: 2, scoreDecimals: 2 }, usage: {}, warnings: [] }));
  });
});
afterAll(() => new Promise((r) => stub.close(r)));

async function stubUrl(): Promise<string> {
  if (!stub.listening) await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const a = stub.address() as any;
  return `http://127.0.0.1:${a.port}/v4/ai/evaluation-model`;
}

describe("stub gateway：协议形状与真实 HTTP 路径", () => {
  it("evalChoice 发 choice+criteria，映射期望答案概率", async () => {
    const url = await stubUrl();
    const r = await evalChoice({ ctx: 1 }, "派哪个团队", { proc: "采购", ops: "物流" }, "t", url);
    expect(r.ok).toBe(true);
    expect(r.choice).toBe("proc");
    const q = lastBodies.at(-1).questions.q;
    expect(q.type).toBe("choice");
    expect(q.criteria).toEqual({ proc: "采购", ops: "物流" });
    const m = mapChoiceOutcome(r, "proc");
    expect(m.outcome).toBe("pass");
    expect(m.p).toBe(0.9);
    expect(mapChoiceOutcome(r, "ops").outcome).toBe("fail");
  });
  it("evalScore 发 score+criteria levels，映射 ±1 灰带", async () => {
    const url = await stubUrl();
    const r = await evalScore({ ctx: 1 }, "成熟度", ["原型", "可用", "成熟"], "t", url);
    expect(r.ok).toBe(true);
    expect(r.score).toBe(2.31);
    const q = lastBodies.at(-1).questions.q;
    expect(q.type).toBe("score");
    expect(q.criteria).toEqual(["原型", "可用", "成熟"]);
    expect(mapScoreOutcome(r, 2).outcome).toBe("pass");
    expect(mapScoreOutcome(r, 3).outcome).toBe("pending"); // 2.31 ∈ [2,3)
    expect(mapScoreOutcome(r, 4).outcome).toBe("fail"); // 2.31 ≤ 3
  });
  it("evalBoolean 走共享传输层仍工作（回归）", async () => {
    const url = await stubUrl();
    const r = await evalBoolean({ ctx: 1 }, "完成了吗", "t", url);
    expect(r).toEqual({ ok: true, p: 0.95 });
  });
  it("无 token 离线安全（不出网）", async () => {
    const r = await evalChoice({}, "q", { a: "x" }, "");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no evaluator configured");
    const s = await evalScore({}, "q", ["a", "b"], "");
    expect(s.ok).toBe(false);
  });
});

describe("eval question envelope", () => {
  it("plain question 向后兼容（op=eval 的 value 不是 JSON）", () => {
    expect(parseEvalSpec("研究任务已完成吗")).toEqual({ q: "研究任务已完成吗" });
    expect(parseEvalSpec("")).toEqual({ q: "" });
    expect(parseEvalSpec(undefined)).toEqual({ q: "" });
  });
  it("坏 JSON 回落 plain", () => {
    expect(parseEvalSpec("{not json")).toEqual({ q: "{not json" });
    expect(parseEvalSpec('{"noq":1}')).toEqual({ q: '{"noq":1}' });
  });
  it("choice 信封 pack→parse 往返", () => {
    const v = packEvalChoiceSpec("该派哪个团队", { ops: "物流", proc: "采购" }, "proc");
    const spec = parseEvalSpec(v);
    expect(spec.q).toBe("该派哪个团队");
    expect(spec.options).toEqual({ ops: "物流", proc: "采购" });
    expect(spec.answer).toBe("proc");
  });
  it("score 信封 pack→parse 往返", () => {
    const v = packEvalScoreSpec("成熟度如何", ["原型", "可用", "成熟"], 2);
    const spec = parseEvalSpec(v);
    expect(spec.q).toBe("成熟度如何");
    expect(spec.levels).toEqual(["原型", "可用", "成熟"]);
    expect(spec.min).toBe(2);
  });
});

describe("mapChoiceOutcome 三态（期望答案的概率）", () => {
  const r = (probs: Record<string, number>, choice = "a") =>
    ({ ok: true, choice, probabilities: probs } as any);
  it("P(answer) ≥ 0.7 → pass（即便 top pick 是别的，按期望答案判）", () => {
    expect(mapChoiceOutcome(r({ a: 0.7 }), "a").outcome).toBe("pass");
    expect(mapChoiceOutcome(r({ a: 0.95, b: 0.05 }), "a").outcome).toBe("pass");
  });
  it("P(answer) ≤ 0.4 → fail", () => {
    expect(mapChoiceOutcome(r({ a: 0.4, b: 0.6 }, "b"), "a").outcome).toBe("fail");
  });
  it("灰带 (0.4, 0.7) → pending", () => {
    const m = mapChoiceOutcome(r({ a: 0.55 }), "a");
    expect(m.outcome).toBe("pending");
    expect(m.reason).toContain("gray band");
  });
  it("自定义阈值", () => {
    expect(mapChoiceOutcome(r({ a: 0.8 }), "a", 0.9, 0.5).outcome).toBe("pending");
    expect(mapChoiceOutcome(r({ a: 0.8 }), "a", 0.8, 0.5).outcome).toBe("pass");
  });
  it("评估失败/期望答案不在分布内 → pending", () => {
    expect(mapChoiceOutcome({ ok: false, error: "no evaluator" } as any, "a").outcome).toBe("pending");
    expect(mapChoiceOutcome(r({ b: 1 }), "a").outcome).toBe("pending");
  });
});

describe("mapScoreOutcome 三态（等级 ±1 灰带）", () => {
  const r = (score: number) => ({ ok: true, score, probabilities: {} } as any);
  it("score ≥ min → pass", () => {
    expect(mapScoreOutcome(r(2), 2).outcome).toBe("pass");
    expect(mapScoreOutcome(r(2.5), 2).outcome).toBe("pass");
  });
  it("score ≤ min-1 → fail", () => {
    expect(mapScoreOutcome(r(1), 2).outcome).toBe("fail");
    expect(mapScoreOutcome(r(0.3), 2).outcome).toBe("fail");
  });
  it("[min-1, min) 灰带 → pending", () => {
    const m = mapScoreOutcome(r(1.17), 2);
    expect(m.outcome).toBe("pending");
    expect(m.reason).toContain("gray band");
  });
  it("评估失败 → pending", () => {
    expect(mapScoreOutcome({ ok: false, error: "no evaluator" } as any, 2).outcome).toBe("pending");
  });
});
