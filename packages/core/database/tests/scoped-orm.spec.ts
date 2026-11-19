import "reflect-metadata";
import { Entity, PrimaryColumn } from "typeorm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEntitySelection } from "../src/entity-catalog";
import { createScopedOrm } from "../src/scoped-orm";

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../src/orm-connection", () => ({ openOrmConnection: mocks.open }));
@Entity({ name: "scoped_thing" })
class Thing { @PrimaryColumn({ type: "text" }) id!: string; }
const manifest = { owner: "test/scoped", entities: [{ key: "thing", table: "scoped_thing" }] };
const registration = { owner: manifest.owner, key: "thing", table: "scoped_thing", target: Thing };
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const owners: ReturnType<typeof createScopedOrm>[] = [];
function setup(loadSelected = vi.fn(async () => [registration]), target: any = { dialect: "sqlite", file: "fixture.db" }) {
  const owner = createScopedOrm({ target, selection: createEntitySelection([manifest]), loadSelected });
  owners.push(owner); return { owner, loadSelected };
}
function connection() { return { dataSource: { id: Symbol("ds") }, close: vi.fn(async () => {}) }; }
beforeEach(() => { mocks.open.mockReset(); });
afterEach(async () => {
  for (const owner of owners.splice(0)) { try { await owner.close(); } catch { /* expected poisoned owner */ } }
});

describe("instance-owned lazy ORM", () => {
  it("single-flights the loader, catalog and connection from the first await", async () => {
    const barrier = deferred<typeof registration[]>(), started = deferred<void>(), lease = connection();
    mocks.open.mockResolvedValue(lease);
    const { owner, loadSelected } = setup(vi.fn(() => { started.resolve(); return barrier.promise; }));
    const first = owner.getOrm("fixture.db"), second = owner.getOrm("fixture.db");
    await started.promise;
    expect(loadSelected).toHaveBeenCalledTimes(1); expect(mocks.open).not.toHaveBeenCalled();
    barrier.resolve([registration]);
    expect(await first).toBe(lease.dataSource); expect(await second).toBe(lease.dataSource);
    expect(await owner.getOrm("fixture.db")).toBe(lease.dataSource);
    expect(mocks.open).toHaveBeenCalledTimes(1);
    await owner.close(); expect(lease.close).toHaveBeenCalledTimes(1);
  });
  it("close before first get never loads or opens anything", async () => {
    const { owner, loadSelected } = setup();
    const first = owner.close(); expect(owner.close()).toBe(first); await first;
    expect(loadSelected).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled();
    await expect(owner.getOrm("fixture.db")).rejects.toThrow(/closed/);
  });
  it("close during the loader barrier joins assembly and forbids late connection creation", async () => {
    const gate = deferred<typeof registration[]>(), started = deferred<void>();
    const { owner } = setup(vi.fn(() => { started.resolve(); return gate.promise; }));
    const getting = expect(owner.getOrm("fixture.db")).rejects.toThrow(/closed/);
    await started.promise;
    let closed = false; const close = owner.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    gate.resolve([registration]); await getting; await close;
    expect(closed).toBe(true); expect(mocks.open).not.toHaveBeenCalled();
  });
  it("close joins a failed loader without an unhandled rejection or connection", async () => {
    const gate = deferred<typeof registration[]>(), started = deferred<void>();
    const { owner } = setup(vi.fn(() => { started.resolve(); return gate.promise; }));
    const primary = new Error("load failed");
    const getting = expect(owner.getOrm("fixture.db")).rejects.toBe(primary);
    await started.promise; const close = owner.close(); gate.reject(primary);
    await getting; await close; expect(mocks.open).not.toHaveBeenCalled();
  });
  it("close during initialization destroys the late connection instead of publishing a closed DS", async () => {
    const gate = deferred<any>(), started = deferred<void>(), lease = connection();
    mocks.open.mockImplementation(() => { started.resolve(); return gate.promise; });
    const { owner } = setup();
    const getting = expect(owner.getOrm("fixture.db")).rejects.toThrow(/closed/);
    await started.promise; const close = owner.close(); gate.resolve(lease);
    await getting; await close;
    expect(lease.close).toHaveBeenCalledTimes(1);
  });
  it("validates required entities before constructing or opening a DataSource", async () => {
    const { owner } = setup(vi.fn(async () => []));
    await expect(owner.getOrm("fixture.db")).rejects.toThrow(/missing entity/);
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("can explicitly retry a failed clean initialization without caching its rejection", async () => {
    const primary = new Error("initialization refused"), lease = connection();
    mocks.open.mockRejectedValueOnce(primary).mockResolvedValueOnce(lease);
    const { owner, loadSelected } = setup();
    await expect(owner.getOrm("fixture.db")).rejects.toBe(primary);
    expect(await owner.getOrm("fixture.db")).toBe(lease.dataSource);
    expect(loadSelected).toHaveBeenCalledTimes(2); expect(mocks.open).toHaveBeenCalledTimes(2);
  });
  it("an initialization with unknown cleanup poisons its owner without replacing the primary error", async () => {
    const primary = new Error("original initialization failure"), cleanup = new Error("release unknown");
    Object.defineProperty(primary, "ormCleanupErrors", { value: [cleanup] });
    mocks.open.mockRejectedValue(primary);
    const { owner, loadSelected } = setup();
    const first = await owner.getOrm("fixture.db").then(() => undefined, error => error);
    expect(first).toBe(primary);
    const second = await owner.getOrm("fixture.db").then(() => undefined, error => error);
    const closing = await owner.close().then(() => undefined, error => error);
    expect(second).toBeInstanceOf(AggregateError); expect(second.message).toMatch(/cleanup|poisoned/);
    expect(closing).toBe(second); expect(closing.message).toMatch(/cleanup/);
    expect(loadSelected).toHaveBeenCalledTimes(1); expect(mocks.open).toHaveBeenCalledTimes(1);
  });
  it("repeated failed close shares one failure and never silently reopens or retries cleanup", async () => {
    const cleanup = new Error("release failure"), lease = connection(); lease.close.mockRejectedValue(cleanup);
    mocks.open.mockResolvedValue(lease); const { owner } = setup(); await owner.getOrm("fixture.db");
    const first = owner.close(); expect(owner.close()).toBe(first);
    await expect(first).rejects.toThrow(/cleanup/);
    await expect(owner.getOrm("fixture.db")).rejects.toThrow(/poisoned|cleanup/);
    expect(lease.close).toHaveBeenCalledTimes(1);
  });
  it("owns independent connections even when two owners use the same target", async () => {
    const a = connection(), b = connection(); mocks.open.mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    const one = setup().owner, two = setup().owner;
    await one.getOrm("fixture.db"); await two.getOrm("fixture.db"); await one.close();
    expect(a.close).toHaveBeenCalledTimes(1); expect(b.close).not.toHaveBeenCalled();
    expect(await two.getOrm("fixture.db")).toBe(b.dataSource); expect(mocks.open).toHaveBeenCalledTimes(2);
  });
  it("rejects target and dialect changes before loading, with no credential disclosure", async () => {
    const { owner, loadSelected } = setup();
    await expect(owner.getOrm("other.db")).rejects.toThrow(/target/);
    await expect(owner.getPgOrm("postgres://user:password@example.invalid/private")).rejects.toThrow(/^ORM target does not match this owner$/);
    expect(loadSelected).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled();
  });
  it("copies the target at construction and supports the PG path with the same complete catalog", async () => {
    const target = { dialect: "postgres", url: "postgres://u:p@localhost/example" }, lease = connection();
    mocks.open.mockResolvedValue(lease); const { owner } = setup(undefined, target); target.url = "changed";
    expect(await owner.getPgOrm("postgres://u:p@localhost/example")).toBe(lease.dataSource);
    expect(mocks.open.mock.calls[0][0]).toEqual({ dialect: "postgres", url: "postgres://u:p@localhost/example" });
    expect(mocks.open.mock.calls[0][1].entities).toEqual([Thing]);
  });
});
