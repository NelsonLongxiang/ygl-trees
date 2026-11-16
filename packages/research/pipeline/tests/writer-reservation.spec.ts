import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-ignore — runtime dependency has no bundled declarations.
import NativeDatabase from "better-sqlite3";
import { DataSource } from "typeorm";
import { DB } from "../../../core/database/src/db";
import { CORE_ENTITIES } from "../../../core/database/src/entities";
import { RESEARCH_ENTITIES } from "../src/entities";
import { kbAdd, queryAdd, runTx } from "../src/writes";
import { onEvent, type YglEvent } from "../../../core/text/src/eventbus";

const ROOT = resolve(__dirname, "../../../..");
async function fixture(probe: (ds: DataSource, other: any) => Promise<void>) {
  const parent = join(ROOT, "tmp/writer-reservation"); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "run-")), file = join(home, "workspace.sqlite");
  let ds: DataSource | undefined, other: any;
  try {
    const seed = new DB(file, { lock: false });
    try {
      seed.run("INSERT INTO meta(key,value) VALUES('reservation-probe','0')");
      seed.run("INSERT INTO projects(id,name,created,updated) VALUES('p1','reservation-project','2026-01-01','2026-01-01')");
    } finally { seed.close(); }
    ds = new DataSource({ type: "better-sqlite3", database: file, synchronize: false, entities: [...RESEARCH_ENTITIES, ...CORE_ENTITIES] });
    await ds.initialize(); await ds.query("PRAGMA busy_timeout=10000");
    other = new NativeDatabase(file, { timeout: 0 });
    expect(other.pragma("journal_mode", { simple: true })).toBe("wal");
    await probe(ds, other);
  } finally {
    try { if (ds?.isInitialized) await ds.destroy(); }
    finally {
      try { other?.close(); }
      finally { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    }
  }
}

const mutateMarker = (db: any) => db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='reservation-probe'").run();
const marker = (db: any) => db.prepare("SELECT value FROM meta WHERE key='reservation-probe'").get().value;
const count = (db: any, table: string) => Number(db.prepare("SELECT COUNT(*) AS n FROM " + table).get().n);

describe("SQLite write reservation before dedupe reads (#286)", () => {
  it("control: a competitor commit invalidates an already-read WAL transaction", () => fixture(async (ds, other) => {
    let failure: any;
    try {
      await ds.transaction(async mgr => {
        await mgr.query("SELECT value FROM meta WHERE key='reservation-probe'");
        mutateMarker(other);
        await mgr.query("UPDATE meta SET value='unreachable' WHERE key='reservation-probe'");
      });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "SQLITE_BUSY_SNAPSHOT" });
    expect(marker(other)).toBe("1");
  }));

  it.each(["query", "kb"] as const)("%s dedupe read cannot lose the write slot to a second connection", kind => fixture(async (ds, other) => {
    const runner = ds.createQueryRunner(), original = runner.query.bind(runner);
    const competing: Array<{ blocked: boolean; code?: string }> = [];
    const seen: Array<{ event: YglEvent; committedRows: number }> = [];
    const table = kind === "query" ? "queries" : "kb_notes", eventKind = kind + ".add";
    const unsub = onEvent(event => { if (event.kind === eventKind) seen.push({ event, committedRows: count(other, table) }); });
    const hook = vi.spyOn(runner, "query").mockImplementation(async (...args: any[]) => {
      const result = await (original as any)(...args), sql = String(args[0]);
      const dedupe = kind === "query"
        ? /\bFROM\s+"queries"\s/.test(sql) && /\bWHERE\b[\s\S]*"content_hash"\s*=/.test(sql)
        : /\bFROM\s+kb_notes\b.*\bcontent_hash\b/.test(sql);
      if (dedupe) {
        // The real competing commit is placed after the actual dedupe SELECT, not after a sleep.
        try { mutateMarker(other); competing.push({ blocked: false }); }
        catch (error: any) { competing.push({ blocked: true, code: error.code }); }
      }
      return result;
    });
    const write = () => kind === "query" ? queryAdd(ds, "p1", "reservation query") : kbAdd(ds, { title: "reservation note", body: "transaction body" });
    try {
      let result: Awaited<ReturnType<typeof write>> | undefined, failure: any;
      try { result = await write(); } catch (error) { failure = error; }
      expect(failure, JSON.stringify({ competing, errorCode: failure?.code })).toBeUndefined();
      expect(result?.dup).toBe(false);
      expect(competing).toEqual([{ blocked: true, code: "SQLITE_BUSY" }]);
      expect(marker(other)).toBe("0");
      expect(count(other, table)).toBe(1);
      if (kind === "kb") expect(count(other, "kb_fts")).toBe(1);
      expect(count(other, "events")).toBe(1);
      expect(seen.map(item => item.committedRows)).toEqual([1]);
      const duplicate = await write();
      expect(duplicate.dup).toBe(true); expect(duplicate.row.id).toBe(result!.row.id);
      expect(competing).toEqual([{ blocked: true, code: "SQLITE_BUSY" }, { blocked: true, code: "SQLITE_BUSY" }]);
      expect(count(other, table)).toBe(1); expect(count(other, "events")).toBe(1); expect(seen).toHaveLength(1);
      expect(mutateMarker(other).changes).toBe(1); // The completed transaction releases its reservation.
    } finally { hook.mockRestore(); unsub(); }
  }));

  it("an event failure rolls back base, FTS and pending bus output and releases the writer", () => fixture(async (ds, other) => {
    other.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events WHEN NEW.kind='kb.add' BEGIN SELECT RAISE(ABORT,'reservation fixture abort'); END");
    const seen: YglEvent[] = [], unsub = onEvent(event => seen.push(event));
    try {
      await expect(kbAdd(ds, { title: "rollback note", body: "must not survive" })).rejects.toThrow("reservation fixture abort");
      for (const table of ["kb_notes", "kb_fts", "events"]) expect(count(other, table)).toBe(0);
      expect(seen).toHaveLength(0); expect(marker(other)).toBe("0");
      expect(mutateMarker(other).changes).toBe(1);
    } finally { unsub(); }
  }));

  it("exhausting acquisition keeps the callback unentered and the attempt budget unchanged", () => fixture(async (ds, other) => {
    await ds.query("PRAGMA busy_timeout=1"); // Test-only bounded observer; product timeout is unchanged.
    other.exec("BEGIN IMMEDIATE");
    const body = vi.fn(async () => "must not execute");
    const runner = ds.createQueryRunner(), original = runner.query.bind(runner); let reservations = 0;
    const hook = vi.spyOn(runner, "query").mockImplementation(async (...args: any[]) => {
      if (String(args[0]) === "UPDATE meta SET value=value WHERE 0") reservations++;
      return (original as any)(...args);
    });
    try {
      await expect(runTx(ds, body)).rejects.toMatchObject({ code: "SQLITE_BUSY" });
      expect(body).not.toHaveBeenCalled(); expect(reservations).toBe(5);
      expect(marker(other)).toBe("0"); expect(count(other, "events")).toBe(0);
    } finally { hook.mockRestore(); other.exec("ROLLBACK"); }
    expect(mutateMarker(other).changes).toBe(1);
  }));

  it("does not send SQLite reservation SQL to the PostgreSQL transaction manager", async () => {
    const manager = { connection: { options: { type: "postgres" } }, query: vi.fn(async () => []) };
    const transaction = vi.fn(async (body: (mgr: any) => Promise<unknown>) => body(manager));
    const result = await runTx({ transaction } as any, async mgr => { await mgr.query("SELECT 1"); return "postgres unchanged"; });
    expect(result).toBe("postgres unchanged"); expect(transaction).toHaveBeenCalledTimes(1);
    expect(manager.query.mock.calls.map(call => call[0])).toEqual(["SELECT 1"]);
  });
});
