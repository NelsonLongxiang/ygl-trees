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
    try {
      // Close the cached ORM DataSource if it was opened on this file
      const { closeOrm } = require("./orm") as typeof import("./orm");
      // closeOrm is async but stop() is sync in Cordis — fire-and-forget is
      // safe here because db.close() below releases the file handle the ORM
      // depends on; the ORM will see a closed connection and GC naturally.
      closeOrm().catch(() => { /* best-effort; db.close is the real cleanup */ });
    } catch { /* orm module not loaded — fine */ }
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
}
