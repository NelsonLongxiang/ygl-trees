/**
 * App composition — creates a Cordis Context and loads all domain plugins.
 * Services are accessed via ctx.<name> (no cross-package imports).
 *
 * @module apps/cli/compose
 */
import { Context } from "cordis";

// Plugin entry points (the ONLY cross-package imports — plugin functions only)
import { apply as databasePlugin, DatabaseConfig } from "../../packages/core/database/src/plugin";
import { apply as researchPlugin } from "../../packages/research/pipeline/src/plugin";
import { apply as techtreePlugin } from "../../packages/techtree/model/src/plugin";
import { apply as opsPlugin } from "../../packages/ops/tools/src/plugin";

export interface AppConfig {
  dbFile: string;
}

export function createApp(config: AppConfig): Context {
  const ctx = new Context();
  ctx.plugin(databasePlugin, { file: config.dbFile } as DatabaseConfig);
  ctx.plugin(researchPlugin);
  ctx.plugin(techtreePlugin);
  ctx.plugin(opsPlugin);
  return ctx;
}
