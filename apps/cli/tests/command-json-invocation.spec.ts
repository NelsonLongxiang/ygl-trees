import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runWorkspaceInvocation } from "../src/workspace-invocation";
import { run as predict } from "../../../packages/research/pipeline/src/predict-cmds";
import { refuseMeta } from "../../../packages/ops/tools/src/meta-gate";
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const cases = ["empty-predictions", "prediction-list", "prediction-audit", "meta-refusal", "meta-refusal-report"] as const;
async function command(kind: typeof cases[number], ctx: any): Promise<number> {
  if (kind.startsWith("meta-")) return refuseMeta({ ctx } as any, {
    pass: false, message: "meta admission refused", meta_error: "meta_failed",
    ...(kind === "meta-refusal-report" ? { report: { verdict: "FAIL", rules: [{ id: "R3", verdict: "FAIL" }] } as any } : {}),
  });
  const claims = kind === "empty-predictions" ? [] : [{ id: "prediction", text: "[预测·7天] 2000-01-01 前 树≥1", status: "unverified", confidence: 0.8, created: "1999-12-25", channel: "local" }];
  const db = { all: (sql: string) => sql.includes("FROM claims") ? claims : [], get: () => ({ c: 1 }) };
  return predict({ ctx, store: { db } } as any, { id: "project", name: "project" }, { flags: { json: true, ...(kind === "prediction-audit" ? { offline: true } : {}) } }, kind === "prediction-audit" ? "audit" : "list");
}
describe("remaining command JSON belongs to the invocation result", () => {
  it.each(cases.flatMap(kind => [false, true].map(failedCleanup => ({ kind, failedCleanup }))))("publishes $kind only after cleanup (failure=$failedCleanup)", async ({ kind, failedCleanup }) => {
    const raw: string[] = [], stdout: string[] = [], stderr: string[] = [], entered = gate(), release = gate(), signals = new EventEmitter();
    const spy = vi.spyOn(console, "log").mockImplementation(value => { raw.push(String(value)); });
    let running: Promise<number> | undefined;
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    try {
      const legacyCode = await command(kind, { json: true, color: false, quiet: false });
      expect(legacyCode).toBe(kind.startsWith("meta-") ? 1 : 0);
      expect(raw).toHaveLength(1); const legacyBytes = raw[0], payload = JSON.parse(legacyBytes); raw.length = 0;
      if (kind.startsWith("meta-")) expect(payload).toMatchObject({ error: "meta admission refused", meta_error: "meta_failed" });
      else { expect(Array.isArray(payload)).toBe(true); expect(payload).toHaveLength(kind === "empty-predictions" ? 0 : 1); }
      running = runWorkspaceInvocation({ json: true, color: false, quiet: false }, { dialect: "sqlite", file: "unused-json-owner.db" }, async scope => {
        scope.invocation.own({ name: "native-consumer", close: async () => { entered.resolve(); await release.promise; if (failedCleanup) throw new Error("private cleanup diagnostic"); } });
        return command(kind, scope.ctx);
      }, { stdout: line => { stdout.push(line); }, stderr: line => { stderr.push(line); }, signals, forceExit: () => {} });
      await entered.promise; expect(raw).toEqual([]); expect(stdout).toEqual([]);
      release.resolve(); expect(await running).toBe(failedCleanup && legacyCode === 0 ? 1 : legacyCode);
      expect(raw).toEqual([]); expect(stdout).toHaveLength(1);
      if (failedCleanup && legacyCode === 0) expect(JSON.parse(stdout[0])).toEqual({ error: "workspace cleanup failed" });
      else { expect(stdout[0]).toBe(legacyBytes); expect(JSON.parse(stdout[0])).toEqual(payload); }
      expect(stderr).toHaveLength(failedCleanup ? 1 : 0); expect(stderr.join("\n")).not.toContain("private cleanup diagnostic");
      expect(signals.listenerCount("SIGINT")).toBe(0); expect(signals.listenerCount("SIGTERM")).toBe(0);
    } finally { release.resolve(); try { await running; } finally { spy.mockRestore(); vi.useRealTimers(); } }
  });
});
