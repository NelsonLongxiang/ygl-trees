/**
 * OpsPlugin — provides ctx.ops (OpsService).
 * Injects: database.
 *
 * @module @ygl/ops-tools/plugin
 */
import { Context, Service } from "@deepseek-ai/cordis";

declare module "@deepseek-ai/cordis" {
  interface Context {
    ops: OpsService;
  }
}

export class OpsService extends Service {
  static readonly inject = ["database"] as const;

  constructor(ctx: Context) {
    super(ctx, "ops");
    // Config, PG sync, jobs — accessed via ctx.ops
  }
}

export const inject = ["database"];

export function apply(ctx: Context) {
  new OpsService(ctx);
}
