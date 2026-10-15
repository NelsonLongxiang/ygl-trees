/** ResearchService — Cordis Service for the research domain. */
import { Context, Service } from "cordis";
import { Store } from "./reads";

declare module "cordis" {
  interface Context {
    research: ResearchService;
  }
}

export class ResearchService extends Service {
  readonly store: Store;

  constructor(ctx: Context) {
    super(ctx, "research");
    this.store = new Store(ctx.database.db);
  }
}

export function ResearchPlugin(ctx: Context) {
  new ResearchService(ctx);
}
