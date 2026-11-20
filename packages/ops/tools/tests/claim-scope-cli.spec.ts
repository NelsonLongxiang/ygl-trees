import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Sqlite from "better-sqlite3";
import { SCHEMA_VERSION } from "../../../core/database/src/db";
import { buildTools } from "../src/mcp";
const repo = resolve(__dirname, "../../../.."), bin = join(repo, "dist/bundle/bin.cjs");
let root: string, home: string;
function cli(args: string[], workspace = home, rc = 0) {
  const p = spawnSync(process.execPath, [bin, ...args, "--json"], { cwd: repo, encoding: "utf8", timeout: 60000,
    env: { ...process.env, YGL_HOME: workspace, YGL_DB_URL: "", YGL_PG_URL: "", YGL_PROJECT: "", YGL_SESSION: "scope-cli", YGL_NO_UPDATE_CHECK: "1", YGL_EVAL_OFFLINE: "1" } });
  expect(p.error, p.stderr).toBeUndefined(); expect(p.signal).toBeNull(); expect(p.status, p.stdout + p.stderr).toBe(rc);
  const value = JSON.parse(p.stdout); if (rc) expect(value).toEqual({ error: expect.any(String) }); return value;
}
beforeAll(() => { mkdirSync(join(repo, "tmp"), { recursive: true }); root = mkdtempSync(join(repo, "tmp/claim-scope-cli-")); home = join(root, "home"); cli(["db", "init"]); cli(["project", "new", "scope-p"]); });
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
describe("claims.scope shipped CLI and export replay", () => {
  it("refuses invalid scope before opening a missing workspace", () => {
    const missing = join(root, "must-not-exist");
    for (const scope of ["--scope", "--scope=public", "--scope=dept:ops "]) cli(["research", "claim", "add", "ruling", scope], missing, 2);
    expect(existsSync(missing)).toBe(false);
  });
  it("preserves scope through add/file/batch/list/show/library/rescope", () => {
    const one = cli(["research", "claim", "add", "cli scoped ruling", "--scope=dept:ops"]); expect(one.scope).toBe("dept:ops");
    expect(cli(["research", "claim", "add", "cli scoped ruling", "--scope=dept:ops"])).toMatchObject({ id: one.id, duplicate: true });
    expect(cli(["research", "claim", "add", "cli scoped ruling", "--scope=*"], home, 1).error).toContain("rescope " + one.id);
    const file = join(root, "claim.json"); writeFileSync(file, JSON.stringify({ text: "file ruling", scope: "bench:x" }));
    const two = cli(["research", "claim", "add", "--file", file]); expect(two.scope).toBe("bench:x");
    const batch = join(root, "claims.jsonl"); writeFileSync(batch, JSON.stringify({ text: "batch ruling", scope: "restricted" }));
    expect(cli(["research", "claim", "add", "--batch", batch]).rows[0].scope).toBe("restricted");
    expect(cli(["research", "claim", "show", one.id]).scope).toBe("dept:ops");
    expect(cli(["research", "claim", "list"]).find((r: any) => r.id === two.id).scope).toBe("bench:x");
    const page = cli(["library", "list", "--kind", "claim", "--project", "scope-p", "--scope=dept:ops"]);
    expect(page.items.map((r: any) => r.id)).toEqual([one.id]); expect(cli(["library", "show", "claim", two.id]).scope).toBe("bench:x");
    expect(cli(["research", "claim", "rescope", one.id, "--scope="]).scope).toBe("");
    expect(cli(["research", "claim", "rescope", one.id, "--scope="])).toMatchObject({ duplicate: true, scope: "" });
    const db = new Sqlite(join(home, "ygl-trees.db"), { readonly: true });
    try { const rows: any[] = db.prepare("SELECT payload FROM events WHERE kind='claim.rescope' AND entity_id=?").all(one.id); expect(rows).toHaveLength(1); expect(JSON.parse(rows[0].payload)).toMatchObject({ old_scope: "dept:ops", new_scope: "" }); } finally { db.close(); }
  });
  it("exports and replays explicit empty and nonempty grants without changing row identities", () => {
    const dump = join(root, "dump.sql"); cli(["db", "export", dump]); const sql = readFileSync(dump, "utf8");
    const target = join(root, "replay"); mkdirSync(target); const replay = new Sqlite(join(target, "ygl-trees.db"));
    try { replay.exec(sql); expect(replay.pragma("user_version", { simple: true })).toBe(0); } finally { replay.close(); }
    const before = cli(["research", "claim", "list"]), after = cli(["research", "claim", "list"], target); expect(after).toEqual(before);
    for (const row of before) expect(cli(["research", "claim", "show", row.id], target)).toEqual(cli(["research", "claim", "show", row.id]));
    const restored = new Sqlite(join(target, "ygl-trees.db"), { readonly: true }); try { expect(restored.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION); } finally { restored.close(); }
  });
  it("carries scope through a real MCP child, including explicit empty rescope", async () => {
    const original = process.argv[1]; process.argv[1] = bin;
    try {
      const tools = buildTools({ YGL_HOME: home, YGL_DB_URL: "", YGL_PG_URL: "", YGL_PROJECT: "", YGL_SESSION: "scope-cli", YGL_NO_UPDATE_CHECK: "1" });
      const write = tools.find(t => t.name === "write")!, read = tools.find(t => t.name === "read")!;
      const one: any = await write.execute({ domain: "research", action: "claim-add", text: "MCP scope ruling", scope: "dept:mcp", project: "scope-p" });
      expect(one.scope).toBe("dept:mcp"); expect(await read.execute({ domain: "research", action: "claim-show", id: one.id, project: "scope-p" })).toMatchObject({ scope: "dept:mcp" });
      expect(await write.execute({ domain: "research", action: "claim-rescope", id: one.id, scope: "", project: "scope-p" })).toMatchObject({ scope: "" });
    } finally { process.argv[1] = original; }
  });
});
