import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessShutdown, PROCESS_SHUTDOWN_TIMEOUT_MS } from "../src/process-shutdown";
function gate() { let resolve!: (value?: number) => void; const promise = new Promise<number | void>(yes => { resolve = yes; }); return { promise, resolve }; }
afterEach(() => { vi.useRealTimers(); });
describe("bounded honest process shutdown", () => {
  it("joins one graceful cleanup and uses its final nonzero outcome", async () => {
    const barrier = gate(), dispose = vi.fn(() => barrier.promise), force = vi.fn(), complete = vi.fn();
    const shutdown = createProcessShutdown(dispose, force, complete);
    const first = shutdown.shutdown(0); expect(shutdown.shutdown(0)).toBe(first);
    barrier.resolve(1); await first; expect(dispose).toHaveBeenCalledTimes(1); expect(complete).toHaveBeenCalledWith(1); expect(force).not.toHaveBeenCalled();
  });
  it("a cleanup rejection cannot force exit as successful code0", async () => {
    const force = vi.fn(); const shutdown = createProcessShutdown(async () => { throw new Error("cleanup unknown"); }, force, vi.fn());
    await shutdown.shutdown(0); expect(force).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("a timed-out cleanup retains the unchanged5000ms budget and never reports clean rc0", async () => {
    vi.useFakeTimers(); const barrier = gate(), force = vi.fn(), complete = vi.fn();
    const shutdown = createProcessShutdown(() => barrier.promise, force, complete);
    const pending = shutdown.shutdown(0); await vi.advanceTimersByTimeAsync(PROCESS_SHUTDOWN_TIMEOUT_MS - 1); expect(force).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(PROCESS_SHUTDOWN_TIMEOUT_MS).toBe(5000); expect(force).toHaveBeenCalledExactlyOnceWith(1);
    barrier.resolve(0); await pending; expect(complete).not.toHaveBeenCalled(); expect(force).toHaveBeenCalledTimes(1);
  });
  it("a second signal forces uncertain shutdown nonzero while preserving a prior business rc2", async () => {
    vi.useFakeTimers(); const barrier = gate(), force = vi.fn(), shutdown = createProcessShutdown(() => barrier.promise, force, vi.fn());
    shutdown.interrupt(2); shutdown.interrupt(0); expect(force).toHaveBeenCalledExactlyOnceWith(2); barrier.resolve(2); await Promise.resolve(); await Promise.resolve();
  });
});
