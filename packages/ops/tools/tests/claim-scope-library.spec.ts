import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DB } from "../../../core/database/src/db";
import { libraryList, libraryShow } from "../src/library";
let root: string, db: DB;
beforeAll(() => {
  mkdirSync(join(process.cwd(), "tmp"), { recursive: true }); root = mkdtempSync(join(process.cwd(), "tmp/claim-scope-library-"));
  db = new DB(join(root, "workspace.db"), { managed: true });
  db.run("INSERT INTO projects(id,name,created,updated) VALUES('p','p','old','old'),('q','q','old','old')");
  for (const [id, project, scope] of [["empty", "p", ""], ["a", "p", "dept:ops"], ["b", "p", "dept:ops"], ["public", "p", "*"], ["other", "q", "dept:ops"]])
    db.run("INSERT INTO claims(id,project_id,text,content_hash,scope,created,updated) VALUES(?,?,?,?,?,'2026-11-20','2026-11-20')", [id, project, id, id, scope]);
});
afterAll(() => { db?.closeStrict(); if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
const env = () => ({ db, home: root } as any);
describe("claim scope library projection", () => {
  it("carries empty and named grants on list and show without leaking channel", async () => {
    for (const [id, scope] of [["empty", ""], ["a", "dept:ops"], ["public", "*"]]) {
      expect(await libraryShow(env(), "claim", id)).toMatchObject({ id, scope });
      const row = (await libraryList(env(), { kind: "claim" })).items.find(r => r.id === id)!;
      expect(row.scope).toBe(scope); expect(row).not.toHaveProperty("channel");
    }
  });
  it("filters before totals and paging, and binds the cursor to scope as well as project", async () => {
    const options = { kind: "claim" as const, project: "p", scope: "dept:ops", limit: "1" };
    const first = await libraryList(env(), options); expect(first.total).toBe(2); expect(first.items.map(r => r.id)).toEqual(["b"]);
    expect(first.next_cursor).toBeTypeOf("string");
    expect((await libraryList(env(), { ...options, cursor: first.next_cursor! })).items.map(r => r.id)).toEqual(["a"]);
    for (const scope of [undefined, "", "*", "dept:missing"]) await expect(libraryList(env(), { ...options, scope, cursor: first.next_cursor! })).rejects.toThrow(/cursor/);
    await expect(libraryList(env(), { ...options, project: "q", cursor: first.next_cursor! })).rejects.toThrow(/cursor/);
    expect((await libraryList(env(), { kind: "claim", scope: "" })).items.map(r => r.id)).toEqual(["empty"]);
    expect(await libraryList(env(), { kind: "claim", scope: "dept:missing" })).toEqual({ contract: "ygl-library/1", items: [], total: 0, next_cursor: null });
  });
  it("rejects invalid scope or check scope before reading workspace or verifier index", async () => {
    const noRead: any = { home: root, get db() { throw new Error("unexpected db access"); } };
    await expect(libraryList(noRead, { kind: "claim", scope: "public" })).rejects.toMatchObject({ rc: 2 });
    await expect(libraryList(noRead, { kind: "check", scope: "*" })).rejects.toMatchObject({ rc: 2 });
  });
  it("keeps rows and audit unchanged across repeat reads", async () => {
    const before = { claims: db.all("SELECT * FROM claims ORDER BY id"), events: db.all("SELECT * FROM events") };
    await libraryList(env(), { kind: "claim", scope: "*" }); await libraryShow(env(), "claim", "empty");
    expect({ claims: db.all("SELECT * FROM claims ORDER BY id"), events: db.all("SELECT * FROM events") }).toEqual(before);
  });
});
