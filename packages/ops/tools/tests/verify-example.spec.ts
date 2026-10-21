/**
 * 0.110.0 (可发现性): `verify example` is a read-only projection of the frozen
 * corpus. fdc757f6 pre-audit conditions: explicit checker→case map (never
 * readdir order), a golden test on the generated data, and the payload
 * self-declares its derivation source so consumers can trace the digest.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../../.."); // tests → tools → ops → packages → repo
const BIN = resolve(REPO, "dist/bundle/bin.cjs");
const HAS_BIN = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).status === 0;
const TYPES = ["sql", "sql-pair", "count", "exists", "file", "command", "agent"];

function jrun(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
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
    expect(r.j.examples.map((e: any) => e.checker)).toEqual(TYPES);
    for (const ex of r.j.examples) {
      expect(ex.case_id).toBeTruthy();
      expect(String(ex.spec_id)).toMatch(/^spec_/);
      expect(Array.isArray(ex.vu)).toBe(true);
      expect(ex.vu.length).toBeGreaterThan(0);
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
