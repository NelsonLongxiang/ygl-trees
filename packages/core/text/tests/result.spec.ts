import { describe, expect, it, vi } from "vitest";
import { InvocationResult, RESULT_MAX_BYTES } from "../src/result";
import { ack, bad, dump, emitJson, show, table, writeResult } from "../src/fmt";

describe("bounded invocation-local JSON result", () => {
  it("holds a detached serialized payload until explicit commit", () => {
    const result = new InvocationResult(), output: string[] = [], value = { id: "kept", duplicate: true };
    result.emitJson(value, 2); value.id = "mutated";
    expect(output).toEqual([]); result.commit(line => output.push(line));
    expect(output).toEqual([JSON.stringify({ id: "kept", duplicate: true }, null, 2)]);
    expect(() => result.commit(() => {})).toThrow(/committed/);
  });
  it("a cleanup failure replaces staged success with one error payload", () => {
    const result = new InvocationResult(), lines: string[] = [];
    result.emitJson({ id: "already-committed-business-row" });
    result.fail("workspace cleanup failed"); result.commit(line => lines.push(line));
    expect(lines).toEqual([JSON.stringify({ error: "workspace cleanup failed" }, null, 2)]);
  });
  it("a primary business error can replace an earlier staged payload without publishing either twice", () => {
    const result = new InvocationResult(), lines: string[] = [];
    result.emitJson({ id: "write" }); result.fail("primary business failure"); result.commit(line => lines.push(line));
    expect(lines).toHaveLength(1); expect(JSON.parse(lines[0])).toEqual({ error: "primary business failure" });
  });
  it("rejects a second payload instead of treating output as an unbounded log", () => {
    const result = new InvocationResult(); result.emitJson([]);
    expect(() => result.emitJson({ extra: true })).toThrow(/already staged/);
    result.commit(() => {}); expect(() => result.fail("late")).toThrow(/committed/);
  });
  it("keeps independent same-process invocations isolated", () => {
    const one = new InvocationResult(), two = new InvocationResult(), first: string[] = [], second: string[] = [];
    one.emitJson({ owner: "one" }); two.emitJson({ owner: "two" }); two.commit(x => second.push(x)); one.commit(x => first.push(x));
    expect(JSON.parse(first[0])).toEqual({ owner: "one" }); expect(JSON.parse(second[0])).toEqual({ owner: "two" });
  });
  it("bounds the serialized bytes and rejects non-JSON roots", () => {
    const result = new InvocationResult(); expect(RESULT_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(() => result.emitJson(undefined)).toThrow(/JSON/);
    expect(() => result.emitJson("x".repeat(RESULT_MAX_BYTES))).toThrow(/result.*limit/);
    result.emitJson({ valid: true }); expect(() => result.commit(() => {})).not.toThrow();
  });
  it.each([
    ["ack", (ctx: any) => ack(ctx, { id: "x" }, "ok")],
    ["bad", (ctx: any) => bad(ctx, "no")],
    ["dump", (ctx: any) => dump(ctx, [{ n: 1 }])],
    ["show", (ctx: any) => show(ctx, { n: 1 })],
    ["table", (ctx: any) => table(ctx, [{ n: 1 }])],
    ["writeResult", (ctx: any) => writeResult(ctx, { row: { id: "x" }, dup: true }, () => "x")],
    ["emitJson", (ctx: any) => emitJson(ctx, { n: 1 })],
  ])("routes %s through the supplied local result port, not console", (_name, run) => {
    const result = new InvocationResult(), stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      run({ json: true, quiet: false, color: false, emitJson: result.emitJson, failJson: result.fail });
      expect(stdout).not.toHaveBeenCalled(); result.commit(line => stdout(line)); expect(stdout).toHaveBeenCalledTimes(1);
      expect(() => JSON.parse(stdout.mock.calls[0][0])).not.toThrow();
    } finally { stdout.mockRestore(); }
  });
  it("a pure helper without an invocation keeps the existing direct-output behavior", () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    try { ack({ json: true, quiet: false, color: false }, { id: "x" }, "ok"); expect(stdout).toHaveBeenCalledWith(JSON.stringify({ id: "x" }, null, 2)); }
    finally { stdout.mockRestore(); }
  });
});
