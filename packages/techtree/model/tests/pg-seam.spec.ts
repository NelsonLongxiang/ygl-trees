/** #176 W1-T1 offline: the techtree PG dialect seam and the PG boot gate for tree/node (no PG needed). */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isDomainError, pgPlaceholders, withoutSearchCols } from "../src/writes";

describe("#176 W1-T1 pgPlaceholders", () => {
  it.each([
    ["SELECT * FROM nodes WHERE tree_id=? AND key=?", "SELECT * FROM nodes WHERE tree_id=$1 AND key=$2"],
    ["INSERT INTO t(a,b) VALUES(?,?) ON CONFLICT DO NOTHING", "INSERT INTO t(a,b) VALUES($1,$2) ON CONFLICT DO NOTHING"],
    ["SELECT '?' AS q, ? AS v", "SELECT '?' AS q, $1 AS v"],
    ["SELECT 'it''s ?' AS q WHERE a=?", "SELECT 'it''s ?' AS q WHERE a=$1"],
    ['SELECT "odd?col" FROM t WHERE a=?', 'SELECT "odd?col" FROM t WHERE a=$1'],
    ["SELECT 1 -- why?\nFROM t WHERE a=?", "SELECT 1 -- why?\nFROM t WHERE a=$1"],
    ["SELECT 1", "SELECT 1"],
  ])("%j", (input, expected) => {
    expect(pgPlaceholders(input)).toBe(expected);
  });
});

describe("#176 W1-T2 isDomainError (what PG may show verbatim)", () => {
  it("passes the service's own refusals and masks driver, ORM and socket errors", () => {
    expect(isDomainError(new Error("cycle rejected: a already reaches c"))).toBe(true);
    expect(isDomainError(new Error("parent not found: x"))).toBe(true);
    const sock = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    expect(isDomainError(sock)).toBe(false);
    class QueryFailedError extends Error {}
    expect(isDomainError(new QueryFailedError("duplicate key value violates unique constraint"))).toBe(false);
    expect(isDomainError(Object.assign(new Error("x"), { code: "23505" }))).toBe(false);
    expect(isDomainError("boom")).toBe(false);
  });
});

describe("#176 W1-T1 withoutSearchCols", () => {
  it("drops the PG-only search columns and keeps everything else", () => {
    expect(withoutSearchCols({ id: "n1", key: "a", tier: 1, ngram: "a a", ngram_tsv: "'a'" })).toEqual({ id: "n1", key: "a", tier: 1 });
    expect(withoutSearchCols(undefined)).toBeUndefined();
  });
});

const BIN = resolve(__dirname, "../../../../dist/bundle/bin.cjs");
describe.skipIf(!existsSync(BIN))("#176 W1-T1 PG boot gate for techtree (unreachable PG)", () => {
  const PG = "postgres://127.0.0.1:1/ygl";
  const run = (args: string[]) => {
    const home = mkdtempSync(join(tmpdir(), "tt-pg-gate-"));
    try {
      const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { encoding: "utf8", timeout: 30000, env: { ...process.env, YGL_HOME: home, YGL_DB_URL: PG, YGL_SESSION: "tt-gate", YGL_NO_UPDATE_CHECK: "1" } });
      return { rc: r.status, out: r.stdout || "", text: (r.stdout || "") + (r.stderr || "") };
    } finally { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  };
  it.each([["tree", "list"], ["tree", "new", "x"], ["node", "add", "k"], ["node", "list"], ["node", "show", "k"], ["node", "link", "a", "b"], ["node", "unlink", "a", "b"], ["node", "rm", "a"], ["node", "move", "a", "--to", "t"], ["node", "index"], ["node", "validate"]])(
    "opened face %s %s reaches PG (rc 1 masked failure, not the rc 2 refusal)", (...args) => {
      const r = run(args);
      expect(r.rc, r.text).toBe(1);
      expect(JSON.parse(r.out).error).not.toMatch(/needs the SQLite workspace face/);
      expect(r.text).not.toMatch(/127\.0\.0\.1:1/);
    }, 60_000);
  it.each([["node", "unlock", "a"], ["node", "search", "q"], ["node", "cond", "a"], ["node", "ready"], ["node", "export"]])(
    "face outside T1 %s %s is refused with rc 2", (...args) => {
      const r = run(args);
      expect(r.rc).toBe(2);
      expect(JSON.parse(r.out).error).toMatch(/tree new\/list\/show\/use \| node add\/list\/show\/link\/unlink\/rm\/move\/index\/validate/);
    }, 60_000);
  it("tree use --global is a usage error on PG before any connection", () => {
    expect(run(["tree", "use", "x", "--global"]).rc).toBe(2);
  }, 60_000);
});
