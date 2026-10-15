/** Ops domain — config, PG sync/migrate, jobs, agent views.
 *  Operational surface: not research/tree/knowledge domain logic. */
export { CONFIG_REGISTRY, configGet, configGetNumber, configGetBool, configSet, configReset, configAll, specOf } from "./config";
export { syncToPg, migrateToPg, MIRROR_TABLES } from "./pgsync";
export type { SyncResult, MigrateResult } from "./pgsync";
