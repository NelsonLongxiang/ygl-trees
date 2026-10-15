/**
 * ygl-trees Cordis Context — root application context.
 *
 * Each domain module registers as a Cordis Service on this Context.
 * Cordis provides: runtime service discovery, lifecycle management,
 * event-driven composition, and dynamic plugin loading.
 */
import { Context, Service } from "cordis";
import { DB } from "./core/db";
import { Store } from "./research/reads";

declare module "cordis" {
  interface Context {
    database: DatabaseService;
    research: ResearchService;
  }
}

export class DatabaseService extends Service {
  readonly db: DB;

  constructor(ctx: Context, dbFile: string) {
    super(ctx, "database");
    this.db = new DB(dbFile);
  }
}

export class ResearchService extends Service {
  readonly store: Store;

  constructor(ctx: Context) {
    super(ctx, "research");
    this.store = new Store(ctx.database.db);
  }
}

export interface DatabaseConfig {
  file: string;
}

export function DatabasePlugin(ctx: Context, config: DatabaseConfig) {
  new DatabaseService(ctx, config.file);
}

export function ResearchPlugin(ctx: Context) {
  new ResearchService(ctx);
}

export function createApp(dbFile: string): Context {
  const ctx = new Context();
  ctx.plugin(DatabasePlugin, { file: dbFile });
  ctx.plugin(ResearchPlugin);
  return ctx;
}
