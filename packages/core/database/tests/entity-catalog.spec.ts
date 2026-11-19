import "reflect-metadata";
import { Column, Entity, ManyToOne, PrimaryColumn, getMetadataArgsStorage } from "typeorm";
import { describe, expect, it } from "vitest";
import { createEntitySelection, sealEntityCatalog, assertEntityCatalogUnchanged } from "../src/entity-catalog";

@Entity({ name: "catalog_parent" })
class Parent { @PrimaryColumn({ type: "text" }) id!: string; }
@Entity({ name: "catalog_child" })
class Child {
  @PrimaryColumn({ type: "text" }) id!: string;
  @ManyToOne(() => Parent, { createForeignKeyConstraints: false }) parent?: Parent;
}
@Entity({ name: "catalog_alone" })
class Alone { @PrimaryColumn({ type: "text" }) id!: string; }
@Entity({ name: "catalog_noise" })
class Noise { @PrimaryColumn({ type: "text" }) id!: string; }

const manifest = { owner: "test/catalog", entities: [{ key: "parent", table: "catalog_parent" }, { key: "child", table: "catalog_child" }, { key: "alone", table: "catalog_alone" }] };
const registrations = [
  { owner: manifest.owner, key: "parent", table: "catalog_parent", target: Parent },
  { owner: manifest.owner, key: "child", table: "catalog_child", target: Child },
  { owner: manifest.owner, key: "alone", table: "catalog_alone", target: Alone },
];

describe("explicit entity catalog", () => {
  it("requires declared owners before entity loading", () => {
    expect(() => createEntitySelection([{ ...manifest, requires: ["missing/domain"] }])).toThrow(/required entity owner/);
    expect(() => createEntitySelection([])).toThrow(/entity owner/);
  });
  it("seals only the explicit complete set, not unrelated decorators", () => {
    const catalog = sealEntityCatalog(createEntitySelection([manifest]), registrations);
    expect(catalog.entities).toHaveLength(3);
    expect(catalog.entities).not.toContain(Noise);
    expect(catalog.entities).toEqual([Alone, Child, Parent]);
    expect(Object.isFrozen(catalog.entities)).toBe(true);
    expect(() => assertEntityCatalogUnchanged(catalog)).not.toThrow();
  });
  it("rejects missing independent members even when relationships are closed", () => {
    expect(() => sealEntityCatalog(createEntitySelection([manifest]), registrations.slice(0, 2))).toThrow(/missing entity.*alone/);
  });
  it("rejects an omitted relation target before connecting", () => {
    const subset = { owner: "test/catalog", entities: [{ key: "child", table: "catalog_child" }] };
    expect(() => sealEntityCatalog(createEntitySelection([subset]), [registrations[1]])).toThrow(/relation target/);
  });
  it("accepts only exactly idempotent duplicate registrations", () => {
    const selection = createEntitySelection([manifest, manifest]);
    expect(sealEntityCatalog(selection, [...registrations, registrations[0]]).entities).toHaveLength(3);
    expect(() => sealEntityCatalog(selection, [...registrations, { ...registrations[0], target: Alone }])).toThrow(/conflicting entity/);
  });
  it("rejects unknown keys, table collisions and substituted constructors", () => {
    const selection = createEntitySelection([manifest]);
    expect(() => sealEntityCatalog(selection, [...registrations, { ...registrations[0], key: "extra" }])).toThrow(/undeclared entity/);
    expect(() => createEntitySelection([manifest, { owner: "another", entities: [{ key: "parent2", table: "catalog_parent" }] }])).toThrow(/table.*already/);
    expect(() => sealEntityCatalog(selection, [{ ...registrations[0], target: Noise }, ...registrations.slice(1)])).toThrow(/table metadata/);
  });
  it("copies declarations and registration inputs instead of freezing the caller", () => {
    const entities = manifest.entities.map(x => ({ ...x }));
    const selection = createEntitySelection([{ owner: manifest.owner, entities }]);
    entities[0].table = "changed";
    const values = registrations.map(x => ({ ...x }));
    const catalog = sealEntityCatalog(selection, values);
    values[0].target = Noise;
    expect(catalog.entities).toContain(Parent);
    expect(() => assertEntityCatalogUnchanged(catalog)).not.toThrow();
  });
  it("detects metadata mutation for a selected target without freezing TypeORM global state", () => {
    const catalog = sealEntityCatalog(createEntitySelection([manifest]), registrations);
    const column = getMetadataArgsStorage().columns.find(x => x.target === Parent)!;
    const original = column.options.type;
    try {
      column.options.type = "integer";
      expect(() => assertEntityCatalogUnchanged(catalog)).toThrow(/entity metadata changed/);
    } finally { column.options.type = original; }
    expect(() => assertEntityCatalogUnchanged(catalog)).not.toThrow();
  });
  it("detects a relation callback changing its selected target after validation", () => {
    let target: Function = Parent;
    const relation = getMetadataArgsStorage().relations.find(x => x.target === Child)!;
    const original = relation.type;
    try {
      relation.type = () => target;
      const catalog = sealEntityCatalog(createEntitySelection([manifest]), registrations);
      target = Alone;
      expect(() => assertEntityCatalogUnchanged(catalog)).toThrow(/entity metadata changed/);
    } finally { relation.type = original; }
  });
  it("rejects caller-created selection and catalog objects", () => {
    expect(() => sealEntityCatalog({ owners: [] } as any, registrations)).toThrow(/created by/);
    expect(() => assertEntityCatalogUnchanged({ entities: [Parent] } as any)).toThrow(/created by/);
  });
  it("preserves independent catalogs across different selections", () => {
    const first = sealEntityCatalog(createEntitySelection([manifest]), registrations);
    const second = sealEntityCatalog(createEntitySelection([{ owner: "core-only", entities: [{ key: "standalone", table: "catalog_alone" }] }]), [{ owner: "core-only", key: "standalone", table: "catalog_alone", target: Alone }]);
    expect(first.entities).toHaveLength(3); expect(second.entities).toEqual([Alone]);
    expect(() => assertEntityCatalogUnchanged(first)).not.toThrow();
  });
});
