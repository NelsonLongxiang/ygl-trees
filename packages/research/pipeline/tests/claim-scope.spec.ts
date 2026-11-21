import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DB } from "../../../core/database/src/db";
import { createWorkspaceOrm } from "../../../../apps/cli/src/workspace-orm";
import * as writes from "../src/writes";
let root: string, db: DB, owner: ReturnType<typeof createWorkspaceOrm>, ds: any;
const add = (text: string, scope?: unknown, force = false) => (writes.claimAdd as any)(ds, "p", text, "B", force, "review", scope);
const rescope = (id: string, scope?: unknown) => { expect((writes as any).claimRescope).toBeTypeOf("function"); return (writes as any).claimRescope(ds, id, scope); };
beforeEach(async () => {
  mkdirSync(join(process.cwd(), "tmp"), { recursive: true }); root = mkdtempSync(join(process.cwd(), "tmp/claim-scope-"));
  const file = join(root, "workspace.db"); db = new DB(file, { managed: true });
  db.run("INSERT INTO projects(id,name,created,updated) VALUES('p','p','old','old')");
  owner = createWorkspaceOrm({ dialect: "sqlite", file }); ds = await owner.getOrm(file);
});
afterEach(async () => { await owner?.close(); db?.closeStrict(); if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); vi.restoreAllMocks(); });
describe("claim grant scope writes and projection", () => {
  it.each(["", "*", "restricted", "dept:ops", "bench:A.b_1-2"])("stores and returns explicit scope %s", async scope => {
    const result = await add("ruling", scope); expect(result.dup).toBe(false); expect(result.row.scope).toBe(scope);
    expect(db.get("SELECT scope FROM claims WHERE id=?", [result.row.id])).toEqual({ scope });
  });
  it("defaults to an empty unattributed grant rather than inferring a project grant", async () => { expect((await add("legacy")).row.scope).toBe(""); });
  it.each([null, true, false, 1, {}, [], "public", "ops", "dept:", "dept:运营", " dept:ops", "dept:ops\n"].map(scope => ({ scope })))("rejects an invalid scope before opening a transaction ($scope)", async ({ scope }) => {
    const transaction = vi.fn(() => { throw new Error("transaction must not open"); });
    await expect((writes.claimAdd as any)({ transaction }, "p", "invalid", "B", false, "", scope)).rejects.toMatchObject({ rc: 2 }); expect(transaction).not.toHaveBeenCalled();
  });
  it("treats an initial forced row as an ordinary same-text/scope duplicate", async () => {
    const first = await add("forced first", "dept:ops", true), events = db.all("SELECT * FROM events");
    expect(await add("forced first", "dept:ops")).toMatchObject({ dup: true, row: { id: first.row.id, scope: "dept:ops" } });
    expect(db.all("SELECT * FROM events")).toEqual(events);
    const second = await add("forced first", "dept:ops", true); expect(second.dup).toBe(false); expect(second.row.id).not.toBe(first.row.id);
    await expect(add("forced first", "*", true)).rejects.toMatchObject({ rc: 1 });
  });
  it("uses the unique content hash for ordinary duplicates without loading all text copies", async () => {
    const first = await add("hash ruling", "dept:ops"), calls: any[] = [];
    const wrapped = { transaction: (work: any) => ds.transaction((mgr: any) => work(new Proxy(mgr, {
      get(target, key) {
        if (key === "find") return () => { throw new Error("full text-copy materialization is forbidden"); };
        if (key === "findOne") return (entity: any, options: any) => { calls.push(options); return target.findOne(entity, options); };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      },
    }))) };
    expect(await writes.claimAdd(wrapped as any, "p", "hash ruling", "B", false, "review", "dept:ops")).toMatchObject({ dup: true, row: { id: first.row.id } });
    expect(calls.some(options => typeof options.where?.contentHash === "string" && options.where.projectId === "p")).toBe(true);
  });
  it("returns a same-text same-scope duplicate without another event", async () => {
    const one = await add("same ruling", "dept:ops"), events = db.all("SELECT * FROM events");
    expect(await add("same ruling", "dept:ops")).toMatchObject({ dup: true, row: { id: one.row.id, scope: "dept:ops" } });
    expect(db.all("SELECT * FROM events")).toEqual(events);
  });
  it.each([false, true])("refuses the same text with a different scope and points to rescope (force=%s)", async force => {
    const one = await add("same ruling", "dept:ops"), events = db.all("SELECT * FROM events");
    await expect(add("same ruling", "*", force)).rejects.toMatchObject({ rc: 1, message: expect.stringMatching(/rescope/) });
    expect(db.all("SELECT id,scope FROM claims")).toEqual([{ id: one.row.id, scope: "dept:ops" }]); expect(db.all("SELECT * FROM events")).toEqual(events);
  });
  it("rescope changes only grant/update fields, logs old/new once, and is idempotent", async () => {
    const one = await add("ruling", ""), before = db.get("SELECT * FROM claims WHERE id=?", [one.row.id]) as any;
    const result = await rescope(one.row.id, "dept:ops"); expect(result).toMatchObject({ dup: false, row: { id: one.row.id, scope: "dept:ops" } });
    const { scope: _s, updated: _u, ...same } = db.get("SELECT * FROM claims WHERE id=?", [one.row.id]) as any;
    const { scope: _oldS, updated: _oldU, ...original } = before; expect(same).toEqual(original);
    const events = db.all("SELECT * FROM events WHERE kind='claim.rescope'") as any[]; expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({ old_scope: "", new_scope: "dept:ops" });
    const stable = db.get("SELECT * FROM claims WHERE id=?", [one.row.id]); expect(await rescope(one.row.id, "dept:ops")).toMatchObject({ dup: true });
    expect(db.get("SELECT * FROM claims WHERE id=?", [one.row.id])).toEqual(stable); expect(db.all("SELECT * FROM events WHERE kind='claim.rescope'")).toEqual(events);
    expect((await rescope(one.row.id, "")).row.scope).toBe("");
  });
  it("requires explicit rescope and returns a named error for a missing claim", async () => {
    const one = await add("ruling", "");
    await expect(rescope(one.row.id)).rejects.toMatchObject({ rc: 2 }); await expect(rescope(one.row.id, "public")).rejects.toMatchObject({ rc: 2 });
    await expect(rescope("missing", "*")).rejects.toMatchObject({ rc: 1, message: expect.stringMatching(/claim.*not found/) });
  });
  it("rolls the scope change back when its audit insertion fails", async () => {
    const one = await add("ruling", "dept:ops"), before = db.get("SELECT * FROM claims WHERE id=?", [one.row.id]);
    db.run("CREATE TRIGGER fail_rescope BEFORE INSERT ON events WHEN NEW.kind='claim.rescope' BEGIN SELECT RAISE(ABORT,'audit refused'); END");
    await expect(rescope(one.row.id, "*")).rejects.toThrow(/audit refused/); expect(db.get("SELECT * FROM claims WHERE id=?", [one.row.id])).toEqual(before);
    expect(db.all("SELECT * FROM events WHERE kind='claim.rescope'")).toEqual([]);
  });
  it("rejects conflicting batch rows atomically, including earlier inserted rows and events", async () => {
    await add("existing", "dept:ops"); const before = db.all("SELECT * FROM claims"), events = db.all("SELECT * FROM events");
    await expect((writes.claimAddBatch as any)(ds, "p", [{ text: "new", scope: "bench:x" }, { text: "existing", scope: "*" }])).rejects.toMatchObject({ rc: 1 });
    expect(db.all("SELECT * FROM claims")).toEqual(before); expect(db.all("SELECT * FROM events")).toEqual(events);
  });

});
