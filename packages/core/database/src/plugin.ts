/**
 * DatabasePlugin — provides ctx.database (DatabaseService).
 * This is the entry point that apps compose via ctx.plugin().
 *
 * @module @ygl/core-database/plugin
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { DB } from "./db";

declare module "@deepseek-ai/cordis" {
  interface Context {
    database: DatabaseService;
  }
}

export class DatabaseService extends Service {
  readonly db: DB;

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
}

export interface DatabaseConfig {
  file: string;
}

export function apply(ctx: Context, config: DatabaseConfig) {
  new DatabaseService(ctx, config.file);
}
