/** Lightweight entity ownership declaration; importing this module never loads TypeORM. */
import type { EntityManifest } from "../../../core/database/src/entity-catalog";

export const RESEARCH_ENTITY_MANIFEST: EntityManifest = Object.freeze({
  owner: "research/pipeline",
  entities: Object.freeze([
    Object.freeze({ key: "Project", table: "projects" }),
    Object.freeze({ key: "Query", table: "queries" }),
    Object.freeze({ key: "Source", table: "sources" }),
    Object.freeze({ key: "QuerySource", table: "query_sources" }),
    Object.freeze({ key: "Evidence", table: "evidence" }),
    Object.freeze({ key: "Claim", table: "claims" }),
    Object.freeze({ key: "ClaimEvidence", table: "claim_evidence" }),
  ]),
});
