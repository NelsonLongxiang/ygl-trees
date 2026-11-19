import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { runWorkspaceInvocation } from "../src/workspace-invocation";
import { run as verifyCommand } from "../../../packages/ops/tools/src/verify-cmds";
import { payloadHash } from "../../../packages/verify/core/src/engine";

function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const cases = [
  { field: "run_id", patch: { run_id: "../outside" } },
  { field: "spec_id", patch: { spec_id: "../outside" } },
  { field: "binary_sha256", patch: { verifier: { binary_sha256: "../outside" } } },
];
describe("report import invocation-local refusal receipt", () => {
  it.each(cases.flatMap(item => [false, true].map(failedCleanup => ({ ...item, failedCleanup }))))("holds $field refusal until cleanup settles (cleanup failure=$failedCleanup)", async ({ field, patch, failedCleanup }) => {
    const root = mkdtempSync(join(tmpdir(), "report-invocation-")), home = join(root, "home"), input = join(root, "input.json");
    mkdirSync(home);
    const value = { contract_version: "1.1", run_id: "run_invocation", spec_id: "spec_invocation", verifier: {}, summary: {}, ...patch };
    writeFileSync(input, JSON.stringify({ ...value, payload_sha256: payloadHash(value as any) }));
    const stdout: string[] = [], stderr: string[] = [], raw: unknown[][] = [], entered = gate(), release = gate(), signals = new EventEmitter();
    const noDb = new Proxy({}, { get: () => { throw new Error("refused import accessed a database"); } });
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => { raw.push(args); });
    let running: Promise<number> | undefined;
    try {
      running = runWorkspaceInvocation({ json: true, quiet: false, color: false }, { dialect: "sqlite", file: join(root, "unused.db") }, async scope => {
        scope.invocation.own({ name: "import-consumer", close: async () => {
          entered.resolve(); await release.promise;
          if (failedCleanup) throw new Error("postgres://user:secret@private/cleanup");
        } });
        const env = { home, ctx: scope.ctx, db: noDb, store: noDb, asyncStore: noDb, group: "verify", args: { _: [], flags: { json: true } } } as any;
        return await verifyCommand(env, "report", ["import", input], { flags: { json: true } });
      }, { stdout: line => { stdout.push(line); }, stderr: line => { stderr.push(line); }, signals, forceExit: () => {} });
      await entered.promise;
      expect(raw).toEqual([]); expect(stdout).toEqual([]);
      const reports = join(home, "verify", "reports");
      expect(existsSync(reports) ? readdirSync(reports) : []).toEqual([]);
      expect(existsSync(join(home, "verify", "outside.json"))).toBe(false);
      release.resolve(); expect(await running).toBe(1);
      expect(raw).toEqual([]); expect(stdout).toHaveLength(1);
      const result = JSON.parse(stdout[0]);
      expect(result.imported).toBe(false); expect(result.problems.join(" ")).toContain(field);
      expect(result).not.toHaveProperty("error");
      expect(stderr).toHaveLength(failedCleanup ? 1 : 0);
      expect(stderr.join("\n")).not.toMatch(/secret|postgres:\/\//);
      expect(signals.listenerCount("SIGINT")).toBe(0); expect(signals.listenerCount("SIGTERM")).toBe(0);
    } finally {
      release.resolve();
      try { if (running) await running; } finally {
        spy.mockRestore();
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  });
});
