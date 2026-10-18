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

export const CORE_ENTITIES = [Event];
