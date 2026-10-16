/**
 * ResearchPlugin — provides ctx.research (ResearchService).
 * Injects: database.
 *
 * @module @ygl/research-pipeline/plugin
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { Store } from "./reads";

declare module "@deepseek-ai/cordis" {
  interface Context {
    research: ResearchService;
  }
}

export class ResearchService extends Service {
  static readonly inject = ["database"] as const;

  readonly store: Store;

  constructor(ctx: Context) {
    super(ctx, "research");
    this.store = new Store(ctx.database.db);
  }
}

export const inject = ["database"];

export function apply(ctx: Context) {
  new ResearchService(ctx);
}
