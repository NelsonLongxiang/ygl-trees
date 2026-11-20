import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { buildTools } from "../src/mcp";
import { parse } from "../../../core/database/src/types";
afterEach(() => vi.restoreAllMocks());
function route() {
  const cp = require("node:child_process") as typeof import("node:child_process");
  const calls: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
  vi.spyOn(cp, "spawn").mockImplementation((_exe: any, argv: any, options: any) => {
    calls.push({ argv, env: options.env });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => { child.stdout.end(JSON.stringify({ contract: "ygl-library/1", items: [], total: 0, next_cursor: null })); child.stderr.end(); child.emit("close", 0); });
    return child as any;
  });
  return { calls, read: buildTools({ YGL_HOME: "isolated-route-fixture" }).find(t => t.name === "read")! };
}
describe("library project MCP routing", () => {
  it.each([undefined, "alpha", "true", "O'Reilly project", "--json", "--scope=restricted"])("preserves explicit project exactly without changing other flags (%s)", async project => {
    const { calls, read } = route();
    expect(await read.execute({ domain: "library", action: "list", kind: "claim", project, limit: 1 })).toMatchObject({ contract: "ygl-library/1", items: [] });
    expect(calls).toHaveLength(1);
    const parsed = parse(calls[0].argv.slice(1));
    expect(parsed._).toEqual(["library", "list"]); expect(parsed.flags.kind).toBe("claim"); expect(parsed.flags.project).toBe(project);
    expect(parsed.flags.limit).toBe("1"); expect(parsed.flags.json).toBe(true); expect(parsed.flags.scope).toBeUndefined();
    expect(calls[0].env.YGL_HOME).toBe("isolated-route-fixture");
  });
  it.each(["", "   ", true, false, null, ["alpha"]].map(project => ({ project })))("rejects invalid project before spawning a CLI child ($project)", async ({ project }) => {
    const { calls, read } = route();
    await expect(read.execute({ domain: "library", action: "list", kind: "claim", project })).rejects.toMatchObject({ rc: 2, json: { error: expect.stringMatching(/project.*value|project.*name/) } });
    expect(calls).toEqual([]);
  });
});
