/**
 * DatabasePlugin — provides ctx.database (DatabaseService).
 * This is the entry point that apps compose via ctx.plugin().
 *
 * @module @ygl/core-database/plugin
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { DB, ormState } from "./db";
// 0.86 M7-3: static import, not require — under ESM hosts (vitest) require is
// undefined and the try/catch silently swallowed it, leaving the bridge dead;
// any ESM entry would silently lose ctx.on("ygl") events. core→core same
// layer, no cycle (text never imports database).
import { onEvent } from "../../../core/text/src/eventbus";

declare module "@deepseek-ai/cordis" {
  interface Context {
    database: DatabaseService;
  }
}

export class DatabaseService extends Service {
  readonly db: DB;
  private disposed = false;

  constructor(ctx: Context, dbFile: string) {
    super(ctx, "database");
    // GPT-6.1 SOL fix: the DB lock was only applied in the profile-boot
    // fallback path, but the base bundle always instantiates this Service —
    // the primary path never locked. Lock here (the actual entry point for
    // every CLI invocation), preserving bypasses:
    //   YGL_TEST=1  — parallel test execution
    //   YGL_SERVE=1 — webui serve (long-lived; WAL permits concurrent access)
    const lock = process.env.YGL_TEST !== "1" && process.env.YGL_SERVE !== "1";
    this.db = new DB(dbFile, { lock });
  }

  /** Lifecycle: Cordis calls this when the Context is disposed — the
   *  "Services stop with Context, resources auto-clean" promise made real.
   *  Closes the SQLite handle AND the cached ORM DataSource. */
  stop(): void {
    if (this.disposed) return;
    this.disposed = true;
    // 0.87: closeOrm only when the ORM actually opened this run (cheap for
    // write-only runs), via dynamic import — the old require("./orm") died
    // silently under ESM hosts (same pattern the 0.86 bridge fix removed).
    if (ormState.opened) {
      // closeOrm is async but stop() is sync in Cordis — fire-and-forget is
      // safe: db.close() below releases the file handle the ORM depends on.
      void import("./orm").then((m) => m.closeOrm()).catch(() => { /* best effort */ });
    }
    try {
      this.db.close(); // releases .ygllock + closes SQLite handle
    } catch { /* already closed */ }
  }
}

export interface DatabaseConfig {
  file: string;
}

export function apply(ctx: Context, config: DatabaseConfig) {
  new DatabaseService(ctx, config.file);
  // 0.76 bridge: eventbus (internal) → ctx.emit (Cordis public API).
  // This makes "ctx.on()/emit()" work as documented — plugins can listen
  // with ctx.on("ygl", handler) or ctx.on("ygl:node.unlock", handler).
  // The eventbus remains the internal write-path transport.
  // 0.86 M7-4: kind channels bridge DYNAMICALLY from evt.kind — the old
  // hardcoded knownKinds list silently dropped any kind it didn't name.
  try {
    const unsub = onEvent((evt) => {
      try {
        (ctx as any).emit("ygl", evt);
        if (evt?.kind) (ctx as any).emit(`ygl:${evt.kind}`, evt);
      } catch { /* */ }
    });
    const kindSubs: Array<() => void> = [unsub];
    // Cleanup on Context dispose (best-effort — this fork has no ctx.dispose)
    (ctx as any).fiber?.collect?.(() => {
      for (const u of kindSubs) { try { u(); } catch { /* */ } }
    });
  } catch { /* eventbus optional */ }
}
