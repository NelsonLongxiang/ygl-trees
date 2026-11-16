import "reflect-metadata";
import { Column, Entity, PrimaryColumn, getMetadataArgsStorage } from "typeorm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createEntitySelection, sealEntityCatalog } from "../src/entity-catalog";
import { openOrmConnection, type OrmConnection } from "../src/orm-connection";

@Entity({ name: "connection_thing" })
class Thing { @PrimaryColumn({ type: "text" }) id!: string; }
@Entity({ name: "connection_bad" })
class Bad {
  @PrimaryColumn({ type: "text" }) id!: string;
  @Column({ type: "unsupported-for-both-drivers" as any }) value!: string;
}
const Native = require("better-sqlite3");
const leases: OrmConnection[] = [];
const roots: string[] = [];
function fixture() {
  fs.mkdirSync(path.join(process.cwd(), "tmp"), { recursive: true });
  const root = fs.mkdtempSync(path.join(process.cwd(), "tmp/orm-connection-")); roots.push(root);
  const file = path.join(root, "workspace.db"), db = new Native(file);
  db.exec("PRAGMA user_version=15;CREATE TABLE connection_thing(id TEXT PRIMARY KEY);INSERT INTO connection_thing VALUES('original')");
  db.close(); return file;
}
function catalog(bad = false) {
  const member = { key: "thing", table: bad ? "connection_bad" : "connection_thing" };
  return sealEntityCatalog(createEntitySelection([{ owner: "test/connection", entities: [member] }]), [{ owner: "test/connection", ...member, target: bad ? Bad : Thing }]);
}
afterEach(async () => {
  for (const lease of leases.splice(0)) { try { await lease.close(); } catch { /* expected strict failed close remains poisoned */ } }
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("owned native ORM connections", () => {
  it("opens the explicit SQLite catalog without synchronizing or altering schema and closes the actual handle", async () => {
    const file = fixture(), lease = await openOrmConnection({ dialect: "sqlite", file }, catalog(), () => false); leases.push(lease);
    const ds = lease.dataSource, native = (ds.driver as any).databaseConnection;
    expect(ds.options.synchronize).toBe(false); expect(ds.entityMetadatas.map(x => x.tableName)).toEqual(["connection_thing"]);
    expect(await ds.query("PRAGMA user_version")).toEqual([{ user_version: 15 }]);
    expect(await ds.query("SELECT id FROM connection_thing")).toEqual([{ id: "original" }]);
    expect(await ds.query("PRAGMA busy_timeout")).toEqual([{ timeout: 10000 }]);
    expect(native.open).toBe(true);
    const first = lease.close(); expect(lease.close()).toBe(first); await first;
    expect(native.open).toBe(false); expect(ds.isInitialized).toBe(false);
  });
  it("keeps a same-target second connection usable when the first owner closes", async () => {
    const file = fixture(), first = await openOrmConnection({ dialect: "sqlite", file }, catalog(), () => false), second = await openOrmConnection({ dialect: "sqlite", file }, catalog(), () => false);
    leases.push(first, second); await first.close();
    expect(await second.dataSource.query("SELECT COUNT(*) n FROM connection_thing")).toEqual([{ n: 1 }]);
    expect((second.dataSource.driver as any).databaseConnection.open).toBe(true);
  });
  it("closes the allocated native handle when metadata initialization fails", async () => {
    const file = fixture(), close = vi.spyOn(Native.prototype, "close");
    await expect(openOrmConnection({ dialect: "sqlite", file }, catalog(true), () => false)).rejects.toThrow(/not supported|unsupported/);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close.mock.instances[0].open).toBe(false);
  });
  it("closes a handle that was allocated before driver.connect failed to return it", async () => {
    const file = fixture(), close = vi.spyOn(Native.prototype, "close");
    vi.spyOn(Native.prototype, "pragma").mockImplementationOnce(() => { throw new Error("foreign-key setup failed"); });
    await expect(openOrmConnection({ dialect: "sqlite", file }, catalog(), () => false)).rejects.toThrow("foreign-key setup failed");
    expect(close).toHaveBeenCalledTimes(1); expect(close.mock.instances[0].open).toBe(false);
  });
  it("retains metadata initialization as primary when native close also fails, without repeating native close", async () => {
    const file = fixture(), failure = new Error("native close unknown"), nativeClose = Native.prototype.close;
    const close = vi.spyOn(Native.prototype, "close").mockImplementation(() => { throw failure; });
    let primary: any;
    try {
      primary = await openOrmConnection({ dialect: "sqlite", file }, catalog(true), () => false).then(() => undefined, error => error);
      expect(primary.message).toMatch(/not supported|unsupported/); expect(primary.ormCleanupErrors).toContain(failure);
      expect(close).toHaveBeenCalledTimes(1); expect(close.mock.instances[0].open).toBe(true);
    } finally { for (const native of close.mock.instances) if (native.open) nativeClose.call(native); close.mockRestore(); }
  });
  it("does not retry a failed native close when destroy and owner cleanup both join it", async () => {
    const file = fixture(), nativeClose = Native.prototype.close;
    const close = vi.spyOn(Native.prototype, "close").mockImplementation(() => { throw new Error("release refused"); });
    const lease = await openOrmConnection({ dialect: "sqlite", file }, catalog(), () => false);
    const native = (lease.dataSource.driver as any).databaseConnection;
    try { const first = lease.close(); expect(lease.close()).toBe(first); await expect(first).rejects.toThrow(/resources/); expect(close).toHaveBeenCalledTimes(1); expect(native.open).toBe(true); }
    finally { nativeClose.call(native); close.mockRestore(); }
  });
  it("rechecks selected metadata after the async module load before native allocation", async () => {
    const file = fixture(), selected = catalog(), column = getMetadataArgsStorage().columns.find(row => row.target === Thing)!;
    const original = column.options.default, pragma = vi.spyOn(Native.prototype, "pragma");
    let lease: OrmConnection | undefined, failure: any;
    try {
      const opening = openOrmConnection({ dialect: "sqlite", file }, selected, () => false);
      column.options.default = "changed-after-open-start";
      await opening.then(value => { lease = value; }, error => { failure = error; });
      expect(failure?.message).toMatch(/entity metadata changed/); expect(pragma).not.toHaveBeenCalled();
    } finally { column.options.default = original; await lease?.close(); pragma.mockRestore(); }
  });
  it("also refuses metadata changed during driver connection before metadata construction", async () => {
    const file = fixture(), selected = catalog(), column = getMetadataArgsStorage().columns.find(row => row.target === Thing)!;
    const original = column.options.default, realPragma = Native.prototype.pragma; let lease: OrmConnection | undefined, failure: any;
    const pragma = vi.spyOn(Native.prototype, "pragma").mockImplementationOnce(function(this:any, ...args:any[]) { column.options.default = "changed-during-connect"; return realPragma.apply(this,args); });
    const close = vi.spyOn(Native.prototype, "close");
    try { await openOrmConnection({ dialect: "sqlite", file }, selected, () => false).then(value => { lease = value; }, error => { failure = error; });
      expect(failure?.message).toMatch(/entity metadata changed/); expect(close).toHaveBeenCalledTimes(1); expect(close.mock.instances[0].open).toBe(false);
    } finally { column.options.default = original; await lease?.close(); pragma.mockRestore(); close.mockRestore(); }
  });
  it("refuses cancelled or forged catalogs before opening native resources", async () => {
    const file = fixture(), close = vi.spyOn(Native.prototype, "close");
    await expect(openOrmConnection({ dialect: "sqlite", file }, catalog(), () => true)).rejects.toThrow(/closed|cancel/);
    await expect(openOrmConnection({ dialect: "sqlite", file }, { entities: [Thing] } as any, () => false)).rejects.toThrow(/created by/);
    expect(close).not.toHaveBeenCalled();
  });
});
