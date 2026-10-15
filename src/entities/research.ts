/**
 * Research-domain entities — a typed snapshot of schema v5.
 *
 * Contract with the schema authority:
 *  - `synchronize` is ALWAYS false; migrations stay on the PRAGMA
 *    user_version track (src/db.ts). If SCHEMA_SQL changes, these
 *    entities must be updated in the same commit.
 *  - Column names are explicit snake_case to match the database exactly.
 *  - FTS5 virtual tables and PRAGMA paths are OUT of entity scope; they
 *    stay raw SQL in store.ts (see docs/plan.md TypeORM boundaries).
 */
import "reflect-metadata";
import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
} from "typeorm";

@Entity({ name: "projects" })
export class Project {
  @PrimaryColumn({ name: "id", type: "text" })
  id!: string;

  @Column({ name: "name", type: "text" })
  name!: string;

  @Column({ name: "question", type: "text" })
  question!: string;

  @Column({ name: "inclusion", type: "text" })
  inclusion!: string;

  @Column({ name: "exclusion", type: "text" })
  exclusion!: string;

  @Column({ name: "status", type: "text" })
  status!: string;

  @Column({ name: "created", type: "text" })
  created!: string;

  @Column({ name: "updated", type: "text" })
  updated!: string;

  @OneToMany(() => Query, (q) => q.project, { createForeignKeyConstraints: false })
  queries?: Query[];

  @OneToMany(() => Claim, (c) => c.project, { createForeignKeyConstraints: false })
  claims?: Claim[];

  @OneToMany(() => Source, (s) => s.project, { createForeignKeyConstraints: false })
  sources?: Source[];
}

@Entity({ name: "queries" })
export class Query {
  @PrimaryColumn({ name: "id", type: "text" })
  id!: string;

  @Column({ name: "project_id", type: "text" })
  projectId!: string;

  @Column({ name: "text", type: "text" })
  text!: string;

  @Column({ name: "engine", type: "text" })
  engine!: string;

  @Column({ name: "status", type: "text" })
  status!: string;

  @Column({ name: "note", type: "text" })
  note!: string;

  @Column({ name: "content_hash", type: "text" })
  contentHash!: string;

  @Column({ name: "created", type: "text" })
  created!: string;

  @ManyToOne(() => Project, (p) => p.queries, { createForeignKeyConstraints: false })
  @JoinColumn({ name: "project_id" })
  project?: Project;

  @OneToMany(() => QuerySource, (qs) => qs.query, { createForeignKeyConstraints: false })
  querySources?: QuerySource[];
}

@Entity({ name: "sources" })
export class Source {
  @PrimaryColumn({ name: "id", type: "text" })
  id!: string;

  @Column({ name: "project_id", type: "text" })
  projectId!: string;

  @Column({ name: "url", type: "text" })
  url!: string;

  @Column({ name: "title", type: "text" })
  title!: string;

  @Column({ name: "url_hash", type: "text" })
  urlHash!: string;

  @Column({ name: "content_hash", type: "text" })
  contentHash!: string;

  @Column({ name: "abstract", type: "text" })
  abstract!: string;

  @Column({ name: "content", type: "text" })
  content!: string;

  @Column({ name: "engine", type: "text" })
  engine!: string;

  @Column({ name: "relevance", type: "integer" })
  relevance!: number;

  @Column({ name: "confidence", type: "text" })
  confidence!: string;

  @Column({ name: "tags", type: "text" })
  tags!: string;

  @Column({ name: "retrieved_at", type: "text" })
  retrievedAt!: string;

  @ManyToOne(() => Project, (p) => p.sources, { createForeignKeyConstraints: false })
  @JoinColumn({ name: "project_id" })
  project?: Project;

  @OneToMany(() => QuerySource, (qs) => qs.source, { createForeignKeyConstraints: false })
  querySources?: QuerySource[];
}

@Entity({ name: "query_sources" })
export class QuerySource {
  @PrimaryColumn({ name: "query_id", type: "text" })
  queryId!: string;

  @PrimaryColumn({ name: "source_id", type: "text" })
  sourceId!: string;

  @Column({ name: "note", type: "text" })
  note!: string;

  @Column({ name: "created", type: "text" })
  created!: string;

  @ManyToOne(() => Query, (q) => q.querySources, { createForeignKeyConstraints: false })
  @JoinColumn({ name: "query_id" })
  query?: Query;

  @ManyToOne(() => Source, (s) => s.querySources, { createForeignKeyConstraints: false })
  @JoinColumn({ name: "source_id" })
  source?: Source;
}

@Entity({ name: "evidence" })
export class Evidence {
  @PrimaryColumn({ name: "id", type: "text" })
  id!: string;

  @Column({ name: "project_id", type: "text" })
  projectId!: string;

  @Column({ name: "source_id", type: "text" })
  sourceId!: string;

  @Column({ name: "quote", type: "text" })
  quote!: string;

  @Column({ name: "note", type: "text" })
  note!: string;

  @Column({ name: "locator", type: "text" })
  locator!: string;

  @Column({ name: "content_hash", type: "text" })
  contentHash!: string;

  @Column({ name: "created", type: "text" })
  created!: string;

  @ManyToOne(() => Project, undefined, { createForeignKeyConstraints: false })
  @JoinColumn({ name: "project_id" })
  project?: Project;

  @ManyToOne(() => Source, undefined, { createForeignKeyConstraints: false })
  @JoinColumn({ name: "source_id" })
  source?: Source;

  @OneToMany(() => ClaimEvidence, (ce) => ce.evidence, { createForeignKeyConstraints: false })
  claimEvidence?: ClaimEvidence[];
}

@Entity({ name: "claims" })
export class Claim {
  @PrimaryColumn({ name: "id", type: "text" })
  id!: string;

  @Column({ name: "project_id", type: "text" })
  projectId!: string;

  @Column({ name: "text", type: "text" })
  text!: string;

  @Column({ name: "status", type: "text" })
  status!: string;

  @Column({ name: "confidence", type: "text" })
  confidence!: string;

  @Column({ name: "content_hash", type: "text" })
  contentHash!: string;

  @Column({ name: "created", type: "text" })
  created!: string;

  @ManyToOne(() => Project, (p) => p.claims, { createForeignKeyConstraints: false })
  @JoinColumn({ name: "project_id" })
  project?: Project;

  @OneToMany(() => ClaimEvidence, (ce) => ce.claim, { createForeignKeyConstraints: false })
  claimEvidence?: ClaimEvidence[];
}

@Entity({ name: "claim_evidence" })
export class ClaimEvidence {
  @PrimaryColumn({ name: "claim_id", type: "text" })
  claimId!: string;

  @PrimaryColumn({ name: "evidence_id", type: "text" })
  evidenceId!: string;

  @Column({ name: "stance", type: "text" })
  stance!: string;

  @ManyToOne(() => Claim, (c) => c.claimEvidence, { createForeignKeyConstraints: false })
  @JoinColumn({ name: "claim_id" })
  claim?: Claim;

  @ManyToOne(() => Evidence, undefined, { createForeignKeyConstraints: false })
  @JoinColumn({ name: "evidence_id" })
  evidence?: Evidence;
}

export const RESEARCH_ENTITIES = [Project, Query, Source, QuerySource, Evidence, Claim, ClaimEvidence];
