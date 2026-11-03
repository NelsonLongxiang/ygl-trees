import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
const ROOT = resolve(__dirname, "../../../.."), BIN = join(ROOT, "dist/bundle/bin.cjs");
let home = "", evidence = "", claim = "";
function cli(args: string[], rc = 0) {
  const env = { ...process.env, YGL_HOME: home, YGL_SESSION: "promote-gate-159", YGL_TEST: "1", YGL_EVAL_OFFLINE: "1", YGL_NO_UPDATE_CHECK: "1" };
  for (const k of ["YGL_DB_URL", "YGL_PG_URL", "YGL_PROJECT", "YGL_DB"]) delete env[k];
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { env, cwd: home, encoding: "utf8", timeout: 30000 });
  expect(r.error).toBeUndefined(); expect(r.signal).toBeNull(); expect(r.status, r.stdout + r.stderr).toBe(rc);
  return JSON.parse(r.stdout);
}
function sql(q: string, params: any[] = []) { const db = new DatabaseSync(join(home, "ygl-trees.db")); try { return db.prepare(q).all(...params); } finally { db.close(); } }
const note = (title: string, body = "Scratch notes do not yet establish reusable knowledge.") => cli(["kb", "add", "--title", title, "--body=" + body]).id;
beforeAll(() => {
  mkdirSync(join(ROOT, "tmp"), { recursive: true }); home = mkdtempSync(join(ROOT, "tmp/promote-159-"));
  cli(["db", "init"]); cli(["project", "new", "fixture"]);
  const source = cli(["research", "source", "add", "--title", "Recorded fixture run", "--url", "session://promote-fixture"]).id;
  evidence = cli(["research", "evidence", "add", source, "--quote", "The isolated fixture run completed the expected checks."]).id;
  claim = cli(["research", "claim", "add", "The recorded workflow is reusable when the same conditions hold."]).id;
}, 120000);
afterAll(() => { if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
describe("#159 promotion admission", () => {
  it("rejects a diary with one error naming missing requirements and no skill or event", () => {
    const id = note("diary"), before = sql("SELECT COUNT(*) AS n FROM events WHERE kind='kb.promote'");
    const result = cli(["kb", "promote", id, "--name", "diary-skill"], 1);
    expect(Object.keys(result)).toEqual(["error"]);
    for (const term of ["cue", "lesson", "evidence", "rel", "placeholder"]) expect(result.error).toContain(term);
    expect(cli(["skill", "show", "diary-skill"], 1).error).toContain("not found");
    expect(sql("SELECT COUNT(*) AS n FROM events WHERE kind='kb.promote'")).toEqual(before);
  });
  it("lists only missing frontmatter fields and refuses whitespace-only values", () => {
    const id = note("incomplete", '---\ncue: on retry\nlesson: " "\nevidence: ""\n---\nCheck observed output.');
    expect(cli(["kb", "promote", id, "--name", "incomplete-skill"], 1).error).toMatch(/missing: lesson, evidence/);
  });
  it("accepts complete frontmatter while preserving body and origin", () => {
    const body = '---\ncue: when a lock holder has exited\nlesson: retry the transaction after checking ownership\nevidence: an isolated run recorded a clean retry\n---\nPreserve the observed run before retrying.';
    const id = note("complete", body); cli(["kb", "promote", id, "--name", "complete-skill"]);
    expect(cli(["skill", "show", "complete-skill"])).toMatchObject({ body, origin: "kb:" + id, support_refs: [] });
  });
  it("accepts evidence and reverse claim relations, exposing actual typed ids", () => {
    const id = note("linked");
    cli(["rel", "add", "kb:" + id, "evidence:" + evidence, "--rel", "evidenced-by"]);
    cli(["rel", "add", "claim:" + claim, "kb:" + id, "--rel", "related"]);
    cli(["kb", "promote", id, "--name", "linked-skill"]);
    expect(cli(["skill", "show", "linked-skill"]).support_refs).toEqual([
      { type: "claim", id: claim }, { type: "evidence", id: evidence }
    ]);
  });
  it("does not count orphan or unrelated rel endpoints as evidence", () => {
    const id = note("dangling"), other = note("other"); cli(["rel", "add", "kb:" + id, "kb:" + other]);
    const db = new DatabaseSync(join(home, "ygl-trees.db"));
    try { db.prepare("INSERT INTO relations(id,src_type,src_id,dst_type,dst_id,rel) VALUES('dangling-159','kb',?,'evidence','absent','evidenced-by')").run(id); } finally { db.close(); }
    expect(cli(["kb", "promote", id, "--name", "dangling-skill"], 1).error).toContain("evidence");
  });
  it("force bypass is explicit and atomically recorded", () => {
    const id = note("forced"); cli(["kb", "promote", id, "--name", "forced-skill", "--force"]);
    const rows = sql("SELECT payload FROM events WHERE kind='kb.promote' AND entity_id=?", [id]);
    expect(rows).toHaveLength(1); expect(JSON.parse(String(rows[0].payload))).toMatchObject({ name: "forced-skill", forced: true });
    expect(cli(["skill", "show", "forced-skill"]).support_refs).toEqual([]);
  });
  it("import retains admission frontmatter without making add/import restrictive", () => {
    const file = join(home, "import-lesson.md"), body = '---\ntitle: imported lesson\ncue: after a failed check\nlesson: verify the target before retry\nevidence: isolated fixture output\n---\nUse the actual observed target.';
    writeFileSync(file, body); expect(cli(["kb", "import", file]).added).toBe(1);
    const id = cli(["kb", "list"]).find((r: any) => r.title === "imported lesson").id;
    expect(cli(["kb", "promote", id, "--name", "imported-skill"]).name).toBe("imported-skill");
  });
  it("keeps promotion-time support when source-note links change, until promoted again", () => {
    const id = note("snapshot"); cli(["rel", "add", "kb:" + id, "claim:" + claim]);
    cli(["kb", "promote", id, "--name", "snapshot-skill"]);
    cli(["rel", "rm", "kb:" + id, "claim:" + claim]);
    expect(cli(["skill", "show", "snapshot-skill"]).support_refs).toEqual([{ type: "claim", id: claim }]);
    cli(["rel", "add", "evidence:" + evidence, "kb:" + id]);
    cli(["kb", "promote", id, "--name", "snapshot-skill"]);
    expect(cli(["skill", "show", "snapshot-skill"]).support_refs).toEqual([{ type: "evidence", id: evidence }]);
  });
  it("--force=false does not bypass admission and normal promotions record forced:false", () => {
    const id = note("not-forced"); expect(cli(["kb", "promote", id, "--name", "not-forced-skill", "--force=false"], 1).error).toContain("cue");
    cli(["rel", "add", "kb:" + id, "claim:" + claim]); cli(["kb", "promote", id, "--name", "normal-skill"]);
    const events = sql("SELECT payload FROM events WHERE kind='kb.promote' AND entity_id=?", [id]);
    expect(events).toHaveLength(1); expect(JSON.parse(String(events[0].payload))).toMatchObject({ name: "normal-skill", forced: false });
  });
  it("skill deletion clears promotion support before a same-name replacement", () => {
    const id = note("delete-support"); cli(["rel", "add", "kb:" + id, "claim:" + claim]);
    cli(["kb", "promote", id, "--name", "reused-skill"]);
    expect(cli(["skill", "show", "reused-skill"]).support_refs).toEqual([{ type: "claim", id: claim }]);
    cli(["skill", "rm", "reused-skill"]);
    expect(sql("SELECT id FROM relations WHERE src_type='skill' AND src_id='reused-skill' AND rel='promoted-with'")).toEqual([]);
    cli(["skill", "add", "--name", "reused-skill", "--description", "new independent skill", "--body", "unrelated workflow"]);
    expect(cli(["skill", "show", "reused-skill"]).support_refs).toEqual([]);
  });
  it.each(["add", "import"])("same-name skill %s preserves previous promotion support", (action) => {
    const id = note("overwrite-" + action), name = "overwrite-" + action;
    cli(["rel", "add", "kb:" + id, "evidence:" + evidence]); cli(["kb", "promote", id, "--name", name]);
    expect(cli(["skill", "show", name]).support_refs).toEqual([{ type: "evidence", id: evidence }]);
    if (action === "add") cli(["skill", "add", "--name", name, "--description", "new content", "--body", "independent replacement"]);
    else { const file = join(home, name + ".md"); writeFileSync(file, "---\nname: " + name + "\ndescription: independent replacement\n---\nNew instructions."); cli(["skill", "import", file]); }
    expect(cli(["skill", "show", name]).support_refs).toEqual([{ type: "evidence", id: evidence }]);
  });
  it("requires a note id even when duplicate titles have different support", () => {
    const first = note("ambiguous-title", "First reusable note."), second = note("ambiguous-title", "Second reusable note.");
    expect(first).not.toBe(second);
    cli(["rel", "add", "kb:" + first, "claim:" + claim]);
    cli(["rel", "add", "kb:" + second, "evidence:" + evidence]);
    expect(cli(["kb", "promote", "ambiguous-title", "--name", "ambiguous-skill"], 1).error).toContain("note not found");
    expect(cli(["skill", "show", "ambiguous-skill"], 1).error).toContain("not found");
    cli(["kb", "promote", second, "--name", "selected-id-skill"]);
    expect(cli(["skill", "show", "selected-id-skill"])).toMatchObject({ origin: "kb:" + second, support_refs: [{ type: "evidence", id: evidence }] });
  });
  it("a note id wins even when another note title equals that id", () => {
    const target = note("id-target", "Target note."), other = note("other-note", "Other note.");
    const db = new DatabaseSync(join(home, "ygl-trees.db"));
    try { db.prepare("UPDATE kb_notes SET title=? WHERE id=?").run(target, other); } finally { db.close(); }
    cli(["rel", "add", "kb:" + target, "claim:" + claim]);
    cli(["kb", "promote", target, "--name", "id-collision-skill"]);
    expect(cli(["skill", "show", "id-collision-skill"])).toMatchObject({ origin: "kb:" + target, support_refs: [{ type: "claim", id: claim }] });
  });
  it("failed re-promotion restores prior skill, FTS and support snapshot", () => {
    const id = note("replace-rollback", "Original instructions."), name = "replace-rollback-skill";
    cli(["rel", "add", "kb:" + id, "evidence:" + evidence]);
    cli(["kb", "promote", id, "--name", name]);
    const before = cli(["skill", "show", name]);
    const shadow = sql("SELECT name,description,tags,ngram FROM skills_fts WHERE name=?", [name]);
    const db = new DatabaseSync(join(home, "ygl-trees.db"));
    try {
      db.prepare("DELETE FROM relations WHERE src_type='kb' AND src_id=?").run(id);
      db.prepare("UPDATE kb_notes SET body=? WHERE id=?").run("Replacement instructions.", id);
      db.exec("CREATE TRIGGER abort_replace_159 BEFORE INSERT ON events WHEN NEW.kind='kb.promote' BEGIN SELECT RAISE(ABORT,'replacement rejected'); END;");
    } finally { db.close(); }
    cli(["rel", "add", "kb:" + id, "claim:" + claim]);
    try { expect(cli(["kb", "promote", id, "--name", name], 1).error).toContain("replacement rejected"); }
    finally { const db = new DatabaseSync(join(home, "ygl-trees.db")); try { db.exec("DROP TRIGGER abort_replace_159"); } finally { db.close(); } }
    expect(cli(["skill", "show", name])).toEqual(before);
    expect(sql("SELECT name,description,tags,ngram FROM skills_fts WHERE name=?", [name])).toEqual(shadow);
  });
  it("event failure rolls skill and search shadow back together", () => {
    const id = note("rollback", '---\ncue: test failure\nlesson: roll back the whole operation\nevidence: isolated fixture transaction\n---\nRollback proof.');
    const db = new DatabaseSync(join(home, "ygl-trees.db"));
    try { db.exec("CREATE TRIGGER abort_promote_159 BEFORE INSERT ON events WHEN NEW.kind='kb.promote' BEGIN SELECT RAISE(ABORT,'promotion event rejected'); END;"); } finally { db.close(); }
    try { expect(cli(["kb", "promote", id, "--name", "rollback-skill"], 1).error).toContain("promotion event rejected"); }
    finally { const clean = new DatabaseSync(join(home, "ygl-trees.db")); try { clean.exec("DROP TRIGGER abort_promote_159"); } finally { clean.close(); } }
    expect(sql("SELECT id FROM skills WHERE name='rollback-skill'")).toEqual([]);
    expect(sql("SELECT id FROM skills_fts WHERE name='rollback-skill'")).toEqual([]);
  });
});
