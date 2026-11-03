/** #162: semicolons inside quotes, identifiers and comments are not statement separators. */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SqliteRunner, singleStatement, trimSqlWs } from "../src/sqlite-runner";

const vectors = JSON.parse(readFileSync(join(__dirname, "fixtures/sql-statements.json"), "utf8")).vectors as { sql: string; clean: string | null }[];

describe("#162 single-statement contract", () => {
  it.each(vectors)("singleStatement(%j)", (v) => {
    expect(singleStatement(trimSqlWs(v.sql))).toBe(v.clean);
  });

  it("runs a SELECT whose string literal contains a semicolon, without touching the snapshot", () => {
    const file = join(mkdtempSync(join(tmpdir(), "verify-semicolon-")), "synthetic.sqlite");
    const seed = new DatabaseSync(file);
    seed.exec("CREATE TABLE facts(needle TEXT, present INTEGER)");
    seed.prepare("INSERT INTO facts VALUES(?,1)").run("--color: #123456;");
    seed.close();
    const hash = () => createHash("sha256").update(readFileSync(file)).digest("hex");
    const before = hash();
    const runner = new SqliteRunner(file);
    try {
      expect(runner.query("SELECT present FROM facts WHERE needle='--color: #123456;' AND present=1").map((r) => r.present)).toEqual([1]);
      expect(() => runner.query("SELECT 'x;' AS a; SELECT 2")).toThrow(/multi-statement SQL rejected/);
    } finally {
      runner.close();
    }
    expect(hash()).toBe(before);
  });
});
