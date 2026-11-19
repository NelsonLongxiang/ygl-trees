import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { run } from "../src/agent-cmds";
import { runWorkspaceInvocation } from "../../../../apps/cli/src/workspace-invocation";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
function child(output: string) {
  fs.mkdirSync(path.join(process.cwd(), "tmp"), { recursive: true }); const root = fs.mkdtempSync(path.join(process.cwd(), "tmp/agent-ask-owner-")); roots.push(root);
  const file = path.join(root, "child.cjs");
  fs.writeFileSync(file, 'if(!process.argv.includes("--json")){console.log("human-table");process.exit(0)};process.stdout.write('+JSON.stringify(output)+');');
  return { root, file };
}
describe("matched agent ask machine result", () => {
  it("forwards parsed child JSON through the local sink rather than publishing raw stdout", async () => {
    const fixture = child(JSON.stringify([{ name: "kept" }])), old = process.argv[1], lines: string[] = [], consoleOutput = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.argv[1] = fixture.file;
      const code = await runWorkspaceInvocation({ json: true, color: false, quiet: true }, { dialect: "sqlite", file: "unused.db" }, async scope => {
        const code = run({ home: fixture.root, ctx: scope.ctx } as any, "ask", ["what projects"], {});
        expect(lines).toEqual([]); return code;
      }, { stdout: line => lines.push(line), stderr: () => {} });
      expect(code).toBe(0); expect(consoleOutput).not.toHaveBeenCalled(); expect(lines.map(line => JSON.parse(line))).toEqual([[{ name: "kept" }]]);
    } finally { process.argv[1] = old; }
  });
  it("parent cleanup failure emits just one error JSON even after the child succeeded", async () => {
    const fixture = child('[{"id":"child-success"}]'), old = process.argv[1], lines: string[] = [], raw = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.argv[1] = fixture.file;
      const code = await runWorkspaceInvocation({ json: true, color: false, quiet: true }, { dialect: "sqlite", file: "unused.db" }, async scope => {
        scope.invocation.own({ name: "cleanup-failure", close: () => { throw new Error("release unknown"); } });
        return run({ home: fixture.root, ctx: scope.ctx } as any, "ask", ["what projects"], {});
      }, { stdout: line => lines.push(line), stderr: () => {} });
      expect(code).toBe(1); expect(raw).not.toHaveBeenCalled(); expect(lines.map(line => JSON.parse(line))).toEqual([{ error: "workspace cleanup failed" }]);
    } finally { process.argv[1] = old; }
  });
  it.each(["not-json", '"not-an-object"'])("rejects malformed machine output %s instead of returning success", value => {
    const fixture = child(value), old = process.argv[1], results: unknown[] = [], raw = vi.spyOn(console, "log").mockImplementation(() => {});
    try { process.argv[1] = fixture.file; const code = run({ home: fixture.root, ctx: { json: true, color: false, quiet: true, emitJson: (value: unknown) => results.push(value), failJson: (error: string) => results.push({ error }) } } as any, "ask", ["what projects"], {}); expect(code).toBe(1); expect(results).toHaveLength(1); expect(results[0]).toHaveProperty("error"); expect(raw).not.toHaveBeenCalled(); }
    finally { process.argv[1] = old; }
  });
});
