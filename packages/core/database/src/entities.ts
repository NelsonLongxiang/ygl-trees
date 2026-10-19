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

export const CORE_ENTITIES = [Event, PatrolCheck, PatrolFinding];
