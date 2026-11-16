/** One outer publication/cleanup boundary covers every resource-opening return in main(). */
import type { Ctx } from "../../../packages/core/text/src/fmt";
import { bad } from "../../../packages/core/text/src/fmt";
import { InvocationResult } from "../../../packages/core/text/src/result";
import { InvocationOwner } from "../../../packages/core/database/src/invocation";
import type { OrmTarget, ScopedOrm } from "../../../packages/core/database/src/scoped-orm";
import { createWorkspaceOrm } from "./workspace-orm";
import { createProcessShutdown } from "./process-shutdown";

export interface WorkspaceInvocation {
  readonly ctx: Ctx;
  readonly invocation: InvocationOwner;
  readonly orm: ScopedOrm;
  /** Only a long-lived control waiter detaches; its actual requests/jobs stay tracked. */
  detachControl(): void;
}
interface InvocationOptions {
  stdout?: (serialized: string) => void;
  stderr?: (message: string) => void;
  signals?: { on(name: string, listener: () => void): unknown; removeListener(name: string, listener: () => void): unknown };
  forceExit?: (code: number) => void;
}
export async function runWorkspaceInvocation(
  context: Ctx,
  target: OrmTarget,
  work: (scope: WorkspaceInvocation) => Promise<number>,
  options: InvocationOptions = {},
): Promise<number> {
  const invocation = new InvocationOwner(), orm = createWorkspaceOrm(target), result = new InvocationResult();
  const ctx: Ctx = context.json ? { ...context, emitJson: result.emitJson, failJson: result.fail } : { ...context };
  const stdout = options.stdout ?? ((serialized: string) => { console.log(serialized); });
  const stderr = options.stderr ?? ((message: string) => { console.error(message); });
  const signals = options.signals ?? process;
  let code = 0;
  let finishedWork!: () => void;
  const workSettled = new Promise<void>(resolve => { finishedWork = resolve; });
  // A detached serve waiter must stop before joining; it is a release prerequisite, not a drain activity.
  invocation.own({ name: "command-control", close: () => workSettled });
  invocation.own({ name: "orm", close: () => orm.close() });
  let finalizing: Promise<number> | undefined;
  const finish = () => {
    if (!finalizing) finalizing = Promise.resolve().then(async () => {
      try { await invocation.close(); }
      catch {
        stderr("workspace cleanup failed; business work may already be committed; resource release is unconfirmed, do not blindly retry writes");
        if (code === 0) {
          code = 1;
          if (ctx.json) result.fail("workspace cleanup failed");
          else bad(ctx, "workspace cleanup failed");
        }
      }
      if (ctx.json) result.commit(stdout);
      return code;
    });
    return finalizing;
  };
  const shutdown = createProcessShutdown(finish, options.forceExit, () => {});
  const interrupt = () => { shutdown.interrupt(code); };
  signals.on("SIGINT", interrupt);
  signals.on("SIGTERM", interrupt);
  try {
    try { code = await invocation.control(detachControl => work(Object.freeze({ ctx, invocation, orm, detachControl }))); }
    catch (error: any) {
      code = 1;
      bad(ctx, target.dialect === "postgres" ? "PostgreSQL operation failed; check the selected workspace and server diagnostics" : error?.message || String(error));
    } finally { finishedWork(); }
    await shutdown.shutdown(code);
    return code;
  } finally {
    signals.removeListener("SIGINT", interrupt);
    signals.removeListener("SIGTERM", interrupt);
  }
}
