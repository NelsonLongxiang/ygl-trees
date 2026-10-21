/**
 * 0.110.x: `db init` cold-start import runs in ONE transaction with per-skill
 * savepoints (was one transaction per skill: 85-86s observed on 0.105.1–0.109.1).
 * Partial failure is visible (failed list + rc=1), the summary event is one row
 * (skill.import) instead of N per-skill events, and re-running init stays
 * idempotent. Duration is recorded as an observation, not a hard gate.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const REPO = resolve(__dirname, "../../../..");
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;

let HOME = "";
const dbFile = () => resolve(HOME, "ygl-trees.db");

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME },
  });
  return { rc: r.status ?? -1, out: (r.stdout || "").trim() };
}

function jrun(args: string[]) {
  const r = run(args);
  let j: any = null;
  try {
    j = JSON.parse(r.out);
  } catch {
    j = null;
  }
  return { rc: r.rc, j, raw: r.out };
}

describe.skipIf(!HAS_BIN)("db init batched skill import (0.110.x)", () => {
  let firstMs = 0;

  beforeAll(() => {
    HOME = mkdtempSync(resolve(tmpdir(), "ygl-dbinit-"));
  });

  afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("fresh init imports all built-in skills in one transaction", () => {
    const t0 = Date.now();
    const r = jrun(["db", "init", "--json"]);
    firstMs = Date.now() - t0;
    console.log(`db init fresh workspace: ${firstMs}ms`);
    expect(r.rc).toBe(0);
    expect(r.j.imported).toBeGreaterThan(0);
    expect(r.j.failed).toEqual([]);

    const db = new DatabaseSync(dbFile());
    const skills = Number((db.prepare("SELECT COUNT(*) AS n FROM skills").get() as any).n);
    const imports = Number((db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='skill.import'").get() as any).n);
    const perSkill = Number((db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='skill.upsert'").get() as any).n);
    db.close();
    expect(skills).toBe(r.j.imported);
    expect(imports).toBe(1); // one summary event, not N
    expect(perSkill).toBe(0); // batched path suppresses per-skill rows
  }, 300_000);

  it("re-running init stays idempotent (no duplicate skills, rc=0)", () => {
    const r = jrun(["db", "init", "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j.failed).toEqual([]);
    const db = new DatabaseSync(dbFile());
    const skills = Number((db.prepare("SELECT COUNT(*) AS n FROM skills").get() as any).n);
    const dup = Number((db.prepare("SELECT COUNT(*) AS n FROM (SELECT name FROM skills GROUP BY name HAVING COUNT(*)>1)").get() as any).n);
    db.close();
    expect(dup).toBe(0);
    expect(skills).toBe(r.j.imported);
    console.log(`db init second run: ${r.j.ms}ms (import ${r.j.imported})`);
  }, 300_000);
});
