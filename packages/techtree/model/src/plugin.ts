/**
 * TechTreePlugin — provides ctx.techtree (TechTreeService).
 * Injects: database.
 *
 * @module @ygl/techtree-model/plugin
 */
import { Context, Service } from "cordis";
import { TreeStore } from "./reads";

declare module "cordis" {
  interface Context {
    techtree: TechTreeService;
  }
}

export class TechTreeService extends Service {
  static readonly inject = ["database"] as const;

  readonly trees: TreeStore;

  constructor(ctx: Context) {
    super(ctx, "techtree");
    this.trees = new TreeStore(ctx.database.db);
  }
}

export const inject = ["database"];

export function apply(ctx: Context) {
  new TechTreeService(ctx);
}
