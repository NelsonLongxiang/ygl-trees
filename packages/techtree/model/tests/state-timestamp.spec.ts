import { afterEach, describe, expect, it, vi } from "vitest";
import { DB } from "../../../core/database/src/db";
import * as asyncdb from "../../../core/database/src/asyncdb";
import { TreeStore } from "../src/reads";
import { AsyncTreeStore } from "../src/async-store";

let db: DB | undefined;
afterEach(() => { vi.restoreAllMocks(); db?.close(); db = undefined; });

describe("node state timestamps", () => {
  it.each(["sync", "async-sqlite", "pg-projection"])("%s only exposes the current context's actual unlock timestamp", async mode => {
    db = new DB(":memory:");
    db.run("INSERT INTO trees(id,name,created) VALUES(?,?,?)", ["t", "timestamps", "2026-01-01"]);
    db.run("INSERT INTO nodes(id,tree_id,key,name,created) VALUES(?,?,?,?,?)", ["n", "t", "x", "X", "2026-01-01"]);
    if (mode === "pg-projection") {
      // Exercise the PG query branches through SQLite's SQL-compatible CASE implementation.
      const sql = (query: string) => query.replace(/::int/g, "").replace(/COLLATE "C"/g, "COLLATE BINARY");
      vi.spyOn(asyncdb, "getAsyncDb").mockReturnValue({
        dialect: "pg", get: async (q, args) => db!.get(sql(q), args), all: async (q, args) => db!.all(sql(q), args),
      });
    }
    const store = mode === "sync" ? new TreeStore(db) : new AsyncTreeStore(db);
    expect(await store.nodeStateOf("t", "x")).toEqual({ state: "locked", unlocked_at: null });
    expect((await store.nodeList("t"))[0]).toMatchObject({ key: "x", state: "locked", unlocked_at: null });
    db.run("INSERT INTO node_state(tree_id,context,node_id,status,updated) VALUES(?,?,?,?,?)", ["t", "default", "n", "unlocked", "2026-02-01"]);
    db.run("INSERT INTO node_state(tree_id,context,node_id,status,updated) VALUES(?,?,?,?,?)", ["t", "other", "n", "unlocked", "2026-03-01"]);
    expect(await store.nodeStateOf("t", "n")).toEqual({ state: "unlocked", unlocked_at: "2026-02-01" });
    expect((await store.nodeList("t"))[0].unlocked_at).toBe("2026-02-01");
    db.run("UPDATE node_state SET status='locked',updated='2026-04-01' WHERE context='default'");
    const before = db.all("SELECT * FROM node_state ORDER BY context");
    expect(await store.nodeStateOf("t", "x")).toEqual({ state: "locked", unlocked_at: null });
    expect((await store.nodeList("t"))[0]).toMatchObject({ state: "locked", unlocked_at: null });
    expect(await store.nodeStateOf("t", "x", "other")).toEqual({ state: "unlocked", unlocked_at: "2026-03-01" });
    expect((await store.nodeList("t", "other"))[0].unlocked_at).toBe("2026-03-01");
    expect(db.all("SELECT * FROM node_state ORDER BY context")).toEqual(before);
  });
});
