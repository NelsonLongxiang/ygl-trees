/** Scope is a grant key, not a project name or an implicit public permission. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Sqlite from "better-sqlite3";
import { validateScope } from "../../../core/text/src/scope";
import { buildTools } from "../src/mcp";

const ROOT = resolve(__dirname, "../../../..");
const BIN = join(ROOT, "dist/apps/cli/src/bin.js");
const SCRATCH = join(ROOT, "tmp", "276-scope", "tests");
let home: string;
const envFor = (workspace = home) => ({ ...process.env, YGL_HOME: workspace, YGL_DB_URL: "", YGL_PG_URL: "", YGL_PROJECT: "", YGL_SESSION: "scope-test", YGL_NO_UPDATE_CHECK: "1", YGL_EVAL_OFFLINE: "1" });
function run(args: string[], expected = 0, workspace = home) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { cwd: ROOT, encoding: "utf8", timeout: 60000, env: envFor(workspace) });
  expect(r.status, r.stdout + r.stderr).toBe(expected);
  const value = JSON.parse(r.stdout);
  if (expected) expect(value).toEqual({ error: expect.any(String) });
  return value;
}
function sql<T = any>(query: string, params: unknown[] = []): T[] {
  const db = new Sqlite(join(home, "ygl-trees.db"));
  try { return db.prepare(query).all(...params) as T[]; } finally { db.close(); }
}
function add(title: string, scope?: string, body = "scope-filter-token material") {
  return run(["kb", "add", "--title", title, "--body=" + body, ...(scope === undefined ? [] : ["--scope=" + scope])]);
}
function promote(note: any, name: string) {
  const source = run(["research", "source", "add", "--title", "Scope test source", "--url", "https://example.test/scope-proof"]);
  const evidence = run(["research", "evidence", "add", source.id, "--quote", "isolated scope propagation fixture"]);
  run(["rel", "add", "kb:" + note.id, "evidence:" + evidence.id, "--rel", "evidenced-by"]);
  return run(["kb", "promote", note.id, "--name", name]);
}
function titleSet(rows: any[]) { return rows.map(r => r.title).sort(); }

describe("scope v15", () => {
  beforeEach(() => {
    mkdirSync(SCRATCH, { recursive: true });
    home = mkdtempSync(join(SCRATCH, "case-"));
    run(["db", "init"]);
    run(["project", "new", "scope-fixture"]);
  }, 60000);
  afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("validates exact syntax without trimming, coercion, or interpreting ids", () => {
    for (const good of [undefined, "", "*", "restricted", "dept:ops", "bench:x", "dept:" + "a".repeat(64), "bench:A.b_1-2"]) {
      expect(validateScope(good)).toBe(good ?? "");
    }
    for (const bad of [null, true, false, 1, {}, [], "ops", "dept:", "dept:a b", "dept:a/../b", "dept:" + "a".repeat(65), "dept:运营", " dept:ops", "dept:ops ", "dept:ops\n", "bench:x\r\n", "\n", "public"]) {
      expect(() => validateScope(bad), String(bad)).toThrow();
    }
  });

  it("accepts the four forms, stores empty by default, and rejects bad/bare flags before business writes", () => {
    for (const [i, scope] of ["dept:ops", "bench:x", "*", "restricted"].entries()) expect(add("valid-" + i, scope).scope).toBe(scope);
    expect(add("unattributed").scope).toBe("");
    const before = sql("SELECT id FROM kb_notes");
    for (const scope of ["ops", "dept:", "dept:a b", " dept:ops", "dept:ops ", "dept:" + "x".repeat(65)]) run(["kb", "add", "--title", "rejected", "--body", "b", "--scope=" + scope], 2);
    run(["kb", "add", "--title", "bare", "--body", "b", "--scope"], 2);
    expect(sql("SELECT id FROM kb_notes")).toEqual(before);
    expect(sql("SELECT * FROM events WHERE kind='kb.rescope'")).toEqual([]);
    const missingHome = join(home, "not-created");
    run(["kb", "add", "--title", "bad", "--body", "b", "--scope=invalid"], 2, missingHome);
    expect(require("node:fs").existsSync(missingHome)).toBe(false);
  }, 120000);

  it("duplicate add preserves the original grant and rescope changes it with one old/new event", () => {
    const first = add("same", "dept:ops");
    const dup = add("same", "*");
    expect(dup).toMatchObject({ id: first.id, scope: "dept:ops", duplicate: true });
    const changed = run(["kb", "rescope", first.id, "--scope=bench:sales"]);
    expect(changed.scope).toBe("bench:sales");
    expect(changed.updated).toBe(sql("SELECT updated FROM kb_notes WHERE id=?", [first.id])[0].updated);
    expect(run(["kb", "rescope", first.id, "--scope=bench:sales"]).duplicate).toBe(true);
    const events = sql("SELECT payload FROM events WHERE kind='kb.rescope' AND entity_id=?", [first.id]);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({ old_scope: "dept:ops", new_scope: "bench:sales" });
    run(["kb", "rescope", first.title, "--scope=restricted"], 1);
    run(["kb", "rescope", "missing-id", "--scope=restricted"], 1);
    run(["kb", "rescope", first.id, "--scope"], 2);
    run(["kb", "rescope", first.id], 2);
    expect(run(["kb", "show", first.id]).scope).toBe("bench:sales");
  });

  it("rescope rolls the grant back if audit insertion fails", () => {
    const note = add("rollback", "dept:ops");
    const db = new Sqlite(join(home, "ygl-trees.db"));
    try { db.exec("CREATE TRIGGER reject_rescope BEFORE INSERT ON events WHEN NEW.kind='kb.rescope' BEGIN SELECT RAISE(ABORT,'audit fixture refuses'); END"); } finally { db.close(); }
    run(["kb", "rescope", note.id, "--scope=restricted"], 1);
    expect(run(["kb", "show", note.id]).scope).toBe("dept:ops");
    expect(sql("SELECT * FROM events WHERE kind='kb.rescope'")).toEqual([]);
  });

  it("promote inherits scope, later ordinary upsert preserves it, and re-promote refreshes it", () => {
    const note = add("promoted", "dept:ops");
    promote(note, "scope-promoted");
    expect(run(["skill", "show", "scope-promoted"]).scope).toBe("dept:ops");
    const file = join(home, "replacement.md");
    writeFileSync(file, "---\nname: scope-promoted\ndescription: edited fixture\n---\nordinary content update");
    run(["skill", "import", file]);
    expect(run(["skill", "show", "scope-promoted"]).scope).toBe("dept:ops");
    run(["kb", "rescope", note.id, "--scope=restricted"]);
    run(["kb", "promote", note.id, "--name", "scope-promoted"]);
    expect(run(["skill", "show", "scope-promoted"]).scope).toBe("restricted");
    run(["kb", "rescope", note.id, "--scope="]);
    run(["kb", "promote", note.id, "--name", "scope-promoted"]);
    expect(run(["skill", "show", "scope-promoted"]).scope).toBe("");
  }, 120000);

  it("kb list/search, including the fallback, filter before ranking and do not bump excluded reuse", () => {
    add("scope-filter-token ops", "dept:ops");
    add("scope-filter-token other", "bench:sales");
    add("scope-filter-token company", "*");
    add("scope-filter-token empty");
    const before = run(["kb", "list"]);
    const publicRows = run(["kb", "list", "--scope=*"]);
    expect(titleSet(publicRows)).toEqual(["scope-filter-token company"]);
    expect(titleSet(run(["kb", "list", "--scope="]))).toEqual(["scope-filter-token empty"]);
    expect(titleSet(run(["kb", "search", "scope-filter-token", "--scope=dept:ops"]))).toEqual(["scope-filter-token ops"]);
    expect(sql("SELECT title FROM kb_notes WHERE reuse>0").map(r => r.title)).toEqual(["scope-filter-token ops"]);
    expect(titleSet(run(["kb", "search", "scope-filter-token", "--scope=dept:missing"]))).toEqual([]);
    const oldShape = before.map(({ scope, ...row }: any) => row);
    expect(before).toEqual(oldShape);
    // Empty ngram triggers the title-LIKE fallback; scope must still apply.
    add("%", "dept:ops", "punctuation"); add("%", "bench:other", "different punctuation");
    const fallback = run(["kb", "search", "%", "--scope=dept:ops"]);
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback.map((r: any) => r.id).sort()).toEqual(sql("SELECT id FROM kb_notes WHERE scope=?", ["dept:ops"]).map(r => r.id).sort());
  }, 120000);

  it("skill and library filters exclude other scopes, distinguish omitted/empty cursors, and omit empty scope", () => {
    const a = add("ops-1", "dept:ops"), b = add("ops-2", "dept:ops"), c = add("other", "bench:other"), u = add("unattributed");
    promote(a, "ops-skill"); promote(c, "other-skill");
    expect(run(["skill", "list", "--scope=dept:ops"]).map((r: any) => r.name)).toEqual(["ops-skill"]);
    expect(run(["skill", "list", "--scope=bench:other"]).map((r: any) => r.name)).toEqual(["other-skill"]);
    const page = run(["library", "list", "--kind", "note", "--scope=dept:ops", "--limit", "1"]);
    expect(page.total).toBe(2); expect(page.items).toHaveLength(1); expect(page.items[0].scope).toBe("dept:ops");
    const next = run(["library", "list", "--kind", "note", "--scope=dept:ops", "--limit", "1", "--cursor", page.next_cursor]);
    expect(new Set([page.items[0].id, next.items[0].id])).toEqual(new Set([a.id, b.id]));
    run(["library", "list", "--kind", "note", "--scope=bench:other", "--cursor", page.next_cursor], 2);
    const all = run(["library", "list", "--kind", "note", "--limit", "1"]);
    run(["library", "list", "--kind", "note", "--scope=", "--cursor", all.next_cursor], 2);
    const empty = run(["library", "list", "--kind", "note", "--scope="]);
    expect(empty.items.map((r: any) => r.id)).toEqual([u.id]); expect(empty.items[0]).not.toHaveProperty("scope");
    expect(run(["library", "show", "note", a.id]).scope).toBe("dept:ops");
    expect(run(["library", "show", "note", u.id])).not.toHaveProperty("scope");
    expect(run(["library", "list", "--kind", "skill", "--scope=dept:ops"]).items.map((r: any) => r.title)).toEqual(["ops-skill"]);
    run(["library", "list", "--kind", "claim", "--scope="], 2);
    run(["library", "list", "--kind", "note", "--scope"], 2);
  }, 120000);

  it("import validates all items, including duplicates, before any row is committed", () => {
    const dir = join(home, "import"); mkdirSync(dir);
    writeFileSync(join(dir, "a.md"), "---\ntitle: frontmatter\nscope: dept:ops\n---\nmaterial");
    expect(run(["kb", "import", dir, "--scope=bench:fallback"]).added).toBe(1);
    expect(run(["kb", "show", "frontmatter"]).scope).toBe("dept:ops");
    writeFileSync(join(dir, "a.md"), "---\ntitle: frontmatter\nscope: bad\n---\nmaterial");
    writeFileSync(join(dir, "b.md"), "---\ntitle: must-not-land\n---\nvalid material");
    run(["kb", "import", dir], 2);
    run(["kb", "show", "must-not-land"], 1);
    expect(run(["kb", "show", "frontmatter"]).scope).toBe("dept:ops");
  });

  it("ingest accepts scope and duplicates keep their prior scope", () => {
    const artifact = run(["produce", "section", "Scope report", "--body", "artifact material"]);
    const a = run(["kb", "ingest", artifact.id, "--scope=dept:ops"]);
    expect(a.scope).toBe("dept:ops");
    expect(run(["kb", "ingest", artifact.id, "--scope=restricted"])).toMatchObject({ id: a.id, scope: "dept:ops", duplicate: true });
    run(["kb", "ingest", artifact.id, "--scope=invalid"], 2);
  });

  it("MCP parameters preserve CLI semantics including an explicit empty scope", async () => {
    const argv = process.argv[1]; process.argv[1] = BIN;
    try {
      const tools = buildTools(envFor());
      const read = tools.find(t => t.name === "read")!, write = tools.find(t => t.name === "write")!;
      expect((write.inputSchema.properties as any).scope.type).toBe("string");
      const a: any = await write.execute({ domain: "kb", action: "add", name: "MCP scope", body: "scope-filter-token", scope: "dept:ops" });
      add("hidden", "restricted");
      expect((await read.execute({ domain: "kb", action: "list", scope: "dept:ops" }) as any[]).map(r => r.id)).toEqual([a.id]);
      expect((await read.execute({ domain: "kb", action: "search", query: "scope-filter-token", scope: "dept:ops" }) as any[]).map(r => r.id)).toEqual([a.id]);
      promote(a, "mcp-scoped-skill");
      expect((await read.execute({ domain: "skill", action: "list", scope: "dept:ops" }) as any[]).map(r => r.name)).toEqual(["mcp-scoped-skill"]);
      const skillPage: any = await read.execute({ domain: "library", action: "list", kind: "skill", scope: "dept:ops" });
      expect(skillPage.items.map((r: any) => r.title)).toEqual(["mcp-scoped-skill"]);
      await write.execute({ domain: "kb", action: "rescope", id: a.id, scope: "" });
      const page: any = await read.execute({ domain: "library", action: "list", kind: "note", scope: "" });
      expect(page.items.map((r: any) => r.id)).toEqual([a.id]);
      expect(page.items[0]).not.toHaveProperty("scope");
      const bad = async () => write.execute({ domain: "kb", action: "add", name: "bad", body: "body", scope: true });
      await expect(bad()).rejects.toMatchObject({ rc: 2 });
      expect(run(["kb", "list"]).some((r: any) => r.title === "bad")).toBe(false);
    } finally { process.argv[1] = argv; }
  }, 120000);

  it("a v14 database and version-zero dump replay retain notes and skills with empty defaults", () => {
    const note = add("legacy-note"); promote(note, "legacy-skill");
    const dbPath = join(home, "ygl-trees.db");
    for (const version of [14, 0]) {
      const db = new Sqlite(dbPath);
      try { db.exec("ALTER TABLE kb_notes DROP COLUMN scope; ALTER TABLE skills DROP COLUMN scope; PRAGMA user_version=" + version); } finally { db.close(); }
      expect(run(["kb", "show", note.id]).scope).toBe("");
      expect(run(["skill", "show", "legacy-skill"]).scope).toBe("");
      expect(sql("PRAGMA user_version")[0].user_version).toBe(15);
    }
    const dump = join(home, "export.sql");
    run(["db", "export", dump]);
    const exported = readFileSync(dump, "utf8");
    expect(exported).toContain("scope");
    expect(exported).toContain("legacy-note");
    expect(exported).toContain("legacy-skill");
    const replayHome = join(home, "replayed"); mkdirSync(replayHome);
    const replay = new Sqlite(join(replayHome, "ygl-trees.db"));
    try { replay.exec(exported); expect(replay.pragma("user_version", { simple: true })).toBe(0); } finally { replay.close(); }
    expect(run(["kb", "show", note.id], 0, replayHome).scope).toBe("");
    expect(run(["skill", "show", "legacy-skill"], 0, replayHome).scope).toBe("");
    const upgraded = new Sqlite(join(replayHome, "ygl-trees.db"));
    try { expect(upgraded.pragma("user_version", { simple: true })).toBe(15); } finally { upgraded.close(); }
  }, 120000);
});
