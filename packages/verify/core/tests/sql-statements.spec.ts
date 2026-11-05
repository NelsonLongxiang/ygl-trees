/** #162: semicolons inside quotes, identifiers and comments are not statement separators. */
import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SqliteRunner, leadingNonAsciiWs, singleStatement, trimSqlWs } from "../src/sqlite-runner";

// temp folders made here are removed after the file's tests (verifier reruns used to leave them in the system temp)
const scratchDirs: string[] = [];
const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/sql-statements.json"), "utf8"));
const vectors = fixture.vectors as { sql: string; clean: string | null }[];
const leadingWs = fixture.leading_ws as { sql: string; ws: string | null }[];

describe("#162 single-statement contract", () => {
  it.each(vectors)("singleStatement(%j)", (v) => {
    expect(singleStatement(trimSqlWs(v.sql))).toBe(v.clean);
  });

  it("runs a SELECT whose string literal contains a semicolon, without touching the snapshot", () => {
    const file = join(scratch("verify-semicolon-"), "synthetic.sqlite");
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

  it.each(leadingWs)("leadingNonAsciiWs(%j)", (v) => {
    expect(leadingNonAsciiWs(trimSqlWs(v.sql))).toBe(v.ws);
  });

  it("names the code point when SQL starts with non-ASCII whitespace (#162 P4)", () => {
    const file = join(scratch("verify-nbsp-"), "synthetic.sqlite");
    new DatabaseSync(file).close();
    const runner = new SqliteRunner(file);
    try {
      expect(() => runner.query("\u00A0SELECT 1")).toThrow(/non-ASCII whitespace U\+00A0/);
      expect(() => runner.query(" \uFEFFSELECT 1")).toThrow(/non-ASCII whitespace U\+FEFF/);
      expect(() => runner.query("DELETE FROM t")).toThrow(/only SELECT\/WITH allowed/);
    } finally {
      runner.close();
    }
  });
});
