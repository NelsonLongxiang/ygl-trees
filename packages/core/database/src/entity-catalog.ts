/** Explicit entity selection and validation; no domain discovery or connection effects. */
import { isDeepStrictEqual } from "node:util";

export interface EntityManifest {
  readonly owner: string;
  readonly requires?: readonly string[];
  readonly entities: readonly { readonly key: string; readonly table: string }[];
}
export interface EntityRegistration {
  readonly owner: string;
  readonly key: string;
  readonly table: string;
  readonly target: Function;
}
export interface EntitySelection { readonly owners: readonly EntityManifest[] }
export interface EntityCatalog { readonly entities: readonly Function[] }

/** Bind an owner's declared keys without silently dropping a missing or extra constructor. */
export function registerEntityOwner(manifest: EntityManifest, bindings: Readonly<Record<string, Function>>): readonly EntityRegistration[] {
  if (!manifest || !bindings || typeof bindings !== "object") throw new Error("entity owner bindings are required");
  const expected = new Set(manifest.entities.map(member => member.key));
  for (const key of Object.keys(bindings)) if (!expected.has(key)) throw new Error("undeclared entity binding: " + manifest.owner + ":" + key);
  return Object.freeze(manifest.entities.map(member => {
    const target = Object.prototype.hasOwnProperty.call(bindings, member.key) ? bindings[member.key] : undefined;
    if (typeof target !== "function") throw new Error("missing entity binding: " + manifest.owner + ":" + member.key);
    return Object.freeze({ owner: manifest.owner, key: member.key, table: member.table, target });
  }));
}
class Selection implements EntitySelection {
  readonly owners: readonly EntityManifest[];
  constructor(owners: readonly EntityManifest[]) { this.owners = Object.freeze([...owners]); Object.freeze(this); }
}
class ValidatedCatalog implements EntityCatalog {
  readonly entities: readonly Function[];
  readonly #registrations: readonly EntityRegistration[];
  readonly #metadata: unknown;
  constructor(registrations: readonly EntityRegistration[]) {
    this.#registrations = Object.freeze([...registrations]);
    this.#metadata = selectedMetadata(this.#registrations);
    this.entities = Object.freeze(this.#registrations.map(entry => entry.target));
    Object.freeze(this);
  }
  assertUnchanged(): void {
    if (!isDeepStrictEqual(this.#metadata, selectedMetadata(this.#registrations))) throw new Error("entity metadata changed after catalog validation");
  }
}
const id = (owner: string, key: string) => JSON.stringify([owner, key]);
const valid = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.trim() === value;

/** Copy all declarations before any loader can await or caller can mutate its inputs. */
export function createEntitySelection(input: readonly EntityManifest[]): EntitySelection {
  if (!Array.isArray(input) || !input.length) throw new Error("at least one entity owner is required");
  const owners = new Map<string, EntityManifest>(), tables = new Map<string, string>();
  for (const manifest of input as readonly EntityManifest[]) {
    if (!manifest || !valid(manifest.owner) || !Array.isArray(manifest.entities) || !manifest.entities.length) throw new Error("invalid entity owner declaration");
    if (manifest.requires !== undefined && (!Array.isArray(manifest.requires) || manifest.requires.some((x: string) => !valid(x)))) throw new Error("invalid required entity owner");
    const keys = new Set<string>();
    const entities = manifest.entities.map((member: EntityManifest["entities"][number]) => {
      if (!member || !valid(member.key) || !valid(member.table) || keys.has(member.key)) throw new Error("invalid or duplicate entity key: " + manifest.owner);
      keys.add(member.key);
      return Object.freeze({ key: member.key, table: member.table });
    }).sort((a: EntityManifest["entities"][number], b: EntityManifest["entities"][number]) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const copy = Object.freeze({ owner: manifest.owner, requires: Object.freeze([...new Set<string>(manifest.requires ?? [])].sort()), entities: Object.freeze(entities) });
    const prior = owners.get(copy.owner);
    if (prior) {
      if (!isDeepStrictEqual(copy, prior)) throw new Error("conflicting entity owner: " + copy.owner);
      continue;
    }
    for (const member of copy.entities) {
      const collision = tables.get(member.table);
      if (collision) throw new Error("entity table already declared: " + member.table);
      tables.set(member.table, id(copy.owner, member.key));
    }
    owners.set(copy.owner, copy);
  }
  for (const owner of owners.values()) for (const required of owner.requires ?? []) if (!owners.has(required)) throw new Error("required entity owner is missing: " + required);
  return new Selection([...owners.values()].sort((a, b) => a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
}

/** Duplicate only metadata values; preserve constructor/callback identity and never freeze TypeORM's storage. */
function snapshot(value: any, seen = new Map<object, any>()): any {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return Object.freeze({ date: value.getTime() });
  if (Buffer.isBuffer(value)) return Object.freeze({ buffer: [...value] });
  const copy: any = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const key of Object.keys(value).sort()) copy[key] = snapshot(value[key], seen);
  return Object.freeze(copy);
}

function selectedMetadata(registrations: readonly EntityRegistration[]): unknown {
  // This load occurs only after explicit entity loading, never while creating a lightweight selection.
  const storage = require("typeorm").getMetadataArgsStorage();
  const targets = new Set(registrations.map(r => r.target));
  for (const registration of registrations) {
    const rows = storage.tables.filter((row: any) => row.target === registration.target);
    if (rows.length !== 1 || rows[0].name !== registration.table || rows[0].type !== "regular") throw new Error("entity table metadata does not match: " + registration.owner + ":" + registration.key);
  }
  const resolvedRelations: unknown[] = [];
  for (const relation of storage.relations.filter((row: any) => targets.has(row.target))) {
    if (typeof relation.type !== "function") throw new Error("entity relation target must be explicitly registered: " + String(relation.propertyName));
    let target: unknown;
    try { target = relation.type(); } catch { throw new Error("entity relation target cannot be resolved: " + String(relation.propertyName)); }
    if (!targets.has(target as Function)) throw new Error("entity relation target is not registered: " + String(relation.propertyName));
    resolvedRelations.push(Object.freeze({ target: relation.target, property: relation.propertyName, inverseTarget: target }));
  }
  const result: Record<string, unknown> = { resolvedRelations: Object.freeze(resolvedRelations) };
  for (const key of Object.keys(storage).sort()) {
    if (!Array.isArray(storage[key])) continue;
    result[key] = snapshot(storage[key].filter((row: any) => targets.has(row.target)));
  }
  return Object.freeze(result);
}

export function sealEntityCatalog(selection: EntitySelection, input: readonly EntityRegistration[]): EntityCatalog {
  if (!(selection instanceof Selection)) throw new Error("entity selection must be created by createEntitySelection");
  if (!Array.isArray(input)) throw new Error("entity registrations must be an array");
  const required = new Map<string, { owner: string; key: string; table: string }>();
  for (const owner of selection.owners) for (const member of owner.entities) required.set(id(owner.owner, member.key), { owner: owner.owner, ...member });
  const registrations = new Map<string, EntityRegistration>(), targets = new Set<Function>();
  for (const entry of input) {
    if (!entry || !valid(entry.owner) || !valid(entry.key) || !valid(entry.table) || typeof entry.target !== "function") throw new Error("invalid entity registration");
    const key = id(entry.owner, entry.key), expected = required.get(key);
    if (!expected) throw new Error("undeclared entity: " + entry.owner + ":" + entry.key);
    if (entry.table !== expected.table) throw new Error("conflicting entity table: " + entry.owner + ":" + entry.key);
    const prior = registrations.get(key);
    if (prior) {
      if (prior.target !== entry.target || prior.table !== entry.table) throw new Error("conflicting entity: " + entry.owner + ":" + entry.key);
      continue;
    }
    if (targets.has(entry.target)) throw new Error("conflicting entity constructor registered under multiple keys");
    targets.add(entry.target);
    registrations.set(key, Object.freeze({ owner: entry.owner, key: entry.key, table: entry.table, target: entry.target }));
  }
  const ordered = [...required].map(([key, value]) => {
    const registration = registrations.get(key);
    if (!registration) throw new Error("missing entity: " + value.owner + ":" + value.key);
    return registration;
  });
  return new ValidatedCatalog(ordered);
}

/** Recheck selected metadata at connection creation, not the global registry or unrelated loaded plugins. */
export function assertEntityCatalogUnchanged(catalog: EntityCatalog): void {
  if (!(catalog instanceof ValidatedCatalog)) throw new Error("entity catalog must be created by sealEntityCatalog");
  catalog.assertUnchanged();
}
