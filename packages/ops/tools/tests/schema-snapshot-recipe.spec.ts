import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(__dirname, "../../../..");
const EXAMPLE = join(ROOT, "examples/verify-schema-snapshot");
const BIN = join(ROOT, "dist/bundle/bin.cjs");
let dir = "";
beforeEach(() => { mkdirSync(join(ROOT, "tmp"), { recursive: true }); dir = mkdtempSync(join(ROOT, "tmp/schema-recipe-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function source(sql = "CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL); PRAGMA user_version=7") {
  const path = join(dir, "source.sqlite"); const db = new DatabaseSync(path); try { db.exec(sql); } finally { db.close(); } return path;
}
function collect(input: string, output: string) {
  return spawnSync(process.execPath, [join(EXAMPLE, "collect.mjs"), input, output], { cwd: ROOT, encoding: "utf8", timeout: 30000 });
}
function cli(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { cwd: ROOT, encoding: "utf8", timeout: 60000,
    env: { ...process.env, YGL_HOME: join(dir, "home"), YGL_DB_URL: "", YGL_PG_URL: "", YGL_SESSION: "schema-recipe-test", YGL_NO_UPDATE_CHECK: "1" } });
  expect(r.error).toBeUndefined(); expect(r.status, r.stdout + r.stderr).toBe(0); return JSON.parse(r.stdout);
}

describe("schema metadata snapshot recipe (contract 1.2)", () => {
  it("collects into new tables while preserving source bytes and never evaluating views", () => {
    const input = source("CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL); CREATE TABLE \"odd'); DROP TABLE orders; --\"(x TEXT); CREATE VIEW broken_view AS SELECT * FROM absent_table; PRAGMA user_version=7");
    const before = digest(input), output = join(dir, "evidence.sqlite");
    const r = collect(input, output); expect(r.status, r.stderr).toBe(0);
    expect(digest(input)).toBe(before);
    const db = new DatabaseSync(output, { readOnly: true });
    try {
      expect(db.prepare("SELECT * FROM schema_columns WHERE table_name='orders' AND column_name='amount'").get()).toMatchObject({ not_null: 1, declared_type: "INTEGER" });
      expect(db.prepare("SELECT * FROM schema_tables WHERE table_name='broken_view'").get()).toBeUndefined();
      expect(db.prepare("SELECT source_sha256,user_version FROM collection_source").get()).toEqual({ source_sha256: "sha256:" + before, user_version: 7 });
    } finally { db.close(); }
    expect(JSON.parse(r.stdout)).toMatchObject({ probe_sha256: "sha256:" + digest(join(EXAMPLE, "collect.mjs")) });
  });
  it("refuses an existing output or the source as output without replacing bytes", () => {
    const input = source(), output = join(dir, "existing.sqlite"); writeFileSync(output, "sentinel"); const before = digest(input);
    expect(collect(input, output).status).toBe(1); expect(readFileSync(output, "utf8")).toBe("sentinel");
    expect(collect(input, input).status).toBe(1); expect(digest(input)).toBe(before);
    for (const suffix of ["-wal", "-shm", "-journal"]) expect(collect(input, input + suffix).stderr).toContain("sidecars");
  });
  it("refuses nonempty source sidecars and unreadable SQLite without a usable output", () => {
    const input = source(), output = join(dir, "evidence.sqlite"); writeFileSync(input + "-wal", "pending snapshot bytes");
    expect(collect(input, output).stderr).toContain("standalone snapshot");
    const invalid = join(dir, "invalid.sqlite"); writeFileSync(invalid, "not sqlite");
    expect(collect(invalid, output).status).toBe(1);
    const { existsSync } = require("node:fs"); expect(existsSync(output)).toBe(false);
  });
  it("prepares the example, reports PASS then FAIL on a missing column, and verifies both archives", () => {
    const input = source(), output = join(dir, "evidence.sqlite"); const r = collect(input, output); expect(r.status, r.stderr).toBe(0);
    const producer = join(dir, "producer.json"); writeFileSync(producer, r.stdout);
    cli(["db", "init"]);
    const submitted = cli(["verify", "submit", "--title", "schema recipe", "--text", join(EXAMPLE, "material.md"), "--meta-repo", ROOT]);
    const db = new DatabaseSync(output, { readOnly: true }); let asOf: string;
    try { asOf = String(db.prepare("SELECT captured_at FROM collection_source").get()!.captured_at); } finally { db.close(); }
    const prepared = cli(["verify", "prepare", submitted.material_id, "--candidates", join(EXAMPLE, "candidates.json"), "--reviews", join(EXAMPLE, "reviews.json"), "--db", output, "--as-of", asOf, "--candidates-author", "recipe-test", "--reviews-author", "recipe-test", "--meta-repo", ROOT]);
    expect(prepared.verdict).toBe("ready");
    const pass = cli(["verify", "run", prepared.spec_id, "--db", output, "--provenance", producer]); expect(pass.overall).toBe("PASS");
    expect(cli(["verify", "archive", "verify", pass.archive.path]).ok).toBe(true);
    const negative = join(dir, "negative-source.sqlite"); const ndb = new DatabaseSync(negative); ndb.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY)"); ndb.close();
    const negativeOutput = join(dir, "negative-evidence.sqlite"); expect(collect(negative, negativeOutput).status).toBe(0);
    const fail = cli(["verify", "run", prepared.spec_id, "--db", negativeOutput, "--provenance", producer]); expect(fail.overall).toBe("FAIL");
    expect(cli(["verify", "archive", "verify", fail.archive.path]).ok).toBe(true);
  }, 120000);
});
