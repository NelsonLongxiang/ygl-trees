/** A single invocation owns admission, accepted work and ordered resource teardown. */
import { AsyncLocalStorage } from "node:async_hooks";
export interface InvocationResource {
  readonly name: string;
  readonly phase?: "consumer" | "connection" | "database";
  quiesce?(): void | Promise<void>;
  close?(): void | Promise<void>;
}
export interface CleanupFailure { readonly phase: "quiesce" | "release"; readonly name: string; readonly cause: unknown }
export class InvocationCleanupError extends Error {
  readonly failures: readonly CleanupFailure[];
  constructor(failures: readonly CleanupFailure[]) {
    super("workspace cleanup failed; resource release is unconfirmed");
    this.name = "InvocationCleanupError";
    this.failures = Object.freeze(failures.map(failure => Object.freeze({ ...failure })));
  }
}
export interface InvocationAccess {
  own(resource: InvocationResource): void;
  run<T>(work: () => T | Promise<T>): Promise<T>;
}
export class InvocationOwner implements InvocationAccess {
  private state: "accepting" | "quiescing" | "draining" | "releasing" | "closed" | "poisoned" = "accepting";
  private readonly resources: InvocationResource[] = [];
  private readonly identities = new WeakSet<object>();
  private readonly stopping: Promise<void>[] = [];
  private readonly failures: CleanupFailure[] = [];
  private active = 0;
  private readonly completion = new AsyncLocalStorage<{ live: boolean }>();
  private drained?: () => void;
  private closing?: Promise<void>;

  /** Accepted work may register a newly acquired resource while it is draining. */
  own(resource: InvocationResource): void {
    if (!resource || typeof resource.name !== "string" || !resource.name || (resource.phase !== undefined && resource.phase !== "consumer" && resource.phase !== "connection" && resource.phase !== "database")) throw new Error("invalid invocation resource");
    if (this.state === "releasing" || this.state === "closed" || this.state === "poisoned" || ((this.state !== "accepting" || this.failures.length) && !this.completion.getStore()?.live)) throw new Error("invocation is closed or releasing resources");
    if (this.identities.has(resource)) throw new Error("resource is already owned by this invocation");
    this.identities.add(resource);
    this.resources.push(resource);
    if (this.state !== "accepting") this.stop(resource);
  }
  private stop(resource: InvocationResource): void {
    if (!resource.quiesce) return;
    let result: void | Promise<void>;
    const token = { live: true };
    try { result = this.completion.run(token, () => resource.quiesce!()); }
    catch (cause) { token.live = false; this.failures.push({ phase: "quiesce", name: resource.name, cause }); return; }
    const pending = Promise.resolve(result).catch(cause => { this.failures.push({ phase: "quiesce", name: resource.name, cause }); }).finally(() => { token.live = false; });
    this.stopping.push(pending);
  }
  private enter(): () => void {
    if (this.state !== "accepting" || this.failures.length) throw new Error("invocation is not accepting new work; cleanup failed or shutdown started");
    this.active++;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.active--;
      if (this.active === 0) { this.drained?.(); this.drained = undefined; }
    };
  }
  /** A long-lived control waiter can detach without revoking its completion context. */
  control<T>(work: (detach: () => void) => T | Promise<T>): Promise<T> {
    let finish: () => void;
    try { finish = this.enter(); } catch (error) { return Promise.reject(error); }
    const token = { live: true };
    const pending = Promise.resolve().then(() => this.completion.run(token, () => work(finish))).finally(() => { token.live = false; finish(); });
    void pending.catch(() => {});
    return pending;
  }
  run<T>(work: () => T | Promise<T>): Promise<T> { return this.control(work); }
  /** Only a live accepted operation or owned cleanup may use dependencies after admission closes. */
  use<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.state === "accepting" && !this.failures.length) return this.run(work);
    if (!this.completion.getStore()?.live || this.state === "closed" || this.state === "poisoned") return Promise.reject(new Error("invocation is not accepting new work"));
    this.active++;
    const token = { live: true };
    const pending = Promise.resolve().then(() => this.completion.run(token, work)).finally(() => {
      token.live = false;
      this.active--;
      if (!this.active) { this.drained?.(); this.drained = undefined; }
    });
    void pending.catch(() => {});
    return pending;
  }
  /** Register an exact native disposer's first execution, including an externally started unload. */
  cleanup(name: string, dispose: () => unknown): () => Promise<void> {
    let pending: Promise<void> | undefined;
    return () => {
      if (pending) return pending;
      if (this.state === "closed" || this.state === "poisoned") return Promise.reject(new Error("invocation is closed"));
      this.active++;
      const token = { live: true };
      pending = Promise.resolve().then(() => this.completion.run(token, dispose)).then(() => {}, cause => {
        this.failures.push({ phase: "release", name, cause }); throw cause;
      }).finally(() => {
        token.live = false; this.active--;
        if (!this.active) { this.drained?.(); this.drained = undefined; }
      });
      void pending.catch(() => {});
      return pending;
    };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = "quiescing";
    this.closing = Promise.resolve().then(async () => {
      // Store the shared close promise before invoking any reentrant stop callback.
      for (const resource of this.resources) this.stop(resource);
      this.state = "draining";
      if (this.active) await new Promise<void>(resolve => { this.drained = resolve; });
      let stopped = 0;
      do {
        while (stopped < this.stopping.length) await this.stopping[stopped++];
        if (this.active) await new Promise<void>(resolve => { this.drained = resolve; });
      } while (stopped < this.stopping.length || this.active);
      this.state = "releasing";
      if (this.failures.length) throw new InvocationCleanupError(this.failures);
      for (const phase of ["consumer", "connection", "database"] as const) {
        const resources = phase === "consumer" ? [...this.resources].reverse() : this.resources;
        for (const resource of resources) {
          if ((resource.phase ?? "connection") !== phase || !resource.close) continue;
          const token = { live: true };
          try { await this.completion.run(token, () => resource.close!()); }
          catch (cause) { this.failures.push({ phase: "release", name: resource.name, cause }); }
          finally { token.live = false; }
          if (this.active) await new Promise<void>(resolve => { this.drained = resolve; });
        }
        if (this.failures.length) throw new InvocationCleanupError(this.failures);
      }
      this.state = "closed";
    }).catch(error => { this.state = "poisoned"; throw error; });
    void this.closing.catch(() => {});
    return this.closing;
  }
}
