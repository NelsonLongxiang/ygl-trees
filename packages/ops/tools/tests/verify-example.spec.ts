/**
 * 0.110.0 (可发现性): `verify example` is a read-only projection of the frozen
 * corpus. fdc757f6 pre-audit conditions: explicit checker→case map (never
 * readdir order), a golden test on the generated data, and the payload
 * self-declares its derivation source so consumers can trace the digest.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../../.."); // tests → tools → ops → packages → repo
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
// #52: isolate the workspace — an unset YGL_HOME wrote cmd.run events into the
// developer's real ~/.ygl-trees on every CLI spawn.
const HOME = mkdtempSync(join(tmpdir(), "ygl-verify-example-"));
beforeAll(() => {
  expect(jrun(["db", "init"]).rc).toBe(0);
  expect(jrun(["project", "new", "p"]).rc).toBe(0);
});
afterAll(() => rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const TYPES = ["sql", "sql-pair", "count", "exists", "file", "command", "agent"];

function jrun(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, YGL_HOME: HOME },
  });
  let j: any = null;
  try {
    j = JSON.parse((r.stdout || "").trim());
  } catch {
    j = null;
  }
  return { rc: r.status ?? -1, j, raw: (r.stdout || "") + (r.stderr || "") };
}

describe.skipIf(!HAS_BIN)("verify example (corpus-derived, 0.110.0)", () => {
  it("projects all seven checker types with a self-declared derivation source", () => {
    const r = jrun(["verify", "example", "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j._derived_from).toMatch(/^corpus 1\.2 \(173 files, digest 683766f1077bb2c0/);
    // #79: the payload declares the two faces (spec vu vs prepare candidates).
    expect(String(r.j._shape_note)).toMatch(/SPEC face/);
    expect(String(r.j._shape_note)).toMatch(/PREPARE shape/);
    expect(r.j.examples.map((e: any) => e.checker)).toEqual(TYPES);
    for (const ex of r.j.examples) {
      expect(ex.case_id).toBeTruthy();
      expect(String(ex.spec_id)).toMatch(/^spec_/);
      expect(Array.isArray(ex.vu)).toBe(true);
      expect(ex.vu.length).toBeGreaterThan(0);
      // #63: each example also projects the CANDIDATE shape (anchor+id) so
      // "copy → prepare" does not require translating expected_from.
      expect(Array.isArray(ex.candidates)).toBe(true);
      for (const c of ex.candidates) {
        expect(c.source_clause).toBeTruthy();
        expect(c.checker?.type).toBeTruthy();
        expect(c.anchor?.quote).toBeTruthy();
        expect(c.anchor?.locator).toBeTruthy();
      }
    }
    // 显式映射（非 readdir 顺序）：锁住每型代表案例
    expect(r.j.examples.map((e: any) => e.case_id)).toEqual([
      "sql-find-violation",
      "sql-pair-tolerance",
      "count-batch-coverage",
      "exists-attachment-registered",
      "file-attachment-glob",
      "command-exit-code",
      "agent-sealed-rejected",
    ]);
  });

  it("filters by --checker and rejects unknown types (rc=2 list)", () => {
    const one = jrun(["verify", "example", "--checker", "sql-pair", "--json"]);
    expect(one.rc).toBe(0);
    expect(one.j.examples).toHaveLength(1);
    expect(one.j.examples[0].case_id).toBe("sql-pair-tolerance");

    const bad = jrun(["verify", "example", "--checker", "nope", "--json"]);
    expect(bad.rc).toBe(2);
    expect(String(bad.j.error)).toMatch(/unknown checker 'nope'/);
    expect(String(bad.j.error)).toMatch(/sql, sql-pair, count, exists, file, command, agent/);
  });

  it("--null-ops ships the syntax note (is null / is not null + count NULL asymmetry)", () => {
    const r = jrun(["verify", "example", "--null-ops", "--json"]);
    expect(r.rc).toBe(0);
    expect(r.j.null_ops.ops).toEqual(["is null", "is not null"]);
    expect(String(r.j.null_ops.note)).toContain("count(col)");
    expect(String(r.j.null_ops.note)).toContain("max/min/sum 产 NULL");
    expect(r.j.null_ops.example.checker.predicate.where.conditions[0]).toEqual({ col: "closed_at", op: "is null" });
    expect(String(r.j.null_ops._derived_from)).toContain("syntax note");
  });

  it("golden: examples.generated.ts is in sync with the frozen corpus", () => {
    const r = spawnSync(process.execPath, [resolve(REPO, "scripts/gen-examples.mjs"), "--check"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(String(r.stdout)).toContain("in sync");
  });
});
