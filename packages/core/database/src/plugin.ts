/**
 * DatabasePlugin — provides ctx.database (DatabaseService).
 * This is the entry point that apps compose via ctx.plugin().
 *
 * @module @ygl/core-database/plugin
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { DB } from "./db";
import { InvocationOwner } from "./invocation";
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
  private readonly owner: InvocationOwner;

  constructor(ctx: Context, dbFile: string, owner?: InvocationOwner) {
    super(ctx, "database");
    this.owner = owner ?? new InvocationOwner();
    const lock = process.env.YGL_TEST !== "1" && process.env.YGL_SERVE !== "1";
    this.db = new DB(dbFile, { lock, managed: true });
    try {
      this.owner.own({ name: "sqlite", phase: "database", close: () => this.db.closeStrict() });
      if (!owner) ctx.effect(() => () => this.stop());
    }
    catch (error) { this.db.closeStrict(); throw error; }
  }

  /** Join this application's complete teardown; callers must await the returned promise. */
  stop(): Promise<void> { return this.owner.close(); }
}

export interface DatabaseConfig {
  file: string;
  owner?: InvocationOwner;
}

export function apply(ctx: Context, config: DatabaseConfig) {
  new DatabaseService(ctx, config.file, config.owner);
  ctx.effect(() => onEvent(evt => {
    try {
      (ctx as any).emit("ygl", evt);
      if (evt?.kind) (ctx as any).emit(`ygl:${evt.kind}`, evt);
    } catch { /* optional event observers do not replace the write result */ }
  }));
}
