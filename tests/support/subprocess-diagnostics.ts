import { Buffer } from "node:buffer";

interface ChildFacts {
  status: number | null;
  signal: string | null;
  error?: { name?: string; code?: string };
  stdout?: string | null;
  stderr?: string | null;
}

/** Test failure context: callers supply a fixed command shape, never argument values or environment. */
export function subprocessDiagnostic(step: string, argvShape: readonly string[], result: ChildFacts, elapsedMs: number, traceFile?: string): string {
  return JSON.stringify({
    step,
    argv_shape: argvShape,
    elapsed_ms: Math.max(0, Math.round(elapsedMs)),
    status: result.status,
    signal: result.signal,
    error_name: result.error?.name ?? null,
    error_code: result.error?.code ?? null,
    stdout_bytes: Buffer.byteLength(result.stdout ?? ""),
    stderr_bytes: Buffer.byteLength(result.stderr ?? ""),
    ...(traceFile ? { trace_file: traceFile } : {}),
  });
}
