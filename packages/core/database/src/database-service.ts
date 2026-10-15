/** DatabaseService — Cordis Service that owns the DB lifecycle. */
import { Context, Service } from "cordis";
import { DB } from "./db";

declare module "cordis" {
  interface Context {
    database: DatabaseService;
  }
}

export class DatabaseService extends Service {
  readonly db: DB;

  constructor(ctx: Context, dbFile: string) {
    super(ctx, "database");
    this.db = new DB(dbFile);
  }
}

export interface DatabaseConfig {
  file: string;
}

export function DatabasePlugin(ctx: Context, config: DatabaseConfig) {
  new DatabaseService(ctx, config.file);
}
