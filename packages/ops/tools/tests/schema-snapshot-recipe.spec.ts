import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fork, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
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
    const input = source("CREATE TABLE orders(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL); CREATE TABLE \"odd'); DROP TABLE orders; --\"(x TEXT); CREATE VIEW broken_view AS SELECT * FROM absent_table; CREATE TABLE sqliteXorders(amount INTEGER); PRAGMA user_version=7");
    const before = digest(input), output = join(dir, "evidence.sqlite");
    const r = collect(input, output); expect(r.status, r.stderr).toBe(0);
    expect(digest(input)).toBe(before);
    const db = new DatabaseSync(output, { readOnly: true });
    try {
      expect(db.prepare("SELECT * FROM schema_columns WHERE table_name='orders' AND column_name='amount'").get()).toMatchObject({ not_null: 1, declared_type: "INTEGER" });
      expect(db.prepare("SELECT * FROM schema_tables WHERE table_name='broken_view'").get()).toBeUndefined();
      expect(db.prepare("SELECT table_name FROM schema_tables WHERE table_name='sqliteXorders'").get()).toEqual({ table_name: "sqliteXorders" });
      expect(db.prepare("SELECT source_sha256,user_version FROM collection_source").get()).toEqual({ source_sha256: "sha256:" + before, user_version: 7 });
    } finally { db.close(); }
    expect(JSON.parse(r.stdout)).toMatchObject({ probe_sha256: "sha256:" + digest(join(EXAMPLE, "collect.mjs")) });
  });
  it("refuses existing outputs and lets only one concurrent collector own a new output", async () => {
    const input = source(), output = join(dir, "existing.sqlite"); writeFileSync(output, "sentinel"); const before = digest(input);
    expect(collect(input, output).status).toBe(1); expect(readFileSync(output, "utf8")).toBe("sentinel");
    expect(collect(input, input).status).toBe(1); expect(digest(input)).toBe(before);
    for (const suffix of ["-wal", "-shm", "-journal"]) expect(collect(input, input + suffix).stderr).toContain("sidecars");
    const runner = join(dir, "collector-race.mjs"), shared = join(dir, "shared-evidence.sqlite");
    writeFileSync(runner,       'import {collectSchema} from ' + JSON.stringify(pathToFileURL(join(EXAMPLE, "collect.mjs")).href) + ';' +
      'process.once("message",()=>{try{collectSchema(process.argv[2],process.argv[3]);process.exitCode=0;}catch(e){console.error(e.message);process.exitCode=1;}finally{process.disconnect();}});process.send("ready");');
    const start = () => {
      const child = fork(runner, [input, shared], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [], timeout: 30000 });
      let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
      const closed = new Promise<{ code: number | null; signal: string | null; error?: Error }>(resolve => {
        let error: Error | undefined; child.once("error", e => { error = e; });
        child.once("close", (code, signal) => resolve({ code, signal, error }));
      });
      const ready = new Promise<void>((resolve, reject) => {
        child.once("message", message => message === "ready" ? resolve() : reject(new Error("unexpected collector readiness")));
        closed.then(() => reject(new Error("collector closed before release")));
      });
      return { child, closed, ready, stderr: () => stderr };
    };
    const children = [start(), start()];
    try {
      await Promise.all(children.map(c => c.ready));
      // Both independent processes are alive at the same barrier before either acquires the shared output.
      children.forEach(c => c.child.send("collect"));
      const results = await Promise.all(children.map(c => c.closed));
      results.forEach(r => { expect(r.error).toBeUndefined(); expect(r.signal).toBeNull(); });
      expect(results.map(r => r.code).sort()).toEqual([0, 1]);
      expect(children[results.findIndex(r => r.code === 1)].stderr()).toMatch(/output already exists|EEXIST/);
      const evidence = new DatabaseSync(shared, { readOnly: true });
      try { expect(evidence.prepare("SELECT source_sha256 FROM collection_source").get()).toEqual({ source_sha256: "sha256:" + before }); }
      finally { evidence.close(); }
      expect(digest(input)).toBe(before);
    } finally {
      children.forEach(c => { if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill(); });
      await Promise.all(children.map(c => c.closed));
    }
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
