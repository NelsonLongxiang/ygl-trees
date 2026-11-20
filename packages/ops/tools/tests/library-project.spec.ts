import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DB } from "../../../core/database/src/db";
import { libraryList, LibraryUsageError } from "../src/library";
import { run } from "../src/library-cmds";
import { buildTools } from "../src/mcp";

let home: string, db: DB;
beforeAll(() => {
  mkdirSync(join(process.cwd(), "tmp"), { recursive: true }); home = mkdtempSync(join(process.cwd(), "tmp/library-project-"));
  db = new DB(join(home, "workspace.db"), { managed: true });
  for (const name of ["alpha", "beta", "true", "O'Reilly project"]) db.run("INSERT INTO projects(id,name,created,updated) VALUES(?,?,?,?)", [name, name, "2026-11-20", "2026-11-20"]);
  for (const [id, project, updated] of [
    ["a1", "alpha", "2026-11-20T10:00:00Z"], ["a2", "alpha", "2026-11-20T10:00:00Z"], ["a3", "alpha", "2026-11-19T10:00:00Z"],
    ["b1", "beta", "2026-11-21T10:00:00Z"], ["t1", "true", "2026-11-20T10:00:00Z"], ["q1", "O'Reilly project", "2026-11-20T10:00:00Z"],
  ]) db.run("INSERT INTO claims(id,project_id,text,status,confidence,content_hash,created,updated) VALUES(?,?,?,?,?,?,?,?)", [id, project, id, "supported", "B", id, updated, updated]);
});
afterAll(() => { db?.closeStrict(); if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
const env = () => ({ db, home } as any);
describe("library project filter (#295 item 1)", () => {
  it("filters claims before totals and tied-timestamp pagination, without relying on current selection", async () => {
    const first = await libraryList(env(), { kind: "claim", project: "alpha", limit: "1" });
    expect(first.contract).toBe("ygl-library/1"); expect(first.total).toBe(3); expect(first.items.map(r => r.id)).toEqual(["a2"]); expect(first.items[0].project).toBe("alpha");
    expect(first.next_cursor).toBeTypeOf("string");
    const second = await libraryList(env(), { kind: "claim", project: "alpha", limit: "2", cursor: first.next_cursor! });
    expect(second.total).toBe(3); expect(second.items.map(r => r.id)).toEqual(["a1", "a3"]); expect(second.next_cursor).toBeNull();
    expect((await libraryList(env(), { kind: "claim" })).total).toBe(6);
  });
  it("keeps the existing empty page envelope for an unknown project", async () => {
    expect(await libraryList(env(), { kind: "claim", project: "missing" })).toEqual({ contract: "ygl-library/1", items: [], total: 0, next_cursor: null });
  });
  it.each(["true", "O'Reilly project"])("uses the exact parameterized project name %s", async project => {
    const page = await libraryList(env(), { kind: "claim", project }); expect(page.total).toBe(1); expect(page.items[0].project).toBe(project);
    expect((await libraryList(env(), { kind: "claim", project: "' OR 1=1 --" })).total).toBe(0);
  });
  it("combines project and since, and keeps cursors bound to the project", async () => {
    const options = { kind: "claim" as const, project: "alpha", since: "2026-11-20T00:00:00Z", limit: "1" };
    const page = await libraryList(env(), options); expect(page.total).toBe(2);
    for (const project of [undefined, "beta", "missing"]) await expect(libraryList(env(), { ...options, project, cursor: page.next_cursor! })).rejects.toThrow(/cursor/);
    expect((await libraryList(env(), { ...options, cursor: page.next_cursor! })).items.map(r => r.id)).toEqual(["a1"]);
  });
  it.each(["note", "skill", "check"] as const)("refuses --project for %s before opening any data or verifier index", async kind => {
    const noRead = { home: join(home, "must-not-be-created"), get db() { throw new Error("unexpected workspace read"); } } as any;
    await expect(libraryList(noRead, { kind, project: "alpha" })).rejects.toThrow(LibraryUsageError);
    await expect(libraryList(noRead, { kind, project: "missing" })).rejects.toThrow(new RegExp(kind + ".*project|project.*" + kind));
    expect(existsSync(noRead.home)).toBe(false);
  });
  it.each([true, false, "", "   ", ["alpha"]].map(project => ({ project })))("refuses an invalid direct project value before reading ($project)", async ({ project }) => {
    const noRead = { get db() { throw new Error("unexpected workspace read"); } } as any;
    await expect(libraryList(noRead, { kind: "claim", project: project as any })).rejects.toThrow(/project.*value|project.*name/);
  });
  it.each(["note", "skill", "check"] as const)("the command shell returns rc2 and one named JSON refusal for %s", async kind => {
    const output: any[] = [], ctx = { json: true, color: false, quiet: false, emitJson: (j: unknown) => output.push(j) };
    expect(await run({ ctx, home, get db() { throw new Error("unexpected workspace read"); } } as any, "list", [], { flags: { kind, project: "alpha" } })).toBe(2);
    expect(output).toHaveLength(1); expect(output[0].error).toMatch(new RegExp(kind + ".*project|project.*" + kind));
  });
  it("never converts a bare flag into the legitimate project named true", async () => {
    const output: any[] = [], ctx = { json: true, color: false, quiet: false, emitJson: (j: unknown) => output.push(j) };
    expect(await run({ ...env(), ctx }, "list", [], { flags: { kind: "claim", project: true } })).toBe(2);
    expect(output).toHaveLength(1); expect(output[0].error).toMatch(/project.*value|project.*name/);
  });
  it("the shipped CLI preserves project-specific pages, errors and cursor admission", () => {
    const bin = resolve(__dirname, "../../../../dist/bundle/bin.cjs");
    const cli = (args: string[]) => {
      const r = spawnSync(process.execPath, [bin, "--home", home, "--db", join(home, "workspace.db"), "--json", ...args], {
        cwd: home, encoding: "utf8", timeout: 60000,
        env: { ...process.env, YGL_DB_URL: "", YGL_PROJECT: "beta", YGL_NO_UPDATE_CHECK: "1", YGL_TEST: "1", YGL_EVAL_OFFLINE: "1" },
      });
      expect(r.error).toBeUndefined(); expect(r.signal).toBeNull();
      return { rc: r.status, body: JSON.parse(r.stdout), stderr: r.stderr };
    };
    const args = ["library", "list", "--kind", "claim", "--project", "alpha", "--limit", "1"];
    const first = cli(args); expect(first.rc, first.stderr).toBe(0); expect(first.body.total).toBe(3); expect(first.body.items[0].id).toBe("a2");
    const second = cli([...args, "--cursor", first.body.next_cursor]); expect(second.rc, second.stderr).toBe(0); expect(second.body.items[0].id).toBe("a1");
    const wrong = cli(["library", "list", "--kind", "claim", "--project", "beta", "--cursor", first.body.next_cursor]);
    expect(wrong.rc).toBe(2); expect(wrong.body.error).toMatch(/cursor/);
    const missing = cli(["library", "list", "--kind", "claim", "--project", "missing"]);
    expect(missing.rc).toBe(0); expect(missing.body).toEqual({ contract: "ygl-library/1", items: [], total: 0, next_cursor: null });
    for (const kind of ["note", "skill", "check"]) {
      const result = cli(["library", "list", "--kind", kind, "--project", "alpha"]);
      expect(result.rc).toBe(2); expect(result.body.error).toMatch(new RegExp(kind + ".*project|project.*" + kind));
    }
  });
  it("the real MCP child preserves project filtering and unsupported-kind rc2", async () => {
    const beforeArgv = process.argv[1]; process.argv[1] = resolve(__dirname, "../../../../dist/bundle/bin.cjs");
    try {
      const read = buildTools({ ...process.env, YGL_HOME: home, YGL_DB_URL: "", YGL_PROJECT: "beta", YGL_NO_UPDATE_CHECK: "1", YGL_TEST: "1", YGL_EVAL_OFFLINE: "1" }).find(t => t.name === "read")!;
      // MCP owns its workspace filename; seed a private matching home without a foreign active handle.
      const homeDb = new DB(join(home, "ygl-trees.db"), { managed: true });
      try {
        for (const name of ["alpha", "beta"]) homeDb.run("INSERT INTO projects(id,name,created,updated) VALUES(?,?,?,?)", [name, name, "2026-11-20", "2026-11-20"]);
        for (const name of ["alpha", "beta"]) homeDb.run("INSERT INTO claims(id,project_id,text,content_hash,created,updated) VALUES(?,?,?,?,?,?)", [name, name, name, name, "2026-11-20", "2026-11-20"]);
      } finally { homeDb.closeStrict(); }
      const page: any = await read.execute({ domain: "library", action: "list", kind: "claim", project: "alpha" });
      expect(page.total).toBe(1); expect(page.items.map((r: any) => r.project)).toEqual(["alpha"]);
      const missing: any = await read.execute({ domain: "library", action: "list", kind: "claim", project: "missing" }); expect(missing.total).toBe(0); expect(missing.items).toEqual([]);
      for (const kind of ["note", "skill", "check"]) await expect(read.execute({ domain: "library", action: "list", kind, project: "alpha" })).rejects.toMatchObject({ rc: 2, json: { error: expect.stringContaining(kind) } });
    } finally { process.argv[1] = beforeArgv; }
  });
  it("remains a read-only projection of the selected project", async () => {
    const before = db.all("SELECT * FROM events"), metadata = db.all("SELECT * FROM meta ORDER BY key");
    await libraryList(env(), { kind: "claim", project: "alpha" });
    expect(db.all("SELECT * FROM events")).toEqual(before); expect(db.all("SELECT * FROM meta ORDER BY key")).toEqual(metadata);
  });
});
