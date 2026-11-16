/** Lightweight entity ownership declaration; importing this module never loads TypeORM. */
import type { EntityManifest } from "./entity-catalog";

export const CORE_ENTITY_MANIFEST: EntityManifest = Object.freeze({
  owner: "core/database",
  entities: Object.freeze([
    Object.freeze({ key: "Event", table: "events" }),
    Object.freeze({ key: "PatrolCheck", table: "patrol_checks" }),
    Object.freeze({ key: "PatrolFinding", table: "patrol_findings" }),
    Object.freeze({ key: "VerifierInstance", table: "verifier_instances" }),
    Object.freeze({ key: "VerifierRun", table: "verifier_runs" }),
  ]),
});
