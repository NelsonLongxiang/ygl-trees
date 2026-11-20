import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB, SCHEMA_VERSION } from "../../../packages/core/database/src/db";
import { createEntitySelection, registerEntityOwner, sealEntityCatalog } from "../../../packages/core/database/src/entity-catalog";
import { CORE_ENTITY_MANIFEST } from "../../../packages/core/database/src/entity-manifest";
import { RESEARCH_ENTITY_MANIFEST } from "../../../packages/research/pipeline/src/entity-manifest";
import { CORE_ENTITY_REGISTRATIONS } from "../../../packages/core/database/src/entities";
import { RESEARCH_ENTITY_REGISTRATIONS } from "../../../packages/research/pipeline/src/entities";
import { createWorkspaceOrm } from "../src/workspace-orm";
import { getOrm as implicitSqlite, getPgOrm as implicitPg, closeOrm as implicitClose } from "../../../packages/core/database/src/orm";
import { createScopedOrm } from "../../../packages/core/database/src/scoped-orm";

const golden = [
  ["Event", "events"], ["PatrolCheck", "patrol_checks"], ["PatrolFinding", "patrol_findings"], ["VerifierInstance", "verifier_instances"], ["VerifierRun", "verifier_runs"],
  ["Project", "projects"], ["Query", "queries"], ["Source", "sources"], ["QuerySource", "query_sources"], ["Evidence", "evidence"], ["Claim", "claims"], ["ClaimEvidence", "claim_evidence"],
];
const resources: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of resources.splice(0).reverse()) await cleanup(); });
function fixture() {
  fs.mkdirSync(path.join(process.cwd(), "tmp"), { recursive: true });
  const root = fs.mkdtempSync(path.join(process.cwd(), "tmp/workspace-orm-"));
  resources.push(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const file = path.join(root, "workspace.db"), db = new DB(file); resources.push(() => db.close()); return { file, db };
}
describe("explicit workspace ORM composition", () => {
  it("keeps the independent 12-entity/table golden separate from owner declarations", () => {
    expect([...CORE_ENTITY_MANIFEST.entities, ...RESEARCH_ENTITY_MANIFEST.entities].map(x => [x.key, x.table])).toEqual(golden);
    expect([...CORE_ENTITY_REGISTRATIONS, ...RESEARCH_ENTITY_REGISTRATIONS].map(x => [x.key, x.table])).toEqual(golden);
  });
  it("requires exact constructor bindings rather than silently skipping a missing or extra member", () => {
    expect(() => registerEntityOwner(CORE_ENTITY_MANIFEST, {})).toThrow(/missing entity binding/);
    expect(() => registerEntityOwner(CORE_ENTITY_MANIFEST, { Unknown: class Unknown {} })).toThrow(/undeclared entity binding/);
  });
  it("seals the same complete catalog regardless of owner or registration order", () => {
    const a = sealEntityCatalog(createEntitySelection([CORE_ENTITY_MANIFEST, RESEARCH_ENTITY_MANIFEST]), [...CORE_ENTITY_REGISTRATIONS, ...RESEARCH_ENTITY_REGISTRATIONS]);
    const b = sealEntityCatalog(createEntitySelection([RESEARCH_ENTITY_MANIFEST, CORE_ENTITY_MANIFEST]), [...RESEARCH_ENTITY_REGISTRATIONS, ...CORE_ENTITY_REGISTRATIONS].reverse());
    expect(a.entities).toEqual(b.entities); expect(a.entities).toHaveLength(12);
  });
  it("opens all 12 entity metadata entries with 16 closed relations at schema v16", async () => {
    const { file, db } = fixture(), owner = createWorkspaceOrm({ dialect: "sqlite", file }); resources.push(() => owner.close());
    const [first, second] = await Promise.all([owner.getOrm(file), owner.getOrm(file)]);
    expect(first).toBe(second); expect(first.options.synchronize).toBe(false);
    expect(first.entityMetadatas.map(x => x.tableName).sort()).toEqual(golden.map(x => x[1]).sort());
    const relations = first.entityMetadatas.flatMap(x => x.relations);
    expect(relations).toHaveLength(16);
    expect(relations.every(r => first.entityMetadatas.includes(r.inverseEntityMetadata))).toBe(true);
    expect(db.get("PRAGMA user_version")).toEqual({ user_version: SCHEMA_VERSION });
    expect(SCHEMA_VERSION).toBe(16);
  });
  it("old no-owner adapters refuse before closing another owner", async () => {
    const { file } = fixture(), owner = createWorkspaceOrm({ dialect: "sqlite", file }); resources.push(() => owner.close());
    const ds = await owner.getOrm(file);
    await expect(implicitSqlite(file)).rejects.toThrow(/instance is required/);
    await expect(implicitPg("postgres://private:credential@invalid/db")).rejects.toThrow(/^ORM instance is required/);
    await expect(implicitClose()).rejects.toThrow(/instance is required/);
    expect(await ds.query("SELECT COUNT(*) n FROM projects")).toEqual([{ n: 0 }]);
  });
  it("an explicit core-only profile does not auto-load research metadata", async () => {
    const { file } = fixture();
    const owner = createScopedOrm({ target: { dialect: "sqlite", file }, selection: createEntitySelection([CORE_ENTITY_MANIFEST]), loadSelected: async () => CORE_ENTITY_REGISTRATIONS });
    resources.push(() => owner.close());
    const ds = await owner.getOrm(file); expect(ds.entityMetadatas.map(x => x.tableName).sort()).toEqual(golden.slice(0, 5).map(x => x[1]).sort());
    expect(ds.entityMetadatas).toHaveLength(5);
  });
  it("uses a new owner after close, with no process-global close or stale registry state", async () => {
    const { file } = fixture(), first = createWorkspaceOrm({ dialect: "sqlite", file }), second = createWorkspaceOrm({ dialect: "sqlite", file });
    resources.push(() => first.close(), () => second.close());
    const a = await first.getOrm(file), b = await second.getOrm(file);
    expect(a).not.toBe(b); await first.close();
    expect(await b.query("SELECT COUNT(*) n FROM projects")).toEqual([{ n: 0 }]);
    await expect(first.getOrm(file)).rejects.toThrow(/closed/);
    const third = createWorkspaceOrm({ dialect: "sqlite", file }); resources.push(() => third.close());
    expect((await third.getOrm(file)).entityMetadatas).toHaveLength(12);
  });
});
