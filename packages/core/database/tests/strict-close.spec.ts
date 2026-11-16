import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DB } from "../src/db";
import { PgAsyncDb } from "../src/asyncdb";

const databases: DB[] = [], roots: string[] = [];
function fixture() {
  fs.mkdirSync(path.join(process.cwd(), "tmp"), { recursive: true });
  const root = fs.mkdtempSync(path.join(process.cwd(), "tmp/strict-close-")); roots.push(root);
  const file = path.join(root, "workspace.db"), db = new DB(file, { lock: true }); databases.push(db);
  return { file, db, lock: file + ".ygllock" };
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
describe("strict owner resource release", () => {
  it("closes the actual SQLite handle before releasing only its owned lock", () => {
    const { db, lock } = fixture(); expect(fs.existsSync(lock)).toBe(true);
    db.closeStrict(); expect(fs.existsSync(lock)).toBe(false);
    expect(() => db.get("SELECT 1")).toThrow(); expect(() => db.closeStrict()).not.toThrow();
  });
  it("retains its lock and the same failure when native close fails, without retrying cleanup", () => {
    const { db, lock } = fixture(), failure = new Error("native close refused"), close = vi.spyOn(db.db, "close").mockImplementation(() => { throw failure; });
    expect(() => db.closeStrict()).toThrow(failure); expect(fs.existsSync(lock)).toBe(true);
    expect(() => db.closeStrict()).toThrow(failure); expect(close).toHaveBeenCalledTimes(1);
    expect(db.get("SELECT 1 n")).toEqual({ n: 1 });
  });
  it("does not release a lock which no longer belongs to this process", () => {
    const { db, lock } = fixture();
    fs.writeFileSync(path.join(lock, "pid"), "987654321");
    db.closeStrict(); expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readFileSync(path.join(lock, "pid"), "utf8")).toBe("987654321");
    db.ownsLock = false;
  });
  it("a lockless DB never releases another instance's lock", () => {
    const { file, lock } = fixture(), second = new DB(file); databases.push(second);
    second.closeStrict(); expect(fs.existsSync(lock)).toBe(true);
  });
  it("cleans an allocated DB and its owned lock when schema initialization fails before registration", () => {
    fs.mkdirSync(path.join(process.cwd(), "tmp"), { recursive: true });
    const root = fs.mkdtempSync(path.join(process.cwd(), "tmp/strict-construction-")); roots.push(root);
    const file = path.join(root, "workspace.db"), primary = new Error("schema initialization refused");
    const close = vi.spyOn(require("better-sqlite3").prototype, "close");
    vi.spyOn(DB.prototype as any, "migrate").mockImplementationOnce(() => { throw primary; });
    let actual: any; try { new DB(file, { lock: true, managed: true }); } catch (error) { actual = error; }
    expect(actual).toBe(primary); expect(actual.dbOpenCleanupComplete).toBe(true);
    expect(close).toHaveBeenCalledTimes(1); expect(close.mock.instances[0].open).toBe(false);
    expect(fs.existsSync(file + ".ygllock")).toBe(false);
  });
  it("a lock from a different instance with the same PID is not released", () => {
    const { db, lock } = fixture(); fs.writeFileSync(path.join(lock, "owner"), "another-instance");
    db.closeStrict(); expect(fs.existsSync(lock)).toBe(true); expect(fs.readFileSync(path.join(lock, "owner"), "utf8")).toBe("another-instance");
    db.ownsLock = false;
  });
  it("a second independent same-PID writer cannot take an active instance lock", () => {
    const { file, db, lock } = fixture(), identity = fs.readFileSync(path.join(lock, "owner"), "utf8");
    let second: DB | undefined;
    try { expect(() => { second = new DB(file, { lock: true, managed: true }); databases.push(second); }).toThrow(/active instance|locked/); }
    finally { second?.close(); }
    expect(fs.existsSync(lock)).toBe(true); expect(fs.readFileSync(path.join(lock, "owner"), "utf8")).toBe(identity);
    db.run("INSERT INTO meta(key,value) VALUES(?,?)", ["live-first-owner", "yes"]); expect(db.metaGet("live-first-owner")).toBe("yes");
  });
  it("waits for an accepted PG query before ending its native client, then rejects new queries", async () => {
    const queryGate = gate(), started = gate(), events: string[] = [];
    const client = { connect: vi.fn(async () => {}), query: vi.fn(async () => { events.push("query"); started.resolve(); await queryGate.promise; events.push("settled"); return { rows: [{ n: 1 }] }; }), end: vi.fn(async () => { events.push("end"); }) };
    const db = new PgAsyncDb("postgres://unused", () => client);
    const query = db.all("SELECT 1 n"); await started.promise;
    const close = db.closeStrict(); expect(db.closeStrict()).toBe(close);
    await expect(db.all("SELECT 2 n")).rejects.toThrow(/closed|closing/);
    expect(client.end).not.toHaveBeenCalled(); queryGate.resolve(); expect(await query).toEqual([{ n: 1 }]); await close;
    expect(events).toEqual(["query", "settled", "end"]); expect(client.end).toHaveBeenCalledTimes(1);
  });
  it("ends an allocated PG client even if connect failed, preserving strict close failure", async () => {
    const connectError = new Error("connect failed"), endError = new Error("end unknown");
    const client = { connect: vi.fn(async () => { throw connectError; }), query: vi.fn(), end: vi.fn(async () => { throw endError; }) };
    const db = new PgAsyncDb("postgres://unused", () => client);
    await expect(db.all("SELECT 1")).rejects.toBe(connectError);
    const first = db.closeStrict(); await expect(first).rejects.toBe(endError);
    expect(db.closeStrict()).toBe(first); await expect(db.closeStrict()).rejects.toBe(endError);
    expect(client.end).toHaveBeenCalledTimes(1); await expect(db.get("SELECT 1")).rejects.toThrow(/closed|closing/);
  });
  it("close of an unused native PG client never loads or constructs it", async () => {
    const factory = vi.fn(), db = new PgAsyncDb("postgres://unused", factory);
    await db.closeStrict(); expect(factory).not.toHaveBeenCalled();
  });
});
