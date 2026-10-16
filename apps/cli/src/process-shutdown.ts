/**
 * Bounded process shutdown — DSH process-shutdown.ts exemplar.
 * Normal shutdown calls coalesce; a repeated interrupt escalates to a forced
 * exit; dispose gets a bounded grace (default 5s) and a rejection still
 * force-exits (never hangs the terminal).
 */
export const PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface ProcessShutdown {
  /** Start or join graceful disposal, then record natural completion with `code`. */
  shutdown(code: number): Promise<void>;
  /** Graceful disposal then exit; repeated calls escalate to a forced exit. */
  interrupt(code: number): void;
}

export function createProcessShutdown(
  dispose: () => Promise<void>,
  forceExit: (code: number) => void = (code) => process.exit(code),
  complete: (code: number) => void = (code) => { process.exitCode = code; },
  timeoutMs = PROCESS_SHUTDOWN_TIMEOUT_MS,
): ProcessShutdown {
  let pending: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  let forceExited = false;

  const clearTimer = () => { if (timeout !== undefined) clearTimeout(timeout); };
  const forceExitOnce = (code: number) => {
    if (forceExited) return;
    forceExited = true;
    clearTimer();
    forceExit(code);
  };
  const completeOnce = (code: number) => {
    if (completed || forceExited) return;
    completed = true;
    clearTimer();
    complete(code);
  };
  const start = (code: number, forceAfter: boolean): Promise<void> => {
    if (pending !== undefined) return pending;
    timeout = setTimeout(() => forceExitOnce(code), timeoutMs);
    pending = Promise.resolve()
      .then(dispose)
      .then(
        () => (forceAfter ? forceExitOnce(code) : completeOnce(code)),
        () => forceExitOnce(code),
      );
    return pending;
  };

  return {
    shutdown: (code) => start(code, false),
    interrupt: (code) => {
      if (pending !== undefined) forceExitOnce(code); // second signal escalates
      else void start(code, true);
    },
  };
}
