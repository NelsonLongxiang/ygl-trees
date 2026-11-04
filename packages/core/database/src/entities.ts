/** Cross-cutting entities (audit trail). Research-domain entities live in
 *  research.ts; both are registered in src/orm.ts. */
import "reflect-metadata";
import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "events" })
export class Event {
  @PrimaryColumn({ name: "id", type: "text" })
  id!: string;

  @Column({ name: "ts", type: "text" })
  ts!: string;

  @Column({ name: "actor", type: "text" })
  actor!: string;

  @Column({ name: "kind", type: "text" })
  kind!: string;

  @Column({ name: "entity", type: "text" })
  entity!: string;

  @Column({ name: "entity_id", type: "text" })
  entityId!: string;

  @Column({ name: "payload", type: "text" })
  payload!: string;

  /** v7 telemetry severity: info | warn | error (spec R10.2) */
  @Column({ name: "level", type: "text", default: "info" })
  level!: string;

  /** v10 (PG-A④): PG-side BIGSERIAL ordering for PG-native writes; NULL on
   * SQLite where rowid is the native order (0.87.1 ordering contract). */
  @Column({ name: "seq", type: "bigint", nullable: true })
  seq?: number | null;
}

/** v12 (0.93-T2): boundary assertion — a SELECT that returns violating rows. */
@Entity({ name: "patrol_checks" })
export class PatrolCheck {
  @PrimaryColumn({ name: "id", type: "text" })
  id!: string;

  @Column({ name: "name", type: "text" })
  name!: string;

  @Column({ name: "description", type: "text", default: "" })
  description!: string;

  @Column({ name: "sql", type: "text" })
  sql!: string;

  /** S1 critical | S2 warning | S3 info (.157 ops-handbook vocabulary) */
  @Column({ name: "severity", type: "text", default: "S2" })
  severity!: string;

  @Column({ name: "enabled", type: "integer", default: 1 })
  enabled!: number;

  @Column({ name: "created", type: "text" })
  created!: string;

  @Column({ name: "updated", type: "text" })
  updated!: string;
}

/** v12 (0.93-T2): disposition queue — open | ack | fixed | fp. */
@Entity({ name: "patrol_findings" })
export class PatrolFinding {
  @PrimaryColumn({ name: "id", type: "text" })
  id!: string;

  @Column({ name: "check_id", type: "text" })
  checkId!: string;

  @Column({ name: "row_key", type: "text" })
  rowKey!: string;

  @Column({ name: "detail", type: "text", default: "" })
  detail!: string;

  @Column({ name: "severity", type: "text", default: "S2" })
  severity!: string;

  @Column({ name: "status", type: "text", default: "open" })
  status!: string;

  @Column({ name: "first_seen", type: "text" })
  firstSeen!: string;

  @Column({ name: "last_seen", type: "text" })
  lastSeen!: string;

  @Column({ name: "resolved", type: "text", nullable: true })
  resolved?: string | null;

  @Column({ name: "note", type: "text", default: "" })
  note!: string;
}

/** v13 (#206): verifier instance — a binding (pack@version x target x params) kept as a row.
 *  identity_sha256 is content-addressed; owner/schedule are mutable and outside the identity. */
@Entity({ name: "verifier_instances" })
export class VerifierInstance {
  @PrimaryColumn({ name: "id", type: "text" })
  id!: string;

  @Column({ name: "identity_sha256", type: "text" })
  identitySha256!: string;

  /** pack | legacy-repo (S1 bridge) */
  @Column({ name: "kind", type: "text", default: "pack" })
  kind!: string;

  @Column({ name: "pack", type: "text" })
  pack!: string;

  @Column({ name: "pack_version", type: "text" })
  packVersion!: string;

  /** JCS JSON {target, rev, params} */
  @Column({ name: "binding", type: "text" })
  binding!: string;

  @Column({ name: "owner", type: "text" })
  owner!: string;

  @Column({ name: "schedule", type: "text", default: "" })
  schedule!: string;

  /** draft | active | retired */
  @Column({ name: "state", type: "text", default: "active" })
  state!: string;

  @Column({ name: "note", type: "text", default: "" })
  note!: string;

  @Column({ name: "created", type: "text" })
  created!: string;

  @Column({ name: "updated", type: "text" })
  updated!: string;
}

/** v13 (#206): verifier run — evidence pointing at an engine report and archive (append-only). */
@Entity({ name: "verifier_runs" })
export class VerifierRun {
  @PrimaryColumn({ name: "id", type: "text" })
  id!: string;

  @Column({ name: "instance_id", type: "text" })
  instanceId!: string;

  @Column({ name: "verdict", type: "text" })
  verdict!: string;

  @Column({ name: "judged_at", type: "text" })
  judgedAt!: string;

  @Column({ name: "target_sha", type: "text", default: "" })
  targetSha!: string;

  @Column({ name: "payload_sha256", type: "text", default: "" })
  payloadSha256!: string;

  @Column({ name: "archive_sha256", type: "text", default: "" })
  archiveSha256!: string;

  @Column({ name: "executor", type: "text", default: "" })
  executor!: string;

  @Column({ name: "engine_version", type: "text", default: "" })
  engineVersion!: string;

  @Column({ name: "created", type: "text" })
  created!: string;
}

export const CORE_ENTITIES = [Event, PatrolCheck, PatrolFinding, VerifierInstance, VerifierRun];
