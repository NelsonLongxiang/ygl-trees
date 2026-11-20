import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { buildTools } from "../src/mcp";
import { parse } from "../../../core/database/src/types";
afterEach(() => vi.restoreAllMocks());
function route() {
  const cp = require("node:child_process") as typeof import("node:child_process");
  const calls: string[][] = [];
  vi.spyOn(cp, "spawn").mockImplementation((_exe: any, argv: any) => {
    calls.push(argv); const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => { child.stdout.end("{}"); child.stderr.end(); child.emit("close", 0); }); return child as any;
  });
  return { calls, write: buildTools({ YGL_HOME: "claim-scope-route" }).find(t => t.name === "write")! };
}
describe("claim scope MCP route", () => {
  it.each([undefined, "", "dept:ops", "bench:x", "*", "restricted"])("passes claim-add scope unchanged (%s)", async scope => {
    const { calls, write } = route(); await write.execute({ domain: "research", action: "claim-add", text: "ruling", project: "p", scope });
    const args = parse(calls[0].slice(1)); expect(args._).toEqual(["research", "claim", "add", "ruling"]); expect(args.flags.scope).toBe(scope); expect(args.flags.p).toBe("p");
  });
  it("passes the command fallback to claim batches", async () => {
    const { calls, write } = route(); await write.execute({ domain: "research", action: "claim-add", batch_file: "claims.jsonl", project: "p", scope: "bench:x" });
    expect(parse(calls[0].slice(1)).flags).toMatchObject({ batch: "claims.jsonl", scope: "bench:x", p: "p" });
  });
  it("routes an explicit empty rescope and publishes the closed action enum", async () => {
    const { calls, write } = route(); expect((write.inputSchema as any).properties.action.enum).toContain("claim-rescope");
    await write.execute({ domain: "research", action: "claim-rescope", id: "claim-id", project: "p", scope: "" });
    const args = parse(calls[0].slice(1)); expect(args._).toEqual(["research", "claim", "rescope", "claim-id"]); expect(args.flags.scope).toBe(""); expect(args.flags.p).toBe("p");
  });
  it.each([null, true, false, [], "public", "dept:ops\n"].map(scope => ({ scope })))("rejects invalid grant before spawning ($scope)", async ({ scope }) => {
    const { calls, write } = route(); await expect(write.execute({ domain: "research", action: "claim-add", text: "ruling", scope })).rejects.toMatchObject({ rc: 2 }); expect(calls).toEqual([]);
  });
  it("requires explicit id and scope on rescope before spawning", async () => {
    const { calls, write } = route();
    for (const input of [{ id: "claim-id" }, { scope: "*" }]) await expect(write.execute({ domain: "research", action: "claim-rescope", ...input })).rejects.toMatchObject({ rc: 2 });
    expect(calls).toEqual([]);
  });
});
