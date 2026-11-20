import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DB } from "../../../core/database/src/db";
import { parse } from "../../../core/database/src/types";
import { createWorkspaceOrm } from "../../../../apps/cli/src/workspace-orm";
import { Store } from "../src/reads";
import { AsyncResearchStore } from "../src/async-store";
import { run } from "../src/cmds";
import { claimAdd } from "../src/writes";
let home: string, db: DB, file: string, orm: ReturnType<typeof createWorkspaceOrm>, env: any;
beforeEach(() => {
  mkdirSync(join(process.cwd(), "tmp"), { recursive: true }); home = mkdtempSync(join(process.cwd(), "tmp/claim-scope-cmd-"));
  file = join(home, "workspace.db"); db = new DB(file, { managed: true }); orm = createWorkspaceOrm({ dialect: "sqlite", file });
  db.run("INSERT INTO projects(id,name,created,updated) VALUES('p','p','old','old'),('other','other','old','old')");
  vi.stubEnv("YGL_PROJECT", "p"); vi.stubEnv("YGL_SELECTION_PROJECT", ""); vi.stubEnv("YGL_SELECTION_VIA", "");
  env = { home, dbFile: file, db, store: new Store(db), asyncStore: new AsyncResearchStore(db), orm, ctx: { json: true, quiet: true, color: false } };
});
afterEach(async () => { await orm?.close(); db?.closeStrict(); if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); vi.unstubAllEnvs(); });
async function command(parts: string[]) {
  const output: unknown[] = []; const args = parse(["research", "claim", ...parts]);
  const local = { ...env, args, ctx: { ...env.ctx, emitJson: (value: unknown) => output.push(value), failJson: (error: string) => output.push({ error }) } };
  const rc = await run(local, "claim", args._.slice(2), args); expect(output).toHaveLength(1); return { rc, value: output[0] as any };
}
const seed = async (scope = "dept:ops", project = "p") => claimAdd(await orm.getOrm(file), project, "existing", "B", false, "", scope);
describe("claim scope command boundary", () => {
  it("passes --scope to the write service and reads the same scope from list/show", async () => {
    const added = await command(["add", "ruling", "--scope=dept:ops"]); expect(added).toMatchObject({ rc: 0, value: { scope: "dept:ops" } });
    expect(await command(["show", added.value.id])).toMatchObject({ rc: 0, value: { scope: "dept:ops" } });
    expect((await command(["list"])).value).toEqual([expect.objectContaining({ id: added.value.id, scope: "dept:ops" })]);
  });
  it.each(["--scope", "--scope=public", "--scope=dept:ops "])("rejects invalid grant input %s without claim/event writes", async scope => {
    expect(await command(["add", "invalid", scope])).toMatchObject({ rc: 2, value: { error: expect.stringContaining("scope") } });
    expect(db.all("SELECT * FROM claims")).toEqual([]); expect(db.all("SELECT * FROM events")).toEqual([]);
  });
  it("does not read the default confidence when an explicit confidence was supplied", async () => {
    const get = db.get.bind(db);
    const spy = vi.spyOn(db, "get").mockImplementation((sql: string, params?: any[]) => {
      if (sql.includes("FROM config")) throw new Error("default confidence must not be read");
      return get(sql, params);
    });
    try { expect(await command(["add", "explicit grade", "--confidence=A", "--scope=dept:ops"])).toMatchObject({ rc: 0, value: { confidence: "A", scope: "dept:ops" } }); }
    finally { spy.mockRestore(); }
  });
  it("preserves file scope and reports its invalid type as line-one usage error", async () => {
    const input = join(home, "claim.json"); writeFileSync(input, JSON.stringify({ text: "file", scope: "bench:file" }));
    expect(await command(["add", "--file", input])).toMatchObject({ rc: 0, value: { scope: "bench:file" } });
    writeFileSync(input, JSON.stringify({ text: "bad file", scope: true }));
    expect(await command(["add", "--file", input])).toMatchObject({ rc: 2, value: { error: expect.stringMatching(/line 1.*scope/) } });
  });
  it("makes --file mutually exclusive with --scope rather than silently overriding either", async () => {
    const input = join(home, "claim.json"); writeFileSync(input, JSON.stringify({ text: "file", scope: "bench:file" }));
    expect(await command(["add", "--file", input, "--scope=dept:ops"])).toMatchObject({ rc: 2, value: { error: expect.stringContaining("--file") } });
    expect(await command(["add", "--file", input, "--text", "conflict"])).toEqual({ rc: 2, value: { error: "--file cannot combine with positional text / --text / --confidence" } });
    expect(db.all("SELECT * FROM claims")).toEqual([]);
  });
  it("supports batch row overrides, explicit empty scope and a command fallback", async () => {
    const input = join(home, "batch.jsonl"); writeFileSync(input, [{ text: "a" }, { text: "b", scope: "bench:x" }, { text: "c", scope: "" }].map(x => JSON.stringify(x)).join("\n"));
    const first = await command(["add", "--batch", input, "--scope=dept:ops"]); expect(first.rc).toBe(0);
    expect(first.value.rows.map((r: any) => r.scope)).toEqual(["dept:ops", "bench:x", ""]); expect(first.value.ignored_fields).toBeUndefined();
    const second = await command(["add", "--batch", input, "--scope=dept:ops"]); expect(second.value).toMatchObject({ added: 0, duplicates: 3 });
  });
  it("names the bad batch line and validates every grant before any row writes", async () => {
    const input = join(home, "batch.jsonl"); writeFileSync(input, [{ text: "a", scope: "*" }, { text: "b", scope: null }].map(x => JSON.stringify(x)).join("\n"));
    expect(await command(["add", "--batch", input])).toMatchObject({ rc: 2, value: { error: expect.stringMatching(/line 2.*scope/) } });
    expect(db.all("SELECT * FROM claims")).toEqual([]); expect(db.all("SELECT * FROM events")).toEqual([]);
  });
  it("names the existing claim on a scope conflict and leaves its row/event unchanged", async () => {
    const one = await seed(); const events = db.all("SELECT * FROM events");
    expect(await command(["add", "existing", "--scope=*"])).toMatchObject({ rc: 1, value: { error: expect.stringContaining("rescope " + one.row.id) } });
    expect(db.get("SELECT scope FROM claims WHERE id=?", [one.row.id])).toEqual({ scope: "dept:ops" }); expect(db.all("SELECT * FROM events")).toEqual(events);
  });
  it("rescopes only a claim belonging to the selected active project and is idempotent", async () => {
    const one = await seed(); expect(await command(["rescope", one.row.id, "--scope=*"])).toMatchObject({ rc: 0, value: { scope: "*" } });
    expect(await command(["rescope", one.row.id, "--scope=*"])).toMatchObject({ rc: 0, value: { duplicate: true } });
    const another = await seed("dept:ops", "other"); expect(await command(["rescope", another.row.id, "--scope=*"])).toMatchObject({ rc: 1, value: { error: expect.stringMatching(/other/) } });
    db.run("UPDATE projects SET status='archived' WHERE id='p'");
    expect(await command(["rescope", one.row.id, "--scope=restricted"])).toMatchObject({ rc: 1, value: { error: expect.stringContaining("archived") } });
  });
  it("requires the rescope id and explicit scope, including an explicit empty value", async () => {
    const one = await seed();
    for (const args of [["rescope", one.row.id], ["rescope", "--scope=*"], ["rescope", one.row.id, "--scope"]]) expect((await command(args)).rc).toBe(2);
    expect(await command(["rescope", one.row.id, "--scope="])).toMatchObject({ rc: 0, value: { scope: "" } });
  });
});
