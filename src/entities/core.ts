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
}

export const CORE_ENTITIES = [Event];
