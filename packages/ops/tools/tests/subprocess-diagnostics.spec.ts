import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { subprocessDiagnostic } from "../../../../tests/support/subprocess-diagnostics";

const facts = { status: 0, signal: null, stdout: "", stderr: "" };

describe("Windows subprocess failure diagnostics (#203/#209)", () => {
  it("preserves an observed timeout instead of treating null status as its cause", () => {
    const value = JSON.parse(subprocessDiagnostic("query attach CLI", ["db", "sql", "<query>"], {
      ...facts, status: null, error: { name: "Error", code: "ETIMEDOUT" },
    }, 20003.4));
    expect(value).toMatchObject({ step: "query attach CLI", argv_shape: ["db", "sql", "<query>"], status: null, signal: null, error_name: "Error", error_code: "ETIMEDOUT", elapsed_ms: 20003 });
  });

  it("reports a real bounded child timeout without losing the execution error", () => {
    const started = performance.now();
    const result = spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { encoding: "utf8", timeout: 200 });
    const value = JSON.parse(subprocessDiagnostic("forced child timeout", ["node", "<fixture>"], result, performance.now() - started));
    expect(value).toMatchObject({ status: null, error_code: "ETIMEDOUT" });
    expect(value.elapsed_ms).toBeGreaterThanOrEqual(100);
  });

  it("does not invent ETIMEDOUT for an unexplained null status", () => {
    expect(JSON.parse(subprocessDiagnostic("query attach CLI", ["db", "sql", "<query>"], { ...facts, status: null }, 4)))
      .toMatchObject({ status: null, signal: null, error_name: null, error_code: null });
  });

  it("distinguishes a signal, spawn failure and ordinary nonzero exit", () => {
    const signal = JSON.parse(subprocessDiagnostic("fixture", [], { ...facts, status: null, signal: "SIGTERM" }, 1));
    const spawn = JSON.parse(subprocessDiagnostic("fixture", [], { ...facts, status: null, error: { name: "Error", code: "ENOENT" } }, 2));
    const exit = JSON.parse(subprocessDiagnostic("fixture", [], { ...facts, status: 2 }, 3));
    expect(signal).toMatchObject({ status: null, signal: "SIGTERM", error_code: null });
    expect(spawn).toMatchObject({ status: null, signal: null, error_code: "ENOENT" });
    expect(exit).toMatchObject({ status: 2, signal: null, error_code: null });
  });

  it("keeps the trace location and byte counts without printing output or error-message secrets", () => {
    const secret = "Bearer private-token";
    const value = subprocessDiagnostic("bundle fixture clone", ["git", "clone", "--shared", "<source>", "<target>"], {
      ...facts, status: null, stdout: "中文", stderr: secret,
      error: { name: "Error", code: "ETIMEDOUT", message: secret } as any,
    }, 60001, "tmp/fixture/git-trace.jsonl");
    expect(JSON.parse(value)).toMatchObject({ trace_file: "tmp/fixture/git-trace.jsonl", stdout_bytes: 6, stderr_bytes: Buffer.byteLength(secret) });
    expect(value).not.toContain(secret);
    expect(value).not.toContain("private-token");
  });
});
